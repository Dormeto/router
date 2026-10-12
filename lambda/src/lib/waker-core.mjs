import { randomUUID } from 'node:crypto';
import { STATES } from './state.mjs';
import { acceptsHtml, classify, redirectCount, requestOrigin, requestTarget, response, workloadIdFromEvent } from './http.mjs';
import { renderJson, renderPage } from './page.mjs';
import { ADMIN_PREFIX, parseAdminPath } from './admin.mjs';

const POLL_MS = 1000;
const STUCK_GRACE_MS = 60_000;
const MAX_REDIRECTS = 2;
// ALB rule changes take about 12 s to propagate: right after a wake, requests still reach the waker.
const ROUTE_GRACE_MS = 15_000;

export function createWaker({ store, invokeController, prefix, now = Date.now, sleep, newId = randomUUID, log, getAdmin }) {
  const inRouteGrace = (run) => run.state === STATES.AWAKE && (run.awakeSince ?? 0) > now() - ROUTE_GRACE_MS;
  const servable = (run) => run.state === STATES.AWAKE && !inRouteGrace(run);

  async function startWake(workloadId, cond, run, trigger) {
    const wakeId = newId();
    const next = await store.transition(workloadId, {
      cond,
      set: { state: STATES.WAKING, wakeId, wakeStartedAt: now() },
      remove: ['failedAt'],
      increment: ['wakeCount'],
    });
    if (!next) return (await store.getRun(workloadId)) ?? run;
    log.info('WakeRequested', { workloadId, wakeId, trigger });
    try {
      await invokeController({ action: 'wake', workloadId, wakeId });
      return next;
    } catch (err) {
      log.error('WakeInvokeFailed', { workloadId, wakeId, error: err.message });
      return (await store.transition(workloadId, {
        cond: { state: STATES.WAKING, wakeId },
        set: { state: STATES.FAILED, failedAt: now() },
      })) ?? next;
    }
  }

  async function trigger(workloadId, cfg, run, kind, origin) {
    const t = now();
    switch (run.state) {
      case STATES.ASLEEP:
        return startWake(workloadId, { state: STATES.ASLEEP }, run, origin);
      case STATES.FAILED:
        if ((run.failedAt ?? 0) > t - cfg.failedRetrySeconds * 1000) return run;
        return startWake(workloadId, { state: STATES.FAILED }, run, origin);
      case STATES.WAKING:
        if ((run.wakeStartedAt ?? 0) > t - cfg.wakeTimeoutSeconds * 1000 - STUCK_GRACE_MS) return run;
        log.warn('WakeStuck', { workloadId, wakeId: run.wakeId });
        return startWake(workloadId, { state: STATES.WAKING, wakeId: run.wakeId }, run, origin);
      case STATES.NAPPING:
        if (await store.setPendingWake(workloadId)) log.info('PendingWake', { workloadId, trigger: origin });
        return run;
      case STATES.AWAKE:
        // Reaching the waker while awake is expected during the route grace window; later it means drift.
        if (kind !== 'probe' && !inRouteGrace(run)) await invokeController({ action: 'ensure-awake', workloadId });
        return run;
      default:
        return run;
    }
  }

  // Operator request from the admin dashboard: no retry delay, no hold.
  async function forceWake(workloadId, run) {
    switch (run.state) {
      case STATES.ASLEEP:
      case STATES.FAILED:
        return startWake(workloadId, { state: run.state }, run, { kind: 'admin' });
      case STATES.NAPPING:
        await store.setPendingWake(workloadId);
        return run;
      default:
        return run;
    }
  }

  async function hold(workloadId, cfg, run) {
    if (!(await store.tryAcquireHolder(workloadId, cfg.maxHolders))) return run;
    let current = run;
    try {
      const deadline = now() + cfg.waitSeconds * 1000;
      while (now() < deadline) {
        await sleep(POLL_MS);
        current = (await store.getRun(workloadId)) ?? current;
        if (servable(current) || current.state === STATES.FAILED) break;
      }
    } finally {
      await store.releaseHolder(workloadId);
    }
    return current;
  }

  function waiter(event, pollSeconds, state) {
    const headers = { 'cache-control': 'no-store', 'retry-after': String(pollSeconds), 'x-dormeto-state': state };
    if (event.httpMethod === 'HEAD') return response(503, headers);
    if (acceptsHtml(event)) {
      return response(503, { ...headers, 'content-type': 'text/html; charset=utf-8' }, renderPage({ state, pollSeconds }));
    }
    return response(503, { ...headers, 'content-type': 'application/json' }, renderJson({ state, pollSeconds }));
  }

  function answer(event, cfg, run) {
    if (run.state !== STATES.AWAKE) return waiter(event, cfg.pollSeconds, run.state);
    if (inRouteGrace(run)) return waiter(event, cfg.pollSeconds, STATES.AWAKE);
    const count = redirectCount(event);
    if (count >= MAX_REDIRECTS) return waiter(event, cfg.pollSeconds, STATES.AWAKE);
    return response(307, {
      location: requestTarget(event),
      'cache-control': 'no-store',
      'set-cookie': `dmt_r=${count + 1}; Max-Age=30; Path=/; Secure; HttpOnly; SameSite=Lax`,
    });
  }

  return async function handler(event) {
    const workloadId = workloadIdFromEvent(event, prefix);
    const [cfg, initial] = await Promise.all([store.getConfig(workloadId), store.getRun(workloadId)]);
    if (!cfg || !initial) {
      log.error('WorkloadNotConfigured', { workloadId });
      return waiter(event, 10, STATES.FAILED);
    }
    const admin = getAdmin ? parseAdminPath(event.path, cfg) : null;
    if (!admin && cfg.admin?.enabled && event.path?.startsWith(ADMIN_PREFIX)) {
      // The ALB sends every /_dormeto/* path here: a wrong secret is a 404, never a wake or a redirect.
      return response(404, { 'cache-control': 'no-store', 'content-type': 'text/plain' }, 'Not found');
    }
    if (admin) {
      const handle = await getAdmin();
      return handle({
        event, workloadId, cfg, run: initial, base: admin.base, route: admin.route,
        forceWake: (run) => forceWake(workloadId, run),
      });
    }
    const kind = classify(event);
    let run = initial;
    if (kind !== 'no-wake') run = await trigger(workloadId, cfg, run, kind, requestOrigin(event, kind));
    if (kind === 'normal' && !servable(run) && run.state !== STATES.FAILED && cfg.waitSeconds > 0) {
      run = await hold(workloadId, cfg, run);
    }
    return answer(event, cfg, run);
  };
}
