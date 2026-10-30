// The controller on Google Cloud (vision docs/specs/2026-10-29-google-cloud-design.md, section 6): the wake, the nap and
// the check, with AWS's states, causes and event names (lambda/src/lib/controller-core.mjs). Each action runs within one
// request of at most 900 s; the check only enqueues the naps it decides (POST /v1/tasks), never waiting in its 240 s.
//
// A workload's configuration: `{ workloadId, urlMap, backendService, wakerBackendService (names), backends: [{ kind: 'vm'
// | 'mig', location, name }], idleMinutes, wakeTimeoutSeconds, hibernate? }`. `config`: `{ project, controllerUrl }`.
//
// What the run adds to AWS's: `stopped`, `suspended` (the VMs a nap acted on, names), `autoscalers` (`[{ kind, location,
// name (the autoscaler's), mode }]`, what the wake gives back) and `lastWake` (`{ durationMs }`). The cause and the event of a state change
// are logged (`StateChanged`): the state history in the manager comes with G2.
import { randomUUID } from 'node:crypto';
import { failedSpec, failureError } from '../../lambda/src/lib/failures.mjs';
import { resolveHibernation } from '../../lambda/src/lib/hibernation.mjs';
import { STATES } from '../../lambda/src/lib/state.mjs';
import { OPERATION_NOT_DONE } from './google.mjs';
import { references, UrlMapRefused, withErrorPolicy, withoutErrorPolicy, withWakerRoute } from './urlmaps.mjs';

const COMPUTE = 'https://compute.googleapis.com/compute/v1';
const POLL_MS = 2000;
// The nap's policy reaching the load balancer (G0: 163 to 215 s), which is also the application's drain.
const POLICY_WAIT_MS = 300_000;
// Until the VMs are down, from the moment they are asked to go. G0: 106 s, 96 s suspended, 198 s for a managed group's.
const STOP_TIMEOUT_MS = 300_000;
// Within the request's 900 s: what is left removes the policy after the wake, or records a nap's failure. The nap's fits
// a lost policy's second wait: two writes (G0: 25 s), twice 300 s and a managed group's stop.
const WAKE_BUDGET_MS = 840_000;
const NAP_BUDGET_MS = 870_000;
// A fresh wait for a lost policy needs this left after it: a managed group's stop (G0: 198 s).
const STOP_ROOM_MS = 200_000;
// Cloud Monitoring publishes the first point 72 to 125 s after the requests (spec section 12): the newest requests cannot
// be seen, so the idle read goes this much further back, and the run must have been awake for all of it.
const METRIC_DELAY_MS = 180_000;
const WAKING_STUCK_GRACE_MS = 60_000;
const NAPPING_STUCK_MS = 15 * 60_000;
const CHECK_BUDGET_MS = 240_000;
const CHECK_CONCURRENCY = 8;
const SUSPEND_MAX_MEMORY_MB = 208 * 1024;

const STOPPED = new Set(['TERMINATED', 'STOPPED']);
const GONE = new Set([...STOPPED, 'SUSPENDED']);
const GOING = new Set(['STOPPING', 'SUSPENDING']);
const DOWN = new Set([...GONE, ...GOING]);
// A managed instance's status lags behind what its group is doing to it (G0: 92 s of draining while RUNNING).
const STATUS_OF_ACTION = { STOPPING: 'STOPPING', SUSPENDING: 'SUSPENDING', STARTING: 'STAGING', RESUMING: 'STAGING' };
// What the shared classification cannot read in a Google error. 412: the URL map kept changing, as a throttled switch.
const KIND_OF_CODE = { 403: 'permission', 412: 'throttled', 429: 'throttled' };

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
  const kind = err.kind ?? (err.reason === OPERATION_NOT_DONE ? 'timeout' : KIND_OF_CODE[err.code]);
  return failedSpec(kind ? Object.assign(err, { kind }) : err, options);
}

export function createController({ store, compute, urlmaps, monitoring, tasks, config, now = Date.now, sleep, newId = randomUUID, log }) {
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

  const wakerUrl = (cfg) => `${COMPUTE}/projects/${config.project}/global/backendServices/${cfg.wakerBackendService}`;
  const writePolicy = (cfg) => urlmaps.modify(cfg.urlMap, (map) => withErrorPolicy(map, cfg.backendService, wakerUrl(cfg)));

  // Before VMs go: the map must be the only one naming the service. Another load balancer would keep its visitors with no
  // policy and no way to wake (spec section 7, checked at the onboarding and true only then).
  async function writeOnlyPolicy(cfg) {
    const other = (await urlmaps.list()).find((map) => map.name !== cfg.urlMap && references(map, cfg.backendService).length);
    if (other) throw new UrlMapRefused(`backend service ${cfg.backendService} is also named in URL map ${other.name}: that load balancer would lose its backends during a nap`);
    return writePolicy(cfg);
  }

  // After the state changed to AWAKE: a removal that fails is drift the check repairs.
  async function removePolicy(cfg) {
    try {
      await urlmaps.modify(cfg.urlMap, (map) => withoutErrorPolicy(map, wakerUrl(cfg)));
    } catch (err) {
      log.warn('PolicyNotRemoved', { workloadId: cfg.workloadId, error: err.message });
    }
  }

  // The map as the state wants it, in one read (nothing written when it is): the route for good, and the policy but awake.
  async function repair(cfg, state) {
    const waker = wakerUrl(cfg);
    const { paths } = await urlmaps.modify(cfg.urlMap, (map) => {
      const route = withWakerRoute(map, cfg.backendService, waker);
      const policy = state === STATES.AWAKE ? withoutErrorPolicy(route.map, waker) : withErrorPolicy(route.map, cfg.backendService, waker);
      return { map: policy.map, paths: [...route.paths, ...policy.paths] };
    });
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

  async function healthyCount(cfg) {
    const { backends = [] } = await compute.getBackendService(cfg.backendService);
    const answers = await each(backends, ({ group }) => compute.getBackendServiceHealth(cfg.backendService, group));
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
    const vms = (await vmsOf(backend)).filter((vm) => !DOWN.has(vm.status));
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
    try {
      run = await store.getRun(workloadId);
      // A delayed or duplicated task must not touch anything once its wake is no longer the current one.
      if (run?.state !== STATES.WAKING || run.wakeId !== wakeId) return superseded();
      cfg = await getConfig(workloadId);
    } catch (err) {
      return fail(err);
    }
    const since = run.wakeStartedAt ?? started;
    const deadline = Math.min(since + cfg.wakeTimeoutSeconds * 1000, started + WAKE_BUDGET_MS);
    try {
      await wakeBackends(cfg, run, deadline);
      while ((await healthyCount(cfg)) < 1) {
        if (now() >= deadline) throw await noHealthyError(cfg);
        await sleep(POLL_MS);
      }
      const durationMs = now() - since;
      const awake = await transition(workloadId, {
        cond: { state: STATES.WAKING, wakeId },
        set: { state: STATES.AWAKE, awakeSince: now(), lastWake: { durationMs } },
        remove: ['pendingWake', 'stopped', 'suspended', 'autoscalers', 'failure', 'consecutiveFailures', 'failedAt'],
        event: { wakeId, durationMs },
      });
      if (!awake) return superseded();
      log.info('WakeCompleted', { workloadId, wakeId, durationMs });
      await removePolicy(cfg);
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

  // The operator's wake, whatever the backoff, in a request of its own: this one answers at once. During a nap, it is kept
  // for the nap's end. A task that cannot be enqueued fails the wake now rather than at the check.
  async function wakeNow(workloadId) {
    const run = await store.getRun(workloadId);
    if (run?.state === STATES.NAPPING) {
      if (await store.setPendingWake(workloadId)) log.info('PendingWake', { workloadId, reason: 'operator' });
      return;
    }
    if (![STATES.ASLEEP, STATES.FAILED].includes(run?.state)) return;
    const wakeId = await beginWake(workloadId, run.state, 'operator');
    if (!wakeId) return;
    try {
      await enqueue({ action: 'wake', workloadId, wakeId });
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
    }
  }

  // --- The nap -------------------------------------------------------------------------------------------------------

  // Written, then still there after a whole wait: a check's repair or a customer's apply may have removed it meanwhile,
  // and the VMs must not go with no way to wake. False when it was lost with no room left for another wait.
  async function policyHeld(cfg, latest) {
    await writeOnlyPolicy(cfg);
    for (;;) {
      await sleep(POLICY_WAIT_MS);
      const { paths } = await writeOnlyPolicy(cfg);
      if (!paths.length) return true;
      log.warn('PolicyLost', { workloadId: cfg.workloadId, paths });
      if (now() + POLICY_WAIT_MS + STOP_ROOM_MS > latest) return false;
    }
  }

  async function nap(workloadId, { cause = 'idle' } = {}) {
    const latest = now() + NAP_BUDGET_MS;
    const cfg = await getConfig(workloadId);
    const napping = await transition(workloadId, { cond: { state: STATES.AWAKE }, set: { state: STATES.NAPPING }, remove: ['pendingWake'], cause });
    if (!napping) return { state: 'SKIPPED' };
    log.info('NapStarted', { workloadId });
    const backToAwake = (reason) => transition(workloadId, {
      cond: { state: STATES.NAPPING }, set: { state: STATES.AWAKE, awakeSince: now() }, remove: ['pendingWake', 'stopping'], cause: reason,
    });
    let slept;
    try {
      try {
        if (!(await policyHeld(cfg, latest))) {
          await backToAwake('policy-lost');
          log.warn('NapAborted', { workloadId, reason: 'the policy was lost, no time left to wait for it again' });
          await removePolicy(cfg);
          return { state: STATES.AWAKE, aborted: true };
        }
      } catch (err) {
        // A customer's own policy, or a service moved or named elsewhere, since the onboarding: nothing is stopped yet, the
        // application keeps serving.
        if (!(err instanceof UrlMapRefused)) throw err;
        await backToAwake('switch-failed');
        log.warn('NapAborted', { workloadId, reason: err.message });
        await removePolicy(cfg);
        return { state: STATES.AWAKE, aborted: true, error: err.message };
      }
      const autoscalers = await autoscalersToRecord(cfg, napping);
      // Commit point: after this transition the VMs go, even if a request arrives. The modes are on the run before any
      // autoscaler is turned off.
      if (!(await transition(workloadId, { cond: { state: STATES.NAPPING, pendingWake: false }, set: { stopping: true, autoscalers } }))) {
        await backToAwake('pending-wake');
        log.info('NapAborted', { workloadId });
        await removePolicy(cfg);
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
    // A wake asked during the stop: in a request of its own, as this one may have used most of its 900 s. Its task lost,
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

  // A failed workload whose backends run for nothing is stopped like a nap and left asleep behind the policy, its failure
  // kept (requests wake it again, backed off). The policy is there since its nap, unless the nap failed before writing it.
  async function release(workloadId) {
    const latest = now() + NAP_BUDGET_MS;
    const run = await store.getRun(workloadId);
    if (run?.state !== STATES.FAILED) return { state: 'SKIPPED', reason: run?.state ?? 'unknown' };
    const cfg = await getConfig(workloadId);
    try {
      const { paths } = await writeOnlyPolicy(cfg);
      if (paths.length) await sleep(POLICY_WAIT_MS);
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
      await each(cfg.backends, (backend) => wakeBackend(backend, deadline)).catch((err) => log.warn('BackendsNotWoken', { workloadId, error: err.message }));
      const givenBack = await gaveBackAutoscalers(workloadId, run);
      run = (await transition(workloadId, {
        cond: { state: from },
        set: { state: STATES.AWAKE, awakeSince: now() },
        remove: ['stopped', 'suspended', ...(givenBack ? ['autoscalers'] : []), 'failure', 'consecutiveFailures', 'failedAt'],
        cause: from === STATES.FAILED ? 'recovered' : 'external-start',
      })) ?? (await store.getRun(workloadId));
    } else if (from !== STATES.ASLEEP && vms.length > 0 && vms.every((vm) => DOWN.has(vm.status)) && (await healthyCount(cfg)) < 1) {
      // Stopped by hand: the policy first, with no wait, they are already down.
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

  async function checkOne(cfg, deadline) {
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
      if ((run.wakeStartedAt ?? 0) >= now() - cfg.wakeTimeoutSeconds * 1000 - WAKING_STUCK_GRACE_MS) return { state: run.state };
      log.warn('WakeStuck', { workloadId, wakeId: run.wakeId });
      const message = `the wake did not finish within ${cfg.wakeTimeoutSeconds} s (its request stopped)`;
      return { state: (await failStuck(workloadId, { state: STATES.WAKING, wakeId: run.wakeId }, 'wake', message, 'wake-stuck'))?.state };
    }
    run = await reconcile(cfg, run, deadline);
    const t = now();
    const idleMs = cfg.idleMinutes * 60_000;
    // Still paying for backends that run without a healthy instance: released once its idle window has passed.
    if (run?.state === STATES.FAILED && (run.failedAt ?? 0) <= t - idleMs) {
      await enqueue({ action: 'release', workloadId });
      log.info('ReleaseRequested', { workloadId });
      return { state: run.state, release: 'requested' };
    }
    const from = t - idleMs - METRIC_DELAY_MS;
    if (run?.state !== STATES.AWAKE || (run.awakeSince ?? 0) > from) return { state: run?.state ?? 'UNKNOWN' };
    if ((await monitoring.requestCount({ backendService: cfg.backendService, from, to: t })) > 0) return { state: run.state };
    await enqueue({ action: 'nap', workloadId });
    log.info('NapRequested', { workloadId });
    return { state: run.state, nap: 'requested' };
  }

  // 8 workloads at a time, none started past the budget; one that fails is logged and stops only itself.
  async function check() {
    const deadline = now() + CHECK_BUDGET_MS;
    const { configs } = await store.listWorkloads();
    const order = [...configs].sort((a, b) => a.workloadId.localeCompare(b.workloadId));
    const results = [];
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(CHECK_CONCURRENCY, order.length) }, async () => {
      while (next < order.length && now() < deadline) {
        const cfg = order[next++];
        try {
          results.push({ workloadId: cfg.workloadId, ...(await checkOne(cfg, deadline)) });
        } catch (err) {
          log.error('CheckFailed', { workloadId: cfg.workloadId, error: err.message });
          results.push({ workloadId: cfg.workloadId, error: err.message });
        }
      }
    }));
    if (next < order.length) log.warn('CheckBudgetReached', { checked: next, workloads: order.length, next: order[next].workloadId });
    return results;
  }

  return { wake, beginWake, wakeNow, nap, napNow, release, check };
}
