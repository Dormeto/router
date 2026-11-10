// The router's rows and events as the manager reads them: the shapes of AWS's `Workload state changed` detail (lambda/src/lib/events.mjs)
// and of its `list` row, built from what Firestore holds.

import { nextAttemptAt } from '../../lambda/src/lib/failures.mjs';
import { resolvedSettings } from '../../lambda/src/lib/settings-writes.mjs';
import { STATES } from '../../lambda/src/lib/state.mjs';
import { totals } from '../../lambda/src/lib/summary.mjs';
import { effectiveOf } from './levels.mjs';

const iso = (ms) => new Date(ms).toISOString();

// The failure the run stores holds `at` in ms; the event's holds it as an ISO string.
const failureOf = (failure) => (typeof failure?.at === 'number' ? { ...failure, at: iso(failure.at) } : failure);

// The `Workload state changed` detail of a transition. `event` is what the transition's caller says of it (the wake id and its duration,
// the failure, the VMs a nap suspended and the items it stopped, the fallbacks, who asked); the rest of it (the names it stopped, the
// autoscalers) stays in the run. `stateAt` is the instant of the change (ms).
export function eventOf({ workloadId, from, to, stateAt, cause, event = {}, router, tags = {} }) {
  const { wakeId, durationMs, failure, fallbacks, by, suspended, items } = event;
  return {
    workloadId,
    from,
    to,
    router: router.name,
    region: router.region,
    project: router.project,
    at: iso(stateAt),
    ...(cause ? { cause } : {}),
    ...(wakeId ? { wakeId } : {}),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(failure ? { failure: failureOf(failure) } : {}),
    ...(by ? { by } : {}),
    ...(fallbacks ? { fallbacks } : {}),
    ...(suspended?.length ? { hibernated: suspended } : {}),
    ...(items ? { stopped: items } : {}),
    tags,
  };
}

const isoOrNull = (ms) => (typeof ms === 'number' && ms > 0 ? iso(ms) : null);

// The run's last failure, stored as JSON with `at` in ms; an unreadable record is none.
function lastFailure(run) {
  try {
    const failure = run?.failure ? JSON.parse(run.failure) : null;
    return failure ? { ...failure, at: isoOrNull(failure.at) } : null;
  } catch {
    return null;
  }
}

// The VMs a wake left on a fallback machine type, `[{ instance, from, to }]` (the run's `instanceTypes` is a map here).
const fallbacksOf = (run) => Object.entries(run?.instanceTypes ?? {}).map(([instance, { from, to }]) => ({ instance, from, to }));

// The AWS kind names of the backends (G5's type names map the same way), in AWS's order; the Cloud SQL twin of `rds-instance`.
export const KIND_OF = { vm: 'instance', mig: 'asg', k8s: 'k8s', cloudsql: 'cloudsql-instance' };
const KINDS = Object.values(KIND_OF);

// The AWS `list` row (lambda/src/lib/summary.mjs's workloadSummary) of a workload, from its configuration and run. `stats7d`: the
// store's `getStats(id, 7)`, or null when it could not be read. `router` and `organization`: the router's level and the organization's, for the resolved settings; `pauses`
// and `scheduled`: the workload's active pauses and whether it has a schedule. Instead of `targetGroupArn`, its Google resources.
// Its `hibernated` is true only while it is asleep with a VM suspended, as AWS's.
export function rowOf({ cfg, run, stats7d = null, routerName, router = null, organization = null, pauses = [], scheduled = false }) {
  const failure = lastFailure(run);
  const fallbacks = fallbacksOf(run);
  const effective = effectiveOf(cfg, { run, router, organization });
  const { settings, settingsFrom, type } = resolvedSettings(effective);
  const nextAttempt = nextAttemptAt(effective, run);
  return {
    workloadId: cfg.workloadId,
    name: cfg.name ?? cfg.workloadId,
    backendService: cfg.backendService,
    wakerBackendService: cfg.wakerBackendService,
    urlMap: cfg.urlMap,
    lb: cfg.lb ?? { kind: 'global' },
    source: cfg.source ?? 'cli',
    tags: cfg.tags ?? {},
    state: run?.state ?? 'UNKNOWN',
    stateAt: isoOrNull(run?.stateAt),
    url: cfg.hosts?.length ? `https://${cfg.hosts[0]}/` : null,
    wakeMode: effective.wakeMode ?? 'any',
    wakeCount: run?.wakeCount ?? 0,
    awakeSince: isoOrNull(run?.awakeSince),
    wakeStartedAt: isoOrNull(run?.wakeStartedAt),
    failedAt: isoOrNull(run?.failedAt),
    failure,
    consecutiveFailures: run?.consecutiveFailures ?? 0,
    nextAttemptAt: nextAttempt === null ? null : iso(nextAttempt),
    ...(fallbacks.length ? { fallbacks } : {}),
    updatedAt: isoOrNull(run?.updatedAt),
    pendingWake: run?.pendingWake === true,
    backends: KINDS.filter((kind) => (cfg.backends ?? []).some((b) => KIND_OF[b.kind] === kind)),
    pauses,
    ...(scheduled ? { scheduled: true } : {}),
    ...(run?.state === STATES.ASLEEP && run.suspended?.length ? { hibernated: true } : {}),
    stats7d: totals(stats7d),
    ...(settingsFrom ? { type: type?.name ?? null, settingsFrom } : {}),
    settings: {
      waitSeconds: settings.waitSeconds,
      idleMinutes: settings.idleMinutes,
      drainSeconds: settings.drainSeconds,
      wakeTimeoutSeconds: settings.wakeTimeoutSeconds,
      maxHolders: settings.maxHolders,
    },
  };
}
