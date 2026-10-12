// Live status of a workload: state, route, backends, targets, nap estimate, statistics, rules, lists. Served by the
// admin page (waker) and by the controller `status` action (manager).
import { recommendations } from './advice.mjs';
import { STATES } from './state.mjs';
import { conditionsOf, currentTarget, routeOf } from './route.mjs';
import { resolveRules } from './rules.mjs';
import { instanceStates } from './instances.mjs';
import { backendKey, backendStatuses, resolveBackends } from './backends.mjs';
import { lastRequestAt } from './metrics.mjs';

const CHECK_PERIOD_MS = 5 * 60_000;

export function napEstimate({ cfg, run, lastRequest, now }) {
  if (run.state !== STATES.AWAKE) return null;
  const eligibleAt = Math.max(run.awakeSince ?? 0, lastRequest ?? 0) + cfg.idleMinutes * 60_000;
  return { eligibleAt, latestAt: eligibleAt + CHECK_PERIOD_MS, inSeconds: Math.max(0, Math.ceil((eligibleAt - now) / 1000)) };
}

const iso = (ms) => (typeof ms === 'number' && ms > 0 ? new Date(ms).toISOString() : null);

export function createStatus({ ec2, elbv2, cloudwatch, autoscaling, ecs, tagging, appscaling, rds, now = Date.now, version = {} }) {
  const clients = { ec2, elbv2, autoscaling, ecs, tagging, appscaling, rds };
  // Extras that depend on the caller: router rules, wake rules, statistics and IP lists loaders.
  return async function status(workloadId, cfg, run, { pauses = [], noWakeRules = [], wakeRules = [], loadStats = null, loadLists = null } = {}) {
    const t = now();
    const resolved = await resolveBackends(clients, cfg);
    const instanceIds = resolved.backends.filter((b) => b.kind === 'instance').map((b) => b.id);
    const [statuses, instances, health, rules, lastRequest] = await Promise.all([
      resolved.backends.length ? backendStatuses(clients, resolved.backends) : {},
      instanceIds.length ? instanceStates(ec2, instanceIds) : {},
      elbv2.describeTargetHealth({ TargetGroupArn: cfg.appTargetGroupArn }),
      resolveRules(elbv2, [cfg]).then((found) => found.get(cfg.workloadId)),
      lastRequestAt(cloudwatch, cfg, t - cfg.idleMinutes * 60_000, t),
    ]);
    // Paused: never napped, no estimate.
    const nap = pauses.length ? null : napEstimate({ cfg, run, lastRequest, now: t });
    return {
      workloadId,
      router: { version: version.version ?? 'unknown', build: version.build ?? 'unknown' },
      targetGroupArn: cfg.appTargetGroupArn,
      state: run.state,
      updatedAt: iso(run.updatedAt),
      awakeSince: iso(run.awakeSince),
      wakeStartedAt: iso(run.wakeStartedAt),
      failedAt: iso(run.failedAt),
      wakeCount: run.wakeCount ?? 0,
      holders: run.holders ?? 0,
      pendingWake: run.pendingWake === true,
      pauses,
      lastRequestAt: iso(lastRequest),
      nap: nap && { eligibleAt: iso(nap.eligibleAt), latestAt: iso(nap.latestAt), inSeconds: nap.inSeconds },
      // The route over the instrumented rules; every rule forwarding to the target group, with the issue of those the router
      // cannot switch (they keep the workload awake).
      route: routeOf(rules.instrumented, cfg),
      rules: rules.rules.map((rule) => {
        const issue = rules.issues.find((i) => i.arn === rule.RuleArn)?.reason;
        return { arn: rule.RuleArn, priority: rule.Priority ?? null, conditions: conditionsOf(rule), route: currentTarget(rule.Actions ?? [], cfg), ...(issue ? { issue } : {}) };
      }),
      issues: rules.issues.map((i) => i.reason),
      discovery: resolved.mode,
      instances: instanceIds.map((id) => ({ id, state: instances[id] ?? 'unknown' })),
      backends: resolved.backends.map((b) => {
        const status = statuses[backendKey(b)];
        if (b.kind === 'asg') return { kind: 'asg', id: b.name, status, min: b.min, max: b.max, desired: b.desired, warmPool: b.warmPool };
        if (b.kind === 'ecs') return { kind: 'ecs', id: b.id, status, desired: b.desired, scalable: b.scalable };
        if (b.kind.startsWith('rds-')) return { kind: b.kind, id: b.id, status, companion: true };
        return { kind: 'instance', id: b.id, status };
      }),
      ignoredTargets: resolved.ignored,
      recommendations: recommendations(resolved.backends),
      targets: (health.TargetHealthDescriptions ?? []).map((d) => ({ id: d.Target?.Id, state: d.TargetHealth?.State })),
      settings: {
        waitSeconds: cfg.waitSeconds,
        idleMinutes: cfg.idleMinutes,
        drainSeconds: cfg.drainSeconds,
        wakeTimeoutSeconds: cfg.wakeTimeoutSeconds,
        maxHolders: cfg.maxHolders,
      },
      // Requests that reached the waker while the workload was not awake: an unreadable table never breaks the status.
      stats: loadStats ? await loadStats().catch((err) => ({ error: err.message })) : null,
      ipLists: loadLists ? await loadLists().catch((err) => [{ error: err.message }]) : [],
      wakeMode: cfg.wakeMode ?? 'any',
      wakeRules,
      noWakeRules,
    };
  }
}
