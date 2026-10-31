#!/usr/bin/env node
// G0's measuring tool (vision docs/specs/2026-10-29-google-cloud-design.md, section 12), for terraform/gcp-dev: how
// fast a URL map switch takes effect, how fast stopped or suspended VMs come back healthy, Cloud Monitoring's request
// count delay, and whether Google health checks a backend service out of service; and (spec 2026-10-30, section 10) a
// VM in a zonal NEG, a Cloud SQL instance stopped and started, and a Deployment scaled behind a standalone NEG. Each command prints a timeline, one
// line per event: `<seconds since the start>s  <what>  <value>`.
//
// Google's REST APIs with gcloud's access token (`gcloud config config-helper --format=json --min-expiry=20m
// --configuration <configuration>`: at least 20 minutes left; asked again 5 minutes before it expires, and with a
// forced refresh after a 401, the request then sent once more); the load balancer probed with a new connection for
// each request, every 250 ms for a switch and 500 ms for a VM or a managed group. No dependency. Usage: --help, or
// terraform/gcp-dev's README.
import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { constants } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import * as core from './measure-core.mjs';

const COMPUTE = 'https://compute.googleapis.com/compute/v1';
const MONITORING = 'https://monitoring.googleapis.com/v3';
const SQLADMIN = 'https://sqladmin.googleapis.com/v1';
const CONTAINER = 'https://container.googleapis.com/v1';
const PROBE_TIMEOUT_MS = 10_000;
const OPERATION_TIMEOUT_MS = 180_000;
const STATUS_EVERY_MS = 1000;
const HEALTH_EVERY_MS = 2000;
const METRIC_EVERY_MS = 10_000;
// Cloud SQL's state and policy: the router polls every 10 s (spec section 9), so does the measure.
const SQL_EVERY_MS = 10_000;

// One request to the load balancer, on a new connection (`Connection: close`: undici closes the socket after the
// answer, so the next request opens another, as a new client would), never cached, never redirected.
export async function probe(url, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  try {
    const res = await fetch(url, {
      cache: 'no-store',
      redirect: 'manual',
      headers: { connection: 'close', 'cache-control': 'no-cache' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.text();
    return { status: res.status, ...core.pageOf(res.status, body), error: null };
  } catch (e) {
    return { status: 0, kind: 'error', instance: null, boot: null, error: e.cause?.code ?? e.cause?.message ?? e.name ?? String(e) };
  }
}

// A refusal from Google (exit 1).
export class GoogleError extends Error {
  constructor(status, message) {
    super(`Google: ${status ? `${status} ` : ''}${message}`);
    this.status = status;
  }
}

// A check that failed (exit 1): nothing to act on, a URL map without the service.
export class CheckError extends Error {}

// A request to Google; refused with a 401, sent once more with a new token (core.withToken).
export function createGoogle(tokens) {
  return async function request(method, url, body) {
    const res = await core.withToken(tokens, async (token) => {
      const answer = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(OPERATION_TIMEOUT_MS),
      });
      return { status: answer.status, ok: answer.ok, statusText: answer.statusText, text: await answer.text() };
    });
    let json;
    try {
      json = res.text ? JSON.parse(res.text) : {};
    } catch {
      json = { error: { message: res.text.slice(0, 300) } };
    }
    if (!res.ok) throw new GoogleError(res.status, `${method} ${url}: ${json.error?.message ?? res.statusText}`);
    return json;
  };
}

// A Compute Engine operation, waited through its `wait` method (each call returns when done or after about 2 minutes).
async function waitOperation(request, operation, timeoutMs = OPERATION_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let op = operation;
  while (op.status !== 'DONE') {
    if (Date.now() > deadline) throw new GoogleError(0, `operation ${op.name} not done after ${timeoutMs / 1000} s`);
    op = await request('POST', `${op.selfLink}/wait`);
  }
  if (op.error) {
    const errors = (op.error.errors ?? []).map((e) => `${e.code}: ${e.message}`).join('; ');
    throw new GoogleError(op.httpErrorStatusCode ?? 0, `operation ${op.operationType} ${op.targetLink}: ${errors || 'failed'}`);
  }
  return op;
}

const labelsText = (labels) => Object.entries(labels ?? {}).map(([k, v]) => `${k}=${v}`).join(' ') || '-';
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// The load balancer probed every `everyMs` (a request does not wait for the previous one); each answer kept with the
// time it was sent, and printed when its kind changes, or when an instance answers with another boot time.
function startProber(ctx, url, everyMs) {
  const answers = [];
  const inflight = new Set();
  const boots = new Map();
  let lastKind = null;
  const fire = () => {
    const t = ctx.at();
    const p = ctx.probe(url).then((answer) => {
      answers.push({ t, ...answer });
      if (answer.kind !== lastKind) {
        lastKind = answer.kind;
        ctx.log('answer', [answer.kind, answer.instance, answer.error].filter(Boolean).join(' '), t);
      }
      if (answer.instance && answer.boot && boots.get(answer.instance) !== answer.boot) {
        const was = boots.get(answer.instance);
        boots.set(answer.instance, answer.boot);
        ctx.log('boot', `${answer.instance} ${answer.boot}${was ? ` (was ${was}: booted again)` : ''}`, t);
      }
    });
    inflight.add(p);
    p.finally(() => inflight.delete(p));
  };
  fire();
  const stopFiring = ctx.every(fire, everyMs);
  return {
    answers,
    async stop() {
      stopFiring();
      await Promise.all(inflight);
    },
  };
}

// `read` every `everyMs`, one at a time; each sample kept with its time; its changes printed by `report`.
function startPoller(ctx, everyMs, read, report) {
  let stopped = false;
  let lastError = null;
  const samples = [];
  const loop = (async () => {
    while (!stopped) {
      const began = ctx.at();
      try {
        const t = ctx.at();
        const sample = await read();
        samples.push({ t, states: sample });
        report(sample, t);
        lastError = null;
      } catch (e) {
        if (e.message !== lastError) ctx.log('error', e.message);
        lastError = e.message;
      }
      await ctx.wait(Math.max(0, everyMs - (ctx.at() - began)));
    }
  })();
  return {
    samples,
    async stop() {
      stopped = true;
      await loop;
    },
  };
}

// A reporter of { name: state } samples: each change on a line `<what>  <name> <state>` (`none`: no longer there).
function reporter(ctx, what, initial = {}, none = 'absent') {
  let previous = initial;
  return (states, t) => {
    for (const c of core.changes(previous, states)) ctx.log(what, `${c.name} ${c.to ?? none}`, t);
    previous = states;
  };
}

// A summary: [what, time or null, the value when it happened, the value when it did not]; those that happened in
// time order, then the others.
function printSummary(log, rows) {
  const happened = rows.filter(([, t]) => t !== null).sort((a, b) => a[1] - b[1]);
  for (const [what, t, value] of happened) log(what, value, t);
  for (const [what, , , none] of rows.filter(([, t]) => t === null)) log(what, none);
}

const scopeOf = (o) => `${COMPUTE}/projects/${o.project}/${o.region ? `regions/${o.region}` : 'global'}`;

const nameOf = (url) => url.slice(url.lastIndexOf('/') + 1);

async function readHealth(request, backendService) {
  const groups = (backendService.backends ?? []).map((b) => b.group);
  const answers = await Promise.all(groups.map((group) => request('POST', `${backendService.selfLink}/getHealth`, { group })));
  return Object.assign({}, ...answers.map(core.healthStates));
}

// switch: the URL map's references to --from written as --to (with --weighted: --to at 1000 and --from at 0 in a
// weighted route), the load balancer probed every 250 ms until 20 answers in a row come from --to's page, and both
// backend services' health read every 2 s: Google health checks only a backend service that a forwarding rule
// references (spec section 12, 7), so a service the switch brings back may answer 503 until its health checks pass, and
// its health line tells that warm-up from the propagation.
export async function runSwitch(ctx) {
  const { options: o, request, log } = ctx;
  const scope = scopeOf(o);
  const [from, to] = await Promise.all([o.from, o.to].map((name) => request('GET', `${scope}/backendServices/${name}`)));
  const oldKind = core.kindOfPort(from.portName);
  const newKind = core.kindOfPort(to.portName);
  if (!oldKind || !newKind || oldKind === newKind) {
    throw new CheckError(`${o.from} (named port ${from.portName}) and ${o.to} (named port ${to.portName}): their answers cannot be told apart; one must serve app, the other standin`);
  }
  const mapUrl = `${scope}/urlMaps/${o.urlMap}`;
  const map = await request('GET', mapUrl);
  const { map: next, paths } = core.switchService(map, o.from, o.to, { weighted: o.weighted });
  if (paths.length === 0) throw new CheckError(`the URL map ${o.urlMap} does not send traffic to ${o.from}`);
  log('url map', `${o.urlMap}: ${o.from} (${oldKind}) to ${o.to} (${newKind})${o.weighted ? ', weighted' : ''}, at ${paths.join(', ')}`);

  const readLevels = async () => Object.fromEntries(await Promise.all([from, to].map(
    async (service) => [service.name, core.healthLevel(await readHealth(request, service))],
  )));
  const health = startPoller(ctx, HEALTH_EVERY_MS, readLevels, reporter(ctx, 'health'));
  const prober = startProber(ctx, o.url, 250);
  let sent = null;
  let end = null;
  try {
    await ctx.wait(o.baseline * 1000);
    const before = core.summarize(prober.answers, { old: oldKind, fresh: newKind });
    if (before.firstNew !== null) log('warning', `${newKind} answered before the update`);
    if (!ctx.interrupted()) {
      sent = ctx.at();
      log('update', `sent: ${o.to} at ${plural(paths.length, 'reference')}`);
      await waitOperation(request, await request('PUT', mapUrl, next));
      end = ctx.at();
      log('update', `done, ${core.delta(end - sent)} after it was sent`);
      const deadline = ctx.at() + o.timeout * 1000;
      while (!ctx.interrupted() && ctx.at() < deadline) {
        if (core.summarize(prober.answers, { old: oldKind, fresh: newKind, settle: o.settle }).settled !== null) break;
        await ctx.wait(250);
      }
    }
  } finally {
    await Promise.all([prober.stop(), health.stop()]);
  }
  if (end === null) return 1;
  const summary = core.summarize(prober.answers, { old: oldKind, fresh: newKind, settle: o.settle });

  const since = (t) => `${core.delta(t - end)} after the update`;
  const healthChanges = core.changesSince(health.samples, sent);
  const atUpdate = [from.name, to.name].map((name) => `${name} ${healthChanges.before[name] ?? 'not read yet'}`).join(', ');
  printSummary(log, [
    ['health', sent, `when the update was sent: ${atUpdate}`],
    ...healthChanges.after.map((c) => ['health', c.t, `${c.name} ${c.to ?? 'not read'}, ${since(c.t)}`]),
    ...(healthChanges.after.length === 0 ? [['health', null, null, 'no change after the update was sent']] : []),
    ['first new', summary.firstNew, `${newKind}, ${since(summary.firstNew)}`, `no ${newKind} answer`],
    ['last old', summary.lastOld, `${oldKind}, ${since(summary.lastOld)}`, `no ${oldKind} answer`],
    ['settled', summary.settled, `${o.settle} ${newKind} in a row from ${since(summary.settled)}`, `no: not ${o.settle} ${newKind} in a row within ${o.timeout} s`],
  ]);
  log('answers', `${prober.answers.length} in all`);
  return summary.settled !== null ? 0 : 1;
}

// vm and mig: the action sent, then the instances' status (every second), the backend service's health (every 2 s) and
// the load balancer's answers (every 500 ms) until every instance reached the action's status, the health followed and
// 20 answers in a row say so.
async function runAction(ctx, { names, statusPoller, backendService, act, beforeAct = async () => {}, afterAct = async () => {}, finish = async () => {} }) {
  const { options: o, action, log } = ctx;
  const health = startPoller(ctx, HEALTH_EVERY_MS, () => readHealth(ctx.request, backendService), reporter(ctx, 'health', {}, 'no status'));
  const prober = startProber(ctx, o.url, 500);
  await ctx.wait(1000);

  let since = null;
  let summary = null;
  const summarize = () => core.actionSummary(action, {
    since, names, settle: o.settle, statuses: statusPoller.samples, health: health.samples, answers: prober.answers,
  });
  try {
    if (!ctx.interrupted()) {
      await beforeAct();
      since = ctx.at();
      log(action, `sent: ${names.join(', ')}`);
      await waitOperation(ctx.request, await act());
      log('operation', `done, ${core.delta(ctx.at() - since)} after the request`);
      await afterAct();
      const deadline = ctx.at() + o.timeout * 1000;
      while (!ctx.interrupted() && ctx.at() < deadline) {
        summary = summarize();
        if (summary.done) break;
        await ctx.wait(500);
      }
    }
  } finally {
    await Promise.all([statusPoller.stop(), health.stop(), prober.stop()]);
  }
  if (since === null) return 1;
  summary = summarize();
  await finish();

  const wake = action === 'start' || action === 'resume';
  const after = (t) => `${core.delta(t - since)} after the request`;
  const all = `all ${plural(names.length, 'instance')}`;
  const answers = `${o.settle} ${wake ? 'app' : 'other'} answers in a row`;
  printSummary(log, [
    ...(wake
      ? [['running', summary.reached, `${all}, ${after(summary.reached)}`, 'no'],
        ['healthy', summary.healthy, `one instance, ${after(summary.healthy)}`, 'no'],
        ['first app answer', summary.firstNew, after(summary.firstNew), 'no'],
        ['last other answer', summary.lastOld, after(summary.lastOld), 'none']]
      : [[action === 'stop' ? 'stopped' : 'suspended', summary.reached, `${all}, ${after(summary.reached)}`, 'no'],
        ['unhealthy', summary.unhealthy, `no instance healthy, ${after(summary.unhealthy)}`, 'no'],
        ['last app answer', summary.lastOld, after(summary.lastOld), 'none'],
        ['first other answer', summary.firstNew, after(summary.firstNew), 'no']]),
    ['settled', summary.settled, `${answers} from ${after(summary.settled)}`, `no: not ${answers}`],
  ]);
  if (!summary.done) log('done', `no: not within ${o.timeout} s`);
  return summary.done ? 0 : 1;
}

async function runVm(ctx) {
  const { options: o, action, request, log } = ctx;
  const zone = `${COMPUTE}/projects/${o.project}/zones/${o.zone}`;
  const instanceUrl = `${zone}/instances/${o.instance}`;
  const backendService = await request('GET', `${scopeOf(o)}/backendServices/${o.backendService}`);
  const readStatus = async () => ({ [o.instance]: (await request('GET', instanceUrl)).status });
  const initial = await readStatus();
  log('status', `${o.instance} ${initial[o.instance]}`);
  if (core.targets(action, initial).length === 0) throw new CheckError(`${o.instance} is ${initial[o.instance]}: nothing to ${action}`);
  const statusPoller = startPoller(ctx, STATUS_EVERY_MS, readStatus, reporter(ctx, 'status', initial));

  return runAction(ctx, {
    names: [o.instance],
    statusPoller,
    backendService,
    act: () => request('POST', `${instanceUrl}/${action}`),
    // Spec section 12, 2: a started VM stays in its unmanaged group.
    finish: async () => {
      const members = await request('POST', `${zone}/instanceGroups/${o.group}/listInstances`, { instanceState: 'ALL' });
      const member = (members.items ?? []).some((i) => i.instance.endsWith(`/instances/${o.instance}`));
      log('group', `${o.group} ${member ? 'holds' : 'no longer holds'} ${o.instance}`);
    },
  });
}

async function runMig(ctx) {
  const { options: o, action, request, log } = ctx;
  const zone = `${COMPUTE}/projects/${o.project}/zones/${o.zone}`;
  const migUrl = `${zone}/instanceGroupManagers/${o.group}`;
  const sizes = (mig) => ['targetSize', 'targetStoppedSize', 'targetSuspendedSize']
    .filter((k) => mig[k] !== undefined).map((k) => `${k} ${mig[k]}`).join(', ');
  const backendService = await request('GET', `${scopeOf(o)}/backendServices/${o.backendService}`);
  log('group', `${o.group}: ${sizes(await request('GET', migUrl))}`);

  const readManaged = async () => core.managedStates(await request('POST', `${migUrl}/listManagedInstances`));
  const initial = await readManaged();
  for (const [name, status] of Object.entries(initial.status)) log('status', `${name} ${status ?? 'none'}`);
  const names = core.targets(action, initial.status);
  if (names.length === 0) throw new CheckError(`no instance of ${o.group} to ${action}`);
  const reportStatus = reporter(ctx, 'status', initial.status);
  const reportAction = reporter(ctx, 'action', initial.action);
  const statusPoller = startPoller(ctx, STATUS_EVERY_MS, async () => {
    const { status, action: current } = await readManaged();
    reportAction(current, ctx.at());
    return status;
  }, reportStatus);

  // As the router will: the autoscaler off before a stop or suspend (it would replace the instances), its mode back
  // after a start or resume.
  const autoscalerUrl = `${zone}/autoscalers/${o.autoscaler}`;
  const modeOf = async () => {
    try {
      return (await request('GET', autoscalerUrl)).autoscalingPolicy?.mode ?? null;
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  };
  const setMode = async (mode, was) => {
    await waitOperation(request, await request('PATCH', `${zone}/autoscalers?autoscaler=${o.autoscaler}`, { name: o.autoscaler, autoscalingPolicy: { mode } }));
    log('autoscaler', `${o.autoscaler} ${mode} (was ${was})`);
  };
  const wake = action === 'start' || action === 'resume';

  return runAction(ctx, {
    names,
    statusPoller,
    backendService,
    beforeAct: async () => {
      if (wake) return;
      const mode = await modeOf();
      if (mode === null) log('autoscaler', 'none');
      else if (mode !== 'OFF') await setMode('OFF', mode);
    },
    act: () => request('POST', `${migUrl}/${action}Instances`, { instances: names.map((n) => `${zone}/instances/${n}`) }),
    afterAct: async () => {
      if (!wake) return;
      const mode = await modeOf();
      if (mode === null) log('autoscaler', 'none');
      else if (mode !== o.autoscalerMode) await setMode(o.autoscalerMode, mode);
    },
    // Spec section 12, 4: what the standby pool keeps.
    finish: async () => log('group', `${o.group}: ${sizes(await request('GET', migUrl))}`),
  });
}

// An action's endpoints, read while it ran: how many there were (a stopped VM keeps its NEG endpoint, M1; scaled to 0,
// a Deployment's NEG holds none, M9).
function logEndpoints(ctx, poller, since) {
  const { reads, min, max, last } = core.endpointRange(poller.samples, since);
  ctx.log('endpoints', reads === 0 ? 'not read' : `${min} to ${max} during the ${ctx.action}, ${last} at the end, ${plural(reads, 'read')}`);
}

// neg stop|start: a VM held by a zonal NEG, as `vm`, with the NEG's endpoints read every 2 s beside the backend
// service's health (getHealth on the NEG): the endpoint kept while the VM is stopped, unhealthy, then healthy (M1).
async function runNeg(ctx) {
  const { options: o, action, request, log } = ctx;
  const zone = `${COMPUTE}/projects/${o.project}/zones/${o.zone}`;
  const instanceUrl = `${zone}/instances/${o.instance}`;
  const backendService = await request('GET', `${scopeOf(o)}/backendServices/${o.backendService}`);
  const readStatus = async () => ({ [o.instance]: (await request('GET', instanceUrl)).status });
  const initial = await readStatus();
  log('status', `${o.instance} ${initial[o.instance]}`);
  if (core.targets(action, initial).length === 0) throw new CheckError(`${o.instance} is ${initial[o.instance]}: nothing to ${action}`);

  const readEndpoints = async () => core.endpointStates(await request('POST', `${zone}/networkEndpointGroups/${o.group}/listNetworkEndpoints`, {}));
  const firstEndpoints = await readEndpoints();
  log('endpoint', `${o.group}: ${Object.entries(firstEndpoints).map(([name, at]) => `${name} ${at}`).join(', ') || 'none'}`);
  const endpoints = startPoller(ctx, HEALTH_EVERY_MS, readEndpoints, reporter(ctx, 'endpoint', firstEndpoints, 'none'));
  const statusPoller = startPoller(ctx, STATUS_EVERY_MS, readStatus, reporter(ctx, 'status', initial));
  const since = ctx.at();
  try {
    return await runAction(ctx, {
      names: [o.instance],
      statusPoller,
      backendService,
      act: () => request('POST', `${instanceUrl}/${action}`),
      finish: async () => {
        await endpoints.stop();
        logEndpoints(ctx, endpoints, since);
      },
    });
  } finally {
    await endpoints.stop();
  }
}

// sql stop|start: the activation policy patched (NEVER | ALWAYS), then the PATCH's operation followed until it is DONE: its
// end is the time, as no state of the instance tells a stop (core.SQL_POLICY). Each sample, every 10 s, prints the instance's
// state and policy and the operation's status (M6).
export async function runSql(ctx) {
  const { options: o, action, request, log } = ctx;
  const url = `${SQLADMIN}/projects/${o.project}/instances/${o.instance}`;
  const policy = core.SQL_POLICY[action];
  const instance = await request('GET', url);
  log('instance', `${o.instance}: ${core.sqlState(instance)}, ${instance.databaseVersion ?? '?'} ${instance.settings?.tier ?? '?'}, ${instance.settings?.dataDiskType ?? '?'} ${instance.settings?.dataDiskSizeGb ?? '?'} GB`);
  if (instance.settings?.activationPolicy === policy) throw new CheckError(`${o.instance} has the activation policy ${policy} already: nothing to ${action}`);
  const since = ctx.at();
  log(action, `sent: activationPolicy ${policy}`);
  const operation = await request('PATCH', url, { settings: { activationPolicy: policy } });
  log('operation', `${operation.name ?? '?'} ${operation.operationType ?? '?'} ${operation.status ?? '?'}, ${core.delta(ctx.at() - since)} after the request`);
  let followed = operation;
  const poller = startPoller(ctx, SQL_EVERY_MS, async () => {
    const [read, current] = await Promise.all([
      request('GET', `${SQLADMIN}/projects/${o.project}/operations/${operation.name}`),
      request('GET', url),
    ]);
    followed = read;
    return { instance: core.sqlState(current), operation: core.sqlOperationState(read) };
  }, (states, t) => log('state', `${o.instance} ${states.instance}, operation ${states.operation}`, t));
  const deadline = ctx.at() + o.timeout * 1000;
  try {
    while (!ctx.interrupted() && ctx.at() < deadline) {
      if (core.sqlSummary(action, poller.samples).ended !== null) break;
      await ctx.wait(1000);
    }
  } finally {
    await poller.stop();
  }
  const summary = core.sqlSummary(action, poller.samples);
  const after = (t) => `${core.delta(t - since)} after the request`;
  const seconds = core.sqlOperationSeconds(followed);
  printSummary(log, [
    ['policy', summary.policy, `${policy}, ${after(summary.policy)}`, `no: not read as ${policy}`],
    summary.failure
      ? ['done', null, null, `no: ${summary.failure}`]
      : ['done', summary.ended, `${after(summary.ended)}${seconds === null ? '' : `; Google: ${seconds} s from insertTime to endTime`}`, `no: not within ${o.timeout} s`],
  ]);
  return summary.ended !== null && !summary.failure ? 0 : 1;
}

// gke scale --replicas <n>: the cluster's DNS endpoint from the Container API, the Deployment's scale read and put
// through it with the caller's token (the owner is cluster-admin), then as a VM's action: the pods, the NEG's
// endpoints, the backend service's health and the load balancer's answers (M9, M11's scale as the owner).
export async function runGke(ctx) {
  const { options: o, request, log } = ctx;
  const cluster = await request('GET', `${CONTAINER}/projects/${o.project}/locations/${o.zone}/clusters/${o.cluster}`);
  const host = cluster.controlPlaneEndpointsConfig?.dnsEndpointConfig?.endpoint;
  if (!host) throw new CheckError(`the cluster ${o.cluster} has no DNS endpoint: turn on controlPlaneEndpointsConfig.dnsEndpointConfig`);
  log('cluster', `${o.cluster}: ${cluster.autopilot?.enabled ? 'Autopilot' : 'Standard'}, DNS endpoint ${host}`);
  const base = `https://${host}${core.deploymentPath(o.namespace, o.deployment)}`;
  const deployment = await request('GET', base);
  const action = core.scaleAction(deployment.spec?.replicas ?? 0, o.replicas);
  log('deployment', `${o.namespace}/${o.deployment}: ${deployment.spec?.replicas ?? 0} replicas wanted, ${deployment.status?.readyReplicas ?? 0} ready`);
  if (action === null) throw new CheckError(`${o.deployment} wants ${o.replicas} replicas already: nothing to scale`);

  const backendService = await request('GET', `${scopeOf(o)}/backendServices/${o.backendService}`);
  const groups = (backendService.backends ?? []).map((b) => b.group);
  if (groups.length === 0) throw new CheckError(`the backend service ${o.backendService} has no NEG: attach the Service's NEG first (terraform/gcp-dev's README)`);
  const readEndpoints = async () => Object.assign({}, ...(await Promise.all(groups.map(
    async (group) => core.endpointAddresses(await request('POST', `${group}/listNetworkEndpoints`, {})),
  ))));
  const firstEndpoints = await readEndpoints();
  log('endpoint', `${plural(Object.keys(firstEndpoints).length, 'endpoint')} in ${groups.map(nameOf).join(', ')}`);
  const endpoints = startPoller(ctx, HEALTH_EVERY_MS, readEndpoints, reporter(ctx, 'endpoint', firstEndpoints, 'none'));
  const initial = { [o.deployment]: core.podsState(deployment) };
  const statusPoller = startPoller(ctx, STATUS_EVERY_MS, async () => ({ [o.deployment]: core.podsState(await request('GET', base)) }), reporter(ctx, 'pods', initial));
  const since = ctx.at();
  try {
    return await runAction({ ...ctx, action }, {
      names: [o.deployment],
      statusPoller,
      backendService,
      act: async () => {
        const scale = await request('GET', `${base}/scale`);
        scale.spec = { ...scale.spec, replicas: o.replicas };
        await request('PUT', `${base}/scale`, scale);
        return { status: 'DONE' };
      },
      finish: async () => {
        await endpoints.stop();
        logEndpoints({ ...ctx, action }, endpoints, since);
      },
    });
  } finally {
    await endpoints.stop();
  }
}

// health: a backend service's health (getHealth on each of its groups) every 2 s for --for seconds, each change
// printed, per instance and for the service: 'no status' while Google does not health check it (spec section 12, 7:
// a backend service named in no URL map, or at weight 0 in a weighted route), then the periods of each state.
async function runHealth(ctx) {
  const { options: o, request, log } = ctx;
  const service = await request('GET', `${scopeOf(o)}/backendServices/${o.backendService}`);
  const groups = (service.backends ?? []).map((b) => nameOf(b.group));
  log('backend service', `${o.backendService}: ${plural(groups.length, 'group')}${groups.length ? ` ${groups.join(', ')}` : ''}`);
  const reportInstances = reporter(ctx, 'instance', {}, 'no status');
  const poller = startPoller(ctx, HEALTH_EVERY_MS, async () => {
    const states = await readHealth(request, service);
    reportInstances(states, ctx.at());
    return { [o.backendService]: core.healthLevel(states) };
  }, reporter(ctx, 'health'));
  await ctx.wait(o.duration * 1000);
  await poller.stop();

  const runs = core.periods(poller.samples, o.backendService);
  for (const run of runs) {
    log('period', `${o.backendService} ${run.state} until ${(run.to / 1000).toFixed(1)}s, ${plural(run.samples, 'sample')}`, run.from);
  }
  if (runs.length === 0) log('period', 'none: the health was never read');
  return runs.length > 0 ? 0 : 1;
}

async function listPoints(request, o, filter, from) {
  const points = [];
  let pageToken = '';
  do {
    const query = new URLSearchParams({
      filter,
      'interval.startTime': new Date(from - 60_000).toISOString(),
      'interval.endTime': new Date().toISOString(),
      view: 'FULL',
      ...(pageToken ? { pageToken } : {}),
    });
    const page = await request('GET', `${MONITORING}/projects/${o.project}/timeSeries?${query}`);
    points.push(...core.pointsOf(page));
    pageToken = page.nextPageToken ?? '';
  } while (pageToken);
  return points;
}

// metric: the URL map's series read, --count requests through the load balancer, then Cloud Monitoring read every 10 s
// until its points count them over what they held before: the metric's delay, its series' labels.
async function runMetric(ctx) {
  const { options: o, request, log } = ctx;
  const filter = core.metricFilter(o);
  log('filter', filter);
  const from = Date.now();
  const before = await listPoints(request, o, filter, from);
  log('before', `${plural(before.length, 'point')} published, ${plural(before.reduce((sum, p) => sum + p.value, 0), 'request')}: not counted`);
  const kinds = {};
  for (let i = 0; i < o.count && !ctx.interrupted(); i++) {
    const { kind } = await probe(o.url);
    kinds[kind] = (kinds[kind] ?? 0) + 1;
  }
  const to = Date.now();
  const sent = ctx.at();
  log('requests', `${Object.values(kinds).reduce((a, b) => a + b, 0)} sent to ${o.url}: ${Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(', ')}`);

  const seen = new Set(before.map((p) => `${p.key} ${p.value}`));
  const seenSeries = new Set();
  let first = null;
  let complete = null;
  const deadline = Date.now() + o.timeout * 1000;
  while (!ctx.interrupted() && Date.now() < deadline) {
    const points = await listPoints(request, o, filter, from);
    for (const p of points.sort((a, b) => Date.parse(a.end) - Date.parse(b.end))) {
      if (!seenSeries.has(p.series)) {
        seenSeries.add(p.series);
        log('series', `${p.metric.type} {${labelsText(p.metric.labels)}} ${p.resource.type} {${labelsText(p.resource.labels)}}`);
      }
      if (!seen.has(`${p.key} ${p.value}`)) {
        seen.add(`${p.key} ${p.value}`);
        log('point', `${p.start}..${p.end} ${p.value} {${labelsText(p.metric.labels)}}`);
      }
    }
    const n = core.counted(points, { from, to, before });
    if (n > 0 && first === null) first = ctx.at();
    if (n >= o.count) {
      complete = ctx.at();
      break;
    }
    await ctx.wait(METRIC_EVERY_MS);
  }
  const after = (t) => `${core.delta(t - sent)} after the last request`;
  log('first counted', first !== null ? after(first) : 'no', first ?? undefined);
  log('all counted', complete !== null ? after(complete) : `no: not ${o.count} within ${o.timeout} s`, complete ?? undefined);
  return complete !== null ? 0 : 1;
}

const RUN = { switch: runSwitch, vm: runVm, mig: runMig, neg: runNeg, sql: runSql, gke: runGke, metric: runMetric, health: runHealth };

export async function main(argv, { out = console.log, err = console.error } = {}) {
  let parsed;
  try {
    parsed = core.parseArgs(argv);
  } catch (e) {
    if (!(e instanceof core.UsageError)) throw e;
    err(e.message);
    err(core.USAGE);
    return 2;
  }
  if (parsed.help) {
    out(core.USAGE);
    return 0;
  }
  const { command, action, options } = parsed;

  // The first signal stops the measure and prints what it saw; a second one exits at once.
  const abort = new AbortController();
  let signal = null;
  const onSignal = (name) => {
    if (signal) process.exit(128 + constants.signals[name]);
    signal = name;
    err(`${name}: stopping`);
    abort.abort();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const start = Date.now();
  const at = () => Date.now() - start;
  const tokens = core.createTokens({
    run: async ({ force }) => (await promisify(execFile)('gcloud', core.tokenArgs(options.configuration, { force }), { timeout: 60_000 })).stdout,
  });
  const ctx = {
    command,
    action,
    options,
    request: createGoogle(tokens),
    at,
    log: (what, value, t = at()) => out(core.line(t, what, value)),
    wait: (ms) => sleep(ms, undefined, { signal: abort.signal }).catch(() => {}),
    every: (fn, ms) => {
      const timer = setInterval(fn, ms);
      return () => clearInterval(timer);
    },
    probe,
    interrupted: () => signal !== null,
  };
  ctx.log('start', `${[command, action].filter(Boolean).join(' ')} ${new Date(start).toISOString()} ${options.project}`);
  try {
    const code = await RUN[command](ctx);
    return signal ? 128 + constants.signals[signal] : code;
  } catch (e) {
    err(e instanceof GoogleError || e instanceof CheckError ? e.message : e.stack ?? String(e));
    return signal ? 128 + constants.signals[signal] : 1;
  }
}

const invoked = process.argv[1] && (() => {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (invoked) process.exit(await main(process.argv.slice(2)));
