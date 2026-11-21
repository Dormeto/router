// What both routers' checks decide of a standalone workload (vision standalone workloads design §3, §4): the retry of a failed wake,
// the idle nap and when to read again, a nap window in force, the health's warning of a missing resource. Each cloud reads and acts
// its own way (lambda/src/lib/controller-core.mjs, gcp/src/controller-core.mjs); the rules are here, once. Pure.
import { METRIC_LAG_MS, idleWindow, isIdle } from './activity.mjs';
import { joinOf } from './check-schedules.mjs';
import { failureKind, failureStep, standaloneNextAttemptAt } from './failures.mjs';
import { addWarning } from './health.mjs';
import { occurrenceAt } from './schedule.mjs';
import { STATES } from './state.mjs';

// A failed wake, while FAILED (an outside stop that leaves every backend stopped, ASLEEP, ends the retries): null for any other run;
// `{ wait: true }` before its backoff (the router's own, failures.mjs); `{ held }`, why it waits (a keepAsleep pause, a nap window in
// force); `{ retry: true }` when the check wakes it again (cause `retry`).
// `napWindow`: a value, or a function read only when the decision needs it (a schedule is read at a retry only).
export function failedWakeDecision(run, t, { keptAsleep = false, napWindow = false } = {}) {
  if (run?.state !== STATES.FAILED || failureStep(run) !== 'wake') return null;
  if ((standaloneNextAttemptAt(run) ?? Infinity) > t) return { wait: true };
  if (keptAsleep) return { held: 'a keepAsleep pause' };
  if (typeof napWindow === 'function' ? napWindow() : napWindow) return { held: 'a nap window' };
  return { retry: true };
}

// Whether the check's reconcile must leave a failed standalone workload FAILED rather than call it recovered in state `to` (the
// R30 review's rulings, both clouds): a failed wake whose backends are all stopped stays FAILED and is retried (nothing wakes it on
// demand: ASLEEP would lose its awake window for one transient failure); a failure for a permission stays visible until a nap or
// a wake succeeds. A person who wants it asleep naps or pauses it.
export function failureKept(run, to) {
  if (run?.state !== STATES.FAILED) return false;
  if (failureKind(run) === 'permission') return true;
  return to === STATES.ASLEEP && failureStep(run) === 'wake';
}

// Whether a nap window of the workload's schedule is in force at `t` (`ctx`: the check's schedules and joins). One it cannot read:
// none, said in `ScheduleSkipped`.
export function napWindowNow(workloadId, ctx, t, log) {
  const schedule = ctx?.schedules?.get(workloadId);
  if (!schedule) return false;
  try {
    return occurrenceAt(schedule, t, joinOf(schedule, ctx.joins))?.kind === 'nap';
  } catch (err) {
    log.warn('ScheduleSkipped', { workloadId, error: err.message });
    return false;
  }
}

// The earliest check whose window can find every signal under: the window then starts at or after each one's run of points under
// (the window's end when its last point is not). Null when none applies, a read failed, or a last point is missing (late, or not
// published yet): read again at the next check.
export function idleNotBeforeOf(signals, window) {
  const applying = signals.filter((s) => s.applies);
  if (!applying.length || applying.some((s) => s.reason)) return null;
  if (applying.some((s) => s.underSince === null && (s.value === null || s.value < s.below))) return null;
  const length = window.endMs - window.startMs;
  const starts = applying.map((s) => (s.underSince !== null && s.underSince <= window.startMs ? window.startMs : s.underSince ?? window.endMs));
  return Math.max(...starts) + length + METRIC_LAG_MS;
}

// An awake standalone workload's idle decision at `t`: awake for its whole idle window, not before its `idleNotBefore`, then its signals
// (`read(window)`, the cloud's reader). `{ fields }`: the check's result's fields, nothing to do; with `write`, the idleNotBefore to write
// on the run; `{ nap: true }`: idle, nap it.
export async function idleDecision({ cfg, run, t, read }) {
  const window = idleWindow(cfg, t);
  if (run.awakeSince > window.startMs) return { fields: {} };
  if ((run.idleNotBefore ?? 0) > t) return { fields: { idleNotBefore: run.idleNotBefore } };
  const signals = await read(window);
  if (isIdle(signals, window)) return { nap: true };
  const idleNotBefore = idleNotBeforeOf(signals, window);
  return idleNotBefore === null ? { fields: { idle: false } } : { fields: { idle: false, idleNotBefore }, write: idleNotBefore };
}

// Why a queued idle nap no longer naps it, else null: its levels readable (no decision on levels it cannot read), its signals read again
// over its window now.
export async function idleRecheck({ cfg, t, read }) {
  if (cfg.levelsUnreadable) return 'its settings levels cannot be read';
  const window = idleWindow(cfg, t);
  return isIdle(await read(window), window) ? null : 'busy since it was requested';
}

// The router's health: the standalone workloads whose resource the check could not find (deleted, or no longer the workload's).
// `how`: how a resource stops being the workload's on that cloud (AWS: deleted, or its dormeto:workload tag removed).
export function warnResourceMissing(health, missing, how = 'deleted, or its dormeto:workload tag removed') {
  if (missing) addWarning(health, 'resource-missing', `${missing} standalone workload${missing === 1 ? '' : 's'} without ${missing === 1 ? 'its' : 'their'} resource: ${how} (see the workloads)`);
}
