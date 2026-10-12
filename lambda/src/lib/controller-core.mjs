import { randomUUID } from 'node:crypto';
import { STATES } from './state.mjs';
import { setRoute } from './route.mjs';
import { healthyCount, waitTargetsReleased } from './instances.mjs';
import { createStatus } from './status.mjs';
import { describeRules } from './no-wake.mjs';
import { describeStoredLists } from './list-cache.mjs';
import { STATS_DAYS, workloadSummary } from './summary.mjs';
import { discoverCandidates } from './candidates.mjs';
import { requestSum } from './metrics.mjs';
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

export function createController({
  store, ec2, elbv2, cloudwatch, autoscaling, ecs, tagging, appscaling, rds, invokeSelf, now = Date.now, sleep, newId = randomUUID, log,
  lists = null, router = {}, defaultRules = [], ipLists = [],
}) {
  const clients = { ec2, elbv2, autoscaling, ecs, tagging, appscaling, rds };
  let budgetEnd = Infinity;

  async function config(workloadId) {
    const cfg = await store.getConfig(workloadId);
    if (!cfg) throw new Error(`workload not configured: ${workloadId}`);
    return cfg;
  }

  async function managedBackends(cfg) {
    const { backends, ignored } = await resolveBackends(clients, cfg);
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
    const fail = async (err) => {
      log.error('WakeFailed', { workloadId, wakeId, error: err.message });
      await store.transition(workloadId, { cond: { state: STATES.WAKING, wakeId }, set: { state: STATES.FAILED, failedAt: now(), holders: 0 } });
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
    const timing = { sleep, now, deadline: Math.min(wakeDeadline, budgetEnd) };
    try {
      await wakeBackends(clients, await wakeRecords(run, cfg), timing);
      while ((await healthyCount(elbv2, cfg.appTargetGroupArn)) < 1) {
        if (now() >= timing.deadline) throw new Error('wake timeout: no healthy target');  // or Lambda time budget
        await sleep(HEALTH_POLL_MS);
      }
      if (!(await current())) return superseded();
      await setRoute(elbv2, cfg, 'app');
      const done = await store.transition(workloadId, {
        cond: { state: STATES.WAKING, wakeId },
        set: { state: STATES.AWAKE, awakeSince: now(), holders: 0 },
        remove: ['pendingWake', 'napInstances', 'napBackends'],
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

  async function nap(workloadId) {
    const cfg = await config(workloadId);
    const backends = await managedBackends(cfg);
    if (!backends.length) {
      // Diverting traffic to the waker with nothing to stop or start would only break the application.
      log.warn('NapSkipped', { workloadId, reason: 'no-instances' });
      return { state: 'SKIPPED', reason: 'no-instances' };
    }
    const napping = await store.transition(workloadId, {
      cond: { state: STATES.AWAKE },
      set: { state: STATES.NAPPING, napBackends: JSON.stringify(backends.map(toRecord)) },
      remove: ['pendingWake'],
    });
    if (!napping) return { state: 'SKIPPED' };
    log.info('NapStarted', { workloadId });
    try {
      await setRoute(elbv2, cfg, 'waker');
      await sleep(cfg.drainSeconds * 1000);
      // Commit point: after this transition the instances are stopped even if a request arrives.
      const committed = await store.transition(workloadId, { cond: { state: STATES.NAPPING, pendingWake: false }, set: { stopping: true } });
      if (!committed) {
        await setRoute(elbv2, cfg, 'app');
        await store.transition(workloadId, {
          cond: { state: STATES.NAPPING },
          set: { state: STATES.AWAKE, awakeSince: now() },
          remove: ['pendingWake', 'stopping'],
        });
        log.info('NapAborted', { workloadId });
        return { state: STATES.AWAKE, aborted: true };
      }
      await sleepBackends(clients, backends, { sleep, now, deadline: now() + STOP_TIMEOUT_MS });
      if (!(await waitTargetsReleased(elbv2, cfg.appTargetGroupArn, { sleep, now, deadline: now() + RELEASE_TIMEOUT_MS }))) {
        log.warn('TargetsNotReleased', { workloadId });
      }
    } catch (err) {
      log.error('NapFailed', { workloadId, error: err.message });
      await store.transition(workloadId, { cond: { state: STATES.NAPPING }, set: { state: STATES.FAILED, failedAt: now(), holders: 0 }, remove: ['stopping'] });
      return { state: STATES.FAILED, error: err.message };
    }
    const asleep = await store.transition(workloadId, { cond: { state: STATES.NAPPING, pendingWake: false }, set: { state: STATES.ASLEEP, holders: 0 }, remove: ['stopping'] });
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
    });
    if (!waking) return { state: 'UNKNOWN' };
    log.info('WakeRequested', { workloadId, wakeId, reason: 'pendingWake' });
    return wake(workloadId, wakeId, cfg);
  }

  async function reconcile(cfg) {
    const { workloadId } = cfg;
    let run = await store.getRun(workloadId);
    if (!run) return null;
    const stuckBefore = now() - NAPPING_STUCK_MS;
    if (run.state === STATES.NAPPING && (run.updatedAt ?? 0) < stuckBefore) {
      log.warn('NapStuck', { workloadId });
      return (await store.transition(workloadId, {
        cond: { state: STATES.NAPPING, olderThan: { field: 'updatedAt', ms: stuckBefore } },
        set: { state: STATES.FAILED, failedAt: now(), holders: 0 },
        remove: ['stopping'],
      })) ?? store.getRun(workloadId);
    }
    const wakeStuckBefore = now() - cfg.wakeTimeoutSeconds * 1000 - WAKING_STUCK_GRACE_MS;
    if (run.state === STATES.WAKING && (run.wakeStartedAt ?? 0) < wakeStuckBefore) {
      log.warn('WakeStuck', { workloadId, wakeId: run.wakeId });
      return (await store.transition(workloadId, {
        cond: { state: STATES.WAKING, wakeId: run.wakeId },
        set: { state: STATES.FAILED, failedAt: now(), holders: 0 },
      })) ?? store.getRun(workloadId);
    }
    if (![STATES.AWAKE, STATES.ASLEEP, STATES.FAILED].includes(run.state)) return run;

    const backends = await managedBackends(cfg);
    const statuses = backends.length ? await backendStatuses(clients, backends) : {};
    // The primary backends decide the state; companions (databases) follow it.
    const primaries = backends.filter((b) => !isCompanion(b));
    const companions = backends.filter(isCompanion);
    // No managed primary backend: nothing to infer (every() would be vacuously true).
    const all = (name) => primaries.length > 0 && primaries.every((b) => statuses[backendKey(b)] === name);
    const from = run.state;
    if (from !== STATES.AWAKE && all('running') && (await healthyCount(elbv2, cfg.appTargetGroupArn)) >= 1) {
      log.warn(from === STATES.FAILED ? 'FailedRecovered' : 'ExternalWake', { workloadId });
      if (run.napBackends) await resumeBackends(clients, JSON.parse(run.napBackends));
      else await startCompanions(clients, companions);
      await setRoute(elbv2, cfg, 'app');
      run = (await store.transition(workloadId, {
        cond: { state: from }, set: { state: STATES.AWAKE, awakeSince: now() }, remove: ['napBackends', 'napInstances'],
      }))
        ?? (await store.getRun(workloadId));
    } else if (from !== STATES.ASLEEP && all('stopped')) {
      log.warn(from === STATES.FAILED ? 'FailedRecovered' : 'ExternalStop', { workloadId });
      await setRoute(elbv2, cfg, 'waker');
      await stopCompanions(clients, companions);
      run = (await store.transition(workloadId, { cond: { state: from }, set: { state: STATES.ASLEEP, holders: 0 } }))
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
    if (expected && (await setRoute(elbv2, cfg, expected))) log.warn('RouteRepaired', { workloadId, route: expected });

    if ((run.holders ?? 0) > 0 && (run.updatedAt ?? 0) < now() - HOLDERS_STALE_MS) {
      log.warn('HoldersReset', { workloadId, holders: run.holders });
      run = (await store.transition(workloadId, { cond: { state: run.state }, set: { holders: 0 } })) ?? run;
    }
    return run;
  }

  async function checkOne(cfg) {
    const run = await reconcile(cfg);
    if (!run || run.state !== STATES.AWAKE) return { state: run?.state ?? 'UNKNOWN' };
    if (!run.awakeSince) {
      // First check after deployment: the idle window starts now, not at the epoch.
      await store.transition(cfg.workloadId, { cond: { state: STATES.AWAKE }, set: { awakeSince: now() } });
      return { state: run.state };
    }
    const t = now();
    const idleMs = cfg.idleMinutes * 60_000;
    if ((run.awakeSince ?? 0) > t - idleMs) return { state: run.state };
    const requests = await requestSum(cloudwatch, cfg, t - idleMs, t);
    if (requests > 0) return { state: run.state, requests };
    // A nap lasts minutes: run it in its own invocation so that the check (and the other workloads) are not delayed.
    if (invokeSelf) {
      await invokeSelf({ action: 'nap', workloadId: cfg.workloadId });
      log.info('NapRequested', { workloadId: cfg.workloadId });
      return { state: run.state, nap: 'requested' };
    }
    return nap(cfg.workloadId);
  }

  // --- Manager interface: list, status, force-wake ------------------------------------------------------------------

  const status = createStatus({ ec2, elbv2, cloudwatch, autoscaling, ecs, tagging, appscaling, rds, now, version: router });
  // Host conditions of the workload rules, for their URL: one DescribeRules call, cached (rules rarely change).
  const hosts = { at: 0, byRule: new Map() };
  async function ruleHosts(configs) {
    if (now() - hosts.at < 5 * 60_000 && configs.every((c) => hosts.byRule.has(c.ruleArn))) return hosts.byRule;
    const arns = configs.map((c) => c.ruleArn).filter(Boolean);
    const { Rules = [] } = arns.length ? await elbv2.describeRules({ RuleArns: arns }).catch(() => ({})) : {};
    hosts.byRule = new Map(Rules.map((r) => [r.RuleArn, r.Conditions?.find((c) => c.Field === 'host-header')?.HostHeaderConfig?.Values?.[0] ?? null]));
    hosts.at = now();
    return hosts.byRule;
  }

  async function list() {
    const configs = await store.listConfigs();
    const byRule = await ruleHosts(configs);
    const workloads = await Promise.all(configs.map(async (cfg) => workloadSummary(cfg, await store.getRun(cfg.workloadId), byRule.get(cfg.ruleArn))));
    return { router: { name: router.name, version: router.version, build: router.build }, workloads };
  }

  async function workloadStatus(workloadId) {
    const cfg = await config(workloadId);
    const run = await store.getRun(workloadId);
    return status(workloadId, cfg, run ?? {}, {
      noWakeRules: describeRules([{ level: 'router', rules: defaultRules }, { level: 'workload', rules: cfg.noWakeRules }]),
      wakeRules: describeRules([{ level: 'wake', rules: cfg.wakeRules }]),
      loadStats: () => store.getStats(workloadId, STATS_DAYS),
      loadLists: () => describeStoredLists(store, ipLists),
    });
  }

  async function count(workloadId, counter) {
    try {
      await store.count(workloadId, counter);
    } catch (err) {
      log.warn('StatsWriteFailed', { workloadId, counter, error: err.message });
    }
  }

  // Operator request from the manager: no retry delay; the wake itself runs in its own invocation.
  async function forceWake(workloadId, by) {
    await config(workloadId);
    const run = await store.getRun(workloadId);
    if (run?.state === STATES.ASLEEP || run?.state === STATES.FAILED) {
      const wakeId = newId();
      const next = await store.transition(workloadId, {
        cond: { state: run.state }, set: { state: STATES.WAKING, wakeId, wakeStartedAt: now() }, remove: ['failedAt'], increment: ['wakeCount'],
      });
      if (!next) return { state: (await store.getRun(workloadId))?.state };
      log.info('WakeRequested', { workloadId, wakeId, trigger: { kind: 'manager', by } });
      await count(workloadId, 'wake:manager');
      await invokeSelf({ action: 'wake', workloadId, wakeId });
      return { state: STATES.WAKING };
    }
    if (run?.state === STATES.NAPPING) {
      if (await store.setPendingWake(workloadId)) {
        log.info('PendingWake', { workloadId, trigger: { kind: 'manager', by } });
        await count(workloadId, 'wake:manager');
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

  async function check() {
    await requestListRefresh();
    const results = [];
    for (const cfg of await store.listConfigs()) {
      try {
        results.push({ workloadId: cfg.workloadId, ...(await checkOne(cfg)) });
      } catch (err) {
        log.error('CheckFailed', { workloadId: cfg.workloadId, error: err.message });
        results.push({ workloadId: cfg.workloadId, error: err.message });
      }
    }
    return results;
  }

  async function ensureAwake(workloadId) {
    const cfg = await config(workloadId);
    const run = await store.getRun(workloadId);
    if (run?.state !== STATES.AWAKE) return { state: run?.state };
    if ((await healthyCount(elbv2, cfg.appTargetGroupArn)) < 1) return { state: run.state, healthy: 0 };
    const changed = await setRoute(elbv2, cfg, 'app');
    if (changed) log.warn('RouteRepaired', { workloadId, route: 'app' });
    return { state: run.state, changed };
  }

  return async function handler(event, context) {
    const remaining = context?.getRemainingTimeInMillis?.();
    budgetEnd = typeof remaining === 'number' ? now() + remaining - TIMEOUT_MARGIN_MS : Infinity;
    switch (event?.action) {
      case 'wake': return wake(event.workloadId, event.wakeId);
      case 'nap': return nap(event.workloadId);
      case 'check': return check();
      case 'ensure-awake': return ensureAwake(event.workloadId);
      case 'refresh-lists': return lists ? lists.refresh(event.names ?? []) : [];
      case 'list': return list();
      case 'status': return workloadStatus(event.workloadId);
      case 'force-wake': return forceWake(event.workloadId, event.by);
      case 'discover': return discoverCandidates({ elbv2, autoscaling, ecs, cloudwatch }, { now });
      default: throw new Error(`unknown action: ${event?.action}`);
    }
  };
}
