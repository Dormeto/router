// Workload summary for the manager `list` action: state table only (configuration, runtime state, rule host).
export const STATS_DAYS = 7;

const iso = (ms) => (typeof ms === 'number' && ms > 0 ? new Date(ms).toISOString() : null);

const sum = (counts = {}) => Object.values(counts).reduce((total, n) => total + n, 0);

// 7-day totals of the daily statistics (null when they could not be read).
export const totals = (stats) => (stats ? { ignored: sum(stats.total.ignored), deferred: sum(stats.total.deferred), wakes: sum(stats.total.wakes) } : null);

export function workloadSummary(cfg, run = {}, host = null, stats7d = null, pauses = []) {
  return {
    workloadId: cfg.workloadId,
    // Written by the Terraform workload module, or onboarded by the manager (only those are offboarded by it).
    source: cfg.source ?? 'terraform',
    state: run?.state ?? 'UNKNOWN',
    url: host ? `https://${host}/` : null,
    wakeMode: cfg.wakeMode ?? 'any',
    wakeCount: run?.wakeCount ?? 0,
    awakeSince: iso(run?.awakeSince),
    wakeStartedAt: iso(run?.wakeStartedAt),
    failedAt: iso(run?.failedAt),
    updatedAt: iso(run?.updatedAt),
    pendingWake: run?.pendingWake === true,
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
