import { randomUUID } from 'node:crypto';
import { STATES } from './state.mjs';
import { checkName } from './names.mjs';
import { currentTarget, hostOf, setRoute } from './route.mjs';
import { dormetoTargetGroup, ingressDrift, routeIngress } from './kube-route.mjs';
import { checkRights } from './kube-access.mjs';
import { resolveRules } from './rules.mjs';
import { healthyCount, waitTargetsReleased } from './instances.mjs';
import { createStatus } from './status.mjs';
import { describeRules } from './no-wake.mjs';
import { describeStoredLists } from './list-cache.mjs';
import { failedSpec, failureError } from './failures.mjs';
import { createWakeWatch, unhealthyError } from './wake-watch.mjs';
import { describeStopped } from './stopped.mjs';
import { revertInstanceTypes } from './capacity.mjs';
import { tagsProblem } from './tags.mjs';
import { maintenanceDue, nextEvents, normalizeSchedule, scheduleProblems } from './schedule.mjs';
import { STATS_DAYS, totals, workloadSummary } from './summary.mjs';
import { lastRequestAt } from './metrics.mjs';
import { checkScope } from './check-scope.mjs';
import { healthOf, lambdaMetrics, queueDepths } from './health.mjs';
import {
  backendKey, backendStatuses, isCompanion, resolveBackends, resumeBackends, sleepBackends, startCompanions, stopCompanions, toRecord, wakeBackends,
} from './backends.mjs';

const HEALTH_POLL_MS = 3000;
const STOP_TIMEOUT_MS = 5 * 60_000;
// Longest wait for the target group to drop the stopped backends (deregistration delay included).
const RELEASE_TIMEOUT_MS = 2 * 60_000;
const NAPPING_STUCK_MS = 15 * 60_000;
const WAKING_STUCK_GRACE_MS = 60_000;
// Stop working this long before the Lambda timeout, so that a failure is recorded instead of a silent kill.
const TIMEOUT_MARGIN_MS = 30_000;
// Held requests last at most waitSeconds: a counter untouched for longer is a leak (killed waker).
const HOLDERS_STALE_MS = 2 * 60_000;
// Router health: Lambda metrics and failure queues read at most once a minute (the Routers view polls).
// The scheduled check measures the router's health (metrics, queues, concurrency limit) at most this often and stores
// it; the router action reads what is stored (scale design §3).
const HEALTH_REFRESH_MS = 15 * 60_000;
// The idle check of a crowded account-region (scale design §6): workloads checked 8 at a time within 240 s of the 5-minute
// period, the next check starting where it stopped; one check at a time (a lease for the controller's 15 minutes at most).
const CHECK_BUDGET_MS = 240_000;
const CHECK_CONCURRENCY = 8;
// Workloads whose rules the check resolves at once, in its order: under ELB throttling a check still reaches some.
const CHECK_CHUNK = 25;
const CHECK_LEASE_MS = 15 * 60_000;
// A queued nap older than this is dropped: the next check decides again with fresh metrics.
const NAP_MAX_AGE_MS = 10 * 60_000;
// A queued nap that waited longer than this reads the requests made since it was asked for.
const NAP_RECHECK_MS = 60_000;
// A rule switch throttled by ELB (its bucket of mutating calls) is tried again this long (a burst of wakes).
const ROUTE_RETRY_MS = 180_000;
// Pauses (router management): automatic resume at most this far ahead, reason length.
const PAUSE_MAX_MS = 366 * 86_400_000;
const REASON_MAX = 256;

export function createController({
  store, ec2, elbv2, cloudwatch, autoscaling, ecs, tagging, appscaling, rds, kubernetesOf, invokeSelf, now = Date.now, sleep, newId = randomUUID, log,
  lists = null, router = {}, defaultRules = [], ipLists = [], sqs = null, lambda = null, invokeOnboarder = null,
  // The manager's lists (R6b, lib/catalog.mjs): described from its catalog and manifests, never downloaded here.
  catalog = null,
  // The router's work queue (scale design §6): naps and the wakes of a router pause, run at most 10 at a time.
  queueWork = null,
  // The drift queue: the check's repair requests, read with the drift events by the onboarder (2 at a time).
  queueRepair = null,
  publisher = { enabled: false, checked: async () => {}, stateChanged: async () => {} },
}) {
  const clients = { ec2, elbv2, autoscaling, ecs, tagging, appscaling, rds, kubernetesOf };
  let budgetEnd = Infinity;

  async function config(workloadId) {
    const cfg = await store.getConfig(workloadId);
    if (!cfg) throw new Error(`workload not configured: ${workloadId}`);
    return cfg;
  }

  async function managedBackends(cfg, scope = clients) {
    const { backends, ignored } = await resolveBackends(scope, cfg);
    for (const target of ignored) log.info('IgnoredTarget', { workloadId: cfg.workloadId, target: target.id, reason: target.reason });
    return backends;
  }

  // What the nap stopped (napBackends, or napInstances from earlier versions); else what is managed now.
  async function wakeRecords(run, cfg) {
    if (run.napBackends) return JSON.parse(run.napBackends);
    if (run.napInstances) return JSON.parse(run.napInstances).map((id) => ({ kind: 'instance', id }));
    return managedBackends(cfg);
  }

  async function wake(workloadId, wakeId, knownConfig) {
    // A delayed or duplicated event must not touch EC2 or the ALB once its wake is no longer the current one.
    const isCurrent = (run) => run?.state === STATES.WAKING && run.wakeId === wakeId;
    const current = async () => isCurrent(await store.getRun(workloadId));
    const superseded = () => {
      log.warn('WakeSuperseded', { workloadId, wakeId });
      return { state: 'SUPERSEDED' };
    };
    // Why it failed (R7a): kept on the run until a successful wake, and said in the event.
    const fail = async (err) => {
      const at = now();
      const failed = failedSpec(err, { step: 'wake', wakeId, at });
      log.error('WakeFailed', { workloadId, wakeId, error: err.message, kind: failed.event.failure.kind, backend: failed.event.failure.backend });
      await store.transition(workloadId, {
        cond: { state: STATES.WAKING, wakeId },
        set: { state: STATES.FAILED, failedAt: at, holders: 0, ...failed.set },
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
      if (!isCurrent(run)) return superseded();
      cfg = knownConfig ?? (await config(workloadId));
    } catch (err) {
      return fail(err);
    }
    // The wake deadline counts from the wake start (RUN), not from this invocation: a wake can span invocations.
    const wakeDeadline = (run.wakeStartedAt ?? now()) + cfg.wakeTimeoutSeconds * 1000;
    const timing = { sleep, now, deadline: Math.min(wakeDeadline, budgetEnd), wakeDeadline };
    // Instance types a capacity error made this wake fall back to (R7a), given back after the next stop.
    const fallbacks = {};
    try {
      const records = await wakeRecords(run, cfg);
      await wakeBackends(clients, records, timing, {
        fallbackTypes: cfg.fallbackInstanceTypes ?? [],
        log,
        onFallback: (id, change) => {
          fallbacks[id] = change;
          log.warn('InstanceTypeFallback', { workloadId, wakeId, instance: id, ...change });
        },
      });
      // Launch and placement failures end the wake when AWS reports them, not at its timeout (R7a).
      const watch = createWakeWatch(clients, records, { since: run.wakeStartedAt ?? now(), now });
      const serving = await servingGroup(cfg);
      while ((await healthyCount(elbv2, serving)) < 1) {
        const seen = await watch.check();
        if (seen) throw seen;
        if (now() >= wakeDeadline) throw watch.capacity ?? await unhealthyError(elbv2, serving);
        if (now() >= timing.deadline) throw new Error('wake timeout: no healthy target');  // the Lambda time budget
        await sleep(HEALTH_POLL_MS);
      }
      if (!(await current())) return superseded();
      await routeTo(cfg, 'app');
      const done = await store.transition(workloadId, {
        cond: { state: STATES.WAKING, wakeId },
        set: { state: STATES.AWAKE, awakeSince: now(), holders: 0, ...(Object.keys(fallbacks).length ? { instanceTypes: JSON.stringify(fallbacks) } : {}) },
        remove: ['pendingWake', 'napInstances', 'napBackends', 'failure', 'consecutiveFailures'],
        // The wake's duration (R7a, the base of R8's wake times), and the instance types it fell back to.
        event: { wakeId, durationMs: now() - (run.wakeStartedAt ?? now()), ...(Object.keys(fallbacks).length ? { fallbacks } : {}) },
      });
      if (!done) return superseded();
      log.info('WakeCompleted', { workloadId, wakeId });
      return { state: STATES.AWAKE };
    } catch (err) {
      // The invocation budget ran out before the wake deadline (a database takes minutes): continue in a new one.
      if (invokeSelf && budgetEnd < wakeDeadline && now() >= budgetEnd) {
        await invokeSelf({ action: 'wake', workloadId, wakeId });
        log.info('WakeContinued', { workloadId, wakeId, reason: err.message });
        return { state: STATES.WAKING, continued: true };
      }
      return fail(err);
    }
  }

  // A failed workload whose backends run for nothing is stopped like a nap and left asleep behind the waker, its failure
  // kept (the last wake failed); requests wake it again, backed off (R7a, FinOps).
  async function release(workloadId) {
    const run = await store.getRun(workloadId);
    if (run?.state !== STATES.FAILED) return { state: 'SKIPPED', reason: run?.state ?? 'unknown' };
    if (await isPaused(workloadId)) return { state: 'SKIPPED', reason: 'paused' };
    const cfg = await config(workloadId);
    const backends = await managedBackends(cfg);
    await routeTo(cfg, 'waker', { allowIssues: true });
    const records = await sleepBackends(clients, backends, { sleep, now, deadline: now() + STOP_TIMEOUT_MS });
    await revertInstanceTypes(ec2, backends.filter((b) => b.kind === 'instance').map((b) => b.id), log);
    const asleep = await store.transition(workloadId, {
      cond: { state: STATES.FAILED, failedAt: run.failedAt },
      set: { state: STATES.ASLEEP, holders: 0, napBackends: JSON.stringify(records) },
      remove: ['instanceTypes'],
      cause: 'failed-released',
    });
    log.warn('FailedReleased', { workloadId, backends: records.length });
    return { state: asleep ? STATES.ASLEEP : 'SUPERSEDED' };
  }

  // cause: what asked for it, the idle check or the manager, and by: who, from the manager (the state change event
  // says both).
  async function nap(workloadId, { cause = 'idle', by } = {}) {
    const cfg = await config(workloadId);
    // A nap requested before a pause (idle check, manager) is refused when it starts.
    if (await isPaused(workloadId)) {
      log.warn('NapSkipped', { workloadId, reason: 'paused' });
      return { state: 'SKIPPED', reason: 'paused' };
    }
    const backends = await managedBackends(cfg);
    if (!backends.length) {
      // Diverting traffic to the waker with nothing to stop or start would only break the application.
      log.warn('NapSkipped', { workloadId, reason: 'no-instances' });
      return { state: 'SKIPPED', reason: 'no-instances' };
    }
    // A rule the router cannot switch would send traffic to the stopped backend: no nap until it is fixed.
    const { issues } = await rulesFor(cfg);
    if (issues.length) {
      log.warn('NapSkipped', { workloadId, reason: 'rules not instrumented', issues: reasons(issues) });
      return { state: 'SKIPPED', reason: 'rules not instrumented', issues: reasons(issues) };
    }
    const napping = await store.transition(workloadId, {
      cond: { state: STATES.AWAKE },
      set: { state: STATES.NAPPING, napBackends: JSON.stringify(backends.map(toRecord)) },
      remove: ['pendingWake'],
      cause,
      ...(by ? { by } : {}),
    });
    if (!napping) return { state: 'SKIPPED' };
    log.info('NapStarted', { workloadId });
    let stopped;
    try {
      try {
        await routeTo(cfg, 'waker');
      } catch (err) {
        // A Kubernetes switch the load balancer did not apply: nothing is stopped yet, the application keeps serving
        // (review focus 2); the next check tries again.
        if (!kubeRouted(cfg)) throw err;
        await routeTo(cfg, 'app', { allowIssues: true, wait: false }).catch((back) => log.error('RouteNotRestored', { workloadId, error: back.message }));
        await store.transition(workloadId, { cond: { state: STATES.NAPPING }, set: { state: STATES.AWAKE, awakeSince: now() }, remove: ['pendingWake'], cause: 'switch-failed' });
        log.warn('NapAborted', { workloadId, reason: err.message });
        return { state: STATES.AWAKE, aborted: true, error: err.message };
      }
      await sleep(cfg.drainSeconds * 1000);
      // Commit point: after this transition the instances are stopped even if a request arrives. A pause written since the
      // nap started aborts it, like a request.
      const paused = await isPaused(workloadId);
      const committed = !paused && (await store.transition(workloadId, { cond: { state: STATES.NAPPING, pendingWake: false }, set: { stopping: true } }));
      if (!committed) {
        await routeTo(cfg, 'app');
        await store.transition(workloadId, {
          cond: { state: STATES.NAPPING },
          set: { state: STATES.AWAKE, awakeSince: now() },
          remove: ['pendingWake', 'stopping'],
          cause: paused ? 'paused' : 'pending-wake',
        });
        log.info('NapAborted', { workloadId, ...(paused ? { reason: 'paused' } : {}) });
        return { state: STATES.AWAKE, aborted: true };
      }
      // What the nap stops, for the manager's savings (R9a): described before the stop, never failing the nap.
      stopped = await describeStopped(clients, backends).catch((err) => [{ kind: 'unknown', backend: 'all', reason: String(err?.message ?? err).slice(0, 200) }]);
      await sleepBackends(clients, backends, { sleep, now, deadline: now() + STOP_TIMEOUT_MS });
      // A fallback instance type is for one wake only (R7a, FinOps): stopped, an instance gets its own type back.
      await revertInstanceTypes(ec2, backends.filter((b) => b.kind === 'instance').map((b) => b.id), log);
      if (!(await waitTargetsReleased(elbv2, cfg.appTargetGroupArn, { sleep, now, deadline: now() + RELEASE_TIMEOUT_MS, draining: !cfg.kubernetes }))) {
        log.warn('TargetsNotReleased', { workloadId });
      }
    } catch (err) {
      log.error('NapFailed', { workloadId, error: err.message });
      const at = now();
      const failed = failedSpec(err, { step: 'nap', at });
      await store.transition(workloadId, {
        cond: { state: STATES.NAPPING }, set: { state: STATES.FAILED, failedAt: at, holders: 0, ...failed.set }, increment: failed.increment,
        remove: ['stopping'], cause: 'nap-failed', event: failed.event,
      });
      return { state: STATES.FAILED, error: err.message };
    }
    const asleep = await store.transition(workloadId, {
      cond: { state: STATES.NAPPING, pendingWake: false }, set: { state: STATES.ASLEEP, holders: 0 }, remove: ['stopping', 'instanceTypes'], event: { stopped },
    });
    if (asleep) {
      log.info('NapCompleted', { workloadId });
      return { state: STATES.ASLEEP };
    }
    const wakeId = newId();
    const waking = await store.transition(workloadId, {
      cond: { state: STATES.NAPPING },
      set: { state: STATES.WAKING, wakeId, wakeStartedAt: now() },
      remove: ['stopping', 'pendingWake'],
      increment: ['wakeCount'],
      cause: 'pending-wake',
    });
    if (!waking) return { state: 'UNKNOWN' };
    log.info('WakeRequested', { workloadId, wakeId, reason: 'pendingWake' });
    return wake(workloadId, wakeId, cfg);
  }

  // Rules found from the workload's target group, and the switch of its instrumented rules (issues are logged, and only
  // block a switch to the waker).
  const rulesFor = async (cfg) => (await resolveRules(elbv2, [cfg])).get(cfg.workloadId);
  const reasons = (issues) => issues.map((i) => i.reason);
  // A throttled switch is tried again for up to 3 minutes, within the invocation's budget. A Kubernetes workload behind an
  // Ingress is switched through the Ingress the controller reads (vision docs/specs/2026-10-11-kubernetes-design.md, §6).
  const kubeRouted = (cfg) => cfg.kubernetes?.switch === 'ingress' || cfg.kubernetes?.switch === 'patched-ingress';
  const routeTo = (cfg, target, options = {}) => {
    const onIssues = (issues) => log.warn('RuleIssues', { workloadId: cfg.workloadId, issues: reasons(issues) });
    if (kubeRouted(cfg)) return routeIngress({ elbv2, kubernetesOf }, cfg, target, { ...options, sleep, now, onIssues });
    return setRoute(elbv2, cfg, target, { ...options, sleep, now, until: Math.min(now() + ROUTE_RETRY_MS, budgetEnd), onIssues });
  };
  // The target group the switch sends the application's requests to: Dormeto's own for a grouped Ingress (once the
  // controller made it), else the workload's.
  const servingGroup = async (cfg, found) => (cfg.kubernetes?.switch === 'ingress' ? await dormetoTargetGroup(elbv2, cfg, found) : null) ?? cfg.appTargetGroupArn;
  // The other target groups whose requests count for the idle window.
  const otherRequestGroups = async (cfg, found) => {
    const serving = await servingGroup(cfg, found);
    return serving === cfg.appTargetGroupArn ? [] : [serving.split(':').at(-1)];
  };

  // A drift event the check found (R4c's drift events; the onboarder records its own repairs).
  async function recordDrift(workloadId, kind, detail) {
    log.warn('DriftFound', { workloadId, kind, detail });
    await store.putDrift?.(workloadId, { at: new Date(now()).toISOString(), by: 'check', kind, detail })
      .catch((err) => log.warn('DriftUnrecorded', { workloadId, error: err.message }));
  }

  // ctx (an idle check): its rules snapshot (what it compares; anything it changes is read again) and its clients.
  async function reconcile(cfg, ctx = null) {
    const { workloadId } = cfg;
    let run = await store.getRun(workloadId);
    if (!run) return null;
    const stuckBefore = now() - NAPPING_STUCK_MS;
    if (run.state === STATES.NAPPING && (run.updatedAt ?? 0) < stuckBefore) {
      log.warn('NapStuck', { workloadId });
      const failed = failedSpec(failureError('timeout', `the nap did not finish within ${NAPPING_STUCK_MS / 60_000} minutes (its invocation stopped)`), { step: 'nap', at: now() });
      return (await store.transition(workloadId, {
        cond: { state: STATES.NAPPING, olderThan: { field: 'updatedAt', ms: stuckBefore } },
        set: { state: STATES.FAILED, failedAt: now(), holders: 0, ...failed.set },
        increment: failed.increment,
        remove: ['stopping'],
        cause: 'nap-stuck',
        event: failed.event,
      })) ?? store.getRun(workloadId);
    }
    const wakeStuckBefore = now() - cfg.wakeTimeoutSeconds * 1000 - WAKING_STUCK_GRACE_MS;
    if (run.state === STATES.WAKING && (run.wakeStartedAt ?? 0) < wakeStuckBefore) {
      log.warn('WakeStuck', { workloadId, wakeId: run.wakeId });
      const failed = failedSpec(failureError('timeout', `the wake did not finish within ${cfg.wakeTimeoutSeconds} s (its invocation stopped)`), { step: 'wake', wakeId: run.wakeId, at: now() });
      return (await store.transition(workloadId, {
        cond: { state: STATES.WAKING, wakeId: run.wakeId },
        set: { state: STATES.FAILED, failedAt: now(), holders: 0, ...failed.set },
        increment: failed.increment,
        cause: 'wake-stuck',
        event: failed.event,
      })) ?? store.getRun(workloadId);
    }
    if (![STATES.AWAKE, STATES.ASLEEP, STATES.FAILED].includes(run.state)) return run;

    const backends = await managedBackends(cfg, ctx?.scope);
    const statuses = backends.length ? await backendStatuses(clients, backends) : {};
    // The primary backends decide the state; companions (databases) follow it.
    const primaries = backends.filter((b) => !isCompanion(b));
    const companions = backends.filter(isCompanion);
    // The kinds of its backends, for the manager's lists: written when they change.
    const kinds = [...new Set([...primaries, ...companions].map((b) => b.kind))].join(',');
    if (kinds !== (run.backendKinds ?? '')) {
      await store.setBackendKinds(workloadId, kinds).catch((err) => log.warn('BackendKindsUnwritten', { workloadId, error: err.message }));
    }
    // No managed primary backend: nothing to infer (every() would be vacuously true).
    const all = (name) => primaries.length > 0 && primaries.every((b) => statuses[backendKey(b)] === name);
    const from = run.state;
    if (from !== STATES.AWAKE && all('running') && (await healthyCount(elbv2, cfg.appTargetGroupArn)) >= 1) {
      log.warn(from === STATES.FAILED ? 'FailedRecovered' : 'ExternalWake', { workloadId });
      // GitOps resetting replicas behind the waker's back (section 8 of the Kubernetes design): drift, not a visitor's wake.
      for (const b of from === STATES.ASLEEP ? primaries.filter((p) => p.kind === 'k8s') : []) {
        await recordDrift(workloadId, 'replicas set while asleep', `${b.owner.kind} ${b.namespace}/${b.owner.name} runs ${b.replicas} replica${b.replicas === 1 ? '' : 's'}, set outside Dormeto (a GitOps tool resetting spec.replicas?)`);
      }
      if (run.napBackends) await resumeBackends(clients, JSON.parse(run.napBackends));
      else await startCompanions(clients, companions);
      await routeTo(cfg, 'app');
      run = (await store.transition(workloadId, {
        cond: { state: from }, set: { state: STATES.AWAKE, awakeSince: now() }, remove: ['napBackends', 'napInstances', 'failure', 'consecutiveFailures'],
        cause: from === STATES.FAILED ? 'recovered' : 'external-start',
      }))
        ?? (await store.getRun(workloadId));
    } else if (from !== STATES.ASLEEP && all('stopped')) {
      log.warn(from === STATES.FAILED ? 'FailedRecovered' : 'ExternalStop', { workloadId });
      // The backend is already stopped: the instrumented rules go to the waker whatever the issues.
      await routeTo(cfg, 'waker', { allowIssues: true });
      await stopCompanions(clients, companions);
      run = (await store.transition(workloadId, { cond: { state: from }, set: { state: STATES.ASLEEP, holders: 0 }, cause: from === STATES.FAILED ? 'recovered' : 'external-stop' }))
        ?? (await store.getRun(workloadId));
    }

    // A database started by AWS after 7 days stopped (or by hand) must not run while the workload sleeps.
    if (run.state === STATES.ASLEEP && companions.some((b) => statuses[backendKey(b)] === 'running')) {
      log.warn('DatabaseRestopped', { workloadId });
      await stopCompanions(clients, companions);
    }

    // Keep the route consistent with the state, for example after a Terraform apply reset the weights.
    // A FAILED workload stays behind the waker, so that requests retry the wake.
    const expected = run.state === STATES.AWAKE ? 'app' : [STATES.ASLEEP, STATES.FAILED].includes(run.state) ? 'waker' : null;
    if (expected) {
      // Kubernetes changes do not reach CloudTrail: the check sees what drifted in the switching Ingress; the route repair
      // below applies it again.
      if (kubeRouted(cfg)) {
        const changed = await ingressDrift({ kubernetesOf }, cfg, expected).catch((err) => {
          log.warn('IngressDriftUnread', { workloadId, error: err.message });
          return [];
        });
        for (const reason of changed) await recordDrift(workloadId, cfg.kubernetes.switch === 'ingress' ? 'Dormeto Ingress re-applied' : 'Ingress patch re-applied', reason);
      }
      let found = ctx?.rules?.get(workloadId) ?? (await rulesFor(cfg));
      // A workload the manager onboarded: the onboarder re-applies what drifted (a shadow deleted, a new customer rule) and
      // removes the orphan shadows; a failure is retried at the next check, never stopping this one.
      const repairable = [...found.issues.filter((i) => i.repairable), ...(found.orphans ?? [])];
      if (cfg.source && (queueRepair || invokeOnboarder) && repairable.length) {
        try {
          await (queueRepair ?? invokeOnboarder)({ action: 'repair', workloadId, by: 'check' });
          log.info('RepairRequested', { workloadId, issues: reasons(repairable) });
        } catch (err) {
          log.error('RepairRequestFailed', { workloadId, error: err.message });
        }
      }
      // Acting on the snapshot of the check would write back rules as they were minutes ago: read them again first.
      const switching = found.instrumented.some((rule) => currentTarget(rule.Actions, cfg) !== expected);
      if (ctx?.rules && (switching || (run.state === STATES.ASLEEP && found.issues.some((i) => i.arn)))) found = await rulesFor(cfg);
      // A rule the router cannot switch sends requests to the stopped backend: wake the workload (it is not napped again
      // until the rule is instrumented or removed). A target group without any rule has no such rule: no wake.
      const ruleIssues = found.issues.filter((i) => i.arn);
      if (run.state === STATES.ASLEEP && ruleIssues.length) {
        log.warn('WokenForRuleIssues', { workloadId, issues: reasons(ruleIssues) });
        await forceWake(workloadId, 'dormeto', 'rule-issues');
        return (await store.getRun(workloadId)) ?? run;
      }
      // Every instrumented rule (a rule switched back alone, a mixed route, is repaired too); asleep or failed, the
      // backend does not serve, so the issues do not hold the instrumented rules back from the waker.
      const repaired = await routeTo(cfg, expected, { found, allowIssues: expected === 'waker', wait: false });
      if (repaired.length) log.warn('RouteRepaired', { workloadId, route: expected, rules: repaired });
    }

    if ((run.holders ?? 0) > 0 && (run.updatedAt ?? 0) < now() - HOLDERS_STALE_MS) {
      log.warn('HoldersReset', { workloadId, holders: run.holders });
      run = (await store.transition(workloadId, { cond: { state: run.state }, set: { holders: 0 } })) ?? run;
    }
    return run;
  }

  async function checkOne(cfg, paused, ctx = null) {
    const run = await reconcile(cfg, ctx);
    // A failed workload still paying (its backends run without a healthy target: the reconcile left it FAILED) is stopped
    // once its idle window has passed since the failure (R7a, FinOps); a paused one is left for its team.
    if (run?.state === STATES.FAILED && !paused && (run.failedAt ?? 0) <= now() - cfg.idleMinutes * 60_000) {
      if (queueWork) await queueWork({ action: 'release', workloadId: cfg.workloadId, requestedAt: now() });
      else if (invokeSelf) await invokeSelf({ action: 'release', workloadId: cfg.workloadId });
      log.info('ReleaseRequested', { workloadId: cfg.workloadId });
      return { state: run.state, release: 'requested' };
    }
    if (!run || run.state !== STATES.AWAKE) return { state: run?.state ?? 'UNKNOWN' };
    if (!run.awakeSince) {
      // First check after deployment: the idle window starts now, not at the epoch.
      await store.transition(cfg.workloadId, { cond: { state: STATES.AWAKE }, set: { awakeSince: now() } });
      return { state: run.state };
    }
    if (paused) return { state: run.state, paused: true };
    const t = now();
    const idleMs = cfg.idleMinutes * 60_000;
    if ((run.awakeSince ?? 0) > t - idleMs) return { state: run.state };
    // The request metric is read once the workload can be idle: not before its last request plus the idle window.
    if ((run.idleNotBefore ?? 0) > t) return { state: run.state, idleNotBefore: run.idleNotBefore };
    const last = await lastRequestAt(cloudwatch, cfg, t - idleMs, t, cfg.kubernetes ? await otherRequestGroups(cfg, ctx?.rules?.get(cfg.workloadId)) : []);
    if (last !== null) {
      const idleNotBefore = last + idleMs;
      await store.transition(cfg.workloadId, { cond: { state: STATES.AWAKE }, set: { idleNotBefore } });
      return { state: run.state, idleNotBefore };
    }
    // A nap lasts minutes: queued (at most 10 at a time), else run in its own invocation, never delaying the check.
    if (queueWork) {
      await queueWork({ action: 'nap', workloadId: cfg.workloadId, requestedAt: t });
      log.info('NapRequested', { workloadId: cfg.workloadId });
      return { state: run.state, nap: 'queued' };
    }
    if (invokeSelf) {
      await invokeSelf({ action: 'nap', workloadId: cfg.workloadId });
      log.info('NapRequested', { workloadId: cfg.workloadId });
      return { state: run.state, nap: 'requested' };
    }
    return nap(cfg.workloadId);
  }

  // --- Manager interface: list, status, force-wake ------------------------------------------------------------------

  const status = createStatus({ ec2, elbv2, cloudwatch, autoscaling, ecs, tagging, appscaling, rds, kubernetesOf, now, version: router });
  const hosts = { at: 0, byWorkload: new Map() };
  // Host of each workload: the first of its rules (found from its target group) with a host condition; one listing per
  // load balancer for all workloads, cached five minutes.
  // cachedOnly (the report after a check): the hosts the check found, none for a workload it has not reached yet.
  async function workloadHosts(configs, { cachedOnly = false } = {}) {
    if (cachedOnly || (now() - hosts.at < 5 * 60_000 && configs.every((c) => hosts.byWorkload.has(c.workloadId)))) return hosts.byWorkload;
    return rememberHosts(configs, await resolveRules(elbv2, configs).catch(() => new Map()), now());
  }
  // The check's own listing fills the cache as it goes (the workloads it reached): its report lists no load balancer again.
  function rememberHosts(configs, found, at) {
    for (const c of configs) hosts.byWorkload.set(c.workloadId, (found.get(c.workloadId)?.rules ?? []).map(hostOf).find(Boolean) ?? null);
    hosts.at = at;
    return hosts.byWorkload;
  }

  async function list({ cachedHosts = false } = {}) {
    const { configs, schedules } = await store.listWorkloads();
    const byWorkload = await workloadHosts(configs, { cachedOnly: cachedHosts });
    let pausesError;
    const pauses = await store.listPauses().catch((err) => {
      pausesError = err.message;
      log.warn('PausesUnreadable', { error: err.message });
      return [];
    });
    const routerPauses = pauses.filter((p) => p.workloadId === null);
    const workloads = await Promise.all(configs.map(async (cfg) => {
      const [run, stats] = await Promise.all([
        store.getRun(cfg.workloadId),
        store.getStats(cfg.workloadId, STATS_DAYS).catch(() => null),
      ]);
      const own = pauses.filter((p) => p.workloadId === cfg.workloadId);
      return workloadSummary(cfg, run, byWorkload.get(cfg.workloadId), totals(stats), shownPauses([...own, ...routerPauses]), schedules.has(cfg.workloadId));
    }));
    const health = await store.getCheck().catch(() => null);
    return {
      router: {
        name: router.name, version: router.version, build: router.build, checkSchedule: router.checkSchedule ?? null,
        lastScheduledCheckAt: health?.lastScheduledCheckAt ? new Date(health.lastScheduledCheckAt).toISOString() : null,
        pauses: shownPauses(routerPauses), ...(pausesError ? { pausesError } : {}),
      },
      workloads,
    };
  }

  async function workloadStatus(workloadId) {
    const cfg = await config(workloadId);
    const run = await store.getRun(workloadId);
    const schedule = await store.getSchedule(workloadId);
    return { ...await status(workloadId, cfg, run ?? {}, {
      pauses: await pausesFor(workloadId),
      drift: store.listDrift ? await store.listDrift(workloadId, 10).catch(() => []) : [],
      noWakeRules: describeRules([{ level: 'router', rules: defaultRules }, { level: 'workload', rules: cfg.noWakeRules }]),
      wakeRules: describeRules([{ level: 'wake', rules: cfg.wakeRules }]),
      loadStats: () => store.getStats(workloadId, STATS_DAYS),
      loadLists: async () => [...await describeStoredLists(store, ipLists), ...(catalog ? (await catalog.describe()).lists : [])],
    }), ...scheduleView(schedule, run) };
  }

  // --- Schedules (R12): stored beside the workload, applied by the check ---------------------------------------------

  // What people read: the schedule (its `at` as ISO; null when none), the next events and the maintenance wake.
  function scheduleView(schedule, run) {
    const due = schedule && run?.state === STATES.ASLEEP && run.stateAt ? maintenanceDue(schedule, run.stateAt) : null;
    return {
      schedule: schedule && { ...schedule, at: new Date(schedule.at).toISOString() },
      next: nextEvents(schedule, now()),
      maintenanceDue: due === null ? null : new Date(due).toISOString(),
    };
  }

  async function setSchedule({ workloadId, schedule, by }) {
    await config(workloadId);
    const problems = scheduleProblems(schedule);
    if (problems.length) return { problems };
    const stored = { ...normalizeSchedule(schedule), by, at: now() };
    await store.putSchedule(workloadId, stored);
    log.info('Scheduled', { workloadId, by });
    return scheduleView(stored, await store.getRun(workloadId));
  }

  async function clearSchedule({ workloadId, by }) {
    await config(workloadId);
    const cleared = await store.deleteSchedule(workloadId);
    log.info('ScheduleCleared', { workloadId, by, cleared });
    return { cleared };
  }

  async function count(workloadId, counter) {
    try {
      await store.count(workloadId, counter);
    } catch (err) {
      log.warn('StatsWriteFailed', { workloadId, counter, error: err.message });
    }
  }

  // Operator request from the manager: no retry delay; the wake itself runs in its own invocation.
  // inline (the work queue): the wake runs in this invocation instead of one of its own.
  async function forceWake(workloadId, by, kind = 'manager', { inline = false } = {}) {
    await config(workloadId);
    const run = await store.getRun(workloadId);
    if (run?.state === STATES.ASLEEP || run?.state === STATES.FAILED) {
      const wakeId = newId();
      const next = await store.transition(workloadId, {
        cond: { state: run.state }, set: { state: STATES.WAKING, wakeId, wakeStartedAt: now() }, remove: ['failedAt'], increment: ['wakeCount'], cause: kind,
        ...(by ? { by } : {}),
      });
      if (!next) return { state: (await store.getRun(workloadId))?.state };
      log.info('WakeRequested', { workloadId, wakeId, trigger: { kind, by } });
      await count(workloadId, `wake:${kind}`);
      if (inline) return wake(workloadId, wakeId);
      await invokeSelf({ action: 'wake', workloadId, wakeId });
      return { state: STATES.WAKING };
    }
    if (run?.state === STATES.NAPPING) {
      if (await store.setPendingWake(workloadId)) {
        log.info('PendingWake', { workloadId, trigger: { kind, by } });
        await count(workloadId, `wake:${kind}`);
      }
      return { state: STATES.NAPPING, pendingWake: true };
    }
    return { state: run?.state };
  }

  // IP reputation lists: downloads run in their own invocation, never delaying the workload checks.
  async function requestListRefresh() {
    if (!lists || !invokeSelf) return;
    try {
      const names = await lists.due();
      if (!names.length) return;
      await invokeSelf({ action: 'refresh-lists', names });
      log.info('ListRefreshRequested', { names });
    } catch (err) {
      log.error('ListRefreshCheckFailed', { error: err.message });
    }
  }

  async function check(source) {
    const started = now();
    const holder = newId();
    if (store.acquireCheckLease && !(await store.acquireCheckLease(holder, started + CHECK_LEASE_MS, started))) {
      log.warn('CheckSkipped', { reason: 'previous check still running' });
      return { skipped: 'the previous check is still running' };
    }
    try {
      // Only the schedule proves that naps happen on their own: the e2e and operators also call check.
      if (source === 'schedule') {
        await store.recordScheduledCheck(now()).catch((err) => log.warn('CheckRecordFailed', { error: err.message }));
        // Measured before the work: a check that dies (its timeout lands it in the failure queue) still refreshes it.
        await storedHealth(now(), { refresh: true });
      }
      await requestListRefresh();
      const pauses = await activePauses();
      // Pauses that cannot be read stop every nap of this check (the reconcile still runs).
      const paused = (workloadId) => pauses === null || pauses.some((p) => p.workloadId === null || p.workloadId === workloadId);
      const configs = (await store.listConfigs()).sort((a, b) => a.workloadId.localeCompare(b.workloadId));
      // Starting after the workload where the previous check stopped (its time budget), so every workload gets its turn.
      const cursor = (await store.getCheck?.().catch(() => null))?.cursor;
      const from = cursor ? configs.findIndex((c) => c.workloadId > cursor) : 0;
      const order = from > 0 ? [...configs.slice(from), ...configs.slice(0, from)] : configs;
      // The rules of the workloads, a chunk at a time in the check's order, each load balancer listed once (the listing
      // cache); backends found by tag once. A chunk is not started when its listing would end past the budget.
      const listing = { balancers: new Map(), listed: new Map(), tags: new Map() };
      const ctx = { rules: new Map(), scope: checkScope(clients) };
      const deadline = Math.min(started + CHECK_BUDGET_MS, budgetEnd);
      const results = [];
      let next = 0;
      let listingMs = 0;
      while (next < order.length && now() < deadline && (next === 0 || now() + listingMs < deadline)) {
        const chunk = order.slice(next, next + CHECK_CHUNK);
        const listedAt = now();
        const found = await resolveRules(elbv2, chunk, listing).catch((err) => {
          log.warn('CheckRulesUnread', { error: err.message });
          return null;
        });
        listingMs = now() - listedAt;
        if (found) {
          for (const [id, rules] of found) ctx.rules.set(id, rules);
          rememberHosts(chunk, found, listedAt);
        }
        let i = 0;
        await Promise.all(Array.from({ length: Math.min(CHECK_CONCURRENCY, chunk.length) }, async () => {
          while (i < chunk.length && now() < deadline) {
            const cfg = chunk[i++];
            next += 1;
            try {
              results.push({ workloadId: cfg.workloadId, ...(await checkOne(cfg, paused(cfg.workloadId), ctx)) });
            } catch (err) {
              log.error('CheckFailed', { workloadId: cfg.workloadId, error: err.message });
              results.push({ workloadId: cfg.workloadId, error: err.message });
            }
          }
        }));
      }
      // Cut short: the next check starts after the last workload checked (where this one started if it checked none).
      const stopped = next < order.length ? (next > 0 ? order[next - 1].workloadId : cursor ?? null) : null;
      if (next < order.length) log.warn('CheckBudgetReached', { checked: next, workloads: order.length, next: order[next].workloadId });
      await store.setCheckCursor?.(stopped).catch((err) => log.warn('CheckCursorNotStored', { error: err.message }));
      await report(started);
      return results;
    } finally {
      await store.releaseCheckLease?.(holder).catch((err) => log.warn('CheckLeaseNotReleased', { error: err.message }));
    }
  }

  // The router's state to the manager after each check: its workloads as the list gives them, counts and health.
  async function report(started) {
    if (!publisher.enabled) return;
    try {
      const [info, listed] = await Promise.all([routerInfo(), list({ cachedHosts: true })]);
      await publisher.checked({
        checkedAt: iso(started), durationMs: now() - started, health: info.health, pauses: info.pauses, counts: info.workloads.byState, workloads: listed.workloads,
      });
    } catch (err) {
      log.warn('ReportFailed', { error: err.message });
    }
  }

  // The name people see (design section 7), for a workload the manager onboarded (Terraform writes the others').
  async function rename({ workloadId, name, by }) {
    const cfg = await config(workloadId);
    if (!cfg.source) throw new Error(`workload ${workloadId} was written by Terraform: set name in its workload module`);
    const checked = checkName(name);
    if (!checked.name) throw new Error('name: required');
    if (checked.problem) throw new Error(checked.problem);
    // Conditional: a rename racing an offboarding never writes the workload back.
    if (!(await store.putConfig(workloadId, { ...cfg, name: checked.name }, { mustExist: true }))) throw new Error(`workload not configured: ${workloadId}`);
    log.info('Renamed', { workloadId, name: checked.name, by });
    return { workloadId, name: checked.name };
  }

  // The workload's tags (tags design, section 3), replaced whole, for a workload the manager onboarded.
  async function tag({ workloadId, tags, by }) {
    const cfg = await config(workloadId);
    if (!cfg.source) throw new Error(`workload ${workloadId} was written by Terraform: set tags in its workload module`);
    const problem = tagsProblem(tags);
    if (problem) throw new Error(problem);
    // Conditional: a tag racing an offboarding never writes the workload back.
    if (!(await store.putConfig(workloadId, { ...cfg, tags }, { mustExist: true }))) throw new Error(`workload not configured: ${workloadId}`);
    log.info('Tagged', { workloadId, tags, by });
    return { workloadId, tags };
  }

  async function ensureAwake(workloadId) {
    const cfg = await config(workloadId);
    const run = await store.getRun(workloadId);
    if (run?.state !== STATES.AWAKE) return { state: run?.state };
    if ((await healthyCount(elbv2, cfg.appTargetGroupArn)) < 1) return { state: run.state, healthy: 0 };
    const repaired = await routeTo(cfg, 'app');
    if (repaired.length) log.warn('RouteRepaired', { workloadId, route: 'app', rules: repaired });
    return { state: run.state, changed: repaired.length > 0 };
  }

  // --- Pauses: a paused workload (or every workload of a paused router) is never napped ------------------------------

  const iso = (ms) => new Date(ms).toISOString();
  const expired = (p) => p.until !== undefined && p.until <= now();
  // Exclusions first, then the workload's own pause, then the router's; the newest first within each.
  const rank = (p) => (p.exclusionId ? 0 : p.workloadId ? 1 : 2);
  const shownPauses = (pauses) => pauses.filter((p) => !expired(p)).sort((a, b) => rank(a) - rank(b) || b.at - a.at)
    .map(({ workloadId, by, at, reason, until, keepAsleep, exclusionId }) => ({
      scope: workloadId ? 'workload' : 'router', by, at: iso(at), reason, until: until === undefined ? null : iso(until), keepAsleep: keepAsleep === true,
      ...(exclusionId ? { exclusionId } : {}),
    }));
  const pauseText = (p) => `${p.scope === 'router' ? 'router ' : ''}paused by ${p.by}: ${p.reason}`;

  // Active pauses of a workload: its own and its router's.
  async function pausesFor(workloadId) {
    const [own, routerPauses] = await Promise.all([store.getPauses(workloadId), store.getPauses(null)]);
    return shownPauses([...own, ...routerPauses]);
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
      const deleted = await store.deletePause(p.workloadId, { exclusionId: p.exclusionId, at: p.at }).catch((err) => {
        log.warn('PauseDeleteFailed', { workloadId: p.workloadId, error: err.message });
        return false;
      });
      if (deleted) log.info('PauseExpired', { workloadId: p.workloadId, by: p.by, reason: p.reason, ...(p.exclusionId ? { exclusionId: p.exclusionId } : {}) });
    }
    return pauses.filter((p) => !expired(p));
  }

  function pauseRecord({ by, reason, until, keepAsleep, exclusionId }) {
    const text = typeof reason === 'string' ? reason.trim() : '';
    if (!text || text.length > REASON_MAX) throw new Error(`reason required (1 to ${REASON_MAX} characters)`);
    let untilMs;
    if (until !== undefined && until !== null) {
      untilMs = typeof until === 'number' ? until : Date.parse(until);
      if (!(untilMs > now() && untilMs <= now() + PAUSE_MAX_MS)) throw new Error('until must be in the future, within 366 days');
    }
    return {
      by: by ?? 'unknown', at: now(), reason: text, ...(untilMs === undefined ? {} : { until: untilMs }), keepAsleep: keepAsleep === true,
      ...(exclusionId ? { exclusionId: String(exclusionId) } : {}),
    };
  }

  // Pause the router (no workloadId) or a workload; unless keepAsleep, its asleep and failed workloads are woken and a
  // napping one gets a pending wake.
  async function pause(event) {
    const workloadId = event.workloadId ?? null;
    if (workloadId) {
      // An exclusion names the target group it matched: another workload of the same id (another router) is not it.
      const cfg = await config(workloadId);
      if (event.targetGroupArn && cfg.appTargetGroupArn !== event.targetGroupArn) {
        throw new Error(`workload not configured: ${workloadId} (its target group is not ${event.targetGroupArn})`);
      }
    }
    const record = pauseRecord(event);
    await store.putPause(workloadId, record);
    log.info('Paused', { workloadId, ...record });
    const woken = [];
    if (!record.keepAsleep) {
      const ids = workloadId ? [workloadId] : (await store.listConfigs()).map((c) => c.workloadId);
      for (const id of ids) {
        try {
          // A router pause queues the wakes of its asleep workloads (it may have hundreds): run 10 at a time.
          const state = !workloadId && queueWork ? (await store.getRun(id))?.state : null;
          if (state === STATES.ASLEEP || state === STATES.FAILED) {
            await queueWork({ action: 'wake', workloadId: id, by: record.by, kind: 'pause' });
            woken.push(id);
            continue;
          }
          const result = await forceWake(id, record.by, 'pause');
          if (result.state === STATES.WAKING || result.pendingWake) woken.push(id);
        } catch (err) {
          log.error('PauseWakeFailed', { workloadId: id, error: err.message });
        }
      }
    }
    return { pause: shownPauses([{ workloadId, ...record }])[0], woken };
  }

  // Resume removes one pause: the operator's, or the given exclusion's; the router's and the others stay.
  async function resume({ workloadId = null, by, exclusionId }) {
    const existing = (await store.getPauses(workloadId ?? null)).find((p) => (p.exclusionId ?? null) === (exclusionId ?? null));
    if (!existing) return { resumed: false };
    await store.deletePause(workloadId ?? null, { exclusionId });
    log.info('Resumed', { workloadId: workloadId ?? null, by, ...(exclusionId ? { exclusionId } : {}) });
    return { resumed: true };
  }

  // Manager nap: refused at once with the reason, else run in its own invocation (a nap outlasts the API call).
  async function requestNap({ workloadId, by }) {
    await config(workloadId);
    const run = await store.getRun(workloadId);
    if (run?.state !== STATES.AWAKE) return { requested: false, reason: `not awake (${run?.state ?? 'UNKNOWN'})` };
    const [first] = await pausesFor(workloadId);
    if (first) return { requested: false, reason: pauseText(first) };
    if (queueWork) await queueWork({ action: 'nap', workloadId, requestedAt: now(), by });
    else await invokeSelf({ action: 'nap', workloadId, by });
    log.info('NapRequested', { workloadId, trigger: { kind: 'manager', by } });
    return { requested: true };
  }

  // --- Work queue: naps and the wakes of a router pause ---------------------------------------------------------------

  // A nap the check (or the manager) queued: refused when the workload is no longer awake (delivered twice, or napped
  // since), woke since it was asked for, had requests since (when it waited more than a minute), or when it waited too
  // long (the next check decides again).
  async function queuedNap({ workloadId, requestedAt, by }) {
    const run = await store.getRun(workloadId);
    let reason = run?.state !== STATES.AWAKE ? `not awake (${run?.state ?? 'UNKNOWN'})`
      : (run.awakeSince ?? 0) > requestedAt ? 'woken since it was requested'
        : now() - requestedAt > NAP_MAX_AGE_MS ? `requested more than ${NAP_MAX_AGE_MS / 60_000} minutes ago` : null;
    const recheck = !reason && now() - requestedAt > NAP_RECHECK_MS ? await config(workloadId) : null;
    if (recheck && (await lastRequestAt(cloudwatch, recheck, requestedAt, now(), recheck.kubernetes ? await otherRequestGroups(recheck) : [])) !== null) {
      reason = 'requests since it was requested';
    }
    if (reason) {
      log.warn('NapSkipped', { workloadId, reason });
      return { state: 'SKIPPED', reason };
    }
    return nap(workloadId, { cause: by ? 'manager' : 'idle', by });
  }

  // A wake a router pause queued: skipped when the workload is gone (offboarded since) or no pause applies any more
  // (resumed before the queue reached it).
  async function queuedWake({ workloadId, by, kind = 'manager' }) {
    const reason = !(await store.getConfig(workloadId)) ? 'workload not configured any more'
      : kind === 'pause' && !(await isPaused(workloadId)) ? 'no pause applies any more' : null;
    if (reason) {
      log.warn('WakeSkipped', { workloadId, reason });
      return { state: 'SKIPPED', reason };
    }
    return forceWake(workloadId, by, kind, { inline: true });
  }

  // The messages of the work queue, each on its own: a failed one comes back alone (partial batch response).
  async function runQueued(records) {
    const batchItemFailures = [];
    for (const record of records) {
      try {
        const message = JSON.parse(record.body);
        if (message.action === 'nap') await queuedNap(message);
        else if (message.action === 'wake') await queuedWake(message);
        else if (message.action === 'release') await release(message.workloadId);
        else throw new Error(`unknown queued action: ${message.action}`);
      } catch (err) {
        log.error('QueuedWorkFailed', { messageId: record.messageId, error: err.message });
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures };
  }

  // --- Router: identity, configuration with its source, workloads, pauses, health ------------------------------------

  const TERRAFORM = 'terraform';
  async function measure(t) {
    const [metrics, queues, limit] = await Promise.all([
      lambdaMetrics(cloudwatch, router.functions ?? {}, t).catch((err) => ({ error: err.message })),
      queueDepths(sqs, router.queues).catch((err) => ({ error: err.message })),
      lambda ? lambda.getAccountSettings({}).then((s) => ({ limit: s.AccountLimit?.ConcurrentExecutions })).catch((err) => ({ error: err.message })) : null,
    ]);
    const measured = { at: t, lambda: metrics, queues, limit };
    await store.putHealth?.(measured).catch((err) => log.warn('HealthNotStored', { error: err.message }));
    return measured;
  }
  // The stored health; measured when there is none, when refreshing (the scheduled check) and it is 15 minutes old, or
  // on read once it is 30 minutes old (the scheduled checks that store it are not running).
  async function storedHealth(t, { refresh = false } = {}) {
    const stored = await store.getHealth?.().catch(() => null);
    if (stored && t - stored.at < (refresh ? HEALTH_REFRESH_MS : 2 * HEALTH_REFRESH_MS)) return stored;
    return measure(t);
  }
  // Concurrent executions the router can need at once besides held requests: its queued naps and wakes (the work queue's
  // 10), drift repairs (2) and the check.
  const HEADROOM = 10 + 2 + 1;
  // The account's Lambda concurrency is shared by every function of the region: the router's need is what its waker used
  // (24-hour peak) plus the headroom; the worst case (every workload not awake woken at once, each holding up to its
  // maxHolders) is information only.

  async function routerInfo() {
    const t = now();
    const measured = await storedHealth(t);
    const configs = await store.listConfigs();
    const runs = await Promise.all(configs.map((cfg) => store.getRun(cfg.workloadId).catch(() => null)));
    const needed = (measured.lambda?.waker?.peakConcurrency ?? 0) + HEADROOM;
    const worstCase = configs.reduce((n, c, i) => n + (runs[i]?.state === STATES.AWAKE ? 0 : c.maxHolders ?? 0), 0) + HEADROOM;
    const concurrency = measured.limit && (measured.limit.error ? { error: measured.limit.error } : { limit: measured.limit.limit, needed, worstCase });
    let pausesError;
    const pauses = await store.listPauses().then((all) => all.filter((p) => !expired(p))).catch((err) => {
      pausesError = err.message;
      return [];
    });
    const byState = {};
    for (const run of runs) byState[run?.state ?? 'UNKNOWN'] = (byState[run?.state ?? 'UNKNOWN'] ?? 0) + 1;
    const routerPaused = pauses.some((p) => p.workloadId === null);
    const updated = runs.map((run) => run?.updatedAt ?? 0).filter((ms) => ms > 0);
    const check = await store.getCheck().catch(() => null);
    const own = (await describeStoredLists(store, ipLists)).map((l) => ({ ...l, source: TERRAFORM, refreshHours: ipLists.find((c) => c.name === l.name)?.refreshHours }));
    const managed = catalog ? await catalog.describe() : null;
    const lists = [...own, ...(managed?.lists ?? [])];
    const health = healthOf({
      checkSchedule: router.checkSchedule, lastScheduledCheckAt: check?.lastScheduledCheckAt ?? null, now: t,
      lambda: measured.lambda, queues: measured.queues, failed: byState[STATES.FAILED] ?? 0, concurrency,
      // The manager's lists warn only when the router cannot read them: their freshness is the manager's alarm, once.
      ipLists: [...own, ...(managed?.lists ?? []).filter((l) => l.error && !l.pending).map(({ name, error }) => ({ name, error }))],
      catalogError: managed?.error ?? null,
    });
    if (pausesError) {
      health.problems.push({ level: 'warning', code: 'pauses-unreadable', text: `pauses unreadable: ${pausesError}` });
      if (health.status === 'ok') health.status = 'warning';
    }
    // Repairs of the last 24 hours (R4c): something outside Dormeto keeps changing what onboarding added (the customer's
    // infrastructure as code, or a person).
    const dayAgo = iso(t - 86_400_000);
    const drift24h = (await Promise.all(configs.map((c) => (store.listDrift ? store.listDrift(c.workloadId, 50).catch(() => []) : []))))
      .flat().filter((e) => e.at >= dayAgo).length;
    if (drift24h) {
      health.problems.push({ level: 'warning', code: 'drift', text: `${drift24h} drift repair${drift24h === 1 ? '' : 's'} in 24 hours: rules or tags changed outside Dormeto, repaired (see the workloads)` });
      if (health.status === 'ok') health.status = 'warning';
    }
    return {
      router: { name: router.name, version: router.version, build: router.build },
      configuration: {
        checkSchedule: { value: router.checkSchedule ?? null, source: TERRAFORM },
        ipLists: { value: ipLists.map(({ name, url, action, refreshHours }) => ({ name, url, action, refreshHours })), source: TERRAFORM },
        ...(managed ? { ipListsCatalog: { value: { url: managed.url, lists: managed.lists.map(({ name, action, refreshHours }) => ({ name, action, refreshHours })) }, source: 'manager' } } : {}),
        noWakeRules: { value: describeRules([{ level: 'router', rules: defaultRules }]), source: TERRAFORM },
        metrics: { value: router.metrics ?? null, source: TERRAFORM },
      },
      pauses: shownPauses(pauses.filter((p) => p.workloadId === null)),
      workloads: {
        total: configs.length,
        byState,
        paused: routerPaused ? configs.length : configs.filter((cfg) => pauses.some((p) => p.workloadId === cfg.workloadId)).length,
        lastActivityAt: updated.length ? iso(Math.max(...updated)) : null,
      },
      health: {
        ...health,
        checkSchedule: router.checkSchedule ?? null,
        lastScheduledCheckAt: check?.lastScheduledCheckAt ? iso(check.lastScheduledCheckAt) : null,
        lambda: measured.lambda,
        queues: measured.queues,
        ipLists: lists,
        concurrency,
        drift24h,
      },
    };
  }

  // Whether the router reaches a cluster and may do what Kubernetes workloads need (vision
  // docs/specs/2026-10-11-kubernetes-design.md, section 4), in a namespace.
  async function clusterCheck({ cluster, namespace = 'default' }) {
    try {
      const missing = await checkRights(await kubernetesOf(cluster), namespace);
      return { cluster, reachable: true, allowed: missing.length === 0, missing };
    } catch (err) {
      if (err?.status === 401 || err?.status === 403) {
        return { cluster, reachable: true, allowed: false, missing: [], reason: `the cluster does not know the router's role (no access entry, or not mapped in aws-auth): ${err.message}` };
      }
      return { cluster, reachable: false, allowed: false, missing: [], reason: err.message };
    }
  }

  return async function handler(event, context) {
    const remaining = context?.getRemainingTimeInMillis?.();
    budgetEnd = typeof remaining === 'number' ? now() + remaining - TIMEOUT_MARGIN_MS : Infinity;
    if (Array.isArray(event?.Records)) return runQueued(event.Records);
    switch (event?.action) {
      case 'wake': return wake(event.workloadId, event.wakeId);
      case 'nap': return nap(event.workloadId, { cause: event.by ? 'manager' : 'idle', by: event.by });
      case 'release': return release(event.workloadId);
      case 'check': return check(event.source);
      case 'ensure-awake': return ensureAwake(event.workloadId);
      case 'refresh-lists': return lists ? lists.refresh(event.names ?? []) : [];
      case 'list': return list();
      case 'status': return workloadStatus(event.workloadId);
      case 'force-wake': return forceWake(event.workloadId, event.by);
      case 'pause': return pause(event);
      case 'resume': return resume(event);
      case 'request-nap': return requestNap(event);
      case 'rename': return rename(event);
      case 'tag': return tag(event);
      case 'schedule': return setSchedule(event);
      case 'clear-schedule': return clearSchedule(event);
      case 'router': return routerInfo();
      case 'clusterCheck': return clusterCheck(event);
      default: throw new Error(`unknown action: ${event?.action}`);
    }
  };
}
