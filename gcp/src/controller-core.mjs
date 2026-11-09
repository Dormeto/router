// The controller on Google Cloud (vision docs/specs/2026-10-29-google-cloud-design.md, section 6): the wake, the nap and
// the check, with AWS's states, causes and event names (lambda/src/lib/controller-core.mjs). Each action runs within one
// request of at most 1800 s; the check only enqueues the naps it decides (POST /v1/tasks), never waiting in its 240 s.
//
// The map goes through the workload's switch (switch.mjs): the policy of a global load balancer, the swap of a regional, classic or
// internal one. The order differs: the policy lets visitors reach the application as soon as it is healthy, so AWAKE comes first and its
// removal follows. Under a swap they are at the waker until the application's back has spread, so a wake and a nap given up unswap
// and wait, then AWAKE.
//
// A workload's configuration: `{ workloadId, urlMap, backendService, wakerBackendService (names), backends: [{ kind: 'vm'
// | 'mig', location, name } | { kind: 'cloudsql', name } | { kind: 'k8s', cluster, namespace, service, owner }], idleMinutes, wakeTimeoutSeconds, hibernate?, lb? }`. `lb`: `{ kind: 'regional',
// region }`, `{ kind: 'internal', region }`, `{ kind: 'classic' }` or `{ kind: 'cross-region-internal' }`, absent for a global load balancer.
// `config`: `{ project, region, controllerUrl }`.
//
// The check, the wake, the nap and the release act on the settings resolved through the levels (levels.mjs; vision
// docs/specs/2026-11-08-google-cloud-router-features-design.md, section 4.5), as AWS's `effective()`: the idle window and the wake's
// timeout from the workload, its type, the router level (`router/settings`) and the built-in values, with what Google Cloud fixes;
// whether a nap suspends from the workload, its `fallbackInstanceTypes`, then the router level. The stored configuration stays what
// the writes read. `failedRetrySeconds` is the waker's backoff (failures.mjs), not read here. A router level this instance never
// read is unreadable, as on AWS: no idle nap or release decision, the longest wake timeout, and a plain stop.
//
// A `cloudsql` backend is a companion (cloudsql.mjs): the VMs and groups, the primaries, alone decide the state and serve; it goes
// after them and comes back before them, as on AWS. One deleted without an offboarding is the customer's own state: a nap does not go
// for it, as a NEG gone, and a wake or a check goes on without it, said in `CompanionGone` and on the run's `companionsGone`, until an
// offboarding, as whether the application runs without it is its health check's to say.
//
// A `k8s` backend is a primary (gke.mjs, section 8 of the coverage design): a GKE owner behind standalone NEGs, its one primary, as a mix with VMs is refused. Read as a VM
// where the state is decided, its replicas stand for the VM's status. Scaled to 0, its NEG holds no endpoint and none is healthy: the switch, the idle check and the wake's
// health are the VMs'. `hibernate` means nothing to it.
//
// Capacity (vision docs/specs/2026-11-08-google-cloud-router-features-design.md, section 6), as AWS's (lambda/src/lib/capacity.mjs): every start
// and resume of a wake refused for capacity is tried again within its deadline, and a VM's start may fall back to the next machine type
// of the workload's `fallbackInstanceTypes`, given back after the next stop. The run's `instanceTypes` (`{ <vm>: { from, to } }`, AWS's
// field) is the VMs on a type not their own, `from` their own: written before each change, it is the only record, as a label would need
// one more permission.
//
// What the run adds to AWS's: `stopped`, `suspended` (the VMs a nap acted on, names), `autoscalers` (`[{ kind, location,
// name (the autoscaler's), mode }]`, what the wake gives back), `owners` (k8sRecord's: what a nap read of its k8s backends, replicas and KEDA, for
// the wake), `lastWake` (`{ durationMs }`), `recentWakes` (AWS's: the last 10 wakes' durations, for the waiting page's progress bar), `scheduleApplied` (the last nap or awake window's occurrence applied), `napAborted`
// (`{ reason, at }`: the last nap given up, its cause, until a nap commits), and the heartbeat's (heartbeat.mjs): `napId` (the
// running nap's, as `wakeId` is the wake's), `beatAt`, `resentAt` and `resends`. The cause and the event of a state change are
// logged (`StateChanged`): the state history in the manager comes with G2.
//
// Schedules and pauses as on AWS (vision docs/specs/2026-10-30-google-cloud-coverage-design.md, section 5). Here a pause is
// a workload's: the router's and the exclusions wait for G2.
//
// The waiting page (vision docs/specs/2026-11-08-google-cloud-router-features-design.md, section 5.2): a nap reads the application's
// favicon before its NAPPING, while the route still reaches the application, as AWS's (favicon.mjs's step), from the host the URL map
// sends `/` to it; with custom pages off (pages.mjs), a custom page is none there too.
//
// The idle check's activity (vision docs/specs/2026-11-07-google-cloud-fixes-design.md, section 5, amended by M2): on a backend
// service that logs every request, the requests the waker would not ignore decide alone, read in the router's log view (`logs`,
// absent without DMT_LOG_VIEW); otherwise, and when they cannot be read or are empty, Monitoring's request count. The run says what
// the last check that read log entries, or counted any request, read (`idleReads`).
import { randomUUID } from 'node:crypto';
import { retryCapacity } from '../../lambda/src/lib/capacity.mjs';
import { classify, failedSpec, failureError } from '../../lambda/src/lib/failures.mjs';
import { cacheFavicon, FAVICON_BUDGET_MS, hostOfRules } from '../../lambda/src/lib/favicon.mjs';
import { resolveHibernation } from '../../lambda/src/lib/hibernation.mjs';
import { createListCache } from '../../lambda/src/lib/list-cache.mjs';
import { awakeStartWithin, CLOSE_START_MS, maintenanceDue, occurrenceAt } from '../../lambda/src/lib/schedule.mjs';
import { DAY_MS, STATES, utcDay } from '../../lambda/src/lib/state.mjs';
import { createListRefresher } from '../../lambda/src/lib/list-refresh.mjs';
import { withWake } from '../../lambda/src/lib/page-settings.mjs';
import { createWakeWatch } from '../../lambda/src/lib/wake-watch.mjs';
import { activityOf, createNoWakeRules } from './activity.mjs';
import { COMPANION_GONE, companionGone, companionLost, isCompanion, startDatabase, statusOf, stopDatabase } from './cloudsql.mjs';
import {
  giveBackOwner, isPods, ownerAsVm, ownerChanged, ownerRecord, ownerText, podsUnhealthy, recordOf, sleepOwner, wakeOwner, watchRecord,
} from './gke.mjs';
import { OPERATION_NOT_DONE } from './google.mjs';
import { resendStale, startHeartbeat, staleness } from './heartbeat.mjs';
import { effectiveOf, SWAP_WAKE_ROOM_SECONDS, WAKE_TIMEOUT_MAX } from './levels.mjs';
import { faviconReachable, servedPage } from './pages.mjs';
import { inOneUpdate, isRegionalLb, switchOf } from './switch.mjs';
import { listenerRulesOf, mapBusy, references, UrlMapRefused } from './urlmaps.mjs';

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
// Cloud Monitoring publishes the first point 72 to 125 s after the requests (spec section 12), and Google documents the global
// metric as not visible for up to 210 seconds: the newest requests cannot be seen, so the idle read goes this much further back,
// and the run must have been awake for all of it. An idle nap reads again from its request less this, up to its commit.
const METRIC_DELAY_MS = 210_000;
// The most requests the idle check reads in the logs: past it, the count decides (a busy workload is no idle one anyway).
const LOGS_READ_MAX = 1000;
// Monitoring's request_count is a DELTA metric of 60 s points, and a point whose end is in the window counts the requests of the
// minute before it: the count can hold requests up to a minute before the window's start. The logs are read from that much earlier,
// to the window's end, the window the count would read; the extra minute can only add requests, which errs toward staying awake.
const METRIC_POINT_MS = 60_000;
// What the idle check reads (`idleReads`, on the run and in the API's Workload).
const READS = { logs: 'request logs', count: 'request count' };
// Logs empty while Monitoring counts requests are said (`LogsEmpty`) at most this often per workload, by this process: a log lost
// upstream stays so for every check.
const LOGS_EMPTY_EVERY_MS = 60 * 60_000;
const WAKING_STUCK_GRACE_MS = 60_000;
const NAPPING_STUCK_MS = 35 * 60_000;
// Under a swap, while no VM has been asked to go: visitors are at the waker, so a nap whose request died is a full outage until a
// check finds it. A request that died stops beating, and is found within minutes (heartbeat.mjs): this is the last resort, for a
// nap from before the heartbeat, and the one that fails even a nap still beating, so a legal nap must fit it. Its size, a legal
// nap's way to its commit with one lost swap and each write at its worst: first the update of its map under way in this process,
// which it waits for (urlmaps.mjs, F8), then its own, each the operation's 120 s and the pauses of a map busy with another (60 s on
// a global map, 120 s on a regional one), so 180 s on classic and 240 s on regional. Classic 2 x 250 s + 2 x (180 s + 180 s) =
// 1220 s, regional 2 x 100 s + 2 x (240 s + 240 s) = 1160 s, and the seconds of its reads; internal as regional, cross-region internal
// (a global map, regional's wait until M3) 920 s. 22 minutes holds them all, classic by 100 s,
// and stays under the nap's request (NAP_BUDGET_MS, 29.5 minutes) and the 35 minutes of a nap stopping; the usual nap takes about
// 5 minutes. Not held: a write behind a shared update that Google refused and that is tried again change by change (a 400 or a
// 404, rare). Past it, what is called stuck is a nap that lost its swap twice or was given up after one loss (up to 610 s more on
// classic): nothing is stopped, the commit and the abort are conditional on NAPPING, and the check's wake finishes the job.
const NAPPING_SWAP_STUCK_MS = 22 * 60_000;
const CHECK_BUDGET_MS = 240_000;
const CHECK_CONCURRENCY = 8;
const SUSPEND_MAX_MEMORY_MB = 208 * 1024;
// A nap holds a request of the controller for minutes: a nap window on many workloads is spread over the checks.
const SCHEDULED_NAPS_MAX = 10;
// At most this many naps in flight per router (F8), so that the wakes find room among the controller's 10 instances of 10 requests:
// the NAPPING runs as the check starts, then each nap it asks, the scheduled ones first. The others nap at a later check.
const NAPS_MAX = 20;
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
// What a check does of a companion, by the state: one not as the state wants it, and what it asks.
const COMPANION_DRIFT = {
  [STATES.ASLEEP]: { status: 'running', policy: 'NEVER', event: 'DatabaseRestopped' },
  [STATES.AWAKE]: { status: 'stopped', policy: 'ALWAYS', event: 'DatabaseRestarted' },
};
// What the shared classification cannot read in a Google error.
const KIND_OF_CODE = { 403: 'permission', 429: 'throttled' };
// A machine type's change refused for the permission: a router installed before it was in its role.
const SET_TYPE_REFUSED = 'the router\'s role lacks compute.instances.setMachineType: run dormeto gcp install again';
// Google refused the change itself, its operation's error included: nothing changed.
const nothingChanged = (err) => err?.code >= 400 && err.code < 500;
// A machine type's change refused, in the words that say what to do.
const typeRefusal = (err) => (err?.code === 403 ? failureError('permission', SET_TYPE_REFUSED) : err);

const iso = (ms) => new Date(ms).toISOString();
// The heartbeat's timer: Node's, which holds no process open. The answer stops it.
const repeat = (ms, fn) => {
  const timer = setInterval(fn, ms);
  timer.unref?.();
  return () => clearInterval(timer);
};
const nameOf = (url) => url.slice(url.lastIndexOf('/') + 1);
const zoneOf = (url) => /\/zones\/([^/]+)\//.exec(url)?.[1];
const names = (vms) => vms.map((vm) => vm.name);
const primariesOf = (cfg) => cfg.backends.filter((b) => !isCompanion(b));
const companionsOf = (cfg) => cfg.backends.filter(isCompanion);
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

// `every(ms, fn)`: the heartbeat's timer, which its answer stops; tests run it on their clock.
// A day's counters are kept this long, as the DynamoDB store's (lambda/src/lib/state.mjs).
const STATS_KEPT_DAYS = 35;

// Every request is logged: Google's `sampleRate` is 1.0 when logging is on and none is set.
const logsEveryRequest = (logConfig) => logConfig?.enable === true && (logConfig.sampleRate ?? 1) === 1;

export function createController({
  store, compute, cloudsql, gke, urlmaps, regionalUrlmaps, monitoring, logs, tasks, config, lists = [], download, now = Date.now, sleep, every = repeat, newId = randomUUID, log,
  // The favicon read at a nap (favicon.mjs): the network and its time budget, injected for the tests. customPages: the install's switch.
  fetch = globalThis.fetch, faviconBudgetMs = FAVICON_BUDGET_MS, customPages = false,
}) {
  const clients = { compute, kubernetesOf: (cluster) => gke.kubernetesOf(cluster) };
  const enqueue = (body) => tasks.enqueue({ url: `${config.controllerUrl}/v1/tasks`, body });

  // `action()` with the heartbeat of the run's `field` `id` around it, stopped whatever ends it.
  async function beating(workloadId, field, id, action) {
    const stop = await startHeartbeat({ store, every, log }, workloadId, field, id);
    try {
      return await action();
    } finally {
      stop();
    }
  }

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

  // The router level (`router/settings`): `{ router, unreadable? }`, read once by a check for all its workloads, once by a wake, a
  // nap or a release. A read that fails is said, and keeps the last record this instance read; never read, the level is unreadable
  // (AWS's `readLevels`): the built-in values could act against the router's, an idle window shorter than its own, a suspend
  // against its "off", a wake failed before its timeout. Never a failed check or wake.
  let lastRouterLevel;
  async function routerLevel() {
    try {
      lastRouterLevel = (await store.getRouterSettings?.()) ?? null;
    } catch (err) {
      log.warn('SettingsLevelUnreadable', { level: 'router', error: err.message });
      if (lastRouterLevel === undefined) return { router: null, unreadable: true };
    }
    return { router: lastRouterLevel };
  }

  // The configuration a check, a wake, a nap or a release acts on: the stored one resolved through the levels (levels.mjs), marked
  // when its router level is unreadable.
  const effective = (stored, run, { router, unreadable }) => {
    const cfg = effectiveOf(stored, { run, router });
    return unreadable ? { ...cfg, levelsUnreadable: true } : cfg;
  };
  // The longest a wake may take when its levels are unreadable: the longest Google Cloud allows.
  const wakeTimeoutS = (cfg) => (cfg.levelsUnreadable ? WAKE_TIMEOUT_MAX : cfg.wakeTimeoutSeconds);

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

  // A backend's VMs: `{ name, zone, status, type?, url?, error? }`, a VM's with its machine type's name, a managed group's with its URL and
  // its last failure.
  async function vmsOf(backend) {
    if (isPods(backend)) return [await ownerAsVm(clients, backend)];
    if (backend.kind !== 'mig') {
      const { status, machineType } = await compute.getInstance(backend.location, backend.name);
      return [{ name: backend.name, zone: backend.location, status, ...(machineType ? { type: nameOf(machineType) } : {}) }];
    }
    return (await compute.listManagedInstances(groupOf(backend))).map((m) => ({
      name: nameOf(m.instance),
      zone: zoneOf(m.instance),
      url: m.instance,
      status: STATUS_OF_ACTION[m.currentAction] ?? m.instanceStatus,
      error: (m.lastAttempt?.errors?.errors ?? []).map((e) => `${e.code}: ${e.message}`).join('; '),
    }));
  }
  const allVms = async (cfg) => (await each(primariesOf(cfg), vmsOf)).flat();

  async function act(backend, action, vms) {
    if (!vms.length) return;
    const asked = backend.kind === 'mig'
      ? compute[`${action}Instances`](groupOf(backend), vms.map((vm) => vm.url))
      : compute[`${action}Instance`](backend.location, backend.name);
    await asked.catch(stillUnderWay);
  }

  const setAutoscaler = ({ kind, location, name }, mode) => compute.setAutoscalerMode({ kind, location, name }, mode).catch(stillUnderWay);

  // In the service's scope: a regional or internal load balancer's in its region, the others' global.
  const readService = ({ backendService, lb }) => (isRegionalLb(lb) ? compute.getRegionBackendService(lb.region, backendService) : compute.getBackendService(backendService));

  // The router's lists as the waker holds them (waker.mjs), for the requests the idle check reads in the logs, and the no-wake rules of
  // every level as it compiles them (activity.mjs).
  const listCache = lists.length ? createListCache({ store, lists, now, log }) : null;
  const noWakeRules = createNoWakeRules(log);
  // When each workload's empty logs were last said (LOGS_EMPTY_EVERY_MS).
  const logsEmptySaid = new Map();

  // The requests of the backend service's logs over [from, to] (ms), read from a metric point before `from`, when it logs every
  // one: null without a log view, with logging off or sampled, and with a logConfig or logs that cannot be read (logs.mjs: past the
  // limit, unreadable).
  async function loggedRequests(cfg, from, to) {
    const { workloadId, backendService } = cfg;
    if (!logs) return null;
    let service;
    try {
      service = await readService(cfg);
    } catch (err) {
      log.warn('LogsUnread', { workloadId, backendService, reason: `its logConfig could not be read: ${err.message}` });
      return null;
    }
    if (!logsEveryRequest(service.logConfig)) return null;
    return logs.requests({ backendService, ...(cfg.lb ? { lb: cfg.lb } : {}), from: from - METRIC_POINT_MS, to, limit: LOGS_READ_MAX });
  }

  // The workload's activity over [from, to] (ms), what the idle check and an idle nap's last read go by: `{ activity, reads }`. On
  // a backend service that logs every request, any entry of its logs makes them decide alone, whatever Monitoring counts (M2: the
  // count is sampled and batched): the requests the waker would not ignore (activity.mjs), the no-wake rules of every level of the
  // resolved `cfg` included. Otherwise the service's request count decides, through its load balancer's metric, as before the logs:
  // without logs, when they cannot be read, and when they are empty, so that a log lost upstream (a _Default sink's exclusion, the first
  // minutes of regional logging) naps no busy workload, said in `LogsEmpty`. A log lost only in part is not caught: an exclusion that
  // keeps a sample, one added during the window, or a long ingestion delay leaves entries, and they decide. `reads`: null when that
  // count is none, idle whichever is read.
  async function activityBetween(cfg, from, to) {
    const { workloadId, backendService } = cfg;
    const requests = await loggedRequests(cfg, from, to);
    if (requests?.length) return { activity: activityOf(requests, { lists: listCache ? await listCache.get() : [], rules: noWakeRules(cfg) }), reads: READS.logs };
    const count = await monitoring.requestCount({ backendService, ...(cfg.lb ? { lb: cfg.lb } : {}), from, to });
    const said = logsEmptySaid.get(workloadId);
    if (requests && count > 0 && (said === undefined || now() - said >= LOGS_EMPTY_EVERY_MS)) {
      logsEmptySaid.set(workloadId, now());
      log.warn('LogsEmpty', { workloadId, backendService, count });
    }
    return { activity: count, reads: count < 1 ? null : READS.count };
  }

  // What the idle check read, on the run when it changes: a write that fails is said, and the check goes on.
  async function recordReads(workloadId, run, reads) {
    if (!reads || run.idleReads === reads) return;
    try {
      await store.setIdleReads(workloadId, reads);
    } catch (err) {
      log.warn('IdleReadsNotRecorded', { workloadId, error: err.message });
    }
  }

  // In the service's scope. A service a classic load balancer holds reads no status while its VM is down (M3): none healthy. M9: a NEG at 0 replicas, whichever it answers,
  // none healthy either.
  async function healthyCount({ backendService, lb }) {
    const regional = isRegionalLb(lb);
    const { backends = [] } = await readService({ backendService, lb });
    const answers = await each(backends, ({ group }) => (regional
      ? compute.getRegionBackendServiceHealth(lb.region, backendService, group)
      : compute.getBackendServiceHealth(backendService, group)));
    return answers.flatMap((a) => a.healthStatus ?? []).filter((h) => h.healthState === 'HEALTHY').length;
  }

  // --- Machine types (vision docs/specs/2026-11-08-google-cloud-router-features-design.md, section 6) ----------------------------------

  // What a wake does of its VMs' machine types: `recorded`, the run's `instanceTypes` as this wake changes it, written on the run before each
  // change (`record`), so that a request that dies leaves the next stop what to give back; `fallbacks`, this wake's (`fellBack`), for its
  // AWAKE event. `retryUntil`: when its retries end.
  function wakeTypes(cfg, run, wakeId, retryUntil) {
    const { workloadId } = cfg;
    const recorded = { ...(run.instanceTypes ?? {}) };
    const fallbacks = {};
    // One write at a time, each of the record as it is then: VMs fall back at once, and the last write holds them all.
    let writes = Promise.resolve();
    const record = (name, change) => {
      if (change) recorded[name] = change;
      else delete recorded[name];
      writes = writes.catch(() => {}).then(async () => {
        const map = { ...recorded };
        const written = await transition(workloadId, { cond: { state: STATES.WAKING, wakeId }, ...(Object.keys(map).length ? { set: { instanceTypes: map } } : { remove: ['instanceTypes'] }) });
        if (!written) throw new Error(`${name}: its machine type was not recorded: the wake is no longer the current one`);
      });
      return writes;
    };
    const fellBack = (name, change) => {
      fallbacks[name] = change;
      log.warn('InstanceTypeFallback', { workloadId, wakeId, instance: name, ...change });
    };
    const list = Array.isArray(cfg.fallbackInstanceTypes) ? cfg.fallbackInstanceTypes : [];
    return { workloadId, list, recorded, fallbacks, record, fellBack, timing: { now, sleep, deadline: retryUntil } };
  }

  // A stopped VM's start, in AWS's order (capacity.mjs's startWithCapacity): its own type first, given back first when a stop could not;
  // on a capacity error the next type of [its own, ...the list], set on it and started again at once; past the list, its last type
  // under the retries' waits, its own tried again only at the next wake. Its own type: the run's record, else the type it has.
  async function startVm(backend, vm, types) {
    const { location: zone, name } = backend;
    const start = () => act(backend, 'start', [vm]);
    let { type } = vm;
    const own = types.recorded[name]?.from ?? type;
    if (type !== own) {
      try {
        await compute.setMachineType(zone, name, own).catch((err) => { throw typeRefusal(err); });
        type = own;
      } catch (err) {
        log.warn('InstanceTypeNotReverted', { workloadId: types.workloadId, instance: name, error: err.message });
      }
    }
    if (type === own && types.recorded[name]) await types.record(name, null);
    if (!types.list.length || !own) return retryCapacity(start, types.timing);
    const order = [...new Set([own, ...types.list])];
    return retryCapacity(async () => {
      for (;;) {
        try {
          return await start();
        } catch (err) {
          const next = classify(err).kind === 'capacity' && order[order.indexOf(type) + 1];
          if (!next) throw err;
          const before = types.recorded[name];
          const change = { from: own, to: next };
          await types.record(name, change);
          try {
            await compute.setMachineType(zone, name, next);
          } catch (refusal) {
            // Google refused it: the record goes back to what is. That write lost, the record names a type the VM is not on, and the
            // next stop, which reads the VM's own, changes nothing.
            if (nothingChanged(refusal)) await types.record(name, before).catch(() => {});
            throw typeRefusal(refusal);
          }
          type = next;
          types.fellBack(name, change);
        }
      }
    }, types.timing);
  }

  // After a stop (AWS's revertInstanceTypes): each VM the run says is on a fallback type gets its own back, once stopped. One that cannot
  // (`InstanceTypeNotReverted`), or not stopped, stays on the run, for the next try. The run's change: none when it records none.
  async function revertTypes(cfg, recorded) {
    if (!recorded || !Object.keys(recorded).length) return { set: {}, remove: [] };
    const kept = {};
    await each(Object.entries(recorded), async ([name, change]) => {
      try {
        const backend = cfg.backends.find((b) => b.kind === 'vm' && b.name === name);
        if (!backend) throw new Error(`${name} is no VM of the workload`);
        const vm = await compute.getInstance(backend.location, name);
        if (!STOPPED.has(vm.status)) {
          kept[name] = change;
          return;
        }
        if (nameOf(vm.machineType) !== change.from) await compute.setMachineType(backend.location, name, change.from).catch((err) => { throw typeRefusal(err); });
      } catch (err) {
        log.warn('InstanceTypeNotReverted', { workloadId: cfg.workloadId, instance: name, error: err.message });
        kept[name] = change;
      }
    });
    return Object.keys(kept).length ? { set: { instanceTypes: kept }, remove: [] } : { set: {}, remove: ['instanceTypes'] };
  }

  // --- The wake's backends -------------------------------------------------------------------------------------------

  // A VM still going down is waited for (a wake right after a stop); the others are read live, not from the nap's record:
  // after 60 days Compute Engine turns a suspended VM into a stopped one. An owner is read live too. A wake's machine types (`types`,
  // wakeTypes): its starts and resumes refused for capacity tried again, a VM's start on a fallback type; without, a check's: one try.
  // A suspended VM resumes on its type: Google changes none while suspended.
  async function wakeBackend(backend, deadline, run, types) {
    if (isPods(backend)) {
      await wakeOwner(clients, backend, recordOf(run.owners, backend));
      return;
    }
    const retried = (action) => (types ? retryCapacity(action, types.timing) : action());
    for (;;) {
      const vms = await vmsOf(backend);
      if (!vms.some((vm) => GOING.has(vm.status))) {
        const stopped = vms.filter((vm) => STOPPED.has(vm.status));
        if (types && backend.kind === 'vm' && stopped.length) await startVm(backend, stopped[0], types);
        else await retried(() => act(backend, 'start', stopped));
        await retried(() => act(backend, 'resume', vms.filter((vm) => vm.status === 'SUSPENDED')));
        return;
      }
      if (now() >= deadline) throw failureError('timeout', `${backend.name}: still going down when the wake timed out`);
      await sleep(POLL_MS);
    }
  }

  // KEDA is an owner's autoscaler: its pause goes back with the modes, under their rules.
  const giveBackAutoscalers = async (run) => {
    await each(run.autoscalers ?? [], (recorded) => setAutoscaler(recorded, recorded.mode));
    await each(run.owners ?? [], (record) => giveBackOwner(clients, record));
  };

  // The autoscalers get their modes back whatever a VM's start says.
  async function wakeBackends(cfg, run, deadline, types) {
    try {
      await each(primariesOf(cfg), (backend) => wakeBackend(backend, deadline, run, types));
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

  // At the wake's deadline: what a managed group failed on (it keeps trying on its own), else why none is healthy. An owner's pods: with the events the watch read.
  async function noHealthyError(cfg, watch) {
    const owner = primariesOf(cfg).find(isPods);
    if (owner) return podsUnhealthy(owner, watch);
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

  // `onFallback`: the VMs on a fallback type, stopped, never suspended, so that they get their own type back (AWS's rule).
  async function sleepBackend(backend, hibernate, deadline, owners, onFallback) {
    if (isPods(backend)) {
      await sleepOwner(clients, backend, recordOf(owners, backend), { now, sleep, deadline });
      return { stopped: [ownerText(backend)], suspended: [] };
    }
    // Only what runs: Google refuses a request naming a VM being created or started, and the whole nap with it.
    const vms = (await vmsOf(backend)).filter((vm) => vm.status === 'RUNNING');
    const fits = hibernate ? await Promise.all(vms.map(async (vm) => !onFallback.includes(vm.name) && canSuspend(vm))) : vms.map(() => false);
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

  // What a nap writes on the run of its k8s backends, read now.
  const ownersToRecord = (cfg, run) => each(cfg.backends.filter(isPods), (backend) => ownerRecord(clients, backend, recordOf(run.owners, backend)));

  // Down when this returns, the companions asked to go: an operation's end says little (a managed group's VMs go after it, and its
  // wait may run out before), so the VMs are read until they are. `stillGoing()`: whether the run is still the nap's or the release's:
  // a wake taken over, or asked and kept, needs its database, which is then left alone.
  async function putToSleep(cfg, { autoscalers, owners, router, instanceTypes }, latest, stillGoing) {
    const deadline = Math.min(now() + STOP_TIMEOUT_MS, latest);
    await each(autoscalers, (recorded) => setAutoscaler(recorded, 'OFF'));
    // The workload's own, else none with fallback machine types (the type a VM wakes on may not suspend), else the router's. Its
    // level unreadable, a plain stop, as on AWS: the built-in true could suspend against the router's "off".
    const hibernate = !cfg.levelsUnreadable && resolveHibernation({ workload: cfg.hibernate, fallbackTypes: cfg.fallbackInstanceTypes, router: router?.hibernate }).hibernate;
    const done = await each(primariesOf(cfg), (backend) => sleepBackend(backend, hibernate, deadline, owners, Object.keys(instanceTypes ?? {})));
    for (;;) {
      const up = (await allVms(cfg)).filter((vm) => !GONE.has(vm.status));
      if (!up.length) break;
      if (now() >= deadline) throw failureError('timeout', `not down in time: ${names(up).join(', ')}`);
      await sleep(POLL_MS);
    }
    // After the application, with no wait: a stop takes minutes, and nothing depends on it. One deleted since the nap's last read
    // holds nothing to stop, and its wake goes on without it.
    await each(companionsOf(cfg), async ({ name }) => {
      if ((await stopDatabase(cloudsql, name, latest, stillGoing)) === COMPANION_GONE) log.warn('CompanionGone', { workloadId: cfg.workloadId, instance: name });
    });
    return { stopped: done.flatMap((d) => d.stopped), suspended: done.flatMap((d) => d.suspended) };
  }

  // The companions found gone, said each time and kept on the run while they are, for whoever reads the workload. `cond`: the run as read.
  async function saidGone(workloadId, run, cond, gone) {
    for (const instance of gone) log.warn('CompanionGone', { workloadId, instance });
    const recorded = run.companionsGone ?? [];
    if (gone.length === recorded.length && gone.every((name) => recorded.includes(name))) return;
    await transition(workloadId, gone.length ? { cond, set: { companionsGone: gone } } : { cond, remove: ['companionsGone'] });
  }

  // --- The wake ------------------------------------------------------------------------------------------------------

  // A wake's request, beating from its start to its end: a duplicate's beats hold the run only while it is still WAKING with that
  // wakeId, as its transitions do.
  const wake = (workloadId, wakeId) => beating(workloadId, 'wakeId', wakeId, () => wakeBeating(workloadId, wakeId));

  async function wakeBeating(workloadId, wakeId) {
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
      const [stored, levels] = await Promise.all([getConfig(workloadId), routerLevel()]);
      cfg = effective(stored, run, levels);
      sw = switchFor(cfg);
    } catch (err) {
      return fail(err);
    }
    const since = run.wakeStartedAt ?? started;
    const deadline = Math.min(since + wakeTimeoutS(cfg) * 1000, started + WAKE_BUDGET_MS);
    const isCurrent = async () => {
      const current = await store.getRun(workloadId);
      return current?.state === STATES.WAKING && current.wakeId === wakeId;
    };
    let types;
    let saidUnread = false;
    const unread = (err) => {
      if (saidUnread) return;
      saidUnread = true;
      log.warn('DatabaseOperationsUnread', { workloadId, wakeId, error: err.message });
    };
    try {
      // The application needs them, whatever becomes of its VMs. Their minutes may have made this wake another's. One gone is no
      // reason to keep visitors out: the application starts, and its health check says what it can do without it.
      if (companionsOf(cfg).length) {
        const gone = await each(companionsOf(cfg), async ({ name }) => ((await startDatabase(cloudsql, name, { now, sleep, deadline, unread })) === COMPANION_GONE ? name : null));
        await saidGone(workloadId, run, { state: STATES.WAKING, wakeId }, gone.filter(Boolean));
        if (!(await isCurrent())) return superseded();
      }
      let givenBack = true;
      // Under a swap the retries end in time for the map's change: the swap's wait, and the room the wake's floor gives it (levels.mjs) for
      // the last start's own time and the map's write. A wait past that is not taken: the VM is given up, as once its retries are done.
      types = wakeTypes(cfg, run, wakeId, deadline - (sw.kind === 'swap' ? sw.waitMs + SWAP_WAKE_ROOM_SECONDS * 1000 : 0));
      try {
        await wakeBackends(cfg, run, deadline, types);
      } catch (err) {
        // Under a swap a wake is the only way out of FAILED, and visitors stay at the waker until it ends: a backend that cannot
        // start does not keep them from another that serves. The modes as on an external wake: a record stays until given back.
        if (sw.kind !== 'swap' || (await healthyCount(cfg).catch(() => 0)) < 1) throw err;
        log.warn('BackendsNotWoken', { workloadId, error: err.message });
        givenBack = await gaveBackAutoscalers(workloadId, run);
      }
      // A pod that will not run ends the wake when its events say so; one the scheduler cannot place waits for the deadline (the shared code).
      const watch = createWakeWatch(clients, primariesOf(cfg).filter(isPods).map(watchRecord), { since, now });
      while ((await healthyCount(cfg)) < 1) {
        const seen = await watch.check();
        if (seen) throw seen;
        if (now() >= deadline) throw await noHealthyError(cfg, watch);
        await sleep(POLL_MS);
      }
      if (sw.kind === 'swap') {
        // The wait counts in the wake's time, and is not cut short: the map has changed. It must also fit the request, and this reserve
        // holds it, not the write before it: a VM healthy late in the budget, with a write at its worst (up to 240 s), ends past the
        // request's 1800 s. That heals: Cloud Tasks' retry or the check fails it, and the next wake finishes. The band R12 documents.
        if (now() >= Math.min(deadline, started + WAKE_BUDGET_MS - sw.waitMs)) throw failureError('timeout', 'a VM is healthy, but the wake timed out before the URL map could change');
        if (!(await isCurrent())) return superseded();
        await writeAwake(cfg);
        await sleep(sw.waitMs);
        if (now() >= deadline) throw failureError('timeout', 'a VM is healthy, but the wake timed out while the URL map\'s change spread');
      }
      const durationMs = now() - since;
      const { fallbacks } = types;
      const awake = await transition(workloadId, {
        cond: { state: STATES.WAKING, wakeId },
        // recentWakes, as AWS's: only a wake that ended here counts, for the waiting page's typical time.
        set: { state: STATES.AWAKE, awakeSince: now(), lastWake: { durationMs }, recentWakes: withWake(run.recentWakes, durationMs) },
        remove: ['pendingWake', 'stopped', 'suspended', ...(givenBack ? ['autoscalers', 'owners'] : []), 'failure', 'consecutiveFailures', 'failedAt'],
        // The machine types this wake fell back to, as AWS's.
        event: { wakeId, durationMs, ...(Object.keys(fallbacks).length ? { fallbacks } : {}) },
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

  const isNapping = async (workloadId) => (await store.getRun(workloadId))?.state === STATES.NAPPING;

  // Written, then still there after a whole wait: a check's repair or a customer's apply may have removed it meanwhile,
  // and the VMs must not go with no way to wake. 'held'; 'lost' when it was lost with no room left for another wait: for the stop,
  // and under a swap for the wait of a nap given up after that one; 'superseded' when the run moved on (a nap called stuck, whose
  // wake may be unswapping): read around each wait, as a write now would fight that wake.
  async function asleepHeld(cfg, sw, latest) {
    const room = sw.waitMs + STOP_ROOM_MS + (sw.kind === 'swap' ? sw.waitMs : 0);
    await writeOnlyAsleep(cfg);
    for (;;) {
      if (!(await isNapping(cfg.workloadId))) return 'superseded';
      await sleep(sw.waitMs);
      if (!(await isNapping(cfg.workloadId))) return 'superseded';
      const { paths } = await writeOnlyAsleep(cfg);
      if (!paths.length) return 'held';
      log.warn(sw.kind === 'swap' ? 'SwapLost' : 'PolicyLost', { workloadId: cfg.workloadId, paths });
      if (now() + room > latest) return 'lost';
    }
  }

  // The unmanaged groups' VMs (`groups`, VM -> group URL), each group read once: what it lists now against the VMs recorded in it.
  // A config written before the field compares nothing.
  async function groupsChanged(cfg) {
    const byGroup = new Map();
    for (const [vm, url] of Object.entries(cfg.groups ?? {})) byGroup.set(url, [...(byGroup.get(url) ?? []), vm]);
    return each([...byGroup], async ([url, vms]) => {
      const [, zone, name] = /\/zones\/([^/]+)\/instanceGroups\/([^/]+)$/.exec(url) ?? [];
      if (!name) return null;
      const items = await compute.listGroupInstances(zone, name).catch((err) => {
        if (err?.code !== 404) throw err;
        return null;
      });
      if (!items) return `instance group ${name} no longer exists: offboard and onboard again`;
      const current = [...new Set(items.map((item) => nameOf(item.instance)))];
      const added = current.filter((vm) => !vms.includes(vm));
      const removed = vms.filter((vm) => !current.includes(vm));
      if (!added.length && !removed.length) return null;
      const parts = [...(added.length ? [`VMs added: ${added.join(', ')}`] : []), ...(removed.length ? [`VMs removed: ${removed.join(', ')}`] : [])];
      return `instance group ${name} changed since the onboarding (${parts.join('; ')}): offboard and onboard again`;
    });
  }

  // The backend service's backends (`serviceBackends`) against the service read now, as a set.
  async function serviceChanged(cfg) {
    if (!cfg.serviceBackends) return [];
    const service = await readService(cfg).catch((err) => {
      if (err?.code !== 404) throw err;
      return null;
    });
    if (!service) return [`backend service ${cfg.backendService} no longer exists: offboard and onboard again`];
    const current = new Set((service.backends ?? []).map((b) => b.group));
    const recorded = new Set(cfg.serviceBackends);
    const added = [...current].filter((group) => !recorded.has(group));
    const removed = [...recorded].filter((group) => !current.has(group));
    if (!added.length && !removed.length) return [];
    const parts = [...(added.length ? [`backends added: ${added.join(', ')}`] : []), ...(removed.length ? [`backends removed: ${removed.join(', ')}`] : [])];
    return [`backend service ${cfg.backendService} changed since the onboarding (${parts.join('; ')}): offboard and onboard again`];
  }

  // A NEG's VMs are stopped only while they still are the NEG: one is edited more freely than a group. Why not, else null; a NEG
  // deleted is one more change, not a failure. A read that fails throws. The wake needs none of this: starting what was recorded
  // is harmless. An owner's pods legitimately change: what must hold of its NEGs is gke.mjs's, and its being gone throws. A companion
  // gone or no longer to be read is one more change: the application stays up rather than go down for it (cloudsql.mjs).
  async function backendsChanged(cfg) {
    const recorded = new Map();
    for (const backend of cfg.backends.filter((b) => b.kind === 'vm')) {
      for (const neg of [backend.neg, ...(backend.moreNegs ?? [])].filter(Boolean)) {
        const key = `${neg.zone}/${neg.name}`;
        recorded.set(key, { neg, vms: [...(recorded.get(key)?.vms ?? []), backend.name] });
      }
    }
    const changes = await each([...recorded.values()], async ({ neg, vms }) => {
      const items = await compute.listNetworkEndpoints(neg.zone, neg.name).catch((err) => {
        if (err?.code !== 404) throw err;
        return null;
      });
      if (!items) return `network endpoint group ${neg.name} no longer exists: offboard and onboard again`;
      const endpoints = items.map((item) => item.networkEndpoint ?? {});
      const current = endpoints.filter((endpoint) => endpoint.instance).map((endpoint) => nameOf(endpoint.instance));
      const bare = endpoints.filter((endpoint) => !endpoint.instance).map((endpoint) => endpoint.ipAddress);
      const added = [...new Set(current)].filter((name) => !vms.includes(name));
      const removed = vms.filter((name) => !current.includes(name));
      if (!added.length && !removed.length && !bare.length) return null;
      const parts = [
        ...(added.length ? [`VMs added: ${added.join(', ')}`] : []),
        ...(removed.length ? [`VMs removed: ${removed.join(', ')}`] : []),
        ...(bare.length ? [`an endpoint with no VM: ${bare.join(', ')}`] : []),
      ];
      return `network endpoint group ${neg.name} changed since the onboarding (${parts.join('; ')}): offboard and onboard again`;
    });
    const groupChanges = await groupsChanged(cfg);
    const serviceChanges = await serviceChanged(cfg);
    const ownerChanges = await each(cfg.backends.filter(isPods), (backend) => ownerChanged(clients, backend, () => readService(cfg)));
    const companionChanges = await each(companionsOf(cfg), ({ name }) => companionLost(cloudsql, name));
    const found = [...changes, ...groupChanges, ...serviceChanges, ...ownerChanges, ...companionChanges].filter(Boolean);
    return found.length ? found.join('; ') : null;
  }

  // Why a nap's task no longer holds, else null: a pause written since it was asked for; a task delivered late or twice with the
  // workload woken since it was asked for (`requestedAt`: it was idle then, it says nothing of now), or a nap window ended (`until`,
  // its end).
  async function napRefusal(workloadId, requestedAt, until) {
    if (await isPaused(workloadId)) return 'paused';
    if (until !== undefined && now() >= until) return 'the nap window ended';
    if (requestedAt === undefined) return null;
    return ((await store.getRun(workloadId))?.awakeSince ?? 0) > requestedAt ? 'woken since it was requested' : null;
  }

  async function nap(workloadId, { cause = 'idle', requestedAt, until } = {}) {
    const started = now();
    const latest = started + NAP_BUDGET_MS;
    const [stored, levels] = await Promise.all([getConfig(workloadId), routerLevel()]);
    const { router } = levels;
    const cfg = effective(stored, null, levels);
    const sw = switchFor(cfg);
    const refusal = await napRefusal(workloadId, requestedAt, until);
    if (refusal) {
      log.warn('NapSkipped', { workloadId, reason: refusal });
      return { state: 'SKIPPED', reason: refusal };
    }
    // The nap is decided, and the route still reaches the application: the only moment its home page can be read.
    if (faviconReachable(cfg.lb)) await faviconAtNap(cfg, sw);
    // Its id: what its heartbeat holds the run by, from NAPPING to its end.
    const napId = newId();
    const napping = await transition(workloadId, { cond: { state: STATES.AWAKE }, set: { state: STATES.NAPPING, napId }, remove: ['pendingWake'], cause });
    if (!napping) return { state: 'SKIPPED' };
    log.info('NapStarted', { workloadId });
    return beating(workloadId, 'napId', napId, () => napBeating(workloadId, { cfg, router, sw, napping, cause, requestedAt, started, latest }));
  }

  // The application's favicon for the waiting page, by AWS's step (favicon.mjs's cacheFavicon): the levels as the waiting page shows
  // them, the host from the URL map read once the read is due.
  function faviconAtNap(cfg, sw) {
    const { workloadId } = cfg;
    const served = servedPage(customPages);
    return cacheFavicon(workloadId, {
      store, fetch, now, budgetMs: faviconBudgetMs, log,
      levels: async () => {
        const [router, workload] = await Promise.all([store.getWaitingPage('router'), store.getWaitingPage({ workloadId })]);
        return [null, served(router?.page), served(workload?.page)];
      },
      host: async () => hostOfRules(listenerRulesOf(await sw.urlmaps.get(cfg.urlMap), cfg.backendService)),
    });
  }

  // A nap from its NAPPING on.
  async function napBeating(workloadId, { cfg, router, sw, napping, cause, requestedAt, started, latest }) {
    // The run moved on while this request held it (a nap called stuck, a forced offboarding): the map and the state are another's.
    const superseded = () => {
      log.warn('NapSuperseded', { workloadId });
      return { state: 'SUPERSEDED' };
    };
    // Nothing is stopped yet, the application keeps serving. Under a swap, visitors are at the waker until the application's back
    // has spread: unswapped and waited for before AWAKE, a wake asked meanwhile being part of it; nothing to unswap, no wait. The
    // policy's removal follows it. The run says why (`napAborted`, its cause and time) until a nap commits.
    const giveUp = async (cause, level, { reason, error } = {}) => {
      if (!(await isNapping(workloadId))) return superseded();
      if (sw.kind === 'swap') {
        const { paths } = await writeAwake(cfg);
        if (paths.length) await sleep(sw.waitMs);
      }
      const at = now();
      const back = { set: { state: STATES.AWAKE, napAborted: { reason: cause, at } }, remove: ['pendingWake', 'stopping'], cause };
      // A map other updates kept busy holds no switch of this nap's (its first write never went through, or a lost swap's again):
      // unless a wake was asked meanwhile, the idle time goes on, and the next check asks again. A wake asked restarts it, as any abort.
      const kept = cause === 'map-busy' ? await transition(workloadId, { ...back, cond: { state: STATES.NAPPING, pendingWake: false } }) : null;
      const awake = kept ?? await transition(workloadId, { ...back, cond: { state: STATES.NAPPING }, set: { ...back.set, awakeSince: at } });
      if (!awake) return superseded();
      log[level]('NapAborted', { workloadId, ...(reason ? { reason } : {}) });
      if (sw.kind === 'policy') await removePolicy(cfg);
      return { state: STATES.AWAKE, aborted: true, ...(error ? { error } : {}) };
    };
    let slept;
    let types;
    try {
      // Before the first write as well as after the wait: under a swap an abort after it would hold visitors at the waker for two
      // waits, at each idle period until an offboarding.
      const changedBefore = await backendsChanged(cfg);
      if (changedBefore) return await giveUp('backends-changed', 'warn', { reason: changedBefore, error: changedBefore });
      try {
        const held = await asleepHeld(cfg, sw, latest);
        if (held === 'superseded') return superseded();
        if (held === 'lost') return await giveUp(`${sw.kind}-lost`, 'warn', { reason: `the ${sw.kind} was lost, no time left to wait for it again` });
      } catch (err) {
        // A customer's own policy, or a service moved or named elsewhere, since the onboarding: nothing is stopped yet, the
        // application keeps serving. So with a map other updates kept busy past the pauses (another router process's naps, a
        // customer's apply): its switch is not on it, and the nap is no failure (F8).
        if (mapBusy(err)) {
          const message = `URL map ${cfg.urlMap} stayed busy with other updates: ${err.message}`;
          return await giveUp('map-busy', 'warn', { reason: message, error: message });
        }
        if (!(err instanceof UrlMapRefused)) throw err;
        return await giveUp('switch-failed', 'warn', { reason: err.message, error: err.message });
      }
      const changed = await backendsChanged(cfg);
      if (changed) return await giveUp('backends-changed', 'warn', { reason: changed, error: changed });
      const autoscalers = await autoscalersToRecord(cfg, napping);
      const owners = await ownersToRecord(cfg, napping);
      // An idle nap's last read of the requests: from what its check could not see yet (its request less the metric's delay) to now,
      // the wait included. A scheduled or an operator's nap goes whatever the traffic. One that cannot be read is given up, not failed:
      // the application still serves, and a failure would hold visitors at the waker, then be released by the check.
      if (cause === 'idle') {
        let requests;
        try {
          requests = (await activityBetween(cfg, (requestedAt ?? started) - METRIC_DELAY_MS, now())).activity;
        } catch (err) {
          const message = `the requests could not be read: ${err.message}`;
          return await giveUp('traffic-unread', 'warn', { reason: message, error: message });
        }
        if (requests > 0) return await giveUp('traffic', 'info', { reason: 'traffic' });
      }
      // Commit point: after this transition the VMs go, even if a request arrives. The modes and the replicas are on the run before any
      // autoscaler is turned off or any owner scaled. A pause written since the nap started aborts it, like a request.
      const paused = await isPaused(workloadId);
      if (paused || !(await transition(workloadId, {
        cond: { state: STATES.NAPPING, pendingWake: false }, set: { stopping: true, autoscalers, ...(owners.length ? { owners } : {}) }, remove: ['napAborted'],
      }))) {
        return await giveUp(paused ? 'paused' : 'pending-wake', 'info', paused ? { reason: 'paused' } : {});
      }
      slept = await putToSleep(cfg, { autoscalers, owners, router, instanceTypes: napping.instanceTypes }, latest, async () => {
        const current = await store.getRun(workloadId);
        return current?.state === STATES.NAPPING && !current.pendingWake;
      });
      // A fallback machine type is for one wake only (AWS's, FinOps): stopped, a VM gets its own type back.
      types = await revertTypes(cfg, napping.instanceTypes);
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
      set: { state: STATES.ASLEEP, ...slept, ...types.set },
      remove: ['stopping', ...types.remove],
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
      set: { state: STATES.WAKING, wakeId, wakeStartedAt: now(), ...types.set },
      remove: ['stopping', 'pendingWake', ...types.remove],
      increment: ['wakeCount'],
      cause: 'pending-wake',
    });
    if (!waking) return { state: 'UNKNOWN' };
    log.info('WakeRequested', { workloadId, wakeId, reason: 'pendingWake' });
    await enqueue({ action: 'wake', workloadId, wakeId });
    return { state: STATES.WAKING, wakeId };
  }

  // The operator's nap, in a request of its own: it takes minutes. Asked for, not idle: it does not read the traffic again.
  const napNow = (workloadId) => enqueue({ action: 'nap', workloadId, cause: 'operator', requestedAt: now() });

  // A failed workload whose backends run for nothing is stopped like a nap and left asleep behind the switch, its failure
  // kept (requests wake it again, backed off). The switch is there since its nap, unless the nap failed before writing it.
  async function release(workloadId) {
    const latest = now() + NAP_BUDGET_MS;
    let run = await store.getRun(workloadId);
    if (run?.state !== STATES.FAILED) return { state: 'SKIPPED', reason: run?.state ?? 'unknown' };
    if (await isPaused(workloadId)) return { state: 'SKIPPED', reason: 'paused' };
    const [stored, levels] = await Promise.all([getConfig(workloadId), routerLevel()]);
    const { router } = levels;
    const cfg = effective(stored, run, levels);
    try {
      const { paths } = await writeOnlyAsleep(cfg);
      if (paths.length) {
        await sleep(switchFor(cfg).waitMs);
        // What it records may have changed: with the old record, an autoscaler read OFF would lose its mode for good.
        run = await store.getRun(workloadId);
        if (run?.state !== STATES.FAILED) return { state: 'SUPERSEDED' };
      }
      const changed = await backendsChanged(cfg);
      if (changed) {
        log.warn('ReleaseAborted', { workloadId, reason: changed });
        return { state: STATES.FAILED, error: changed };
      }
      const autoscalers = await autoscalersToRecord(cfg, run);
      const owners = await ownersToRecord(cfg, run);
      // A wake asked meanwhile takes over.
      if (!(await transition(workloadId, { cond: { state: STATES.FAILED }, set: { autoscalers, ...(owners.length ? { owners } : {}) } }))) return { state: 'SUPERSEDED' };
      const slept = await putToSleep(cfg, { autoscalers, owners, router, instanceTypes: run.instanceTypes }, latest, async () => (await store.getRun(workloadId))?.state === STATES.FAILED);
      const types = await revertTypes(cfg, run.instanceTypes);
      const asleep = await transition(workloadId, {
        cond: { state: STATES.FAILED }, set: { state: STATES.ASLEEP, ...slept, ...types.set }, remove: types.remove, cause: 'failed-released', event: slept,
      });
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

  // The nap windows' naps a check asks for, oldest occurrence first and at most SCHEDULED_NAPS_MAX accepted, within the naps in
  // flight (`flight`, NAPS_MAX): the next check takes the rest, and those a Cloud Tasks too slow left past the check's budget. Each
  // occurrence is recorded only once its task is accepted, whatever the state by then: the task may have started. A record lost
  // asks again at the next check, and the task it adds finds the nap under way. A pause written after that refuses the task, and
  // the occurrence stays consumed: once the pause is gone only an idle nap comes, not the window's.
  async function askScheduledNaps(naps, applied, t, deadline, flight) {
    const deferred = [];
    const failed = (workloadId) => (err) => log.error('ScheduleFailed', { workloadId, error: err.message });
    let accepted = 0;
    naps.sort((a, b) => a.occurrence.start - b.occurrence.start || a.workloadId.localeCompare(b.workloadId));
    for (const { workloadId, occurrence } of naps) {
      if (accepted === SCHEDULED_NAPS_MAX || flight.naps >= NAPS_MAX || now() >= deadline) {
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
      flight.naps += 1;
      applied.set(workloadId, 'nap');
      log.info('NapRequested', { workloadId, cause: 'schedule' });
      await recordOccurrence(workloadId, occurrence, 'nap', ANY_STATE).catch(failed(workloadId));
    }
    if (deferred.length) log.info('ScheduledNapsDeferred', { workloads: deferred });
  }

  // Before the check's loop, every scheduled workload whatever the loop's budget: 8 at a time, one run read each, nothing
  // called but the tasks it enqueues. holdOf(workloadId): { paused, keepAsleep }. `flight`: the naps in flight, which its naps
  // add to. Answers each workload's outcome (what it did, or what held it) and the schedules the router can read: one it cannot
  // (a time zone Intl refuses) is logged and the workload behaves as if it had none.
  async function applySchedules(configs, schedules, holdOf, t, deadline, flight) {
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
    await askScheduledNaps(naps, applied, t, deadline, flight);
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
      await each(primariesOf(cfg), (backend) => wakeBackend(backend, deadline, run)).catch((err) => log.warn('BackendsNotWoken', { workloadId, error: err.message }));
      const givenBack = await gaveBackAutoscalers(workloadId, run);
      run = (await transition(workloadId, {
        cond: { state: from },
        set: { state: STATES.AWAKE, awakeSince: now() },
        remove: ['stopped', 'suspended', ...(givenBack ? ['autoscalers', 'owners'] : []), 'failure', 'consecutiveFailures', 'failedAt'],
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
    if (from === STATES.AWAKE && (run.autoscalers?.length || run.owners?.length) && (await gaveBackAutoscalers(workloadId, run))) {
      run = (await transition(workloadId, { cond: { state: STATES.AWAKE }, remove: ['autoscalers', 'owners'] })) ?? run;
    }
    return run;
  }

  // The companions follow the state the primaries decided: asleep, a running one is stopped again, as AWS's that restart after 7 days;
  // awake, a stopped one is started. No wait in a check: one try, and a refusal or another operation is for the next check. The run is
  // read again before anything is asked: a wake or a nap since owns them. What is left is a wake begun in that PATCH's round trip, whose
  // read of the database may have come first: it then goes on with the database going down, and no later read of its own sees that.
  // The next check, once it is awake, starts it again. One gone is said, and no failure.
  async function companionsFollow(cfg, run) {
    const drift = COMPANION_DRIFT[run?.state];
    if (!drift || !companionsOf(cfg).length) return;
    const { workloadId } = cfg;
    const followed = await Promise.all(companionsOf(cfg).map(async ({ name }) => {
      try {
        if (statusOf(await cloudsql.get(name)) !== drift.status) return null;
        if ((await store.getRun(workloadId))?.state !== run.state) return null;
        log.warn(drift.event, { workloadId, instance: name });
        await cloudsql.setActivation(name, drift.policy);
      } catch (err) {
        if (companionGone(err)) return name;
        log.warn('DatabaseNotFollowed', { workloadId, instance: name, error: err.message });
      }
      return null;
    }));
    await saidGone(workloadId, run, { state: run.state }, followed.filter(Boolean));
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

  async function checkOne(stored, deadline, paused, ctx) {
    const { workloadId } = stored;
    let run = await store.getRun(workloadId);
    if (!run) return { state: 'UNKNOWN' };
    const cfg = effective(stored, run, ctx.levels);
    if (run.state === STATES.NAPPING) {
      // A nap whose request no longer beats is stuck now (heartbeat.mjs). Its deadline stays, the last resort: for a nap from before
      // the heartbeat, or one that still beats past it.
      const t = now();
      const stale = staleness(run, t);
      const stuckMs = switchFor(cfg).kind === 'swap' && !run.stopping ? NAPPING_SWAP_STUCK_MS : NAPPING_STUCK_MS;
      const before = t - stuckMs;
      if (!stale && (run.updatedAt ?? 0) >= before) return { state: run.state };
      log.warn('NapStuck', { workloadId, ...(stale ? { reason: stale } : {}) });
      const message = stale ? `the nap's request stopped: ${stale}` : `the nap did not finish within ${stuckMs / 60_000} minutes (its request stopped)`;
      // A stale nap that moved on since this read (a transition dates it) is not failed.
      const olderThan = { field: 'updatedAt', ms: stale ? (run.updatedAt ?? 0) + 1 : before };
      return { state: (await failStuck(workloadId, { state: STATES.NAPPING, olderThan }, 'nap', message, 'nap-stuck'))?.state };
    }
    if (run.state === STATES.WAKING) {
      // A swap's wait is not cut short at the wake's timeout: a wake in it is no stuck one. Within its deadline, a wake whose task was
      // lost or whose request died no longer beats: it is sent again with its wakeId (heartbeat.mjs). Past it, the deadline is the last
      // resort, sent again or not.
      const sw = switchFor(cfg);
      const grace = WAKING_STUCK_GRACE_MS + (sw.kind === 'swap' ? sw.waitMs : 0);
      if ((run.wakeStartedAt ?? 0) >= now() - wakeTimeoutS(cfg) * 1000 - grace) {
        const resent = await resendStale({ store, enqueue, now, log }, workloadId, run, 'check');
        return { state: run.state, ...(resent ? { wake: 'resent' } : {}) };
      }
      log.warn('WakeStuck', { workloadId, wakeId: run.wakeId });
      const message = `the wake did not finish within ${wakeTimeoutS(cfg)} s (its request stopped)`;
      return { state: (await failStuck(workloadId, { state: STATES.WAKING, wakeId: run.wakeId }, 'wake', message, 'wake-stuck'))?.state };
    }
    // The nap this check just asked for may have started since the run was read: a repair on that read would remove its policy.
    if (ctx.applied.get(workloadId) === 'nap') return { state: run.state };
    run = await reconcile(cfg, run, deadline);
    await companionsFollow(cfg, run);
    // Its router level unreadable (never read here): no decision on an idle window it may not have, as on AWS.
    if (cfg.levelsUnreadable) return { state: run?.state ?? 'UNKNOWN', settings: 'unreadable' };
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
    const { activity, reads } = await activityBetween(cfg, from, t);
    await recordReads(workloadId, run, reads);
    if (activity > 0) return { state: run.state };
    // Its place among the naps in flight, taken before its task is asked: two workloads checked at once cannot both take the last
    // one. Given back when the task is refused.
    if (ctx.flight.naps >= NAPS_MAX) {
      ctx.flight.deferred += 1;
      return { state: run.state, nap: 'deferred' };
    }
    ctx.flight.naps += 1;
    try {
      await enqueue({ action: 'nap', workloadId, requestedAt: t });
    } catch (err) {
      ctx.flight.naps -= 1;
      throw err;
    }
    log.info('NapRequested', { workloadId });
    return { state: run.state, nap: 'requested' };
  }

  // The naps in flight as the check starts: the NAPPING runs, 8 read at a time. One that cannot be read counts as one.
  async function napsInFlight(configs) {
    let napping = 0;
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(CHECK_CONCURRENCY, configs.length) }, async () => {
      while (i < configs.length) {
        const { workloadId } = configs[i++];
        const state = await store.getRun(workloadId).then((run) => run?.state, () => STATES.NAPPING);
        if (state === STATES.NAPPING) napping += 1;
      }
    }));
    return napping;
  }

  // 8 workloads at a time, none started past the budget; one that fails is logged and stops only itself. The schedules
  // first, whatever the budget. Pauses that cannot be read hold every nap and scheduled wake of this check; the reconcile
  // still runs. At most NAPS_MAX naps in flight: the idle naps past it are said once (`NapDeferred`, with their count), and asked
  // at a later check. Wakes are never held back.
  async function check() {
    const deadline = now() + CHECK_BUDGET_MS;
    const pauses = await activePauses();
    const paused = (workloadId) => pauses === null || pauses.some((p) => p.workloadId === workloadId);
    const keptAsleep = (workloadId) => pauses === null || pauses.some((p) => p.keepAsleep && p.workloadId === workloadId);
    const [{ configs, schedules }, levels] = await Promise.all([store.listWorkloads(), routerLevel()]);
    const order = [...configs].sort((a, b) => a.workloadId.localeCompare(b.workloadId));
    // A workload holds one nap in flight at most: with no more workloads than NAPS_MAX, their runs are not read for it.
    const flight = { naps: order.length > NAPS_MAX ? await napsInFlight(order) : 0, deferred: 0 };
    const { applied, readable } = await applySchedules(order, schedules, (id) => ({ paused: paused(id), keepAsleep: keptAsleep(id) }), now(), deadline, flight);
    await requestListRefresh();
    const ctx = { schedules: readable, applied, flight, levels };
    const passed = (workloadId) => (applied.has(workloadId) ? { schedule: applied.get(workloadId) } : {});
    const results = [];
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(CHECK_CONCURRENCY, order.length) }, async () => {
      while (next < order.length && now() < deadline) {
        const cfg = order[next++];
        try {
          results.push({ workloadId: cfg.workloadId, ...(await checkOne(cfg, deadline, paused(cfg.workloadId), ctx)), ...passed(cfg.workloadId) });
        } catch (err) {
          // An offboarding that ran under this check deleted the workload: its writes failing is no failure.
          if (!(await store.getConfig(cfg.workloadId).catch(() => cfg))) {
            log.info('CheckSkipped', { workloadId: cfg.workloadId, reason: 'offboarded' });
            results.push({ workloadId: cfg.workloadId, skipped: 'offboarded' });
            continue;
          }
          log.error('CheckFailed', { workloadId: cfg.workloadId, error: err.message });
          results.push({ workloadId: cfg.workloadId, error: err.message });
        }
      }
    }));
    if (flight.deferred) log.info('NapDeferred', { reason: 'cap', count: flight.deferred });
    if (next < order.length) log.warn('CheckBudgetReached', { checked: next, workloads: order.length, next: order[next].workloadId });
    // What the schedules did for the workloads the loop did not reach.
    const reached = new Set(results.map((r) => r.workloadId));
    for (const workloadId of applied.keys()) if (!reached.has(workloadId)) results.push({ workloadId, ...passed(workloadId) });
    await sweepStats();
    return results;
  }

  // The counters older than 35 days, once a UTC day: the first check of the day sweeps, the others find the day claimed. An
  // instance that has seen the day claimed reads nothing more of it.
  let sweepDay = null;
  async function sweepStats() {
    const day = utcDay(now());
    if (sweepDay === day) return;
    try {
      const claimed = await store.claimSweep();
      sweepDay = day;
      if (claimed) log.info('StatsSwept', { swept: await store.sweepStats(now() - STATS_KEPT_DAYS * DAY_MS) });
    } catch (err) {
      log.warn('StatsSweepFailed', { error: err.message });
    }
  }

  return { refreshLists, wake, beginWake, wakeNow, nap, napNow, release, check, pause, resume, pausesFor };
}
