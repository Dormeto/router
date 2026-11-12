// The schedules the check applies, both routers' (R12 design, section 4; vision docs/specs/2026-11-12-cloud-duplication-design.md,
// §5): before the check's per-workload loop, every scheduled workload whatever the loop's budget, so a crowded router still meets
// the times. Each window occurrence is applied once (the run records the last one applied, `scheduleApplied`), so a late check, a
// deploy inside a window or two checks in it apply it once; then the maintenance wake of a workload asleep longer than maxNapDays.
// A pause holds the window's nap and a keepAsleep pause the wakes: held, the occurrence stays unapplied and applies once the pause
// is gone. A nap window's occurrence is recorded as soon as its nap is asked: a pause written after that refuses the nap, and only an
// idle nap comes once the pause is gone. Windows that ended long ago leave their schedule.
//
// The ports, passed where each controller is created:
// - `store`: the cloud's store, its `getRun(workloadId)`, `transition(workloadId, { cond, set })` (conditional on the run's state, one
//   or a list, as both stores' share in state.mjs) and `replaceSchedule(workloadId, from, next)` (over the schedule as read);
// - `wake(workloadId, run, kind, occurrence?)`: the cloud's wake of an asleep or failed workload from the run read (`kind`:
//   `schedule` for an awake window's, with its occurrence, `maintenance`), truthy when it started;
// - `wakeRecords`: true when the cloud's wake writes the awake window's occurrence with its WAKING (AWS: one conditional write);
//   otherwise the occurrence is recorded once the wake has started, whatever the state by then (Google Cloud: once its task is
//   accepted; refused, the run is FAILED and the next check wakes it);
// - `pendingWake(workloadId, kind)`: a napping workload's pending wake, true when this call set it;
// - `concurrency`: the workloads applied at once; `log`.
// And for each check, `nap`, the cloud's nap of a nap window: `ask({ workloadId, occurrence, t })` for a workload awake at a nap window
// not held, true once its nap is asked (its occurrence then recorded on the run as read), false when the cloud asks it later, in
// `end(applied, t)` after every workload's (Google Cloud's caps), which records the occurrences of the naps it asks and sets their
// outcomes.
import { STATES } from './state.mjs';
import { awakeStartWithin, CLOSE_START_MS, maintenanceDue, occurrenceAt, resolveJoin, withoutEnded } from './schedule.mjs';

const ANY_STATE = Object.values(STATES);

// How far a schedule's windows join: its own joinMinutes, else the levels' above it (`joins`: `{ router, manager }`, their values or
// null), else the default (design, section 11).
export const joinOf = (schedule, joins) => ({ joinMinutes: resolveJoin({ workload: schedule?.joinMinutes, ...joins }).joinMinutes });

// Why a schedule keeps a workload from its idle nap now, else null: the nap the schedules just decided (asked, put off or refused: not
// asked twice, nor ahead of a cloud's caps), an awake window active or starting within 30 minutes. `ctx`: the check's `schedules` (those
// the router can read), `applied` (the outcomes) and `joins`. A schedule the runtime refuses throws: each cloud says it its own way.
export function scheduleKeeps(workloadId, ctx, t) {
  const schedule = ctx?.schedules?.get(workloadId);
  if (!schedule) return null;
  if (ctx.applied?.get(workloadId)?.startsWith('nap')) return {};
  if (occurrenceAt(schedule, t, joinOf(schedule, ctx.joins))?.kind === 'awake') return { kept: 'awake window' };
  if (awakeStartWithin(schedule, t, CLOSE_START_MS)) return { kept: 'awake window within 30 minutes' };
  return null;
}

export function createScheduleCheck({ store, wake, pendingWake, wakeRecords = false, concurrency = 8, log }) {
  const said = (workloadId, occurrence, action) => log.info('ScheduleApplied', { workloadId, occurrence: occurrence.id, kind: occurrence.kind, action });
  // The occurrence written on the run while it is in `state` (one or a list), and said once written: a run that changed since is
  // left for the next check.
  async function record(workloadId, occurrence, action, state) {
    if (await store.transition(workloadId, { cond: { state }, set: { scheduleApplied: occurrence.id } })) said(workloadId, occurrence, action);
  }

  // `concurrency` at a time, one run read each, nothing called but the wakes and naps it asks for. `holds`: the pauses' (pauses.mjs's
  // pauseHolds), `{ paused(workloadId), keptAsleep(workloadId) }`. `joins`: the levels' joinMinutes; `endedDays`: the days after which an
  // ended window leaves (null: none leaves). Answers each workload's outcome (what it did, or what held it) and the schedules the router
  // can read: one it cannot (a time zone Intl refuses) is logged and the workload behaves as if it had none.
  async function applySchedules(configs, schedules, holds, t, { joins, endedDays = null, nap }) {
    const due = [];
    const readable = new Map();
    for (const { workloadId } of configs) {
      const schedule = schedules.get(workloadId);
      if (!schedule) continue;
      try {
        const occurrence = occurrenceAt(schedule, t, joinOf(schedule, joins));
        // A nap window's occurrence is skipped when an awake window starts within 30 minutes of its start, or of now (an
        // occurrence first applied late).
        const closeStart = occurrence?.kind === 'nap'
          && (awakeStartWithin(schedule, occurrence.start, CLOSE_START_MS) || awakeStartWithin(schedule, t, CLOSE_START_MS));
        readable.set(workloadId, schedule);
        due.push({ workloadId, schedule, occurrence, closeStart });
      } catch (err) {
        log.warn('ScheduleSkipped', { workloadId, error: err.message });
      }
    }
    const applied = new Map();
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, due.length) }, async () => {
      while (i < due.length) {
        const item = due[i++];
        try {
          const outcome = await applySchedule(item, holds, t, nap);
          if (outcome) applied.set(item.workloadId, outcome);
        } catch (err) {
          log.error('ScheduleFailed', { workloadId: item.workloadId, error: err.message });
        }
      }
    }));
    if (nap.end) await nap.end(applied, t);
    if (endedDays) await removeEnded(due, t, endedDays);
    return { applied, readable };
  }

  // Windows that ended more than `days` days ago leave their schedule (the user, 2026-11-02), and so do the dates without a window as
  // old; a schedule left with nothing is removed. Only between occurrences: an occurrence's id holds its window's index, which a
  // removal shifts. Written only over the schedule as read, so a save since is kept.
  async function removeEnded(due, t, days) {
    for (const { workloadId, schedule, occurrence } of due) {
      if (occurrence) continue;
      const ended = withoutEnded(schedule, t, days);
      if (!ended) continue;
      try {
        if (await store.replaceSchedule(workloadId, schedule, ended.schedule)) log.info('EndedWindowsRemoved', { workloadId, windows: ended.windows, dates: ended.dates, days });
      } catch (err) {
        log.warn('EndedWindowsKept', { workloadId, error: err.message });
      }
    }
  }

  // The occurrence active now, then the maintenance wake. Every write is conditional on the run read: one that changed since (a
  // request's wake) is left for the next check. Answers what it did or what held it, else null (a nap the cloud asks later says its
  // own).
  async function applySchedule({ workloadId, schedule, occurrence, closeStart }, holds, t, nap) {
    if (!occurrence && !schedule.maxNapDays) return null;
    const run = await store.getRun(workloadId);
    if (!run) return null;
    const pending = occurrence && run.scheduleApplied !== occurrence.id ? occurrence : null;
    const asleep = run.state === STATES.ASLEEP || run.state === STATES.FAILED;
    if (pending?.kind === 'awake' && (asleep || run.state === STATES.NAPPING)) {
      if (holds.keptAsleep(workloadId)) return 'held by a keepAsleep pause';
      // A napping workload gets its pending wake; the occurrence is recorded once the nap settled (a write now would delay the
      // detection of a stuck nap, which reads updatedAt).
      if (run.state === STATES.NAPPING) return (await pendingWake(workloadId, 'schedule')) ? 'pending wake' : null;
      // Woken as the manager's Wake does.
      if (!(await wake(workloadId, run, 'schedule', pending))) return null;
      if (wakeRecords) said(workloadId, pending, 'wake');
      else await record(workloadId, pending, 'wake', ANY_STATE);
      return 'wake';
    }
    if (pending?.kind === 'nap' && run.state === STATES.AWAKE && !closeStart) {
      if (holds.paused(workloadId)) return 'held by a pause';
      if (!(await nap.ask({ workloadId, occurrence: pending, t }))) return null;
      await record(workloadId, pending, 'nap', run.state);
      return 'nap';
    }
    // Napping or waking at a nap window: left for the next check, which naps it once awake.
    if (pending?.kind === 'nap' && (run.state === STATES.NAPPING || run.state === STATES.WAKING)) return null;
    // Nothing to do (the workload is already as the window wants it, or the nap window comes just before an awake one).
    if (pending) await record(workloadId, pending, closeStart ? 'skipped: an awake window starts within 30 minutes' : 'none', run.state);
    const due = run.state === STATES.ASLEEP ? maintenanceDue(schedule, run.stateAt) : null;
    if (due === null || due > t) return null;
    if (holds.keptAsleep(workloadId)) return 'held by a keepAsleep pause';
    return (await wake(workloadId, run, 'maintenance')) ? 'maintenance' : null;
  }

  return { applySchedules, record };
}
