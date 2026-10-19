import { randomUUID } from 'node:crypto';
import { failedSpec, failureKind, nextAttemptAt } from './failures.mjs';
import { STATES } from './state.mjs';
import { WAKE_HEADER, acceptsHtml, classify, redirectCount, requestOrigin, requestTarget, response, workloadIdFromEvent } from './http.mjs';
import { renderJson, renderPage } from './page.mjs';
import { ADMIN_PREFIX, parseAdminPath } from './admin.mjs';
import { compileRules, describeRules } from './no-wake.mjs';
import { STATS_DAYS } from './summary.mjs';
import { localTime, occurrenceAt } from './schedule.mjs';

const POLL_MS = 1000;
const STUCK_GRACE_MS = 60_000;
const MAX_REDIRECTS = 2;
// ALB rule changes take about 12 s to propagate: right after a wake, requests still reach the waker.
const ROUTE_GRACE_MS = 15_000;
// Route repairs requested from a warm waker instance: at most one per workload in this interval.
const ENSURE_INTERVAL_MS = 10_000;

export function createWaker({ store, invokeController, prefix, now = Date.now, sleep, newId = randomUUID, log, getAdmin, defaultRules = [], listCache = null }) {
  const ensured = new Map(); // workload id → last ensure-awake request
  const inRouteGrace = (run) => run.state === STATES.AWAKE && (run.awakeSince ?? 0) > now() - ROUTE_GRACE_MS;
  const servable = (run) => run.state === STATES.AWAKE && !inRouteGrace(run);

  // Compiled once per distinct rule list: an invalid rule is reported once, not on every request.
  const compiled = new Map();
  function rulesFor(level, rules) {
    if (!rules?.length) return [];
    const key = `${level}:${JSON.stringify(rules)}`;
    if (!compiled.has(key)) {
      compiled.set(key, compileRules(rules, {
        level,
        onInvalid: (rule, reason) => log.warn('NoWakeRuleInvalid', { level, rule: rule?.name, reason }),
      }));
    }
    return compiled.get(key);
  }
  const noWakeRules = (cfg) => [...rulesFor('router', defaultRules), ...rulesFor('workload', cfg.noWakeRules)];

  // Daily statistics: a failed counter update never changes the answer.
  async function count(workloadId, counter) {
    try {
      await store.count(workloadId, counter);
    } catch (err) {
      log.warn('StatsWriteFailed', { workloadId, counter, error: err.message });
    }
  }

  async function startWake(workloadId, cond, run, trigger) {
    const wakeId = newId();
    const next = await store.transition(workloadId, {
      cond,
      set: { state: STATES.WAKING, wakeId, wakeStartedAt: now() },
      remove: ['failedAt'],
      increment: ['wakeCount'],
      cause: trigger.kind,
    });
    if (!next) return (await store.getRun(workloadId)) ?? run;
    log.info('WakeRequested', { workloadId, wakeId, trigger });
    const counted = count(workloadId, `wake:${trigger.kind}`);
    try {
      await invokeController({ action: 'wake', workloadId, wakeId });
      await counted;
      return next;
    } catch (err) {
      await counted;
      log.error('WakeInvokeFailed', { workloadId, wakeId, error: err.message });
      const failed = failedSpec(err, { step: 'wake', backend: 'controller', wakeId, at: now() });
      return (await store.transition(workloadId, {
        cond: { state: STATES.WAKING, wakeId },
        set: { state: STATES.FAILED, failedAt: now(), ...failed.set },
        increment: failed.increment,
        cause: 'invoke-failed',
        event: failed.event,
      })) ?? next;
    }
  }

  async function trigger(workloadId, cfg, run, kind, origin) {
    const t = now();
    switch (run.state) {
      case STATES.ASLEEP:
        // Asleep after a failure: backed off as FAILED is (review C1).
        if ((nextAttemptAt(cfg, run) ?? 0) > t) return run;
        return startWake(workloadId, { state: STATES.ASLEEP }, run, origin);
      case STATES.FAILED:
        // Backed off (R7a): each consecutive failure doubles the wait, at most 30 minutes.
        if (nextAttemptAt(cfg, run) > t) return run;
        return startWake(workloadId, { state: STATES.FAILED }, run, origin);
      case STATES.WAKING:
        if ((run.wakeStartedAt ?? 0) > t - cfg.wakeTimeoutSeconds * 1000 - STUCK_GRACE_MS) return run;
        log.warn('WakeStuck', { workloadId, wakeId: run.wakeId });
        return startWake(workloadId, { state: STATES.WAKING, wakeId: run.wakeId }, run, origin);
      case STATES.NAPPING:
        if (await store.setPendingWake(workloadId)) {
          log.info('PendingWake', { workloadId, trigger: origin });
          await count(workloadId, `wake:${origin.kind}`);
        }
        return run;
      case STATES.AWAKE:
        // Reaching the waker while awake is expected during the route grace window; later it means drift.
        if (kind !== 'probe' && !inRouteGrace(run) && now() - (ensured.get(workloadId) ?? -Infinity) >= ENSURE_INTERVAL_MS) {
          // At most every 10 s per workload and warm instance: each repair resolves the rules (several ELB calls).
          ensured.set(workloadId, now());
          await invokeController({ action: 'ensure-awake', workloadId });
        }
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
        if (await store.setPendingWake(workloadId)) await count(workloadId, 'wake:admin');
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

  // failed: { kind, retryAt } of a failed workload (R7a): the page says why and when the next attempt is.
  // napUntil: { at, local, timeZone } of the nap window that keeps the workload asleep.
  function waiter(event, pollSeconds, state, wakeHeader, failed = null, napUntil = null) {
    const headers = {
      ...(napUntil ? { 'x-dormeto-nap-until': napUntil.at } : {}),
      'cache-control': 'no-store', 'retry-after': String(pollSeconds), 'x-dormeto-state': state,
      ...(failed?.kind ? { 'x-dormeto-failure': failed.kind } : {}),
      ...(failed?.retryAt ? { 'x-dormeto-retry-at': new Date(failed.retryAt).toISOString() } : {}),
    };
    if (event.httpMethod === 'HEAD') return response(503, headers);
    if (acceptsHtml(event)) {
      const retryInMs = failed?.retryAt ? Math.max(0, failed.retryAt - now()) : undefined;
      return response(503, { ...headers, 'content-type': 'text/html; charset=utf-8' }, renderPage({ state, pollSeconds, failure: failed?.kind, retryInMs, napUntil }));
    }
    return response(503, { ...headers, 'content-type': 'application/json' }, renderJson({ state, pollSeconds, wakeHeader, napUntil }));
  }

  // The nap window active now for a workload that is not awake, or null. A bad stored schedule counts as none.
  async function napWindow(workloadId, run) {
    if (![STATES.ASLEEP, STATES.NAPPING, STATES.FAILED].includes(run.state)) return null;
    try {
      const schedule = await store.getSchedule(workloadId);
      if (!schedule) return null;
      const t = now();
      const occurrence = occurrenceAt(schedule, t);
      if (occurrence?.kind !== 'nap') return null;
      return {
        wake: occurrence.wake ?? 'never',
        until: { at: new Date(occurrence.end).toISOString(), local: localTime(occurrence.end, schedule.timeZone), timeZone: schedule.timeZone },
      };
    } catch (err) {
      log.warn('ScheduleSkipped', { workloadId, error: err.message });
      return null;
    }
  }

  function answer(event, cfg, run, napUntil = null) {
    if (run.state !== STATES.AWAKE) {
      // Browser mode: API clients learn how to wake the workload.
      const hint = cfg.wakeMode === 'browser' && [STATES.ASLEEP, STATES.FAILED].includes(run.state) ? WAKE_HEADER : undefined;
      const retryAt = nextAttemptAt(cfg, run);
      const failed = retryAt !== null ? { kind: failureKind(run), retryAt } : null;
      return waiter(event, cfg.pollSeconds, run.state, hint, failed, napUntil);
    }
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
        noWakeRules: describeRules([{ level: 'router', rules: defaultRules }, { level: 'workload', rules: cfg.noWakeRules }]),
        wakeRules: describeRules([{ level: 'wake', rules: cfg.wakeRules }]),
        loadStats: () => store.getStats(workloadId, STATS_DAYS),
        loadLists: listCache ? () => listCache.describe() : null,
      });
    }
    const options = { browserMode: cfg.wakeMode === 'browser', wakeRules: rulesFor('wake', cfg.wakeRules) };
    let classified = classify(event, noWakeRules(cfg), options);
    // IP lists only matter for requests that the filters and explicit wakes did not settle, and not while awake
    // (requests reach the waker then only during the route switch): no list load for the others.
    if (listCache && initial.state !== STATES.AWAKE && classified.kind !== 'no-wake' && !classified.trigger) {
      const lists = await listCache.get();
      if (lists.length) classified = classify(event, noWakeRules(cfg), { ...options, lists });
    }
    const { kind, reason, trigger: by, deferred } = classified;
    let run = initial;
    const origin = () => requestOrigin(event, by ?? kind);
    // Inside a nap window nothing wakes on traffic, except the wake header when the window allows it.
    const nap = kind === 'no-wake' ? null : await napWindow(workloadId, run);
    const napBlocks = !!nap && !(nap.wake === 'header' && by === 'header');
    if (napBlocks) {
      log.info('WakeIgnored', { workloadId, reason: 'nap window', trigger: origin() });
      await count(workloadId, 'ignored:schedule');
    } else if (kind === 'no-wake') {
      if (run.state !== STATES.AWAKE) {
        log.info('WakeIgnored', { workloadId, reason, trigger: origin() });
        await count(workloadId, `ignored:${reason}`);
      }
    } else if (!deferred || run.state === STATES.AWAKE) {
      // Awake: drift repair as in any mode. A deferred request (browser mode) waits for the waiter page's probe.
      run = await trigger(workloadId, cfg, run, kind, origin());
    } else if ([STATES.ASLEEP, STATES.FAILED].includes(run.state)) {
      log.info('WakeDeferred', { workloadId, reason, trigger: origin() });
      await count(workloadId, `deferred:${reason}`);
    }
    // A deferred request is held only behind a wake already in progress.
    const holdable = !deferred || run.state === STATES.WAKING;
    if (!napBlocks && kind === 'normal' && holdable && !servable(run) && run.state !== STATES.FAILED && cfg.waitSeconds > 0) {
      run = await hold(workloadId, cfg, run);
    }
    return answer(event, cfg, run, napBlocks ? nap.until : null);
  };
}
