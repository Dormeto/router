// A workload's row for the manager (its `list` action, a check's report), as both routers answer it: AWS's here
// (workloadSummary), Google Cloud's from Firestore (gcp/src/rows.mjs), each giving its own identity. And the daily statistics.
import { nextAttemptAt } from './failures.mjs';
import { standaloneRetryAt } from './standalone-check.mjs';
import { STATES } from './state.mjs';
import { STANDALONE_KEYS } from './settings-levels.mjs';

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

// The run's `instanceTypes`, `{ <instance>: { from, to } }`: JSON on DynamoDB, a map on Firestore.
const instanceTypesOf = (run) => (typeof run?.instanceTypes === 'string' ? JSON.parse(run.instanceTypes || '{}') : run?.instanceTypes ?? {});

// The fallback instance types its instances run on (R7a), until the next nap gives them their own back.
export function fallbacksOf(run) {
  try {
    return Object.entries(instanceTypesOf(run)).map(([instance, { from, to }]) => ({ instance, from, to }));
  } catch {
    return [];
  }
}

const sum = (counts = {}) => Object.values(counts).reduce((total, n) => total + n, 0);

// 7-day totals of the daily statistics (null when they could not be read).
export const totals = (stats) => (stats ? { ignored: sum(stats.total.ignored), deferred: sum(stats.total.deferred), wakes: sum(stats.total.wakes) } : null);

// A daily counter (`wake:<trigger>`, `ignored:<reason>`, `deferred:<reason>`): a failed update never changes the answer.
export const createCount = ({ store, log }) => async (workloadId, counter) => {
  try {
    await store.count(workloadId, counter);
  } catch (err) {
    log.warn('StatsWriteFailed', { workloadId, counter, error: err.message });
  }
};

// The row of a workload from its resolved configuration and its run. What each cloud gives: `identity`, the workload's resources
// (the manager finds it by them: exclusions, discovery), right after its name; `defaultSource`, the source of a configuration that
// names none; `host`, its first; `backends`, the kinds of its backends; `hibernated`, whether its nap left something hibernated.
export function workloadRow(cfg, run, {
  identity, defaultSource, host = null, backends = [], hibernated = false, stats7d = null, pauses = [], scheduled = false,
}) {
  const fallbacks = fallbacksOf(run);
  return {
    workloadId: cfg.workloadId,
    name: cfg.name ?? cfg.workloadId,
    ...identity,
    source: cfg.source ?? defaultSource,
    // Dormeto's own labels (tags design, section 3): the manager groups and grants access by them.
    tags: cfg.tags ?? {},
    state: run?.state ?? 'UNKNOWN',
    // When the state began (router 0.26.0): the instant of its state change event, so a check names the same change.
    stateAt: iso(run?.stateAt),
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
    ...(fallbacks.length ? { fallbacks } : {}),
    updatedAt: iso(run?.updatedAt),
    pendingWake: run?.pendingWake === true,
    backends,
    pauses,
    // Only when the workload has a schedule (R12).
    ...(scheduled ? { scheduled: true } : {}),
    // Only while asleep with what its nap hibernated (hibernation design §4).
    ...(run?.state === STATES.ASLEEP && hibernated ? { hibernated: true } : {}),
    stats7d,
    // Its type and where each setting comes from (settings at scale design §6): the manager counts what a level reaches.
    ...(cfg.settingsFrom ? { type: cfg.type?.name ?? null, settingsFrom: cfg.settingsFrom } : {}),
    settings: {
      waitSeconds: cfg.waitSeconds,
      idleMinutes: cfg.idleMinutes,
      drainSeconds: cfg.drainSeconds,
      wakeTimeoutSeconds: cfg.wakeTimeoutSeconds,
      maxHolders: cfg.maxHolders,
    },
  };
}

// AWS's row: the state table only (configuration, runtime state, rule host).
export function workloadSummary(cfg, run = {}, host = null, stats7d = null, pauses = [], scheduled = false) {
  if (cfg.kind === 'standalone') return standaloneSummary(cfg, run, stats7d, pauses, scheduled);
  return workloadRow(cfg, run, {
    // The workload's identity in AWS: the manager finds it from its target group.
    identity: { targetGroupArn: cfg.appTargetGroupArn },
    // Written by the Terraform workload module, or onboarded by the manager (only those are offboarded by it).
    defaultSource: 'terraform',
    host,
    // The kinds of its backends (instance, asg, ecs, k8s, then its databases), as the last idle check found them.
    backends: run?.backendKinds ? run.backendKinds.split(',') : [],
    // Instances its nap hibernated.
    hibernated: Boolean(run?.hibernated),
    stats7d,
    pauses,
    scheduled,
  });
}

// A standalone workload's row (vision standalone workloads design §5): its kind and resource as its identity; no URL, wake mode nor
// waker counter (absent, not null); its retry the check's; its settings its kind's.
function standaloneSummary(cfg, run, stats7d, pauses, scheduled) {
  const row = workloadRow(cfg, run, {
    identity: { kind: 'standalone', resourceArn: cfg.resourceArn },
    defaultSource: 'terraform',
    backends: run?.backendKinds ? run.backendKinds.split(',') : [],
    hibernated: Boolean(run?.hibernated),
    stats7d: stats7d && { wakes: stats7d.wakes },
    pauses,
    scheduled,
  });
  return standaloneRowOf(row, cfg, run);
}

// What makes the shared row (workloadRow's, its stats7d already its wakes) a standalone workload's, both clouds': no URL nor wake mode, the
// check's retry, its kind's settings, `resourceMissing` after its backends while its resource is gone (absent otherwise).
export function standaloneRowOf(row, cfg, run) {
  delete row.url;
  delete row.wakeMode;
  // The check's retry, only while one is coming then (standalone-check.mjs).
  row.nextAttemptAt = iso(standaloneRetryAt(run, row.pauses));
  row.settings = Object.fromEntries(STANDALONE_KEYS.map((key) => [key, cfg[key]]));
  return run?.resourceMissing ? after(row, 'backends', { resourceMissing: true }) : row;
}

// The object with `extra` right after its key `key`.
export const after = (object, key, extra) => Object.fromEntries(Object.entries(object).flatMap((entry) => (entry[0] === key ? [entry, ...Object.entries(extra)] : [entry])));
