// Live status of a workload: state, route, backends, targets, nap estimate, statistics, rules, lists. Served by the
// admin page (waker) and by the controller `status` action (manager).
import { recommendations } from './advice.mjs';
import { after, failureOf, fallbacksOf } from './summary.mjs';
import { nextAttemptAt, standaloneNextAttemptAt } from './failures.mjs';
import { STATES } from './state.mjs';
import { conditionsOf, currentTarget, routeOf } from './route.mjs';
import { resolveRules } from './rules.mjs';
import { instanceStates } from './instances.mjs';
import { backendKey, backendStatuses, isResourceOf, resolveBackends, standaloneStatuses } from './backends.mjs';
import { lastRequestAt } from './metrics.mjs';
import { METRIC_LAG_MS, PERIOD_MS, createIdleSignals, idleWindow } from './activity.mjs';
import { STANDALONE_KEYS } from './settings-levels.mjs';

const CHECK_PERIOD_MS = 5 * 60_000;
// The setting each idle signal's threshold is.
const SIGNAL_SETTINGS = { cpu: 'idleCpuPercent', network: 'idleNetworkBytes', metric: 'idleMetric' };

// A standalone workload's nap estimate (vision standalone workloads design §4): the first check whose idle window starts once every
// applying signal is under and the workload awake (its window ends 10 minutes behind, at a 5-minute boundary); null when none
// applies, a read failed or a signal's last point is missing (no estimate can be made then).
export function standaloneNapEstimate({ signals, window, run, now }) {
  if (run.state !== STATES.AWAKE) return null;
  const applying = signals.filter((s) => s.applies);
  if (!applying.length || applying.some((s) => s.reason || (s.underSince === null && (s.value === null || s.value < s.below)))) return null;
  const length = window.endMs - window.startMs;
  const from = Math.max(run.awakeSince ?? now, ...applying.map((s) => (s.underSince !== null && s.underSince <= window.startMs ? window.startMs : s.underSince ?? window.endMs)));
  const eligibleAt = Math.ceil((from + length) / PERIOD_MS) * PERIOD_MS + METRIC_LAG_MS;
  return { eligibleAt, latestAt: eligibleAt + CHECK_PERIOD_MS, inSeconds: Math.max(0, Math.ceil((eligibleAt - now) / 1000)) };
}

export function napEstimate({ cfg, run, lastRequest, now }) {
  if (run.state !== STATES.AWAKE) return null;
  const eligibleAt = Math.max(run.awakeSince ?? 0, lastRequest ?? 0) + cfg.idleMinutes * 60_000;
  return { eligibleAt, latestAt: eligibleAt + CHECK_PERIOD_MS, inSeconds: Math.max(0, Math.ceil((eligibleAt - now) / 1000)) };
}

const iso = (ms) => (typeof ms === 'number' && ms > 0 ? new Date(ms).toISOString() : null);

export function createStatus({ ec2, elbv2, cloudwatch, autoscaling, ecs, tagging, appscaling, rds, kubernetesOf, now = Date.now, version = {}, log = { info() {}, warn() {}, error() {} } }) {
  const clients = { ec2, elbv2, autoscaling, ecs, tagging, appscaling, rds, kubernetesOf };
  const readIdleSignals = createIdleSignals({ cloudwatch, log });

  // A standalone workload's (design §4, §5): its kind and resource, its idle signals with the level of each threshold and the nap
  // estimate from them, its backends; no route, rule, target, holder, request or list (absent, not null).
  async function standaloneStatus(workloadId, cfg, run, { pauses, drift, loadStats, loadHibernation }) {
    const t = now();
    const resolved = await resolveBackends(clients, cfg);
    const instanceIds = resolved.backends.filter((b) => b.kind === 'instance').map((b) => b.id);
    const window = idleWindow(cfg, t);
    const [statuses, instances, signals, hibernation] = await Promise.all([
      standaloneStatuses(clients, resolved.backends),
      instanceIds.length ? instanceStates(ec2, instanceIds) : {},
      readIdleSignals(cfg, resolved.backends, window),
      loadHibernation ? loadHibernation(instanceIds) : null,
    ]);
    const nap = pauses.length ? null : standaloneNapEstimate({ signals, window, run, now: t });
    const stats = loadStats ? await loadStats().catch((err) => ({ error: err.message })) : null;
    // Its wakes only: nothing is ignored nor deferred without a waker.
    const wakesOnly = (period) => (period ? { wakes: period.wakes ?? {} } : period);
    const answer = {
      workloadId,
      name: cfg.name ?? workloadId,
      kind: 'standalone',
      resourceArn: cfg.resourceArn,
      router: { version: version.version ?? 'unknown', build: version.build ?? 'unknown' },
      source: cfg.source ?? 'terraform',
      tags: cfg.tags ?? {},
      state: run.state,
      stateAt: iso(run.stateAt),
      drift,
      updatedAt: iso(run.updatedAt),
      awakeSince: iso(run.awakeSince),
      wakeStartedAt: iso(run.wakeStartedAt),
      failedAt: iso(run.failedAt),
      failure: failureOf(run),
      consecutiveFailures: run.consecutiveFailures ?? 0,
      nextAttemptAt: iso(standaloneNextAttemptAt(run)),
      fallbacks: fallbacksOf(run),
      wakeCount: run.wakeCount ?? 0,
      pendingWake: run.pendingWake === true,
      pauses,
      idle: signals.map((s) => ({ ...s, underSince: iso(s.underSince), from: cfg.settingsFrom?.[SIGNAL_SETTINGS[s.signal]] ?? null })),
      nap: nap && { eligibleAt: iso(nap.eligibleAt), latestAt: iso(nap.latestAt), inSeconds: nap.inSeconds },
      discovery: resolved.mode,
      instances: instanceIds.map((id) => ({ id, state: instances[id] ?? 'unknown' })),
      ...(hibernation ? { hibernation } : {}),
      backends: resolved.backends.map((b) => {
        const status = statuses[backendKey(b)];
        if (b.kind === 'asg') return { kind: 'asg', id: b.name, status, min: b.min, max: b.max, desired: b.desired, warmPool: b.warmPool };
        if (b.kind === 'ecs') return { kind: 'ecs', id: b.id, status, desired: b.desired, scalable: b.scalable };
        // A database is a companion unless it is the workload's own resource.
        if (b.kind.startsWith('rds-')) return { kind: b.kind, id: b.id, status, ...(isResourceOf(cfg, b) ? {} : { companion: true }) };
        return { kind: 'instance', id: b.id, status };
      }),
      ignoredTargets: resolved.ignored,
      recommendations: recommendations(resolved.backends),
      settings: Object.fromEntries(STANDALONE_KEYS.map((key) => [key, cfg[key]])),
      ...(cfg.settingsFrom ? { settingsFrom: cfg.settingsFrom, type: cfg.type } : {}),
      stats: stats && !stats.error ? { ...stats, today: wakesOnly(stats.today), total: wakesOnly(stats.total) } : stats,
    };
    // Its resource deleted or untagged (the check's mark): said after its backends, absent otherwise.
    return run.resourceMissing ? after(answer, 'backends', { resourceMissing: true }) : answer;
  }
  // Extras that depend on the caller: router rules, wake rules, statistics and IP lists loaders, and the hibernation's
  // (given the EC2 instances outside an Auto Scaling group, never failing; the controller's status only).
  return async function status(workloadId, cfg, run, { pauses = [], drift = [], noWakeRules = [], wakeRules = [], loadStats = null, loadLists = null, loadHibernation = null } = {}) {
    if (cfg.kind === 'standalone') return standaloneStatus(workloadId, cfg, run, { pauses, drift, loadStats, loadHibernation });
    const t = now();
    const resolved = await resolveBackends(clients, cfg);
    const instanceIds = resolved.backends.filter((b) => b.kind === 'instance').map((b) => b.id);
    const [statuses, instances, health, rules, lastRequest, hibernation] = await Promise.all([
      resolved.backends.length ? backendStatuses(clients, resolved.backends) : {},
      instanceIds.length ? instanceStates(ec2, instanceIds) : {},
      elbv2.describeTargetHealth({ TargetGroupArn: cfg.appTargetGroupArn }),
      resolveRules(elbv2, [cfg]).then((found) => found.get(cfg.workloadId)),
      lastRequestAt(cloudwatch, cfg, t - cfg.idleMinutes * 60_000, t),
      loadHibernation ? loadHibernation(instanceIds) : null,
    ]);
    // Paused: never napped, no estimate.
    const nap = pauses.length ? null : napEstimate({ cfg, run, lastRequest, now: t });
    return {
      workloadId,
      // For people (design section 7); workloads named before 0.20.0 show their id.
      name: cfg.name ?? workloadId,
      router: { version: version.version ?? 'unknown', build: version.build ?? 'unknown' },
      targetGroupArn: cfg.appTargetGroupArn,
      // Where the application's requests go: Dormeto's own target group for a grouped Ingress (its rule is first).
      servingTargetGroupArn: rules.switchTargetGroup ?? cfg.appTargetGroupArn,
      source: cfg.source ?? 'terraform',
      // Dormeto's own labels (tags design, section 3), as the summary gives them.
      tags: cfg.tags ?? {},
      state: run.state,
      stateAt: iso(run.stateAt),
      // Latest drift repairs (R4c), newest first.
      drift,
      updatedAt: iso(run.updatedAt),
      awakeSince: iso(run.awakeSince),
      wakeStartedAt: iso(run.wakeStartedAt),
      failedAt: iso(run.failedAt),
      failure: failureOf(run),
      consecutiveFailures: run.consecutiveFailures ?? 0,
      nextAttemptAt: iso(nextAttemptAt(cfg, run)),
      fallbacks: fallbacksOf(run),
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
        // Orphan shadows (to remove) too, which never keep the workload awake.
        const issue = [...rules.issues, ...(rules.orphans ?? [])].find((i) => i.arn === rule.RuleArn)?.reason;
        // A customer rule covered by a Dormeto shadow before it: never reached while the shadow exists.
        const by = (rules.covered ?? []).find((c) => c.arn === rule.RuleArn)?.by;
        const shadow = by && rules.rules.find((r) => r.RuleArn === by);
        if (shadow) return { arn: rule.RuleArn, priority: rule.Priority ?? null, conditions: conditionsOf(rule), route: 'shadowed', shadowedBy: shadow.Priority };
        return { arn: rule.RuleArn, priority: rule.Priority ?? null, conditions: conditionsOf(rule), route: currentTarget(rule.Actions ?? [], cfg), ...(issue ? { issue } : {}) };
      }),
      issues: rules.issues.map((i) => i.reason),
      discovery: resolved.mode,
      instances: instanceIds.map((id) => ({ id, state: instances[id] ?? 'unknown' })),
      ...(hibernation ? { hibernation } : {}),
      backends: resolved.backends.map((b) => {
        const status = statuses[backendKey(b)];
        if (b.kind === 'asg') return { kind: 'asg', id: b.name, status, min: b.min, max: b.max, desired: b.desired, warmPool: b.warmPool };
        if (b.kind === 'ecs') return { kind: 'ecs', id: b.id, status, desired: b.desired, scalable: b.scalable };
        if (b.kind === 'k8s') {
          return { kind: 'k8s', id: b.id, status, cluster: b.cluster, namespace: b.namespace, owner: b.owner, replicas: b.replicas, keda: Boolean(b.keda), switch: cfg.kubernetes.switch };
        }
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
        failedRetrySeconds: cfg.failedRetrySeconds ?? 60,
      },
      // Where each setting comes from and the workload's type (settings at scale design §6), for a resolved configuration.
      ...(cfg.settingsFrom ? { settingsFrom: cfg.settingsFrom, type: cfg.type } : {}),
      // Requests that reached the waker while the workload was not awake: an unreadable table never breaks the status.
      stats: loadStats ? await loadStats().catch((err) => ({ error: err.message })) : null,
      ipLists: loadLists ? await loadLists().catch((err) => [{ error: err.message }]) : [],
      wakeMode: cfg.wakeMode ?? 'any',
      wakeRules,
      noWakeRules,
    };
  }
}
