import { randomUUID } from 'node:crypto';
import { STATES } from './state.mjs';
import { setRoute } from './route.mjs';
import { healthyCount, instanceStates, startInstances, stopInstances } from './instances.mjs';
import { requestSum } from './metrics.mjs';

const HEALTH_POLL_MS = 3000;
const STOP_TIMEOUT_MS = 5 * 60_000;
const NAPPING_STUCK_MS = 15 * 60_000;

export function createController({ store, ec2, elbv2, cloudwatch, now = Date.now, sleep, newId = randomUUID, log }) {
  async function config(workloadId) {
    const cfg = await store.getConfig(workloadId);
    if (!cfg) throw new Error(`workload not configured: ${workloadId}`);
    return cfg;
  }

  async function wake(workloadId, wakeId, knownConfig) {
    const cfg = knownConfig ?? (await config(workloadId));
    const timing = { sleep, now, deadline: now() + cfg.wakeTimeoutSeconds * 1000 };
    try {
      await startInstances(ec2, cfg.instanceIds, timing);
      while ((await healthyCount(elbv2, cfg.appTargetGroupArn)) < 1) {
        if (now() >= timing.deadline) throw new Error('wake timeout: no healthy target');
        await sleep(HEALTH_POLL_MS);
      }
      await setRoute(elbv2, cfg, 'app');
      const done = await store.transition(workloadId, {
        cond: { state: STATES.WAKING, wakeId },
        set: { state: STATES.AWAKE, awakeSince: now(), holders: 0 },
        remove: ['pendingWake'],
      });
      if (!done) {
        log.warn('WakeSuperseded', { workloadId, wakeId });
        return { state: 'SUPERSEDED' };
      }
      log.info('WakeCompleted', { workloadId, wakeId });
      return { state: STATES.AWAKE };
    } catch (err) {
      log.error('WakeFailed', { workloadId, wakeId, error: err.message });
      await store.transition(workloadId, { cond: { state: STATES.WAKING, wakeId }, set: { state: STATES.FAILED, failedAt: now() } });
      return { state: STATES.FAILED, error: err.message };
    }
  }

  async function nap(workloadId) {
    const cfg = await config(workloadId);
    const napping = await store.transition(workloadId, { cond: { state: STATES.AWAKE }, set: { state: STATES.NAPPING }, remove: ['pendingWake'] });
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
      await stopInstances(ec2, cfg.instanceIds, { sleep, now, deadline: now() + STOP_TIMEOUT_MS });
    } catch (err) {
      log.error('NapFailed', { workloadId, error: err.message });
      await store.transition(workloadId, { cond: { state: STATES.NAPPING }, set: { state: STATES.FAILED, failedAt: now() }, remove: ['stopping'] });
      return { state: STATES.FAILED, error: err.message };
    }
    const asleep = await store.transition(workloadId, { cond: { state: STATES.NAPPING, pendingWake: false }, set: { state: STATES.ASLEEP }, remove: ['stopping'] });
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
        set: { state: STATES.FAILED, failedAt: now() },
        remove: ['stopping'],
      })) ?? store.getRun(workloadId);
    }
    if (run.state !== STATES.AWAKE && run.state !== STATES.ASLEEP) return run;

    const states = await instanceStates(ec2, cfg.instanceIds);
    const all = (name) => cfg.instanceIds.every((id) => states[id] === name);
    if (run.state === STATES.ASLEEP && all('running') && (await healthyCount(elbv2, cfg.appTargetGroupArn)) >= 1) {
      log.warn('ExternalWake', { workloadId });
      await setRoute(elbv2, cfg, 'app');
      run = (await store.transition(workloadId, { cond: { state: STATES.ASLEEP }, set: { state: STATES.AWAKE, awakeSince: now() } }))
        ?? (await store.getRun(workloadId));
    } else if (run.state === STATES.AWAKE && all('stopped')) {
      log.warn('ExternalStop', { workloadId });
      await setRoute(elbv2, cfg, 'waker');
      run = (await store.transition(workloadId, { cond: { state: STATES.AWAKE }, set: { state: STATES.ASLEEP } }))
        ?? (await store.getRun(workloadId));
    }

    // Keep the route consistent with the state, for example after a Terraform apply reset the weights.
    const expected = run.state === STATES.AWAKE ? 'app' : run.state === STATES.ASLEEP ? 'waker' : null;
    if (expected && (await setRoute(elbv2, cfg, expected))) log.warn('RouteRepaired', { workloadId, route: expected });
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
    return nap(cfg.workloadId);
  }

  async function check() {
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

  return async function handler(event) {
    switch (event?.action) {
      case 'wake': return wake(event.workloadId, event.wakeId);
      case 'nap': return nap(event.workloadId);
      case 'check': return check();
      case 'ensure-awake': return ensureAwake(event.workloadId);
      default: throw new Error(`unknown action: ${event?.action}`);
    }
  };
}
