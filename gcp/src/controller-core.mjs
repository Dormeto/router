// The controller on Google Cloud (vision docs/specs/2026-10-29-google-cloud-design.md, section 6): the wake, the nap and
// the check, with AWS's states, causes and event names (lambda/src/lib/controller-core.mjs). Each action runs within one
// request of at most 1800 s; the check only enqueues the naps it decides (POST /v1/tasks), never waiting in its 240 s.
//
// The map goes through the workload's switch (switch.mjs): the policy of a global load balancer, the swap of a regional or classic
// one. The order differs: the policy lets visitors reach the application as soon as it is healthy, so AWAKE comes first and its
// removal follows. Under a swap they are at the waker until the application's back has spread, so a wake and a nap given up unswap
// and wait, then AWAKE.
//
// A workload's configuration: `{ workloadId, urlMap, backendService, wakerBackendService (names), backends: [{ kind: 'vm'
// | 'mig', location, name }], idleMinutes, wakeTimeoutSeconds, hibernate?, lb? }`. `lb`: `{ kind: 'regional', region }` or
// `{ kind: 'classic' }`, absent for a global load balancer. `config`: `{ project, region, controllerUrl }`.
//
// What the run adds to AWS's: `stopped`, `suspended` (the VMs a nap acted on, names), `autoscalers` (`[{ kind, location,
// name (the autoscaler's), mode }]`, what the wake gives back), `lastWake` (`{ durationMs }`) and `scheduleApplied` (the last
// nap or awake window's occurrence applied). The cause and the event of a state change are logged (`StateChanged`): the
// state history in the manager comes with G2.
//
// Schedules and pauses as on AWS (vision docs/specs/2026-10-30-google-cloud-coverage-design.md, section 5). Here a pause is
// a workload's: the router's and the exclusions wait for G2.
import { randomUUID } from 'node:crypto';
import { failedSpec, failureError } from '../../lambda/src/lib/failures.mjs';
import { resolveHibernation } from '../../lambda/src/lib/hibernation.mjs';
import { awakeStartWithin, CLOSE_START_MS, maintenanceDue, occurrenceAt } from '../../lambda/src/lib/schedule.mjs';
import { STATES } from '../../lambda/src/lib/state.mjs';
import { createListRefresher } from '../../lambda/src/lib/list-refresh.mjs';
import { OPERATION_NOT_DONE } from './google.mjs';
import { inOneUpdate, switchOf } from './switch.mjs';
import { mapBusy, references, UrlMapRefused } from './urlmaps.mjs';

const POLL_MS = 2000;
// Until the VMs are down, from the moment they are asked to go. G0: 106 s, 96 s suspended, 198 s for a managed group's.
const STOP_TIMEOUT_MS = 300_000;
// Within the request's 1800 s: what is left removes the policy after the wake, or records a nap's failure. The nap's fits
// a lost policy's second wait: two writes (G0: 25 s), twice 300 s and a managed group's stop. A swap's wait comes out of the wake's
// budget, as it comes before AWAKE.
const WAKE_BUDGET_MS = 1_740_000;
const NAP_BUDGET_MS = 1_770_000;
// A fresh wait for a lost policy needs this left after it: a managed group's stop (G0: 198 s).
const STOP_ROOM_MS = 200_000;
// Cloud Monitoring publishes the first point 72 to 125 s after the requests (spec section 12): the newest requests cannot
// be seen, so the idle read goes this much further back, and the run must have been awake for all of it.
const METRIC_DELAY_MS = 180_000;
const WAKING_STUCK_GRACE_MS = 60_000;
const NAPPING_STUCK_MS = 35 * 60_000;
const CHECK_BUDGET_MS = 240_000;
const CHECK_CONCURRENCY = 8;
const SUSPEND_MAX_MEMORY_MB = 208 * 1024;
// A nap holds a request of the controller for minutes: a nap window on many workloads is spread over the checks.
const SCHEDULED_NAPS_MAX = 10;
// Pauses: automatic resume at most this far ahead, reason length.
const PAUSE_MAX_MS = 366 * 86_400_000;
const REASON_MAX = 256;
const ANY_STATE = Object.values(STATES);

const STOPPED = new Set(['TERMINATED', 'STOPPED']);
const GONE = new Set([...STOPPED, 'SUSPENDED']);
const GOING = new Set(['STOPPING', 'SUSPENDING']);
const DOWN = new Set([...GONE, ...GOING]);
// A managed instance's status lags behind what its group is doing to it (G0: 92 s of draining while RUNNING).
const STATUS_OF_ACTION = { STOPPING: 'STOPPING', SUSPENDING: 'SUSPENDING', STARTING: 'STAGING', RESUMING: 'STAGING' };
// What the shared classification cannot read in a Google error.
const KIND_OF_CODE = { 403: 'permission', 429: 'throttled' };

const iso = (ms) => new Date(ms).toISOString();
const nameOf = (url) => url.slice(url.lastIndexOf('/') + 1);
const zoneOf = (url) => /\/zones\/([^/]+)\//.exec(url)?.[1];
const names = (vms) => vms.map((vm) => vm.name);
// A zone ends in its letter, a region in its number.
export const groupOf = ({ location, name }) => ({ kind: /-[a-z]$/.test(location) ? 'zonal' : 'regional', location, name });

// The operation's wait ran out (the only thing the wait knows) or its request did: the change is still under way, and
// what comes next reads the VMs themselves.
const stillUnderWay = (err) => {
  if (err?.reason !== OPERATION_NOT_DONE && err?.name !== 'TimeoutError') throw err;
};

// Each at once, and all finished before the first failure is thrown: nothing goes on behind the caller's back.
async function each(items, action) {
  const results = await Promise.allSettled(items.map((item) => action(item)));
  const failed = results.find((r) => r.status === 'rejected');
  if (failed) throw failed.reason;
  return results.map((r) => r.value);
}

function failedFrom(err, options) {
  // The URL map kept changing, as a throttled switch.
  const kind = err.kind ?? (err.reason === OPERATION_NOT_DONE ? 'timeout' : mapBusy(err) ? 'throttled' : KIND_OF_CODE[err.code]);
  return failedSpec(kind ? Object.assign(err, { kind }) : err, options);
}

// What is wrong with a pause asked for.
export class PauseRefused extends Error {
  constructor(message) {
    super(message);
    this.name = 'PauseRefused';
  }
}

export function createController({ store, compute, urlmaps, regionalUrlmaps, monitoring, tasks, config, lists = [], download, now = Date.now, sleep, newId = randomUUID, log }) {
  const enqueue = (body) => tasks.enqueue({ url: `${config.controllerUrl}/v1/tasks`, body });

  async function transition(workloadId, change) {
    const next = await store.transition(workloadId, change);
    if (next && change.set?.state) {
      const { cond, set, cause, event } = change;
      log.info('StateChanged', { workloadId, from: cond.state, to: set.state, ...(cause ? { cause } : {}), ...event });
    }
    return next;
  }

  async function getConfig(workloadId) {
    const cfg = await store.getConfig(workloadId);
    if (!cfg) throw new Error(`workload not configured: ${workloadId}`);
    return cfg;
  }

  // --- The URL map ---------------------------------------------------------------------------------------------------

  const switchFor = (cfg) => switchOf(cfg, { urlmaps, regionalUrlmaps, project: config.project, region: config.region });

  const writeAsleep = (cfg) => {
    const sw = switchFor(cfg);
    return sw.urlmaps.modify(cfg.urlMap, sw.asleep);
  };
  const writeAwake = (cfg) => {
    const sw = switchFor(cfg);
    return sw.urlmaps.modify(cfg.urlMap, sw.awake);
  };

  // Before VMs go: the map must be the only one of its scope naming the service. Another load balancer would keep its visitors
  // with no switch and no way to wake (spec section 7, checked at the onboarding and true only then).
  async function writeOnlyAsleep(cfg) {
    const other = (await switchFor(cfg).urlmaps.list()).find((map) => map.name !== cfg.urlMap && references(map, cfg.backendService).length);
    if (other) throw new UrlMapRefused(`backend service ${cfg.backendService} is also named in URL map ${other.name}: that load balancer would lose its backends during a nap`);
    return writeAsleep(cfg);
  }

  // The policy's, after the state changed to AWAKE: a removal that fails is drift the check repairs.
  async function removePolicy(cfg) {
    try {
      await writeAwake(cfg);
    } catch (err) {
      log.warn('PolicyNotRemoved', { workloadId: cfg.workloadId, error: err.message });
    }
  }

  // The map as the state wants it, in one read (nothing written when it is), with no wait: the route for good, and awake or
  // asleep. A swap's route is the hold route too.
  async function repair(cfg, state) {
    const sw = switchFor(cfg);
    const { paths } = await sw.urlmaps.modify(cfg.urlMap, (map) => inOneUpdate(map, [sw.route, state === STATES.AWAKE ? sw.awake : sw.asleep]));
    if (paths.length) log.warn('RouteDrift', { workloadId: cfg.workloadId, state, paths });
  }

  // --- The backends --------------------------------------------------------------------------------------------------

  // A backend's VMs: `{ name, zone, status, url?, error? }`, a managed group's with its URL and its last failure.
  async function vmsOf(backend) {
    if (backend.kind !== 'mig') {
      return [{ name: backend.name, zone: backend.location, status: (await compute.getInstance(backend.location, backend.name)).status }];
    }
    return (await compute.listManagedInstances(groupOf(backend))).map((m) => ({
      name: nameOf(m.instance),
      zone: zoneOf(m.instance),
      url: m.instance,
      status: STATUS_OF_ACTION[m.currentAction] ?? m.instanceStatus,
      error: (m.lastAttempt?.errors?.errors ?? []).map((e) => `${e.code}: ${e.message}`).join('; '),
    }));
  }
  const allVms = async (cfg) => (await each(cfg.backends, vmsOf)).flat();

  async function act(backend, action, vms) {
    if (!vms.length) return;
    const asked = backend.kind === 'mig'
      ? compute[`${action}Instances`](groupOf(backend), vms.map((vm) => vm.url))
      : compute[`${action}Instance`](backend.location, backend.name);
    await asked.catch(stillUnderWay);
  }

  const setAutoscaler = ({ kind, location, name }, mode) => compute.setAutoscalerMode({ kind, location, name }, mode).catch(stillUnderWay);

  // In the service's scope. A service a classic load balancer holds reads no status while its VM is down (M3): none healthy.
  async function healthyCount({ backendService, lb }) {
    const regional = lb?.kind === 'regional';
    const { backends = [] } = await (regional ? compute.getRegionBackendService(lb.region, backendService) : compute.getBackendService(backendService));
    const answers = await each(backends, ({ group }) => (regional
      ? compute.getRegionBackendServiceHealth(lb.region, backendService, group)
      : compute.getBackendServiceHealth(backendService, group)));
    return answers.flatMap((a) => a.healthStatus ?? []).filter((h) => h.healthState === 'HEALTHY').length;
  }

  // A VM still going down is waited for (a wake right after a stop); the others are read live, not from the nap's record:
  // after 60 days Compute Engine turns a suspended VM into a stopped one.
  async function wakeBackend(backend, deadline) {
    for (;;) {
      const vms = await vmsOf(backend);
      if (!vms.some((vm) => GOING.has(vm.status))) {
        await act(backend, 'start', vms.filter((vm) => STOPPED.has(vm.status)));
        await act(backend, 'resume', vms.filter((vm) => vm.status === 'SUSPENDED'));
        return;
      }
      if (now() >= deadline) throw failureError('timeout', `${backend.name}: still going down when the wake timed out`);
      await sleep(POLL_MS);
    }
  }

  const giveBackAutoscalers = (run) => each(run.autoscalers ?? [], (recorded) => setAutoscaler(recorded, recorded.mode));

  // The autoscalers get their modes back whatever a VM's start says.
  async function wakeBackends(cfg, run, deadline) {
    try {
      await each(cfg.backends, (backend) => wakeBackend(backend, deadline));
    } finally {
      await giveBackAutoscalers(run);
    }
  }

  // Outside a wake, a mode that cannot be given back leaves the workload awake all the same: the record stays on the run
  // until it is, and the next checks try again. True once it is.
  const gaveBackAutoscalers = (workloadId, run) => giveBackAutoscalers(run).then(() => true, (err) => {
    log.warn('AutoscalersNotGivenBack', { workloadId, error: err.message });
    return false;
  });

  // At the wake's deadline: what a managed group failed on (it keeps trying on its own), else why none is healthy.
  async function noHealthyError(cfg) {
    const vms = await allVms(cfg);
    const refused = vms.find((vm) => vm.error);
    if (refused) return new Error(`${refused.name}: ${refused.error}`);
    const running = vms.filter((vm) => vm.status === 'RUNNING').length;
    if (running) return failureError('unhealthy', `${running} VM${running === 1 ? '' : 's'} running, none healthy when the wake timed out`);
    return failureError('timeout', 'no VM running when the wake timed out');
  }

  // Spec section 2: no GPU, no TPU, not confidential, at most 208 GB of memory. What cannot be read is stopped: a refused
  // suspension would be too, and the nap goes on.
  async function canSuspend({ zone, name }) {
    try {
      const vm = await compute.getInstance(zone, name);
      if (vm.guestAccelerators?.length || vm.confidentialInstanceConfig?.enableConfidentialCompute) return false;
      const type = await compute.getMachineType(zone, nameOf(vm.machineType));
      return !type.accelerators?.length && type.memoryMb <= SUSPEND_MAX_MEMORY_MB;
    } catch (err) {
      log.warn('HibernationUnread', { instance: name, error: err.message });
      return false;
    }
  }

  async function sleepBackend(backend, hibernate) {
    // Only what runs: Google refuses a request naming a VM being created or started, and the whole nap with it.
    const vms = (await vmsOf(backend)).filter((vm) => vm.status === 'RUNNING');
    const fits = hibernate ? await Promise.all(vms.map(canSuspend)) : vms.map(() => false);
    let suspended = vms.filter((_, i) => fits[i]);
    let stopped = vms.filter((_, i) => !fits[i]);
    try {
      await act(backend, 'suspend', suspended);
    } catch (err) {
      log.warn('HibernationRefused', { instances: names(suspended), error: err.message });
      suspended = [];
      stopped = vms;
    }
    await act(backend, 'stop', stopped);
    return { stopped: names(stopped), suspended: names(suspended) };
  }

  // The autoscalers on: what the wake gives back. Those a nap that failed already turned off keep their recorded mode.
  async function autoscalersToRecord(cfg, run) {
    const modes = await each(cfg.backends.filter((b) => b.kind === 'mig'), async (backend) => {
      const group = groupOf(backend);
      const url = (await compute.getManagedGroup(group)).status?.autoscaler;
      if (!url) return { ...group, mode: 'OFF' };
      const autoscaler = { ...group, name: nameOf(url) };
      const mode = await compute.getAutoscaler(autoscaler).then((a) => a.autoscalingPolicy?.mode ?? 'ON', (err) => {
        if (err.code === 404) return 'OFF';
        throw err;
      });
      return { ...autoscaler, mode };
    });
    const on = modes.filter((a) => a.mode !== 'OFF');
    const kept = (run.autoscalers ?? []).filter((old) => !on.some((a) => a.location === old.location && a.name === old.name));
    return [...kept, ...on];
  }

  // Down when this returns: an operation's end says little (a managed group's VMs go after it, and its wait may run out
  // before), so the VMs are read until they are.
  async function putToSleep(cfg, autoscalers, latest) {
    const deadline = Math.min(now() + STOP_TIMEOUT_MS, latest);
    await each(autoscalers, (recorded) => setAutoscaler(recorded, 'OFF'));
    const { hibernate } = resolveHibernation({ workload: cfg.hibernate });
    const done = await each(cfg.backends, (backend) => sleepBackend(backend, hibernate));
    for (;;) {
      const up = (await allVms(cfg)).filter((vm) => !GONE.has(vm.status));
      if (!up.length) break;
      if (now() >= deadline) throw failureError('timeout', `not down in time: ${names(up).join(', ')}`);
      await sleep(POLL_MS);
    }
    return { stopped: done.flatMap((d) => d.stopped), suspended: done.flatMap((d) => d.suspended) };
  }

  // --- The wake ------------------------------------------------------------------------------------------------------

  async function wake(workloadId, wakeId) {
    const started = now();
    const superseded = () => {
      log.warn('WakeSuperseded', { workloadId, wakeId });
      return { state: 'SUPERSEDED' };
    };
    const fail = async (err) => {
      const at = now();
      const failed = failedFrom(err, { step: 'wake', wakeId, at });
      log.error('WakeFailed', { workloadId, wakeId, error: err.message, kind: failed.event.failure.kind });
      await transition(workloadId, {
        cond: { state: STATES.WAKING, wakeId },
        set: { state: STATES.FAILED, failedAt: at, ...failed.set },
        increment: failed.increment,
        cause: 'wake-failed',
        event: failed.event,
      });
      return { state: STATES.FAILED, error: err.message };
    };
    let run;
    let cfg;
    let sw;
    try {
      run = await store.getRun(workloadId);
      // A delayed or duplicated task must not touch anything once its wake is no longer the current one.
      if (run?.state !== STATES.WAKING || run.wakeId !== wakeId) return superseded();
      cfg = await getConfig(workloadId);
      sw = switchFor(cfg);
    } catch (err) {
      return fail(err);
    }
    const since = run.wakeStartedAt ?? started;
    const deadline = Math.min(since + cfg.wakeTimeoutSeconds * 1000, started + WAKE_BUDGET_MS);
    try {
      let givenBack = true;
      try {
        await wakeBackends(cfg, run, deadline);
      } catch (err) {
        // Under a swap a wake is the only way out of FAILED, and visitors stay at the waker until it ends: a backend that cannot
        // start does not keep them from another that serves. The modes as on an external wake: a record stays until given back.
        if (sw.kind !== 'swap' || (await healthyCount(cfg).catch(() => 0)) < 1) throw err;
        log.warn('BackendsNotWoken', { workloadId, error: err.message });
        givenBack = await gaveBackAutoscalers(workloadId, run);
      }
      while ((await healthyCount(cfg)) < 1) {
        if (now() >= deadline) throw await noHealthyError(cfg);
        await sleep(POLL_MS);
      }
      if (sw.kind === 'swap') {
        // The wait counts in the wake's time. It must also fit the request, and is not cut short: the map has changed.
        if (now() >= Math.min(deadline, started + WAKE_BUDGET_MS - sw.waitMs)) throw failureError('timeout', 'a VM is healthy, but the wake timed out before the URL map could change');
        const current = await store.getRun(workloadId);
        if (current?.state !== STATES.WAKING || current.wakeId !== wakeId) return superseded();
        await writeAwake(cfg);
        await sleep(sw.waitMs);
        if (now() >= deadline) throw failureError('timeout', 'a VM is healthy, but the wake timed out while the URL map\'s change spread');
      }
      const durationMs = now() - since;
      const awake = await transition(workloadId, {
        cond: { state: STATES.WAKING, wakeId },
        set: { state: STATES.AWAKE, awakeSince: now(), lastWake: { durationMs } },
        remove: ['pendingWake', 'stopped', 'suspended', ...(givenBack ? ['autoscalers'] : []), 'failure', 'consecutiveFailures', 'failedAt'],
        event: { wakeId, durationMs },
      });
      if (!awake) return superseded();
      log.info('WakeCompleted', { workloadId, wakeId, durationMs });
      if (sw.kind === 'policy') await removePolicy(cfg);
      return { state: STATES.AWAKE, durationMs };
    } catch (err) {
      return fail(err);
    }
  }

  // The run to WAKING for a wake asked here, not by a request (the waker's). Null when its state changed meanwhile.
  async function beginWake(workloadId, from, cause) {
    const wakeId = newId();
    const waking = await transition(workloadId, {
      cond: { state: from },
      set: { state: STATES.WAKING, wakeId, wakeStartedAt: now() },
      remove: ['failedAt'],
      increment: ['wakeCount'],
      cause,
    });
    if (!waking) return null;
    log.info('WakeRequested', { workloadId, wakeId, reason: cause });
    return wakeId;
  }

  // A daily counter: a failed update changes nothing else.
  async function count(workloadId, counter) {
    try {
      await store.count(workloadId, counter);
    } catch (err) {
      log.warn('StatsWriteFailed', { workloadId, counter, error: err.message });
    }
  }

  // A napping workload's wake is kept for the nap's end. True when this call kept it: one log line and one counted wake.
  async function pendingWake(workloadId, kind) {
    if (!(await store.setPendingWake(workloadId))) return false;
    log.info('PendingWake', { workloadId, reason: kind });
    await count(workloadId, `wake:${kind}`);
    return true;
  }

  // The wake of an asleep or failed workload from the run read, in a request of its own. True when its task was accepted;
  // false when the state changed since, or when the task cannot be enqueued, which fails the wake now rather than at the
  // check.
  async function startWake(workloadId, run, kind) {
    const wakeId = await beginWake(workloadId, run.state, kind);
    if (!wakeId) return false;
    await count(workloadId, `wake:${kind}`);
    try {
      await enqueue({ action: 'wake', workloadId, wakeId });
      return true;
    } catch (err) {
      const at = now();
      const failed = failedFrom(err, { step: 'wake', wakeId, at });
      log.error('WakeInvokeFailed', { workloadId, wakeId, error: err.message });
      await transition(workloadId, {
        cond: { state: STATES.WAKING, wakeId },
        set: { state: STATES.FAILED, failedAt: at, ...failed.set },
        increment: failed.increment,
        cause: 'invoke-failed',
        event: failed.event,
      });
      return false;
    }
  }

  // The wake of an operator or a pause, whatever the backoff; this request answers at once.
  async function wakeNow(workloadId, kind = 'operator') {
    const run = await store.getRun(workloadId);
    if (run?.state === STATES.NAPPING) await pendingWake(workloadId, kind);
    else if ([STATES.ASLEEP, STATES.FAILED].includes(run?.state)) await startWake(workloadId, run, kind);
  }

  // --- The nap -------------------------------------------------------------------------------------------------------

  // Written, then still there after a whole wait: a check's repair or a customer's apply may have removed it meanwhile,
  // and the VMs must not go with no way to wake. False when it was lost with no room left for another wait: for the stop, and
  // under a swap for the wait of a nap given up after that one.
  async function asleepHeld(cfg, sw, latest) {
    const room = sw.waitMs + STOP_ROOM_MS + (sw.kind === 'swap' ? sw.waitMs : 0);
    await writeOnlyAsleep(cfg);
    for (;;) {
      await sleep(sw.waitMs);
      const { paths } = await writeOnlyAsleep(cfg);
      if (!paths.length) return true;
      log.warn(sw.kind === 'swap' ? 'SwapLost' : 'PolicyLost', { workloadId: cfg.workloadId, paths });
      if (now() + room > latest) return false;
    }
  }

  // A NEG's VMs are stopped only while they still are the NEG: one is edited more freely than a group. Why not, else null.
  // A read that fails throws. The wake needs none of this: starting what was recorded is harmless.
  async function negsChanged(cfg) {
    const recorded = new Map();
    for (const backend of cfg.backends.filter((b) => b.kind === 'vm')) {
      for (const neg of [backend.neg, ...(backend.moreNegs ?? [])].filter(Boolean)) {
        const key = `${neg.zone}/${neg.name}`;
        recorded.set(key, { neg, vms: [...(recorded.get(key)?.vms ?? []), backend.name] });
      }
    }
    const changes = await each([...recorded.values()], async ({ neg, vms }) => {
      const current = (await compute.listNetworkEndpoints(neg.zone, neg.name)).map((item) => nameOf(item.networkEndpoint?.instance ?? ''));
      const added = [...new Set(current)].filter((name) => !vms.includes(name));
      const removed = vms.filter((name) => !current.includes(name));
      if (!added.length && !removed.length) return null;
      const parts = [...(added.length ? [`VMs added: ${added.join(', ')}`] : []), ...(removed.length ? [`VMs removed: ${removed.join(', ')}`] : [])];
      return `network endpoint group ${neg.name} changed since the onboarding (${parts.join('; ')}): offboard and onboard again`;
    });
    const found = changes.filter(Boolean);
    return found.length ? found.join('; ') : null;
  }

  // Why a nap's task no longer holds, else null: a pause written since it was asked for; for a nap window's (`until`, its
  // end), a task delivered late or twice, a window ended or the workload woken since.
  async function napRefusal(workloadId, requestedAt, until) {
    if (await isPaused(workloadId)) return 'paused';
    if (until === undefined) return null;
    if (now() >= until) return 'the nap window ended';
    return ((await store.getRun(workloadId))?.awakeSince ?? 0) > requestedAt ? 'woken since it was requested' : null;
  }

  async function nap(workloadId, { cause = 'idle', requestedAt, until } = {}) {
    const latest = now() + NAP_BUDGET_MS;
    const cfg = await getConfig(workloadId);
    const sw = switchFor(cfg);
    const refusal = await napRefusal(workloadId, requestedAt, until);
    if (refusal) {
      log.warn('NapSkipped', { workloadId, reason: refusal });
      return { state: 'SKIPPED', reason: refusal };
    }
    const napping = await transition(workloadId, { cond: { state: STATES.AWAKE }, set: { state: STATES.NAPPING }, remove: ['pendingWake'], cause });
    if (!napping) return { state: 'SKIPPED' };
    log.info('NapStarted', { workloadId });
    // Nothing is stopped yet, the application keeps serving. Under a swap, visitors are at the waker until the application's back
    // has spread: unswapped and waited for before AWAKE, a wake asked meanwhile being part of it; nothing to unswap, no wait. The
    // policy's removal follows it.
    const giveUp = async (cause, level, fields = {}) => {
      if (sw.kind === 'swap') {
        const { paths } = await writeAwake(cfg);
        if (paths.length) await sleep(sw.waitMs);
      }
      await transition(workloadId, {
        cond: { state: STATES.NAPPING }, set: { state: STATES.AWAKE, awakeSince: now() }, remove: ['pendingWake', 'stopping'], cause,
      });
      log[level]('NapAborted', { workloadId, ...fields });
      if (sw.kind === 'policy') await removePolicy(cfg);
    };
    let slept;
    try {
      try {
        if (!(await asleepHeld(cfg, sw, latest))) {
          await giveUp(`${sw.kind}-lost`, 'warn', { reason: `the ${sw.kind} was lost, no time left to wait for it again` });
          return { state: STATES.AWAKE, aborted: true };
        }
      } catch (err) {
        // A customer's own policy, or a service moved or named elsewhere, since the onboarding: nothing is stopped yet, the
        // application keeps serving.
        if (!(err instanceof UrlMapRefused)) throw err;
        await giveUp('switch-failed', 'warn', { reason: err.message });
        return { state: STATES.AWAKE, aborted: true, error: err.message };
      }
      const changed = await negsChanged(cfg);
      if (changed) {
        await giveUp('backends-changed', 'warn', { reason: changed });
        return { state: STATES.AWAKE, aborted: true, error: changed };
      }
      const autoscalers = await autoscalersToRecord(cfg, napping);
      // Commit point: after this transition the VMs go, even if a request arrives. The modes are on the run before any
      // autoscaler is turned off. A pause written since the nap started aborts it, like a request.
      const paused = await isPaused(workloadId);
      if (paused || !(await transition(workloadId, { cond: { state: STATES.NAPPING, pendingWake: false }, set: { stopping: true, autoscalers } }))) {
        await giveUp(paused ? 'paused' : 'pending-wake', 'info', paused ? { reason: 'paused' } : {});
        return { state: STATES.AWAKE, aborted: true };
      }
      slept = await putToSleep(cfg, autoscalers, latest);
    } catch (err) {
      log.error('NapFailed', { workloadId, error: err.message });
      const at = now();
      const failed = failedFrom(err, { step: 'nap', at });
      await transition(workloadId, {
        cond: { state: STATES.NAPPING },
        set: { state: STATES.FAILED, failedAt: at, ...failed.set },
        increment: failed.increment,
        remove: ['stopping'],
        cause: 'nap-failed',
        event: failed.event,
      });
      return { state: STATES.FAILED, error: err.message };
    }
    const asleep = await transition(workloadId, {
      cond: { state: STATES.NAPPING, pendingWake: false },
      set: { state: STATES.ASLEEP, ...slept },
      remove: ['stopping'],
      event: slept,
    });
    if (asleep) {
      log.info('NapCompleted', { workloadId });
      return { state: STATES.ASLEEP };
    }
    // A wake asked during the stop: in a request of its own, as this one may have used most of its 1800 s. Its task lost,
    // the check finds the wake stuck.
    const wakeId = newId();
    const waking = await transition(workloadId, {
      cond: { state: STATES.NAPPING },
      set: { state: STATES.WAKING, wakeId, wakeStartedAt: now() },
      remove: ['stopping', 'pendingWake'],
      increment: ['wakeCount'],
      cause: 'pending-wake',
    });
    if (!waking) return { state: 'UNKNOWN' };
    log.info('WakeRequested', { workloadId, wakeId, reason: 'pendingWake' });
    await enqueue({ action: 'wake', workloadId, wakeId });
    return { state: STATES.WAKING, wakeId };
  }

  // The operator's nap, in a request of its own: it takes minutes.
  const napNow = (workloadId) => enqueue({ action: 'nap', workloadId });

  // A failed workload whose backends run for nothing is stopped like a nap and left asleep behind the switch, its failure
  // kept (requests wake it again, backed off). The switch is there since its nap, unless the nap failed before writing it.
  async function release(workloadId) {
    const latest = now() + NAP_BUDGET_MS;
    let run = await store.getRun(workloadId);
    if (run?.state !== STATES.FAILED) return { state: 'SKIPPED', reason: run?.state ?? 'unknown' };
    if (await isPaused(workloadId)) return { state: 'SKIPPED', reason: 'paused' };
    const cfg = await getConfig(workloadId);
    try {
      const { paths } = await writeOnlyAsleep(cfg);
      if (paths.length) {
        await sleep(switchFor(cfg).waitMs);
        // What it records may have changed: with the old record, an autoscaler read OFF would lose its mode for good.
        run = await store.getRun(workloadId);
        if (run?.state !== STATES.FAILED) return { state: 'SUPERSEDED' };
      }
      const changed = await negsChanged(cfg);
      if (changed) {
        log.warn('ReleaseAborted', { workloadId, reason: changed });
        return { state: STATES.FAILED, error: changed };
      }
      const autoscalers = await autoscalersToRecord(cfg, run);
      // A wake asked meanwhile takes over.
      if (!(await transition(workloadId, { cond: { state: STATES.FAILED }, set: { autoscalers } }))) return { state: 'SUPERSEDED' };
      const slept = await putToSleep(cfg, autoscalers, latest);
      const asleep = await transition(workloadId, { cond: { state: STATES.FAILED }, set: { state: STATES.ASLEEP, ...slept }, cause: 'failed-released', event: slept });
      if (!asleep) return { state: 'SUPERSEDED' };
      log.warn('FailedReleased', { workloadId, ...slept });
      return { state: STATES.ASLEEP };
    } catch (err) {
      log.error('ReleaseFailed', { workloadId, error: err.message });
      return { state: STATES.FAILED, error: err.message };
    }
  }

  // --- Schedules, applied by the check -----------------------------------------------------------------------------------

  const recordOccurrence = async (workloadId, occurrence, action, state) => {
    if (await transition(workloadId, { cond: { state }, set: { scheduleApplied: occurrence.id } })) {
      log.info('ScheduleApplied', { workloadId, occurrence: occurrence.id, kind: occurrence.kind, action });
    }
  };

  // The nap windows' naps a check asks for, oldest occurrence first and at most SCHEDULED_NAPS_MAX accepted: the next check
  // takes the rest, and those a Cloud Tasks too slow left past the check's budget. Each occurrence is recorded only once its
  // task is accepted, whatever the state by then: the task may have started. A record lost asks again at the next check, and
  // the task it adds finds the nap under way. A pause written after that refuses the task, and the occurrence stays consumed:
  // once the pause is gone only an idle nap comes, not the window's.
  async function askScheduledNaps(naps, applied, t, deadline) {
    const deferred = [];
    const failed = (workloadId) => (err) => log.error('ScheduleFailed', { workloadId, error: err.message });
    let accepted = 0;
    naps.sort((a, b) => a.occurrence.start - b.occurrence.start || a.workloadId.localeCompare(b.workloadId));
    for (const { workloadId, occurrence } of naps) {
      if (accepted === SCHEDULED_NAPS_MAX || now() >= deadline) {
        deferred.push(workloadId);
        applied.set(workloadId, 'nap deferred');
        continue;
      }
      try {
        await enqueue({ action: 'nap', workloadId, cause: 'schedule', requestedAt: t, until: occurrence.end });
      } catch (err) {
        failed(workloadId)(err);
        applied.set(workloadId, 'nap refused');
        continue;
      }
      accepted += 1;
      applied.set(workloadId, 'nap');
      log.info('NapRequested', { workloadId, cause: 'schedule' });
      await recordOccurrence(workloadId, occurrence, 'nap', ANY_STATE).catch(failed(workloadId));
    }
    if (deferred.length) log.info('ScheduledNapsDeferred', { workloads: deferred });
  }

  // Before the check's loop, every scheduled workload whatever the loop's budget: 8 at a time, one run read each, nothing
  // called but the tasks it enqueues. holdOf(workloadId): { paused, keepAsleep }. Answers each workload's outcome (what it did,
  // or what held it) and the schedules the router can read: one it cannot (a time zone Intl refuses) is logged and the
  // workload behaves as if it had none.
  async function applySchedules(configs, schedules, holdOf, t, deadline) {
    const due = [];
    const readable = new Map();
    for (const { workloadId } of configs) {
      const schedule = schedules.get(workloadId);
      if (!schedule) continue;
      try {
        const occurrence = occurrenceAt(schedule, t);
        // A nap window's occurrence is skipped when an awake window starts within 30 minutes of its start, or of now (an
        // occurrence first applied late).
        const closeStart = occurrence?.kind === 'nap'
          && (awakeStartWithin(schedule, occurrence.start, CLOSE_START_MS) || awakeStartWithin(schedule, t, CLOSE_START_MS));
        readable.set(workloadId, schedule);
        due.push({ workloadId, schedule, occurrence, closeStart });
      } catch (err) {
        log.warn('ScheduleSkipped', { workloadId, error: err.message });
      }
    }
    const applied = new Map();
    const naps = [];
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(CHECK_CONCURRENCY, due.length) }, async () => {
      while (i < due.length) {
        const item = due[i++];
        try {
          const outcome = await applySchedule(item, holdOf(item.workloadId), t, naps);
          if (outcome) applied.set(item.workloadId, outcome);
        } catch (err) {
          log.error('ScheduleFailed', { workloadId: item.workloadId, error: err.message });
        }
      }
    }));
    await askScheduledNaps(naps, applied, t, deadline);
    return { applied, readable };
  }

  // The occurrence active now, applied once: the run records the last applied one, so a late check, a deploy inside a window
  // or two checks in it apply it once. Then the maintenance wake of a workload asleep longer than maxNapDays. A pause holds
  // the window's nap and a keepAsleep pause the wakes: held, the occurrence stays unapplied and applies once the pause is
  // gone. A nap goes in `naps`, each nap a task, which holds nothing here. Every other write is conditional on the run read:
  // one that changed since (a request's wake) is left for the next check. Answers what it did or what held it, else null.
  async function applySchedule({ workloadId, schedule, occurrence, closeStart }, hold, t, naps) {
    if (!occurrence && !schedule.maxNapDays) return null;
    const run = await store.getRun(workloadId);
    if (!run) return null;
    const pending = occurrence && run.scheduleApplied !== occurrence.id ? occurrence : null;
    const asleep = run.state === STATES.ASLEEP || run.state === STATES.FAILED;
    if (pending?.kind === 'awake' && (asleep || run.state === STATES.NAPPING)) {
      if (hold.keepAsleep) return 'held by a keepAsleep pause';
      // A napping workload gets its pending wake; the occurrence is recorded once the nap settled (a write now would delay
      // the detection of a stuck nap, which reads updatedAt).
      if (run.state === STATES.NAPPING) return (await pendingWake(workloadId, 'schedule')) ? 'pending wake' : null;
      // Recorded once its task is accepted: refused, the run is FAILED and the next check wakes it.
      if (!(await startWake(workloadId, run, 'schedule'))) return null;
      await recordOccurrence(workloadId, pending, 'wake', ANY_STATE);
      return 'wake';
    }
    if (pending?.kind === 'nap' && run.state === STATES.AWAKE && !closeStart) {
      if (hold.paused) return 'held by a pause';
      naps.push({ workloadId, occurrence: pending });
      return null;
    }
    // Napping or waking at a nap window: left for the next check, which naps it once awake.
    if (pending?.kind === 'nap' && (run.state === STATES.NAPPING || run.state === STATES.WAKING)) return null;
    // Nothing to do (the workload is already as the window wants it, or the nap window comes just before an awake one).
    if (pending) await recordOccurrence(workloadId, pending, closeStart ? 'skipped: an awake window starts within 30 minutes' : 'none', run.state);
    const due = run.state === STATES.ASLEEP ? maintenanceDue(schedule, run.stateAt) : null;
    if (due === null || due > t) return null;
    if (hold.keepAsleep) return 'held by a keepAsleep pause';
    return (await startWake(workloadId, run, 'maintenance')) ? 'maintenance' : null;
  }

  // Why a schedule keeps a workload from its idle nap now, else null: the nap the schedules just decided (asked, put off or
  // refused, not asked twice and not ahead of the spread), an awake window active or starting within 30 minutes. The
  // schedules here are those the router can read.
  function scheduleKeeps(workloadId, ctx, t) {
    const schedule = ctx.schedules.get(workloadId);
    if (!schedule) return null;
    if (ctx.applied.get(workloadId)?.startsWith('nap')) return {};
    if (occurrenceAt(schedule, t)?.kind === 'awake') return { kept: 'awake window' };
    if (awakeStartWithin(schedule, t, CLOSE_START_MS)) return { kept: 'awake window within 30 minutes' };
    return null;
  }

  // --- Pauses: a paused workload is never napped -------------------------------------------------------------------------

  const expired = (p) => p.until !== undefined && p.until <= now();

  // A workload's active pause, as people read it (at most one).
  async function pausesFor(workloadId) {
    return (await store.getPauses(workloadId)).filter((p) => !expired(p)).map(({ by, at, reason, until, keepAsleep }) => ({
      by, at: iso(at), reason, until: until === undefined ? null : iso(until), keepAsleep: keepAsleep === true,
    }));
  }

  // A nap needs to know: pauses that cannot be read count as a pause.
  async function isPaused(workloadId) {
    try {
      return (await pausesFor(workloadId)).length > 0;
    } catch (err) {
      log.warn('PausesUnreadable', { workloadId, error: err.message });
      return true;
    }
  }

  // Every active pause, null when they cannot be read; the expired ones are deleted (unless a newer pause replaced them).
  async function activePauses() {
    let pauses;
    try {
      pauses = await store.listPauses();
    } catch (err) {
      log.warn('PausesUnreadable', { error: err.message });
      return null;
    }
    for (const p of pauses.filter(expired)) {
      const deleted = await store.removePauses(p.workloadId, { at: p.at }).catch((err) => {
        log.warn('PauseDeleteFailed', { workloadId: p.workloadId, error: err.message });
        return false;
      });
      if (deleted) log.info('PauseExpired', { workloadId: p.workloadId, by: p.by, reason: p.reason });
    }
    return pauses.filter((p) => !expired(p));
  }

  // The record as stored. No `until` when none is asked for: the store would make `undefined` a null, read as expired.
  function pauseRecord({ by, reason, until, keepAsleep }) {
    const text = typeof reason === 'string' ? reason.trim() : '';
    if (!text || text.length > REASON_MAX) throw new PauseRefused(`reason required (1 to ${REASON_MAX} characters)`);
    if (keepAsleep !== undefined && typeof keepAsleep !== 'boolean') throw new PauseRefused('keepAsleep must be true or false');
    let untilMs;
    if (until !== undefined && until !== null) {
      untilMs = typeof until === 'number' ? until : Date.parse(until);
      if (!(untilMs > now() && untilMs <= now() + PAUSE_MAX_MS)) throw new PauseRefused('until must be in the future, within 366 days');
    }
    return { by: by ?? 'unknown', at: now(), reason: text, ...(untilMs === undefined ? {} : { until: untilMs }), keepAsleep: keepAsleep === true };
  }

  // Unless keepAsleep, an asleep or failed workload is woken and a napping one gets a pending wake. keepAsleep holds the
  // scheduled and maintenance wakes only: a visitor still wakes it (the waker knows nothing of pauses).
  async function pause(workloadId, input) {
    const record = pauseRecord(input);
    await store.addPause(workloadId, record);
    log.info('Paused', { workloadId, ...record });
    if (record.keepAsleep) return;
    await wakeNow(workloadId, 'pause').catch((err) => log.error('PauseWakeFailed', { workloadId, error: err.message }));
  }

  async function resume(workloadId, by) {
    if (await store.removePauses(workloadId)) log.info('Resumed', { workloadId, by });
  }

  // --- The check -----------------------------------------------------------------------------------------------------

  async function failStuck(workloadId, cond, step, message, cause) {
    const at = now();
    const failed = failedSpec(failureError('timeout', message), { step, ...(cond.wakeId ? { wakeId: cond.wakeId } : {}), at });
    return (await transition(workloadId, {
      cond,
      set: { state: STATES.FAILED, failedAt: at, ...failed.set },
      increment: failed.increment,
      remove: ['stopping'],
      cause,
      event: failed.event,
    })) ?? store.getRun(workloadId);
  }

  // The run, with the state brought back to what the VMs say and the URL map to what the state says.
  async function reconcile(cfg, run, deadline) {
    const { workloadId } = cfg;
    const from = run.state;
    const vms = await allVms(cfg);
    if (from !== STATES.AWAKE && vms.some((vm) => vm.status === 'RUNNING') && (await healthyCount(cfg)) >= 1) {
      // Started by hand: the others too, and the autoscalers given back, as a wake would. One that cannot start does not
      // keep the workload from being what it is, awake.
      log.warn(from === STATES.FAILED ? 'FailedRecovered' : 'ExternalWake', { workloadId });
      // Under a swap, AWAKE comes only once unswapped and waited for, and a wait does not fit a check: a wake finishes the job, in a
      // request of its own.
      if (switchFor(cfg).kind === 'swap') {
        await startWake(workloadId, run, from === STATES.FAILED ? 'recovered' : 'external-start');
        return store.getRun(workloadId);
      }
      await each(cfg.backends, (backend) => wakeBackend(backend, deadline)).catch((err) => log.warn('BackendsNotWoken', { workloadId, error: err.message }));
      const givenBack = await gaveBackAutoscalers(workloadId, run);
      run = (await transition(workloadId, {
        cond: { state: from },
        set: { state: STATES.AWAKE, awakeSince: now() },
        remove: ['stopped', 'suspended', ...(givenBack ? ['autoscalers'] : []), 'failure', 'consecutiveFailures', 'failedAt'],
        cause: from === STATES.FAILED ? 'recovered' : 'external-start',
      })) ?? (await store.getRun(workloadId));
    } else if (from !== STATES.ASLEEP && vms.length > 0 && vms.every((vm) => DOWN.has(vm.status)) && (await healthyCount(cfg)) < 1) {
      // Stopped by hand: the switch first, with no wait, they are already down.
      log.warn(from === STATES.FAILED ? 'FailedRecovered' : 'ExternalStop', { workloadId });
      await repair(cfg, STATES.ASLEEP);
      return (await transition(workloadId, {
        cond: { state: from }, set: { state: STATES.ASLEEP }, cause: from === STATES.FAILED ? 'recovered' : 'external-stop',
      })) ?? store.getRun(workloadId);
    }
    if ([STATES.AWAKE, STATES.ASLEEP, STATES.FAILED].includes(run?.state)) await repair(cfg, run.state);
    if (from === STATES.AWAKE && run.autoscalers?.length && (await gaveBackAutoscalers(workloadId, run))) {
      run = (await transition(workloadId, { cond: { state: STATES.AWAKE }, remove: ['autoscalers'] })) ?? run;
    }
    return run;
  }

  // --- IP lists ------------------------------------------------------------------------------------------------------------

  // The router's lists (DMT_IP_LISTS). A download is a task of its own, never held by a check: it fetches, and a list that
  // fails is that list's error, stored and logged.
  const refresher = lists.length ? createListRefresher({ store, lists, download, now, log }) : null;

  // Only the lists still due: a duplicate task (the check asks again while an earlier one is queued) downloads nothing.
  async function refreshLists(names) {
    if (!refresher) return { results: [] };
    const due = await refresher.due();
    return { results: await refresher.refresh(names.filter((name) => due.includes(name))) };
  }

  async function requestListRefresh() {
    if (!refresher) return;
    try {
      const names = await refresher.due();
      if (!names.length) return;
      await enqueue({ action: 'refreshLists', names });
      log.info('ListRefreshRequested', { names });
    } catch (err) {
      log.error('ListRefreshCheckFailed', { error: err.message });
    }
  }

  async function checkOne(cfg, deadline, paused, ctx) {
    const { workloadId } = cfg;
    let run = await store.getRun(workloadId);
    if (!run) return { state: 'UNKNOWN' };
    if (run.state === STATES.NAPPING) {
      const before = now() - NAPPING_STUCK_MS;
      if ((run.updatedAt ?? 0) >= before) return { state: run.state };
      log.warn('NapStuck', { workloadId });
      const message = `the nap did not finish within ${NAPPING_STUCK_MS / 60_000} minutes (its request stopped)`;
      return { state: (await failStuck(workloadId, { state: STATES.NAPPING, olderThan: { field: 'updatedAt', ms: before } }, 'nap', message, 'nap-stuck'))?.state };
    }
    if (run.state === STATES.WAKING) {
      // A swap's wait is not cut short at the wake's timeout: a wake in it is no stuck one.
      const sw = switchFor(cfg);
      const grace = WAKING_STUCK_GRACE_MS + (sw.kind === 'swap' ? sw.waitMs : 0);
      if ((run.wakeStartedAt ?? 0) >= now() - cfg.wakeTimeoutSeconds * 1000 - grace) return { state: run.state };
      log.warn('WakeStuck', { workloadId, wakeId: run.wakeId });
      const message = `the wake did not finish within ${cfg.wakeTimeoutSeconds} s (its request stopped)`;
      return { state: (await failStuck(workloadId, { state: STATES.WAKING, wakeId: run.wakeId }, 'wake', message, 'wake-stuck'))?.state };
    }
    // The nap this check just asked for may have started since the run was read: a repair on that read would remove its policy.
    if (ctx.applied.get(workloadId) === 'nap') return { state: run.state };
    run = await reconcile(cfg, run, deadline);
    const t = now();
    const idleMs = cfg.idleMinutes * 60_000;
    // Still paying for backends that run without a healthy instance: released once its idle window has passed; a paused one
    // is left for its team.
    if (run?.state === STATES.FAILED && !paused && (run.failedAt ?? 0) <= t - idleMs) {
      await enqueue({ action: 'release', workloadId });
      log.info('ReleaseRequested', { workloadId });
      return { state: run.state, release: 'requested' };
    }
    if (run?.state !== STATES.AWAKE) return { state: run?.state ?? 'UNKNOWN' };
    if (paused) return { state: run.state, paused: true };
    const kept = scheduleKeeps(workloadId, ctx, t);
    if (kept) return { state: run.state, ...kept };
    const from = t - idleMs - METRIC_DELAY_MS;
    if ((run.awakeSince ?? 0) > from) return { state: run.state };
    if ((await monitoring.requestCount({ backendService: cfg.backendService, ...(cfg.lb ? { lb: cfg.lb } : {}), from, to: t })) > 0) return { state: run.state };
    await enqueue({ action: 'nap', workloadId });
    log.info('NapRequested', { workloadId });
    return { state: run.state, nap: 'requested' };
  }

  // 8 workloads at a time, none started past the budget; one that fails is logged and stops only itself. The schedules
  // first, whatever the budget. Pauses that cannot be read hold every nap and scheduled wake of this check; the reconcile
  // still runs.
  async function check() {
    const deadline = now() + CHECK_BUDGET_MS;
    const pauses = await activePauses();
    const paused = (workloadId) => pauses === null || pauses.some((p) => p.workloadId === workloadId);
    const keptAsleep = (workloadId) => pauses === null || pauses.some((p) => p.keepAsleep && p.workloadId === workloadId);
    const { configs, schedules } = await store.listWorkloads();
    const order = [...configs].sort((a, b) => a.workloadId.localeCompare(b.workloadId));
    const { applied, readable } = await applySchedules(order, schedules, (id) => ({ paused: paused(id), keepAsleep: keptAsleep(id) }), now(), deadline);
    await requestListRefresh();
    const ctx = { schedules: readable, applied };
    const passed = (workloadId) => (applied.has(workloadId) ? { schedule: applied.get(workloadId) } : {});
    const results = [];
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(CHECK_CONCURRENCY, order.length) }, async () => {
      while (next < order.length && now() < deadline) {
        const cfg = order[next++];
        try {
          results.push({ workloadId: cfg.workloadId, ...(await checkOne(cfg, deadline, paused(cfg.workloadId), ctx)), ...passed(cfg.workloadId) });
        } catch (err) {
          log.error('CheckFailed', { workloadId: cfg.workloadId, error: err.message });
          results.push({ workloadId: cfg.workloadId, error: err.message });
        }
      }
    }));
    if (next < order.length) log.warn('CheckBudgetReached', { checked: next, workloads: order.length, next: order[next].workloadId });
    // What the schedules did for the workloads the loop did not reach.
    const reached = new Set(results.map((r) => r.workloadId));
    for (const workloadId of applied.keys()) if (!reached.has(workloadId)) results.push({ workloadId, ...passed(workloadId) });
    return results;
  }

  return { refreshLists, wake, beginWake, wakeNow, nap, napNow, release, check, pause, resume, pausesFor };
}
