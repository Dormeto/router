import { Refusal, refused } from './refusal.mjs';
import { randomUUID } from 'node:crypto';
import { STATES } from './state.mjs';
import { currentTarget, hostOf, setRoute } from './route.mjs';
import { cacheFavicon, FAVICON_BUDGET_MS, hostOfRules, pageLevels } from './favicon.mjs';
import { dormetoTargetGroup, ingressDrift, routeIngress } from './kube-route.mjs';
import { checkRights } from './kube-access.mjs';
import { pingProxy } from './k8s.mjs';
import { resolveRules } from './rules.mjs';
import { healthyCount, instanceDetails, waitTargetsReleased } from './instances.mjs';
import { createStatus } from './status.mjs';
import { describeRules } from './no-wake.mjs';
import { describeStoredLists } from './list-cache.mjs';
import { failedSpec, failureError } from './failures.mjs';
import { failedWakeDecision, idleDecision, idleRecheck as recheckIdle, napWindowNow, warnResourceMissing } from './standalone-check.mjs';
import { createPauses, pauseHolds } from './pauses.mjs';
import { createWakeWatch, unhealthyError } from './wake-watch.mjs';
import { describeStopped } from './stopped.mjs';
import { revertInstanceTypes } from './capacity.mjs';
import { ENDED_DAYS_DEFAULT, maintenanceDue } from './schedule.mjs';
import { createScheduleCheck, scheduleKeeps as keptBySchedule } from './check-schedules.mjs';
import { runCheck } from './check-run.mjs';
import { STATS_DAYS, createCount, totals, workloadSummary } from './summary.mjs';
import { lastRequestAt } from './metrics.mjs';
import { createIdleSignals } from './activity.mjs';
import { checkScope } from './check-scope.mjs';
import { addWarning, healthOf, lambdaMetrics, pausesUnreadable, queueDepths } from './health.mjs';
import { pageViewOf, withWake } from './page-settings.mjs';
import { HIBERNATION_MAX_DAYS, hibernationDue, resolveHibernation, settingsProblems, workloadSettingsProblems } from './hibernation.mjs';
import { joinLevels } from './manager-settings.mjs';
import { IDLE_KEYS, createLevelsReader, describedRules, effectiveConfig } from './settings-levels.mjs';
import { resolvedSettings, withSettings } from './settings-writes.mjs';
import { askedWake, beginWake, pendingWake as setPendingWake } from './asked-wake.mjs';
import { createManagerActions, listRouter, readActivePauses, readPauses, routerAnswer, rowPauses, scheduleView } from './manager-actions.mjs';
import { requestListRefresh as askListRefresh } from './list-refresh.mjs';
import {
  backendKey, backendStatuses, companionsOf, isStandalone, primariesOf, resolveBackends, resumeBackends, sleepBackends, standaloneStatuses, startCompanions,
  stopCompanions, toRecord, wakeBackends, wakeSizeOf,
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

// The pauses' store (lib/pauses.mjs) on the DynamoDB one.
export const pauseStore = (store) => ({
  listPauses: () => store.listPauses(),
  getPauses: (workloadId) => store.getPauses(workloadId),
  putPause: (workloadId, record) => store.putPause(workloadId, record),
  // Two deletes, told apart by `at`. With it, the expiry's: DynamoDB's delete conditional on that time, false for a newer pause.
  // Without it, a resume's: DynamoDB deletes whatever is there without saying whether there was anything, so the pause is read
  // first, false when there is none.
  async deletePause(workloadId, { exclusionId, at } = {}) {
    if (at !== undefined) return store.deletePause(workloadId, { exclusionId, at });
    if (!(await store.getPauses(workloadId)).some((p) => (p.exclusionId ?? null) === (exclusionId ?? null))) return false;
    await store.deletePause(workloadId, { exclusionId });
    return true;
  },
  listConfigs: () => store.listConfigs(),
});

export function createController({
  store, ec2, elbv2, cloudwatch, autoscaling, ecs, tagging, appscaling, rds, kubernetesOf, invokeSelf, now = Date.now, sleep, newId = randomUUID, log,
  lists = null, router = {}, defaultRules = [], ipLists = [], sqs = null, lambda = null, invokeOnboarder = null,
  // The manager's lists (R6b, lib/catalog.mjs): described from its catalog and manifests, never downloaded here.
  catalog = null,
  // The manager's global settings (lib/manager-settings.mjs): read by the check, mirrored in the table.
  managerSettings = null,
  // The router's work queue (scale design §6): naps and the wakes of a router pause, run at most 10 at a time.
  queueWork = null,
  // The drift queue: the check's repair requests, read with the drift events by the onboarder (2 at a time).
  queueRepair = null,
  publisher = { enabled: false, checked: async () => {}, stateChanged: async () => {}, listed: async () => {} },
  // The favicon read of a nap (lib/favicon.mjs): the network and its time budget, injected for the tests.
  fetch = globalThis.fetch, faviconBudgetMs = FAVICON_BUDGET_MS,
  // The organization's waiting page, read from the manager's settings.json (lib/organization-page.mjs); null: none.
  organizationPage = null,
}) {
  const clients = { ec2, elbv2, autoscaling, ecs, tagging, appscaling, rds, kubernetesOf };
  let budgetEnd = Infinity;

  const notConfigured = (workloadId) => new Refusal('not_found', `workload not configured: ${workloadId}`);
  async function config(workloadId) {
    const cfg = await store.getConfig(workloadId);
    if (!cfg) throw notConfigured(workloadId);
    return cfg;
  }

  // The levels above a workload (vision settings at scale design §6; lib/settings-levels.mjs's reader): the router's record and
  // its copy of the manager's settings, read fresh (a check reads them once for all its workloads). A level that cannot be read
  // keeps the last record this instance read; never read, the levels are unreadable (review, 2026-11-04). The organization as
  // hibernation and the join read it: the manager's settings reader, else the router's copy.
  const readLevels = createLevelsReader({
    router: () => store.getRouterSettings?.(),
    organization: managerSettings ? () => managerSettings.current() : () => store.getManagerSettings?.(),
  }, { log });
  // The longest a wake may wait when its levels cannot be read.
  const WAKE_TIMEOUT_MAX_S = 3600;
  const wakeTimeoutS = (cfg) => (cfg.levelsUnreadable ? WAKE_TIMEOUT_MAX_S : cfg.wakeTimeoutSeconds);

  // The configuration a wake, a nap, the check, the status and the list act on: each setting resolved, where it comes
  // from, the type and the rules of every level. The stored one stays what the writes read (config()).
  async function effective(cfg, run, levels) {
    if (cfg.settingsFrom) return cfg;
    const { router: routerLevel, organization, unreadable } = levels ?? await readLevels();
    const resolved = effectiveConfig(cfg, { run, router: routerLevel, organization, terraformRules: defaultRules });
    return unreadable ? { ...resolved, levelsUnreadable: true } : resolved;
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
      cfg = await effective(knownConfig ?? (await config(workloadId)), run);
    } catch (err) {
      return fail(err);
    }
    // The wake deadline counts from the wake start (RUN), not from this invocation: a wake can span invocations.
    const wakeDeadline = (run.wakeStartedAt ?? now()) + wakeTimeoutS(cfg) * 1000;
    const timing = { sleep, now, deadline: Math.min(wakeDeadline, budgetEnd), wakeDeadline };
    // Instance types a capacity error made this wake fall back to (R7a), given back after the next stop.
    const fallbacks = {};
    try {
      const records = await wakeRecords(run, cfg);
      // A standalone workload without its resource (deleted, or untagged): nothing to wake.
      if (isStandalone(cfg) && !primariesOf(cfg, records).length) throw failureError('configuration', 'the resource is missing or no longer tagged dormeto:workload');
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
      if (isStandalone(cfg)) await untilRunning(records, watch, timing);
      else {
        const serving = await servingGroup(cfg);
        while ((await healthyCount(elbv2, serving)) < 1) {
          const seen = await watch.check();
          if (seen) throw seen;
          if (now() >= wakeDeadline) throw watch.capacity ?? await unhealthyError(elbv2, serving);
          if (now() >= timing.deadline) throw new Error('wake timeout: no healthy target');  // the Lambda time budget
          await sleep(HEALTH_POLL_MS);
        }
      }
      if (!(await current())) return superseded();
      if (!isStandalone(cfg)) await routeTo(cfg, 'app');
      const durationMs = now() - (run.wakeStartedAt ?? now());
      const done = await store.transition(workloadId, {
        cond: { state: STATES.WAKING, wakeId },
        // recentWakes (waiting page design §9): only a wake that ended here counts, for the progress bar's typical time.
        set: { state: STATES.AWAKE, awakeSince: now(), holders: 0, recentWakes: withWake(run.recentWakes, durationMs), ...(Object.keys(fallbacks).length ? { instanceTypes: JSON.stringify(fallbacks) } : {}), ...(hibernatedTooLong(run) ? { freshBoot: true } : {}) },
        remove: ['pendingWake', 'napInstances', 'napBackends', 'failure', 'consecutiveFailures', 'hibernated'],
        // The wake's duration (R7a, the base of R8's wake times), and the instance types it fell back to.
        event: { wakeId, durationMs, ...(Object.keys(fallbacks).length ? { fallbacks } : {}) },
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

  // A standalone workload's readiness (vision standalone workloads design §3): every backend it woke runs, an instance running, a
  // group with its instances in service, a service with its tasks, a database available; at its timeout, those that do not.
  async function untilRunning(records, watch, timing) {
    const sizes = new Map(records.filter((r) => r.kind === 'asg' || r.kind === 'ecs').map((r) => [backendKey(r), wakeSizeOf(r)]));
    for (;;) {
      const statuses = await standaloneStatuses(clients, records, sizes);
      const waiting = records.filter((r) => statuses[backendKey(r)] !== 'running');
      if (!waiting.length) return;
      const seen = await watch.check();
      if (seen) throw seen;
      const which = waiting.map((r) => `${backendKey(r)} is ${statuses[backendKey(r)] ?? 'unknown'}`).join(', ');
      if (now() >= timing.wakeDeadline) throw watch.capacity ?? failureError('timeout', `not every backend runs: ${which}`);
      if (now() >= timing.deadline) throw new Error(`wake timeout: not every backend runs: ${which}`);  // the Lambda time budget
      await sleep(HEALTH_POLL_MS);
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
    if (!isStandalone(cfg)) await routeTo(cfg, 'waker', { allowIssues: true });
    const records = await sleepBackends(clients, backends, { sleep, now, deadline: now() + STOP_TIMEOUT_MS }, await stopOptions(cfg, run));
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
    const cfg = await effective(await config(workloadId), await store.getRun(workloadId));
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
    // A standalone workload has no route (vision standalone workloads design §3): no rule, no favicon, no switch, no drain.
    const routed = !isStandalone(cfg);
    if (routed) {
      // A rule the router cannot switch would send traffic to the stopped backend: no nap until it is fixed.
      const { issues, rules } = await rulesFor(cfg);
      if (issues.length) {
        log.warn('NapSkipped', { workloadId, reason: 'rules not instrumented', issues: reasons(issues) });
        return { state: 'SKIPPED', reason: 'rules not instrumented', issues: reasons(issues) };
      }
      // The nap is decided, and the route still reaches the application: the only moment its home page can be read.
      await faviconAtNap(cfg, rules);
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
    // The instances AWS accepted to hibernate, said in the ASLEEP event.
    const hibernated = [];
    try {
      if (routed) {
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
      }
      // Commit point: after this transition the instances are stopped even if a request arrives. A pause written since the
      // nap started aborts it, like a request.
      const paused = await isPaused(workloadId);
      const committed = !paused && (await store.transition(workloadId, { cond: { state: STATES.NAPPING, pendingWake: false }, set: { stopping: true } }));
      if (!committed) {
        if (routed) await routeTo(cfg, 'app');
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
      await sleepBackends(clients, backends, { sleep, now, deadline: now() + STOP_TIMEOUT_MS }, await stopOptions(cfg, committed, hibernated));
      // A fallback instance type is for one wake only (R7a, FinOps): stopped, an instance gets its own type back.
      await revertInstanceTypes(ec2, backends.filter((b) => b.kind === 'instance').map((b) => b.id), log);
      if (routed && !(await waitTargetsReleased(elbv2, cfg.appTargetGroupArn, { sleep, now, deadline: now() + RELEASE_TIMEOUT_MS, draining: !cfg.kubernetes }))) {
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
      cond: { state: STATES.NAPPING, pendingWake: false }, set: { state: STATES.ASLEEP, holders: 0 }, remove: ['stopping', 'instanceTypes', 'freshBoot'],
      event: { stopped, ...(hibernated.length ? { hibernated } : {}) },
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

  // The application's favicon for the waiting page (design §6), read at the nap by the shared step (favicon.mjs's cacheFavicon): the
  // levels with the organization's inside its budget, the host from the rules read.
  function faviconAtNap(cfg, rules) {
    const { workloadId } = cfg;
    return cacheFavicon(workloadId, {
      store, fetch, now, budgetMs: faviconBudgetMs, log,
      levels: pageLevels(store, workloadId, { organization: organizationPage ? ({ signal }) => organizationPage.read({ signal }) : null }),
      host: () => hostOfRules(rules),
    });
  }

  // A wake that completes after the run was hibernated HIBERNATION_MAX_DAYS or more (whatever woke it: a schedule's
  // maxNapDays, a visitor after a long keepAsleep pause, a start outside Dormeto the check finds) asks for a fresh boot:
  // AWS keeps an instance hibernated 60 days at most, so the next nap stops it plainly (start, stop, start).
  function hibernatedTooLong(run) {
    try {
      const at = run?.hibernated ? JSON.parse(run.hibernated)?.at : null;
      return Number.isFinite(at) && now() - at >= HIBERNATION_MAX_DAYS * 86_400_000;
    } catch {
      return false;
    }
  }

  // The levels of the hibernation setting above the workload's (hibernation design §2): the router's record and the
  // manager's settings as the router last read them, null when unset (the manager's: when the router reads none, without a
  // catalog). A router that reads them but has no value yet (nothing read since its upgrade, or every read failed) has the
  // manager's level unknown: { hibernate: null, readAt, error }. A failed read throws: an unreadable level is not an unset
  // one.
  async function hibernationLevels() {
    const [router, manager] = await Promise.all([store.getRouterSettings?.(), managerSettings?.current?.()]);
    return { router: router ?? null, manager: manager ?? (managerSettings?.url ? { hibernate: null, readAt: null, error: null } : null) };
  }
  // The levels of joinMinutes above a workload's: read once for a check or an answer, one that cannot be read logged and
  // unset. A schedule's own value, then these (design, section 11).
  const readJoinLevels = () => joinLevels({ router: () => store.getRouterSettings?.(), manager: () => managerSettings?.current?.(), log });
  // An unknown manager level, when it is the one that decides (the workload and the router set nothing), is false, said
  // `unknown`: the built-in true could hibernate against an administrator's "off" the router has not read yet (spec §3).
  const resolvedFor = (cfg, { router, manager }) => {
    const resolved = resolveHibernation({ workload: cfg.hibernate, fallbackTypes: cfg.fallbackInstanceTypes, router: router?.hibernate, manager });
    return resolved.from === 'default' && manager ? { hibernate: false, from: 'manager', unknown: true } : resolved;
  };

  // How a nap or a release stops the instances (hibernation design §4): those that can be are hibernated when the setting
  // resolves to true and the run asks for no fresh boot; what AWS accepted is recorded on the run at once, and added to
  // `hibernated`. A level that cannot be read, or the manager's still unknown, stops them plainly (logged), never failing
  // the stop: falling to a lower level or the built-in true could hibernate against an administrator's "off".
  async function stopOptions(cfg, run, hibernated = []) {
    const unreadable = (error) => {
      log.warn('HibernationLevelUnreadable', { workloadId: cfg.workloadId, error });
      return false;
    };
    const hibernate = await hibernationLevels().then((levels) => {
      const resolved = resolvedFor(cfg, levels);
      if (!resolved.unknown) return resolved.hibernate;
      return unreadable(levels.manager.error ? `manager settings not read yet: ${levels.manager.error}` : 'manager settings not read yet');
    }, (err) => unreadable(err.message));
    return {
      hibernate: hibernate && run?.freshBoot !== true,
      onHibernated: async (ids) => {
        hibernated.push(...ids);
        await store.setHibernated(cfg.workloadId, { ids, at: now() });
      },
      log,
    };
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
  // seen: given, it gets the backends resolved (the check's idle signals read them).
  async function reconcile(cfg, ctx = null, known = undefined, seen = {}) {
    const { workloadId } = cfg;
    let run = known === undefined ? await store.getRun(workloadId) : known;
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
    const wakeStuckBefore = now() - wakeTimeoutS(cfg) * 1000 - WAKING_STUCK_GRACE_MS;
    if (run.state === STATES.WAKING && (run.wakeStartedAt ?? 0) < wakeStuckBefore) {
      log.warn('WakeStuck', { workloadId, wakeId: run.wakeId });
      const failed = failedSpec(failureError('timeout', `the wake did not finish within ${wakeTimeoutS(cfg)} s (its invocation stopped)`), { step: 'wake', wakeId: run.wakeId, at: now() });
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
    seen.backends = backends;
    const standalone = isStandalone(cfg);
    // A standalone workload's groups and services run at their full size (vision standalone workloads design §3).
    const statuses = standalone ? await standaloneStatuses(clients, backends) : backends.length ? await backendStatuses(clients, backends) : {};
    // The primary backends decide the state; companions (databases) follow it. A standalone workload's primary is its resource.
    const primaries = primariesOf(cfg, backends);
    const companions = companionsOf(cfg, backends);
    // The kinds of its backends, for the manager's lists: written when they change.
    const kinds = [...new Set([...primaries, ...companions].map((b) => b.kind))].join(',');
    if (kinds !== (run.backendKinds ?? '')) {
      await store.setBackendKinds(workloadId, kinds).catch((err) => log.warn('BackendKindsUnwritten', { workloadId, error: err.message }));
    }
    // A standalone workload whose resource is missing (deleted, or its tag removed): said once a check and marked on its run (the
    // router's health counts them); its state stays, nothing is stopped or started.
    if (standalone && !primaries.length) {
      log.warn('ResourceMissing', { workloadId, resourceArn: cfg.resourceArn });
      return run.resourceMissing ? run : (await store.transition(workloadId, { cond: { state: run.state }, set: { resourceMissing: true } })) ?? run;
    }
    if (standalone && run.resourceMissing) run = (await store.transition(workloadId, { cond: { state: run.state }, remove: ['resourceMissing'] })) ?? run;
    // No managed primary backend: nothing to infer (every() would be vacuously true).
    const all = (name) => primaries.length > 0 && primaries.every((b) => statuses[backendKey(b)] === name);
    const from = run.state;
    if (from !== STATES.AWAKE && all('running') && (standalone || (await healthyCount(elbv2, cfg.appTargetGroupArn)) >= 1)) {
      log.warn(from === STATES.FAILED ? 'FailedRecovered' : 'ExternalWake', { workloadId });
      // GitOps resetting replicas behind the waker's back (section 8 of the Kubernetes design): drift, not a visitor's wake.
      for (const b of from === STATES.ASLEEP ? primaries.filter((p) => p.kind === 'k8s') : []) {
        await recordDrift(workloadId, 'replicas set while asleep', `${b.owner.kind} ${b.namespace}/${b.owner.name} runs ${b.replicas} replica${b.replicas === 1 ? '' : 's'}, set outside Dormeto (a GitOps tool resetting spec.replicas?)`);
      }
      if (run.napBackends) await resumeBackends(clients, JSON.parse(run.napBackends));
      else await startCompanions(clients, companions);
      if (!standalone) await routeTo(cfg, 'app');
      run = (await store.transition(workloadId, {
        cond: { state: from }, set: { state: STATES.AWAKE, awakeSince: now(), ...(hibernatedTooLong(run) ? { freshBoot: true } : {}) },
        remove: ['napBackends', 'napInstances', 'failure', 'consecutiveFailures', 'hibernated'],
        cause: from === STATES.FAILED ? 'recovered' : 'external-start',
      }))
        ?? (await store.getRun(workloadId));
    } else if (from !== STATES.ASLEEP && all('stopped')) {
      log.warn(from === STATES.FAILED ? 'FailedRecovered' : 'ExternalStop', { workloadId });
      // The backend is already stopped: the instrumented rules go to the waker whatever the issues.
      if (!standalone) await routeTo(cfg, 'waker', { allowIssues: true });
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
    if (expected && !standalone) {
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

  async function checkOne(stored, paused, ctx = null) {
    // Its run read once: it tells the type (the backends' kinds), and the reconcile goes on from it.
    const known = await store.getRun(stored.workloadId);
    const cfg = await effective(stored, known, ctx?.levels);
    const seen = {};
    const run = await reconcile(cfg, ctx, known, seen);
    // Its levels unreadable (never read here): no decision on an idle window it may not have.
    if (cfg.levelsUnreadable) return { state: run?.state ?? 'UNKNOWN', settings: 'unreadable' };
    if (isStandalone(cfg)) return checkStandalone(cfg, run, paused, ctx, seen.backends);
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
    const kept = scheduleKeeps(cfg.workloadId, ctx, t);
    if (kept) return { state: run.state, ...kept };
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
    const asked = await napSoon(cfg.workloadId, t);
    return asked ? { state: run.state, nap: asked } : nap(cfg.workloadId);
  }

  // A standalone workload at the check (vision standalone workloads design §3, §4): a failed wake retried after its backoff (unless a
  // keepAsleep pause or a nap window holds it), a failed nap released after its idle window, an awake one napped when its idle
  // signals say so for its whole idle window, read once it can be idle. A failed or missing read never naps it.
  const readIdleSignals = createIdleSignals({ cloudwatch, log });
  async function checkStandalone(cfg, run, paused, ctx, backends) {
    const { workloadId } = cfg;
    const t = now();
    if (run?.resourceMissing) return { state: run.state, resource: 'missing' };
    // A failed wake, retried with the router's own backoff (standalone-check.mjs, shared with Google Cloud's).
    const retry = failedWakeDecision(run, t, { keptAsleep: Boolean(ctx?.keptAsleep?.(workloadId)), napWindow: napWindowNow(workloadId, ctx, t, log) });
    if (retry?.wait) return { state: run.state };
    if (retry?.held) return { state: run.state, retry: 'held', reason: retry.held };
    if (retry?.retry) {
      if (!(await startWake(workloadId, run, undefined, 'retry'))) return { state: (await store.getRun(workloadId))?.state ?? 'UNKNOWN' };
      return { state: STATES.WAKING, retry: 'requested' };
    }
    if (run?.state === STATES.FAILED && !paused && (run.failedAt ?? 0) <= t - cfg.idleMinutes * 60_000) {
      if (queueWork) await queueWork({ action: 'release', workloadId, requestedAt: t });
      else if (invokeSelf) await invokeSelf({ action: 'release', workloadId });
      log.info('ReleaseRequested', { workloadId });
      return { state: run.state, release: 'requested' };
    }
    if (!run || run.state !== STATES.AWAKE) return { state: run?.state ?? 'UNKNOWN' };
    if (!run.awakeSince) {
      await store.transition(workloadId, { cond: { state: STATES.AWAKE }, set: { awakeSince: t } });
      return { state: run.state };
    }
    if (paused) return { state: run.state, paused: true };
    const kept = scheduleKeeps(workloadId, ctx, t);
    if (kept) return { state: run.state, ...kept };
    // Awake for the whole window, and not before the signals can all be under for it (standalone-check.mjs).
    const decided = await idleDecision({ cfg, run, t, read: async (window) => readIdleSignals(cfg, backends ?? await managedBackends(cfg), window) });
    if (!decided.nap) {
      if (decided.write !== undefined) await store.transition(workloadId, { cond: { state: STATES.AWAKE }, set: { idleNotBefore: decided.write } });
      return { state: run.state, ...decided.fields };
    }
    const asked = await napSoon(workloadId, t);
    return asked ? { state: run.state, nap: asked } : nap(workloadId);
  }

  // Why a queued idle nap of a standalone workload no longer naps it, else null: its signals read again over its window now, its
  // levels readable (as the check decides nothing on levels it cannot read).
  async function idleRecheck(stored) {
    const cfg = await effective(stored, await store.getRun(stored.workloadId));
    return recheckIdle({ cfg, t: now(), read: async (window) => readIdleSignals(cfg, await managedBackends(cfg), window) });
  }

  // A nap lasts minutes: queued (at most 10 at a time), else run in its own invocation, never delaying the check; null
  // when the router has neither (the caller naps inline). A scheduled nap says its cause (an idle nap's goes without),
  // and in the queue until when it may wait (its window's end).
  async function napSoon(workloadId, t, { cause, until } = {}) {
    const said = cause ? { cause } : {};
    if (queueWork) {
      await queueWork({ action: 'nap', workloadId, requestedAt: t, ...said, ...(until ? { until } : {}) });
      log.info('NapRequested', { workloadId, ...said });
      return 'queued';
    }
    if (invokeSelf) {
      await invokeSelf({ action: 'nap', workloadId, ...said });
      log.info('NapRequested', { workloadId, ...said });
      return 'requested';
    }
    return null;
  }

  // --- Schedules applied by the check (R12 design, section 4) --------------------------------------------------------

  // Before the check's per-workload loop, every scheduled workload whatever the loop's budget (lib/check-schedules.mjs): 8 at a
  // time, no AWS call but the wakes and naps it asks for. An awake window's wake as the manager's Wake does, the occurrence recorded
  // with the wake (one conditional write).
  const { applySchedules } = createScheduleCheck({
    store,
    wake: (workloadId, run, kind, occurrence) => startWake(workloadId, run, undefined, kind, occurrence ? { set: { scheduleApplied: occurrence.id } } : {}),
    pendingWake: (workloadId, kind) => pendingWake(workloadId, undefined, kind),
    wakeRecords: true, concurrency: CHECK_CONCURRENCY, log,
  });
  // A nap window's nap, asked at once: in the queue, it may wait until the window ends (a crowded nap start, 10 naps at a time).
  const scheduledNap = {
    async ask({ workloadId, occurrence, t }) {
      if (!(await napSoon(workloadId, t, { cause: 'schedule', until: occurrence.end }))) await nap(workloadId, { cause: 'schedule' });
      return true;
    },
  };

  // The organization's days before an ended window leaves its schedule, the default without a manager (no settings URL); null
  // when its settings were never read, cannot be, or were read by a router before this field: then nothing leaves, an
  // organization's 0 (keep) may be there.
  async function endedDaysOf() {
    if (!managerSettings?.url) return ENDED_DAYS_DEFAULT;
    try {
      const current = await managerSettings.current();
      if (!current || current.hibernate === null || current.endedWindowDays === undefined) return null;
      return current.endedWindowDays ?? ENDED_DAYS_DEFAULT;
    } catch (err) {
      log.warn('EndedDaysUnreadable', { error: err.message });
      return null;
    }
  }

  // --- The hibernation's 60-day limit (hibernation design §4) ---------------------------------------------------------

  // After the schedules and before the check's loop, every workload whatever the loop's budget, with or without a
  // schedule: one asleep or failed whose run says a nap hibernated its instances at least 59 days ago is woken for
  // maintenance, its run asking for a fresh boot (its next stop is plain: AWS keeps an instance hibernated 60 days at
  // most, then start, stop, start); once it asks, never again (hibernationDue). A keepAsleep pause holds it, as it holds
  // the schedule's maintenance wake. One run read each, 8 at a time, but for the workloads the schedules just woke or held
  // (handled). Answers what it did or what held it.
  async function wakeLongHibernated(configs, handled, keptAsleep, t) {
    const ids = configs.map((c) => c.workloadId).filter((id) => !handled.has(id));
    const outcomes = new Map();
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(CHECK_CONCURRENCY, ids.length) }, async () => {
      while (i < ids.length) {
        const workloadId = ids[i++];
        try {
          const run = await store.getRun(workloadId);
          const due = run?.state === STATES.ASLEEP || run?.state === STATES.FAILED ? hibernationDue(run) : null;
          if (due === null || due > t) continue;
          if (keptAsleep(workloadId)) outcomes.set(workloadId, 'held by a keepAsleep pause');
          else if (await startWake(workloadId, run, undefined, 'maintenance', { set: { freshBoot: true } })) {
            log.info('WokenForHibernationLimit', { workloadId, due: iso(due) });
            outcomes.set(workloadId, 'maintenance');
          }
        } catch (err) {
          log.error('HibernationLimitFailed', { workloadId, error: err.message });
        }
      }
    }));
    return outcomes;
  }

  // Why a schedule keeps a workload from its idle nap now, else null (lib/check-schedules.mjs). A schedule it cannot read counts as
  // none, logged.
  function scheduleKeeps(workloadId, ctx, t) {
    try {
      return keptBySchedule(workloadId, ctx, t);
    } catch (err) {
      log.warn('ScheduleSkipped', { workloadId, error: err.message });
      return null;
    }
  }

  // --- Manager interface: list, status, force-wake ------------------------------------------------------------------

  const status = createStatus({ ec2, elbv2, cloudwatch, autoscaling, ecs, tagging, appscaling, rds, kubernetesOf, now, version: router, log });
  const hosts = { at: 0, byWorkload: new Map() };
  // Host of each workload: the first of its rules (found from its target group) with a host condition; one listing per
  // load balancer for all workloads, cached five minutes.
  // cachedOnly (the report after a check): the hosts the check found, none for a workload it has not reached yet.
  async function workloadHosts(all, { cachedOnly = false } = {}) {
    // A standalone workload has no host: no rule is read for it.
    const configs = all.filter((c) => !isStandalone(c));
    if (cachedOnly || (now() - hosts.at < 5 * 60_000 && configs.every((c) => hosts.byWorkload.has(c.workloadId)))) return hosts.byWorkload;
    if (!configs.length) return hosts.byWorkload;
    return rememberHosts(configs, await resolveRules(elbv2, configs).catch(() => new Map()), now());
  }
  // The check's own listing fills the cache as it goes (the workloads it reached): its report lists no load balancer again.
  function rememberHosts(configs, found, at) {
    for (const c of configs) hosts.byWorkload.set(c.workloadId, (found.get(c.workloadId)?.rules ?? []).map(hostOf).find(Boolean) ?? null);
    hosts.at = at;
    return hosts.byWorkload;
  }

  // A workload's row of the list (and of the check's report): pauses are the router's, all of them.
  async function rowOf(cfg, host, pauses, scheduled, levels) {
    const [run, stats] = await Promise.all([
      store.getRun(cfg.workloadId),
      store.getStats(cfg.workloadId, STATS_DAYS).catch(() => null),
    ]);
    return workloadSummary(await effective(cfg, run, levels), run, host, totals(stats), shownPauses(rowPauses(pauses, cfg.workloadId)), scheduled);
  }

  // One workload's row to the manager at once, after its onboarding (vision refusals design §2): its host read from its
  // rules (a new workload is not in the cache yet), its pauses and schedule as the list reads them.
  async function reportWorkload({ workloadId }) {
    const cfg = await config(workloadId);
    if (!publisher.enabled) return { reported: false };
    const found = isStandalone(cfg) ? new Map() : await resolveRules(elbv2, [cfg]).catch(() => new Map());
    const host = (found.get(workloadId)?.rules ?? []).map(hostOf).find(Boolean) ?? null;
    hosts.byWorkload.set(workloadId, host);
    const { pauses } = await readPauses({ store, log });
    const scheduled = Boolean(await store.getSchedule(workloadId).catch(() => true));
    await publisher.listed({ at: iso(now()), workload: await rowOf(cfg, host, pauses, scheduled, await readLevels()) });
    log.info('WorkloadReported', { workloadId });
    return { reported: true };
  }

  async function list({ cachedHosts = false } = {}) {
    const { configs, schedules } = await store.listWorkloads();
    const byWorkload = await workloadHosts(configs, { cachedOnly: cachedHosts });
    const { pauses, pausesError } = await readPauses({ store, log });
    const levels = await readLevels();
    const workloads = await Promise.all(configs.map((cfg) => rowOf(cfg, byWorkload.get(cfg.workloadId), pauses, schedules.has(cfg.workloadId), levels)));
    const health = await store.getCheck().catch(() => null);
    return {
      router: listRouter({
        name: router.name, version: router.version, build: router.build, checkSchedule: router.checkSchedule ?? null,
        lastScheduledCheckAt: health?.lastScheduledCheckAt ? iso(health.lastScheduledCheckAt) : null,
        pauses: shownPauses(pauses.filter((p) => p.workloadId === null)), pausesError,
      }),
      workloads,
    };
  }

  // The maintenance wake due (scheduleView's `dues`): an asleep workload's maximum nap, of a schedule the router reads (the check
  // applies none of another), or the hibernation's 60-day limit, whichever comes first.
  function maintenanceOf(schedule, run, { readable }) {
    const dues = [
      readable && schedule && run?.state === STATES.ASLEEP && run.stateAt ? maintenanceDue(schedule, run.stateAt) : null,
      run?.state === STATES.ASLEEP || run?.state === STATES.FAILED ? hibernationDue(run) : null,
    ].filter((due) => due !== null);
    return dues.length ? Math.min(...dues) : null;
  }
  // A schedule's view (manager-actions.mjs's), with the run and the join levels read.
  const scheduleOf = (workloadId, schedule, reads) => scheduleView({ now, log, dues: maintenanceOf }, workloadId, schedule, reads);

  async function workloadStatus(workloadId) {
    const run = await store.getRun(workloadId);
    const cfg = await effective(await config(workloadId), run);
    // A schedule the runtime cannot read is shown, with no next events (B3 of the cloud duplication design). One there is nothing to
    // show of (its stored JSON does not parse, its time is none) never breaks the status: none, logged; a failed read (a store
    // error) does, as any read error would.
    const answer = await status(workloadId, cfg, run ?? {}, {
      pauses: await pausesFor(workloadId),
      drift: store.listDrift ? await store.listDrift(workloadId, 10).catch(() => []) : [],
      ...describedRules(cfg),
      loadStats: () => store.getStats(workloadId, STATS_DAYS),
      loadLists: async () => [...await describeStoredLists(store, ipLists), ...(catalog ? (await catalog.describe()).lists : [])],
      loadHibernation: (instanceIds) => hibernationView(cfg, run, instanceIds),
    });
    const joins = await readJoinLevels();
    const reads = { run, joins: () => joins };
    try {
      return { ...answer, ...(await scheduleOf(workloadId, await store.getSchedule(workloadId), reads)) };
    } catch (err) {
      if (!(err instanceof SyntaxError || err instanceof RangeError)) throw err;
      log.warn('ScheduleSkipped', { workloadId, error: err.message });
      // As without a schedule: the hibernation's maintenance wake still shows.
      return { ...answer, ...(await scheduleOf(workloadId, null, reads)) };
    }
  }

  // The hibernation a workload gets (hibernation design §4): the resolution, each level (a failed read of one fails it,
  // as a failed schedule read fails the status), its EC2 instances outside an Auto Scaling group as one DescribeInstances gives them (null when
  // it has none, or when they cannot be described: logged, never failing) and whether its next nap stops them for a
  // fresh boot. levels: already read by the caller.
  async function hibernationView(cfg, run, instanceIds, levels = null) {
    levels ??= await hibernationLevels();
    let instances = null;
    if (instanceIds?.length) {
      try {
        const details = await instanceDetails(ec2, instanceIds);
        instances = instanceIds.map((id) => ({ id, configured: details.get(id)?.configured === true, hibernated: details.get(id)?.hibernated === true }));
      } catch (err) {
        log.warn('HibernationUnread', { workloadId: cfg.workloadId, error: err.message });
      }
    }
    const { router, manager } = levels;
    return {
      ...resolvedFor(cfg, levels),
      workload: typeof cfg.hibernate === 'boolean' ? cfg.hibernate : null,
      router: typeof router?.hibernate === 'boolean' ? router.hibernate : null,
      manager: manager && { hibernate: manager.hibernate ?? null, readAt: manager.readAt ? iso(manager.readAt) : null, error: manager.error ?? null },
      instances,
      freshBoot: run?.freshBoot === true,
    };
  }

  // --- Settings (hibernation design §4): the router's record, or a workload's configuration ---------------------------

  // Terraform's name of each setting a workload module sets (settings at scale design §8): what to set there instead.
  const MODULE_VARIABLES = {
    hibernate: 'hibernate', idleMinutes: 'idle_minutes', waitSeconds: 'wait_seconds', drainSeconds: 'drain_seconds', wakeTimeoutSeconds: 'wake_timeout_seconds',
    maxHolders: 'max_holders', failedRetrySeconds: 'failed_retry_seconds', wakeMode: 'wake_mode', noWakeRules: 'no_wake_rules', wakeRules: 'wake_rules', type: 'type',
    // A standalone workload's idle signals (vision standalone workloads design §4).
    idleCpuPercent: 'idle_cpu_percent', idleNetworkBytes: 'idle_network_bytes', idleMetric: 'idle_metric',
  };

  // What AWS holds back of the manager's writes (manager-actions.mjs's guard): a workload Terraform wrote (no source) is changed in
  // its workload module, named by the Terraform variable of what is written; so is a waiting page Terraform wrote (no by), while a
  // page left from before the workload moved to Terraform can still be cleared.
  async function terraformGuard(write, { workloadId, cfg, settings, level }) {
    if (!cfg || cfg.source) return [];
    if (write === 'page delete') {
      const stored = await store.getWaitingPage(level);
      if (!stored || stored.by) return [];
    }
    const first = Object.keys(settings && typeof settings === 'object' ? settings : {}).find((key) => MODULE_VARIABLES[key]) ?? 'hibernate';
    const variable = { name: 'name', tags: 'tags', settings: MODULE_VARIABLES[first], page: 'waiting_page', 'page delete': 'waiting_page' }[write];
    throw new Refusal('conflict', `workload ${workloadId} was written by Terraform: set ${variable} in its workload module`);
  }

  // --- Waiting page (branded waiting page design §5, §11): one document per level, in its own item ----------------------

  // What people read (page-settings.mjs's pageViewOf): the level's own document, what it would inherit, the effective page and where
  // each field comes from, the cached favicon, the warnings and who wrote it. Never throws on a bad stored value.
  async function pageView(workloadId, cfg) {
    const [organization, upper, favicon] = await Promise.all([
      // The organization's level is the manager's settings.json; unreadable, it is none here (and logged).
      organizationPage ? organizationPage.read().catch((err) => {
        log.warn('WaitingPageUnread', { level: 'organization', error: String(err?.message ?? err).slice(0, 200) });
        return null;
      }) : null,
      store.getWaitingPage('router'), workloadId ? store.getFavicon(workloadId) : null,
    ]);
    // The level read: the workload's, or the router's (its upper levels then are the organization's alone).
    const own = workloadId ? await store.getWaitingPage({ workloadId }) : upper;
    return pageViewOf({ organization, router: upper, own, favicon, workload: Boolean(workloadId), terraform: Boolean(cfg && !cfg.source) });
  }

  const count = createCount({ store, log });

  // The wake of an asleep or failed workload from the run read (asked-wake.mjs's beginWake), null when its state changed since.
  // set: more of the run written with the wake (the schedule occurrence it applies). inline (the work queue): the wake runs in
  // this invocation instead of one of its own.
  async function startWake(workloadId, run, by, kind, { inline = false, set = {} } = {}) {
    const wakeId = await beginWake({ transition: (id, change) => store.transition(id, change), newId, now, log }, workloadId, run.state, { kind, by, set });
    if (!wakeId) return null;
    await count(workloadId, `wake:${kind}`);
    if (inline) return wake(workloadId, wakeId);
    await invokeSelf({ action: 'wake', workloadId, wakeId });
    return { state: STATES.WAKING };
  }

  // A napping workload's pending wake (asked-wake.mjs's): true when this call set it.
  function pendingWake(workloadId, by, kind) {
    return setPendingWake({ store, count, log }, workloadId, { kind, by });
  }

  // A wake asked by an operator (the manager, the work queue, a pause), whatever the retry delay (asked-wake.mjs's askedWake):
  // `answer`, force-wake's; `woke`, whether this call started the wake or set the pending wake (a pause's woken, B5 of the cloud
  // duplication design).
  const wakePorts = {
    async start(workloadId, run, { by, kind, inline }) {
      const started = await startWake(workloadId, run, by, kind, { inline });
      return { woke: started !== null, answer: started };
    },
    pending: (workloadId, { by, kind }) => pendingWake(workloadId, by, kind),
  };
  const asked = (workloadId, by, kind, { inline = false } = {}) => askedWake({ find: config, store, ...wakePorts }, workloadId, { kind, by, inline });

  // Operator request from the manager: no retry delay; the wake itself runs in its own invocation (inline: in this one).
  async function forceWake(workloadId, by, kind = 'manager', { inline = false } = {}) {
    return (await asked(workloadId, by, kind, { inline })).answer;
  }

  // IP reputation lists: downloads run in their own invocation, never delaying the workload checks.
  async function requestListRefresh() {
    if (!lists || !invokeSelf) return;
    await askListRefresh({ due: () => lists.due(), ask: (names) => invokeSelf({ action: 'refresh-lists', names }), log });
  }

  // --- The manager's actions (lib/manager-actions.mjs): rename, tag, settings, waiting page, schedule, request-nap, force-wake --

  // A schedule's answer: its view with the run and the join levels read then (scheduleOf's).
  const scheduledView = async (workloadId, stored) => scheduleOf(workloadId, stored, { run: await store.getRun(workloadId), joins: readJoinLevels });
  // The standalone workloads whose idle settings a write just changed (their idleNotBefore goes once written).
  const rereads = new Set();
  const managerActions = createManagerActions({
    store, find: config, guard: terraformGuard, refuse: { invalid: (message) => new Refusal('invalid', message), notFound: notConfigured },
    pausesFor: (workloadId) => pausesFor(workloadId),
    // Run in its own invocation (a nap outlasts the API call), through the work queue when there is one.
    napNow: async (workloadId, by) => {
      if (queueWork) await queueWork({ action: 'nap', workloadId, requestedAt: now(), by });
      else await invokeSelf({ action: 'nap', workloadId, by });
    },
    wake: wakePorts,
    scheduleView: scheduledView,
    settings: {
      // A level may hold both kinds' keys; a workload, its kind's (standalone workloads design §4).
      routerProblems: (settings) => settingsProblems(settings, { idle: true }),
      workloadProblems: (settings, cfg) => workloadSettingsProblems(settings, cfg),
      // A configuration from before `inherits` inherits what equals the onboarder's old defaults (design §7). A standalone workload whose
      // idle window or idle signals change is read again at the next check (final review, Minor 7).
      next: (cfg, settings) => {
        if (isStandalone(cfg) && ['idleMinutes', ...IDLE_KEYS].some((key) => Object.hasOwn(settings, key))) rereads.add(cfg.workloadId);
        return withSettings(cfg, settings);
      },
      levels: hibernationLevels,
      // After the write: the hibernation with the instances it reads (not read: logged, never failing), the settings resolved.
      async answer(workloadId, next, levels) {
        if (rereads.delete(workloadId)) {
          await store.transition(workloadId, { cond: { state: (await store.getRun(workloadId))?.state }, remove: ['idleNotBefore'] })
            .catch((err) => log.warn('IdleNotBeforeKept', { workloadId, error: err.message }));
        }
        const instanceIds = await resolveBackends(clients, next).then(({ backends }) => backends.filter((b) => b.kind === 'instance').map((b) => b.id)).catch((err) => {
          log.warn('HibernationUnread', { workloadId, error: err.message });
          return null;
        });
        const run = await store.getRun(workloadId);
        const resolved = await effective(next, run);
        return { hibernation: await hibernationView(next, run, instanceIds, levels), resolved: resolvedSettings(resolved) };
      },
    },
    pageView,
    now, log,
  });

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
      await managerSettings?.refresh().catch((err) => log.error('ManagerSettingsFailed', { error: err.message }));
      // Pauses that cannot be read stop every nap of this check (the reconcile still runs), and hold every scheduled nap and wake.
      const { paused, keptAsleep } = pauseHolds((await activePauses()).pauses);
      const listed = await store.listWorkloads();
      const configs = listed.configs.sort((a, b) => a.workloadId.localeCompare(b.workloadId));
      // The schedules first, whatever the budget.
      // The levels once for every workload: their settings (settings at scale design §6) and the join of their windows.
      const levels = await readLevels();
      const joins = listed.schedules.size ? { router: levels.router?.joinMinutes ?? null, manager: levels.organization?.joinMinutes ?? null } : {};
      const endedDays = listed.schedules.size ? await endedDaysOf() : null;
      const { applied, readable } = await applySchedules(configs, listed.schedules, { paused, keptAsleep }, now(), { joins, endedDays, nap: scheduledNap });
      // Then the hibernation's 60-day limit, for every workload, held alike.
      const limited = await wakeLongHibernated(configs, applied, keptAsleep, now());
      await pingProxies(configs);
      // What these passes did for a workload, in its result.
      const passes = new Map([...applied].map(([workloadId, schedule]) => [workloadId, { schedule }]));
      for (const [workloadId, hibernation] of limited) passes.set(workloadId, { ...passes.get(workloadId), hibernation });
      // Then the loop (lib/check-run.mjs), from where the previous check stopped. The rules of the workloads, a chunk at a time in
      // the check's order, each load balancer listed once (the listing cache); backends found by tag once.
      const listing = { balancers: new Map(), listed: new Map(), tags: new Map() };
      const ctx = { rules: new Map(), scope: checkScope(clients), schedules: readable, applied, joins, levels, keptAsleep };
      const { results, cursor } = await runCheck({
        store, workloads: configs, deadline: Math.min(started + CHECK_BUDGET_MS, budgetEnd), concurrency: CHECK_CONCURRENCY, passes, now, log,
        chunk: {
          size: CHECK_CHUNK,
          async prepare(all) {
            // A standalone workload has no rules (vision standalone workloads design §5).
            const chunk = all.filter((c) => !isStandalone(c));
            if (!chunk.length) return;
            const listedAt = now();
            const found = await resolveRules(elbv2, chunk, listing).catch((err) => {
              log.warn('CheckRulesUnread', { error: err.message });
              return null;
            });
            if (!found) return;
            for (const [id, rules] of found) ctx.rules.set(id, rules);
            rememberHosts(chunk, found, listedAt);
          },
        },
        checkOne: (cfg) => checkOne(cfg, paused(cfg.workloadId), ctx),
      });
      // Where the next check starts, on the CHECK item at once.
      await store.setCheckCursor?.(cursor).catch((err) => log.warn('CheckCursorNotStored', { error: err.message }));
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

  async function ensureAwake(workloadId) {
    const cfg = await config(workloadId);
    if (isStandalone(cfg)) throw standaloneRefusal(workloadId, 'it has no route to repair');
    const run = await store.getRun(workloadId);
    if (run?.state !== STATES.AWAKE) return { state: run?.state };
    if ((await healthyCount(elbv2, cfg.appTargetGroupArn)) < 1) return { state: run.state, healthy: 0 };
    const repaired = await routeTo(cfg, 'app');
    if (repaired.length) log.warn('RouteRepaired', { workloadId, route: 'app', rules: repaired });
    return { state: run.state, changed: repaired.length > 0 };
  }

  // --- Pauses: a paused workload (or every workload of a paused router) is never napped ------------------------------

  const iso = (ms) => new Date(ms).toISOString();
  // A pause's wake (B5 of the cloud duplication design): true when this call started the wake or set the napping workload's pending
  // wake. A router pause queues the wakes of its asleep and failed workloads (it may have hundreds): run 10 at a time, each one
  // started as far as this call can know.
  async function pauseWake(workloadId, { by, router: ofRouter }) {
    const queued = ofRouter && queueWork ? (await store.getRun(workloadId))?.state : null;
    if (queued === STATES.ASLEEP || queued === STATES.FAILED) {
      await queueWork({ action: 'wake', workloadId, by, kind: 'pause' });
      return true;
    }
    return (await asked(workloadId, by, 'pause')).woke;
  }
  const pausing = createPauses({ store: pauseStore(store), wake: pauseWake, refuse: (message) => new Refusal('invalid', message), now, log });
  const { expired, shownPauses, pausesFor, isPaused, activePauses } = pausing;

  // Pause the router (no workloadId) or a workload; unless keepAsleep, its asleep and failed workloads are woken and a
  // napping one gets a pending wake.
  async function pause(event) {
    const workloadId = event.workloadId ?? null;
    if (workloadId) {
      // An exclusion names the target group it matched: another workload of the same id (another router) is not it.
      const cfg = await config(workloadId);
      if (event.targetGroupArn && isStandalone(cfg)) throw standaloneRefusal(workloadId, 'it has no target group to exclude');
      if (event.targetGroupArn && cfg.appTargetGroupArn !== event.targetGroupArn) {
        throw new Refusal('not_found', `workload not configured: ${workloadId} (its target group is not ${event.targetGroupArn})`);
      }
    }
    return pausing.pause(workloadId, event, { exclusionId: event.exclusionId });
  }

  // Resume removes one pause: the operator's, or the given exclusion's; the router's and the others stay. The operator's resume of a
  // workload the router does not know is refused as not found, as on Google Cloud (B4 of the cloud duplication design); an
  // exclusion's lift of one is not refused, and has nothing to lift.
  async function resume({ workloadId = null, by, exclusionId }) {
    if (workloadId !== null && exclusionId == null) await config(workloadId);
    return pausing.resume(workloadId, by, { exclusionId });
  }

  // --- Work queue: naps and the wakes of a router pause ---------------------------------------------------------------

  // A nap the check (or the manager) queued: refused when the workload is no longer awake (delivered twice, or napped
  // since), woke since it was asked for, had requests since (when it waited more than a minute; not for a nap window's,
  // which naps whatever its traffic), or when it waited too long (the next check decides again). A nap window's waits
  // until the window ends: the queue runs 10 at a time, and the window's occurrence is recorded as applied.
  async function queuedNap({ workloadId, requestedAt, by, cause, until }) {
    const scheduled = cause === 'schedule';
    const run = await store.getRun(workloadId);
    const stale = scheduled && until ? (now() >= until ? 'the nap window ended' : null)
      : now() - requestedAt > NAP_MAX_AGE_MS ? `requested more than ${NAP_MAX_AGE_MS / 60_000} minutes ago` : null;
    let reason = run?.state !== STATES.AWAKE ? `not awake (${run?.state ?? 'UNKNOWN'})`
      : (run.awakeSince ?? 0) > requestedAt ? 'woken since it was requested' : stale;
    const recheck = !reason && !scheduled && now() - requestedAt > NAP_RECHECK_MS ? await config(workloadId) : null;
    // A standalone workload's idle nap (no one asked it) has its signals read again, as an HTTP workload's requests: busy now, no nap.
    // A person's nap is theirs: never read against the signals (final review, Important 1).
    if (recheck && isStandalone(recheck) && !by) reason = await idleRecheck(recheck);
    if (recheck && !isStandalone(recheck) && (await lastRequestAt(cloudwatch, recheck, requestedAt, now(), recheck.kubernetes ? await otherRequestGroups(recheck) : [])) !== null) {
      reason = 'requests since it was requested';
    }
    if (reason) {
      log.warn('NapSkipped', { workloadId, reason });
      return { state: 'SKIPPED', reason };
    }
    return nap(workloadId, { cause: scheduled ? 'schedule' : by ? 'manager' : 'idle', by });
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
    const { pauses, pausesError } = await readActivePauses({ store, expired });
    const byState = {};
    for (const run of runs) byState[run?.state ?? 'UNKNOWN'] = (byState[run?.state ?? 'UNKNOWN'] ?? 0) + 1;
    const updated = runs.map((run) => run?.updatedAt ?? 0).filter((ms) => ms > 0);
    const check = await store.getCheck().catch(() => null);
    const own = (await describeStoredLists(store, ipLists)).map((l) => ({ ...l, source: TERRAFORM, refreshHours: ipLists.find((c) => c.name === l.name)?.refreshHours }));
    const managed = catalog ? await catalog.describe() : null;
    const routerSettings = await store.getRouterSettings?.().catch(() => null);
    const kubeProxies = await store.getKubeProxies?.().catch(() => null);
    const manager = managerSettings ? await managerSettings.current().catch((err) => ({ hibernate: null, readAt: null, error: err.message })) : null;
    const lists = [...own, ...(managed?.lists ?? [])];
    const health = healthOf({
      checkSchedule: router.checkSchedule, lastScheduledCheckAt: check?.lastScheduledCheckAt ?? null, now: t,
      lambda: measured.lambda, queues: measured.queues, failed: byState[STATES.FAILED] ?? 0, concurrency,
      // The manager's lists warn only when the router cannot read them: their freshness is the manager's alarm, once.
      ipLists: [...own, ...(managed?.lists ?? []).filter((l) => l.error && !l.pending).map(({ name, error }) => ({ name, error }))],
      catalogError: managed?.error ?? null,
      managerSettingsError: manager?.error ?? null,
      kubeProxies: kubeProxies ?? {},
    });
    if (pausesError) pausesUnreadable(health, pausesError);
    // Repairs of the last 24 hours (R4c): something outside Dormeto keeps changing what onboarding added (the customer's
    // infrastructure as code, or a person).
    const dayAgo = iso(t - 86_400_000);
    const drift24h = (await Promise.all(configs.map((c) => (store.listDrift ? store.listDrift(c.workloadId, 50).catch(() => []) : []))))
      .flat().filter((e) => e.at >= dayAgo).length;
    // Standalone workloads whose resource the check could not find (deleted, or its dormeto:workload tag removed).
    warnResourceMissing(health, configs.filter((c, i) => isStandalone(c) && runs[i]?.resourceMissing).length);
    if (drift24h) addWarning(health, 'drift', `${drift24h} drift repair${drift24h === 1 ? '' : 's'} in 24 hours: rules or tags changed outside Dormeto, repaired (see the workloads)`);
    return routerAnswer({
      router: { name: router.name, version: router.version, build: router.build },
      settings: routerSettings, manager, managerUrl: managerSettings?.url ?? null,
      configuration: {
        checkSchedule: { value: router.checkSchedule ?? null, source: TERRAFORM },
        ipLists: { value: ipLists.map(({ name, url, action, refreshHours }) => ({ name, url, action, refreshHours })), source: TERRAFORM },
        ...(managed ? { ipListsCatalog: { value: { url: managed.url, lists: managed.lists.map(({ name, action, refreshHours }) => ({ name, action, refreshHours })) }, source: 'manager' } } : {}),
        noWakeRules: { value: describeRules([{ level: 'router', rules: defaultRules }]), source: TERRAFORM },
        metrics: { value: router.metrics ?? null, source: TERRAFORM },
      },
      routerPauses: shownPauses(pauses.filter((p) => p.workloadId === null)), pauses, configs, byState,
      lastActivity: updated.length ? Math.max(...updated) : 0,
      health,
      figures: { checkSchedule: router.checkSchedule ?? null, lastScheduledCheckAt: check?.lastScheduledCheckAt, lambda: measured.lambda, queues: measured.queues, ipLists: lists, concurrency, drift24h },
    });
  }

  // Whether the router reaches a cluster and may do what Kubernetes workloads need (vision
  // docs/specs/2026-10-11-kubernetes-design.md, section 4), in a namespace.
  async function clusterCheck({ cluster, namespace = 'default' }) {
    let k8s;
    let proxy;
    const reach = () => (k8s?.via ? { via: k8s.via, ...(proxy ? { proxy } : {}) } : {});
    try {
      k8s = await kubernetesOf(cluster);
      if (k8s.via === 'proxy') {
        proxy = { name: k8s.proxy, version: null };
        proxy.version = (await pingProxy((name, payload) => lambda.invoke(name, payload), k8s.proxy, { version: router.version, endpoint: k8s.endpoint })).version;
      }
      const missing = await checkRights(k8s, namespace);
      return { cluster, reachable: true, allowed: missing.length === 0, missing, ...reach() };
    } catch (err) {
      if (err?.status === 401 || err?.status === 403) {
        return { cluster, reachable: true, allowed: false, missing: [], reason: `the cluster does not know the router's role (no access entry, or not mapped in aws-auth): ${err.message}`, ...reach() };
      }
      // Through a proxy a timeout is the cluster's security group (the proxy's own, never the router's): spec section 9.
      const reason = k8s?.via === 'proxy' && err?.reason === 'Timeout' ? `the cluster security group must admit TCP 443 from the proxy's security group (${k8s.proxy} unless security_group_ids were given)` : err.message;
      return { cluster, reachable: false, allowed: false, missing: [], reason, ...reach() };
    }
  }

  // The 5-minute check pings the proxy of each proxied cluster with workloads: it keeps the VPC function active (Lambda
  // deactivates one unused for 14 days) and gives the router's health its state, ROUTER / KUBE-PROXIES, replaced whole.
  // The ping carries the endpoint EKS gives now (a recreated cluster is Stale) and probes it (a removed security group
  // rule is a Timeout). It runs after the schedules and the hibernation limit, within the check's budget: a ping not started
  // before it is skipped (its previous record stays). Nothing here fails the check.
  async function pingProxies(configs) {
    if (!store.putKubeProxies || !lambda?.invoke) return;
    try {
      const clusters = [...new Set(configs.map((cfg) => cfg.kubernetes?.cluster).filter(Boolean))].sort();
      const kept = (await store.getKubeProxies?.().catch(() => null)) ?? {};
      const answers = await Promise.all(clusters.map(async (cluster) => {
        const at = now();
        if (at >= budgetEnd) {
          log.warn('KubeProxyPingSkipped', { cluster, reason: 'the check\'s time budget is spent' });
          return kept[cluster] ? [cluster, kept[cluster]] : null;
        }
        let name = null;
        try {
          const k8s = await kubernetesOf(cluster);
          if (k8s.via !== 'proxy') return null;
          name = k8s.proxy;
          const { version } = await pingProxy((fn, payload) => lambda.invoke(fn, payload), name, { version: router.version, endpoint: k8s.endpoint, probe: true });
          return [cluster, { name, ok: true, version, at }];
        } catch (err) {
          // A cluster unreachable altogether (no proxy needed or possible) is the cluster check's to say.
          if (!name && err?.reason !== 'NoProxy') return null;
          log.warn('KubeProxyPingFailed', { cluster, proxy: name, reason: err?.reason, error: err?.message });
          return [cluster, { name, ok: false, reason: err?.reason ?? 'ProxyFailed', message: String(err?.message ?? err).slice(0, 300), at }];
        }
      }));
      await store.putKubeProxies(Object.fromEntries(answers.filter(Boolean)));
    } catch (err) {
      log.warn('KubeProxiesNotRecorded', { error: err.message });
    }
  }

  // What a standalone workload has not (vision standalone workloads design §2, §5): refused as unsupported.
  const standaloneRefusal = (workloadId, what) => new Refusal('unsupported', `workload ${workloadId} is a standalone workload: ${what}`);
  const storedStandalone = async (workloadId) => typeof workloadId === 'string' && workloadId !== '' && isStandalone(await store.getConfig(workloadId));
  // A nap window's `wake` (never, header) says what a request may do in it: nothing arrives to wake a standalone workload.
  async function standaloneScheduleProblems({ workloadId, schedule }) {
    if (!(await storedStandalone(workloadId)) || !Array.isArray(schedule?.windows)) return [];
    return schedule.windows.flatMap((w, i) => (w?.kind === 'nap' && w.wake !== undefined && w.wake !== null
      ? [`windows[${i}].wake: a standalone workload has no waiting page: nothing arrives to wake it in a nap window`] : []));
  }

  // A refusal is an answer for a caller that reads them (refusals: true, the manager's), else thrown as before (vision
  // refusals design §1); the router's own invocations never send the flag.
  return async function handler(event, context) {
    const remaining = context?.getRemainingTimeInMillis?.();
    budgetEnd = typeof remaining === 'number' ? now() + remaining - TIMEOUT_MARGIN_MS : Infinity;
    if (Array.isArray(event?.Records)) return runQueued(event.Records);
    try {
      return await act(event);
    } catch (err) {
      if (!(err instanceof Refusal) || event?.refusals !== true) throw err;
      log.info('Refused', { action: event?.action ?? null, workloadId: event?.workloadId ?? null, code: err.code, message: err.message });
      return refused(err);
    }
  };

  async function act(event) {
    switch (event?.action) {
      case 'wake': return wake(event.workloadId, event.wakeId);
      case 'nap': return nap(event.workloadId, { cause: event.cause === 'schedule' ? 'schedule' : event.by ? 'manager' : 'idle', by: event.by });
      case 'release': return release(event.workloadId);
      case 'check': return check(event.source);
      case 'ensure-awake': return ensureAwake(event.workloadId);
      case 'refresh-lists': return lists ? lists.refresh(event.names ?? []) : [];
      case 'list': return list();
      case 'report': return reportWorkload(event);
      case 'status': return workloadStatus(event.workloadId);
      case 'force-wake': return managerActions.forceWake(event);
      case 'pause': return pause(event);
      case 'resume': return resume(event);
      case 'request-nap': return managerActions.requestNap(event);
      case 'rename': return managerActions.rename(event);
      case 'tag': return managerActions.tag(event);
      case 'schedule': {
        const problems = await standaloneScheduleProblems(event);
        return problems.length ? { problems } : managerActions.setSchedule(event);
      }
      case 'clear-schedule': return managerActions.clearSchedule(event);
      case 'settings': return managerActions.setSettings(event);
      case 'waiting-page':
        if (await storedStandalone(event.workloadId)) throw standaloneRefusal(event.workloadId, 'it has no waiting page');
        return managerActions.waitingPage(event);
      case 'router': return routerInfo();
      case 'clusterCheck': return clusterCheck(event);
      default: throw new Refusal('unsupported', `unknown action: ${event?.action}`);
    }
  }
}
