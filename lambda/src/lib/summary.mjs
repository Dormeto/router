// Workload summary for the manager `list` action: state table only (configuration, runtime state, rule host).
import { nextAttemptAt } from './failures.mjs';

export const STATS_DAYS = 7;

const iso = (ms) => (typeof ms === 'number' && ms > 0 ? new Date(ms).toISOString() : null);

// The last failure (R7a), its time as ISO; an unreadable record is none.
export function failureOf(run) {
  try {
    const failure = run?.failure ? JSON.parse(run.failure) : null;
    return failure ? { ...failure, at: iso(failure.at) } : null;
  } catch {
    return null;
  }
}

// The fallback instance types its instances run on (R7a), until the next nap gives them their own back.
export function fallbacksOf(run) {
  try {
    return Object.entries(run?.instanceTypes ? JSON.parse(run.instanceTypes) : {}).map(([instance, { from, to }]) => ({ instance, from, to }));
  } catch {
    return [];
  }
}

const sum = (counts = {}) => Object.values(counts).reduce((total, n) => total + n, 0);

// 7-day totals of the daily statistics (null when they could not be read).
export const totals = (stats) => (stats ? { ignored: sum(stats.total.ignored), deferred: sum(stats.total.deferred), wakes: sum(stats.total.wakes) } : null);

export function workloadSummary(cfg, run = {}, host = null, stats7d = null, pauses = []) {
  return {
    workloadId: cfg.workloadId,
    name: cfg.name ?? cfg.workloadId,
    // The workload's identity in AWS: the manager finds it from its target group (exclusions, discovery).
    targetGroupArn: cfg.appTargetGroupArn,
    // Written by the Terraform workload module, or onboarded by the manager (only those are offboarded by it).
    source: cfg.source ?? 'terraform',
    state: run?.state ?? 'UNKNOWN',
    url: host ? `https://${host}/` : null,
    wakeMode: cfg.wakeMode ?? 'any',
    wakeCount: run?.wakeCount ?? 0,
    awakeSince: iso(run?.awakeSince),
    wakeStartedAt: iso(run?.wakeStartedAt),
    failedAt: iso(run?.failedAt),
    failure: failureOf(run),
    consecutiveFailures: run?.consecutiveFailures ?? 0,
    // When a request may retry a failed wake (R7a: backed off).
    nextAttemptAt: iso(nextAttemptAt(cfg, run)),
    // Only when some (check events stay small).
    ...(fallbacksOf(run).length ? { fallbacks: fallbacksOf(run) } : {}),
    updatedAt: iso(run?.updatedAt),
    pendingWake: run?.pendingWake === true,
    // The kinds of its backends (instance, asg, ecs, then its databases), as the last idle check found them.
    backends: run?.backendKinds ? run.backendKinds.split(',') : [],
    pauses,
    stats7d,
    settings: {
      waitSeconds: cfg.waitSeconds,
      idleMinutes: cfg.idleMinutes,
      drainSeconds: cfg.drainSeconds,
      wakeTimeoutSeconds: cfg.wakeTimeoutSeconds,
      maxHolders: cfg.maxHolders,
    },
  };
}
