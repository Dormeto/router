// The contract of lib/check-schedules.mjs on a cloud's store (vision docs/specs/2026-11-12-cloud-duplication-design.md, §2 rule 4):
// run on the DynamoDB store's fake by check-schedules-shared.test.mjs and on the Firestore store over its fake by
// gcp/test/check-schedules-shared.test.mjs. `setup({ run, schedule, now })` answers the cloud's store holding the workload `demo` with
// that run (null: none) and that schedule (null: none), on the clock `now`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScheduleCheck } from '../src/lib/check-schedules.mjs';
import { pauseHolds } from '../src/lib/pauses.mjs';
import { STATES } from '../src/lib/state.mjs';

const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();
// UTC wall times in October 2026: '08:00' is Monday the 19th at 08:00.
const at = (time, day = 19) => Date.parse(`2026-10-${day}T${time}:00Z`);
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];
const OFFICE = { kind: 'awake', days: WEEKDAYS, start: '08:00', end: '18:00' };
const NIGHT = { kind: 'nap', days: WEEKDAYS, start: '20:00', end: '07:00' };
const EARLY = { kind: 'nap', days: ['mon'], start: '07:40', end: '08:00' };
const ENDED = { kind: 'awake', days: ['sat'], start: '10:00', end: '11:00', until: '2025-09-27' };
// A schedule as the stores keep it.
const stored = (fields) => ({ timeZone: 'UTC', ...fields, by: 'ops@example.com', at: at('09:00', 12) });
const occurrence = (window, time, day) => `${window}@${iso(at(time, day))}`;
const FREE = pauseHolds([]);
const PAUSED = pauseHolds([{ workloadId: 'demo', keepAsleep: false }]);
const KEPT_ASLEEP = pauseHolds([{ workloadId: 'demo', keepAsleep: true }]);
const ANY_STATE = Object.values(STATES);

export function checkSchedulesContract(cloud, setup) {
  // The schedules on the cloud's store at `time`, its log kept, and ports that keep their calls: a wake that moves the run to WAKING
  // from the state read (writing the occurrence with it when the cloud's wake records it, `wakeRecords`), a pending wake that answers
  // `pendingWake`. `wake` false: the wake did not start (its state changed since the read).
  async function harness({ run = null, schedule = null, time = at('08:00'), wake = true, pendingWake = true, wakeRecords = false } = {}) {
    const store = await setup({ run, schedule, now: () => time });
    const logs = [];
    const calls = [];
    const keep = (event, data) => { logs.push([event, data]); };
    const check = createScheduleCheck({
      store,
      wake: async (workloadId, read, kind, applies) => {
        calls.push(['wake', workloadId, read.state, kind, applies?.id ?? null]);
        if (!wake) return false;
        const set = { state: STATES.WAKING, wakeId: 'w1', ...(wakeRecords && applies ? { scheduleApplied: applies.id } : {}) };
        return Boolean(await store.transition(workloadId, { cond: { state: read.state }, set }));
      },
      pendingWake: async (workloadId, kind) => {
        calls.push(['pendingWake', workloadId, kind]);
        return pendingWake;
      },
      wakeRecords,
      log: { info: keep, warn: keep, error: keep },
    });
    // A nap asked at once (true), its item kept.
    const asked = { ask: async ({ workloadId, occurrence: applies, t }) => { calls.push(['nap', workloadId, applies.id, applies.end, t]); return true; } };
    // One check's pass over `demo`, with the schedule as the check read it (`listed`, by default the one stored).
    const apply = ({ holds = FREE, endedDays = null, nap = asked, listed = schedule } = {}) => check.applySchedules(
      [{ workloadId: 'demo' }], new Map(listed ? [['demo', listed]] : []), holds, time, { joins: {}, endedDays, nap },
    );
    // The run's reads, counted; `after(n)` runs after the n-th read (a change behind the pass's back).
    const reads = { count: 0, after: null };
    const getRun = store.getRun.bind(store);
    store.getRun = async (workloadId) => {
      const read = await getRun(workloadId);
      reads.count += 1;
      await reads.after?.(reads.count);
      return read;
    };
    return {
      store, check, calls, apply, reads, time,
      run: () => getRun('demo'),
      logged: (event) => logs.filter(([e]) => e === event).map(([, data]) => data),
    };
  }
  const named = (what) => `the schedules a check applies, on ${cloud}: ${what}`;
  const versionOf = async (h) => (await h.run())?.version ?? 0;

  test(named('an awake window wakes an asleep or a failed workload once per occurrence, recorded once its wake started, whatever the state by then'), async () => {
    for (const state of [STATES.ASLEEP, STATES.FAILED]) {
      const h = await harness({ run: { state }, schedule: stored({ windows: [OFFICE] }) });
      const { applied, readable } = await h.apply();
      assert.deepEqual([...applied], [['demo', 'wake']], state);
      assert.deepEqual([...readable.keys()], ['demo']);
      assert.deepEqual(h.calls, [['wake', 'demo', state, 'schedule', occurrence(0, '08:00')]]);
      const run = await h.run();
      assert.deepEqual([run.state, run.scheduleApplied], [STATES.WAKING, occurrence(0, '08:00')]);
      assert.deepEqual(h.logged('ScheduleApplied'), [{ workloadId: 'demo', occurrence: occurrence(0, '08:00'), kind: 'awake', action: 'wake' }]);
      // Asleep again within the same occurrence: applied already, nothing more.
      await h.store.transition('demo', { cond: { state: STATES.WAKING }, set: { state } });
      assert.deepEqual([...(await h.apply()).applied], []);
      assert.equal(h.calls.length, 1);
      assert.equal(h.logged('ScheduleApplied').length, 1);
    }
  });

  test(named('a cloud whose wake writes the occurrence with it: one write, said once; a wake that did not start records and says nothing'), async () => {
    const h = await harness({ run: { state: STATES.ASLEEP }, schedule: stored({ windows: [OFFICE] }), wakeRecords: true });
    const before = await versionOf(h);
    assert.deepEqual([...(await h.apply()).applied], [['demo', 'wake']]);
    assert.equal(await versionOf(h), before + 1, 'the wake\'s own write only');
    assert.equal((await h.run()).scheduleApplied, occurrence(0, '08:00'));
    assert.deepEqual(h.logged('ScheduleApplied'), [{ workloadId: 'demo', occurrence: occurrence(0, '08:00'), kind: 'awake', action: 'wake' }]);
    for (const wakeRecords of [false, true]) {
      const lost = await harness({ run: { state: STATES.ASLEEP }, schedule: stored({ windows: [OFFICE] }), wake: false, wakeRecords });
      const version = await versionOf(lost);
      assert.deepEqual([...(await lost.apply()).applied], []);
      assert.deepEqual([(await lost.run()).scheduleApplied, await versionOf(lost), lost.logged('ScheduleApplied')], [undefined, version, []]);
    }
  });

  test(named('at an awake window a napping workload gets its pending wake, its occurrence unrecorded: no write while it naps'), async () => {
    const h = await harness({ run: { state: STATES.NAPPING }, schedule: stored({ windows: [OFFICE] }) });
    const version = await versionOf(h);
    assert.deepEqual([...(await h.apply()).applied], [['demo', 'pending wake']]);
    assert.deepEqual(h.calls, [['pendingWake', 'demo', 'schedule']]);
    assert.deepEqual([(await h.run()).scheduleApplied, await versionOf(h), h.logged('ScheduleApplied')], [undefined, version, []]);
    // Its pending wake set already: nothing to say.
    const set = await harness({ run: { state: STATES.NAPPING }, schedule: stored({ windows: [OFFICE] }), pendingWake: false });
    assert.deepEqual([...(await set.apply()).applied], []);
  });

  test(named('a keepAsleep pause holds an awake window\'s wake and the maintenance wake, unrecorded; a plain pause holds neither'), async () => {
    const window = await harness({ run: { state: STATES.ASLEEP }, schedule: stored({ windows: [OFFICE] }) });
    const version = await versionOf(window);
    assert.deepEqual([...(await window.apply({ holds: KEPT_ASLEEP })).applied], [['demo', 'held by a keepAsleep pause']]);
    assert.deepEqual([window.calls, await versionOf(window), window.logged('ScheduleApplied')], [[], version, []]);
    const napping = await harness({ run: { state: STATES.NAPPING }, schedule: stored({ windows: [OFFICE] }) });
    assert.deepEqual([...(await napping.apply({ holds: KEPT_ASLEEP })).applied], [['demo', 'held by a keepAsleep pause']]);
    assert.deepEqual(napping.calls, []);
    const asleep = { state: STATES.ASLEEP, stateAt: at('08:00') - 8 * DAY };
    const kept = await harness({ run: asleep, schedule: stored({ maxNapDays: 7 }) });
    assert.deepEqual([...(await kept.apply({ holds: KEPT_ASLEEP })).applied], [['demo', 'held by a keepAsleep pause']]);
    assert.deepEqual(kept.calls, []);
    const plain = await harness({ run: asleep, schedule: stored({ maxNapDays: 7 }) });
    assert.deepEqual([...(await plain.apply({ holds: PAUSED })).applied], [['demo', 'maintenance']]);
    const woken = await harness({ run: { state: STATES.ASLEEP }, schedule: stored({ windows: [OFFICE] }) });
    assert.deepEqual([...(await woken.apply({ holds: PAUSED })).applied], [['demo', 'wake']]);
  });

  test(named('a nap window naps an awake workload once: asked at once with its end, the occurrence recorded on the run as read'), async () => {
    const h = await harness({ run: { state: STATES.AWAKE, awakeSince: 1 }, schedule: stored({ windows: [OFFICE, NIGHT] }), time: at('20:00') });
    assert.deepEqual([...(await h.apply()).applied], [['demo', 'nap']]);
    assert.deepEqual(h.calls, [['nap', 'demo', occurrence(1, '20:00'), at('07:00', 20), at('20:00')]]);
    assert.equal((await h.run()).scheduleApplied, occurrence(1, '20:00'));
    assert.deepEqual(h.logged('ScheduleApplied'), [{ workloadId: 'demo', occurrence: occurrence(1, '20:00'), kind: 'nap', action: 'nap' }]);
    // Still awake at the next pass (the nap not started yet): not asked again.
    assert.deepEqual([...(await h.apply()).applied], []);
    assert.equal(h.calls.length, 1);
  });

  test(named('a nap asked once its run changed since the read (it started at once, or ran inline): asked, its occurrence unrecorded and unsaid'), async () => {
    const h = await harness({ run: { state: STATES.AWAKE, awakeSince: 1 }, schedule: stored({ windows: [OFFICE, NIGHT] }), time: at('20:00') });
    const started = { ask: async ({ workloadId }) => Boolean(await h.store.transition(workloadId, { cond: { state: STATES.AWAKE }, set: { state: STATES.NAPPING } })) };
    assert.deepEqual([...(await h.apply({ nap: started })).applied], [['demo', 'nap']]);
    assert.deepEqual([(await h.run()).scheduleApplied, h.logged('ScheduleApplied')], [undefined, []]);
  });

  test(named('a nap the cloud asks after every workload\'s: its end sets the outcome, and records the occurrence whatever the state, said once'), async () => {
    const h = await harness({ run: { state: STATES.AWAKE, awakeSince: 1 }, schedule: stored({ windows: [OFFICE, NIGHT] }), time: at('20:00') });
    const collected = [];
    const later = {
      ask: (item) => {
        collected.push(item.workloadId);
        return false;
      },
      async end(applied, t) {
        h.calls.push(['end', [...applied], t]);
        // The run as the state then says, which no conditional write on the read could hold: any state.
        await h.check.record('demo', { id: occurrence(1, '20:00'), kind: 'nap' }, 'nap', ANY_STATE);
        applied.set('demo', 'nap');
      },
    };
    assert.deepEqual([...(await h.apply({ nap: later })).applied], [['demo', 'nap']]);
    assert.deepEqual([collected, h.calls], [['demo'], [['end', [], at('20:00')]]]);
    assert.equal((await h.run()).scheduleApplied, occurrence(1, '20:00'));
    assert.deepEqual(h.logged('ScheduleApplied'), [{ workloadId: 'demo', occurrence: occurrence(1, '20:00'), kind: 'nap', action: 'nap' }]);
    // A record conditional on a state the run is not in: not written, not said.
    await h.check.record('demo', { id: 'other', kind: 'nap' }, 'none', STATES.ASLEEP);
    assert.deepEqual([(await h.run()).scheduleApplied, h.logged('ScheduleApplied').length], [occurrence(1, '20:00'), 1]);
  });

  test(named('a pause holds a nap window\'s nap, unrecorded; napping or waking at a nap window, nothing until a pass finds it awake'), async () => {
    const paused = await harness({ run: { state: STATES.AWAKE, awakeSince: 1 }, schedule: stored({ windows: [OFFICE, NIGHT] }), time: at('20:00') });
    assert.deepEqual([...(await paused.apply({ holds: PAUSED })).applied], [['demo', 'held by a pause']]);
    assert.deepEqual([paused.calls, (await paused.run()).scheduleApplied], [[], undefined]);
    for (const state of [STATES.NAPPING, STATES.WAKING]) {
      const h = await harness({ run: { state }, schedule: stored({ windows: [OFFICE, NIGHT] }), time: at('20:00') });
      const version = await versionOf(h);
      assert.deepEqual([...(await h.apply()).applied], [], state);
      assert.deepEqual([h.calls, await versionOf(h), h.logged('ScheduleApplied')], [[], version, []], state);
    }
  });

  test(named('a workload already as its window wants it: the occurrence recorded with nothing to do; a nap window just before an awake start, recorded skipped'), async () => {
    const awake = await harness({ run: { state: STATES.AWAKE, awakeSince: 1 }, schedule: stored({ windows: [OFFICE] }) });
    assert.deepEqual([...(await awake.apply()).applied], []);
    assert.equal((await awake.run()).scheduleApplied, occurrence(0, '08:00'));
    assert.deepEqual(awake.logged('ScheduleApplied'), [{ workloadId: 'demo', occurrence: occurrence(0, '08:00'), kind: 'awake', action: 'none' }]);
    const asleep = await harness({ run: { state: STATES.ASLEEP }, schedule: stored({ windows: [OFFICE, NIGHT] }), time: at('20:00') });
    await asleep.apply();
    assert.deepEqual(asleep.logged('ScheduleApplied').map((d) => [d.occurrence, d.action]), [[occurrence(1, '20:00'), 'none']]);
    assert.deepEqual(asleep.calls, []);
    // The nap window starts 20 minutes before the awake one: skipped, not asked.
    const close = await harness({ run: { state: STATES.AWAKE, awakeSince: 1 }, schedule: stored({ windows: [EARLY, OFFICE] }), time: at('07:40') });
    assert.deepEqual([...(await close.apply()).applied], []);
    assert.deepEqual(close.calls, []);
    assert.equal((await close.run()).scheduleApplied, occurrence(0, '07:40'));
    assert.deepEqual(close.logged('ScheduleApplied').map((d) => d.action), ['skipped: an awake window starts within 30 minutes']);
  });

  test(named('an occurrence is recorded only on the run as read: a run that changed since (a manager\'s nap) is left for the next pass'), async () => {
    const h = await harness({ run: { state: STATES.AWAKE, awakeSince: 1 }, schedule: stored({ windows: [OFFICE] }) });
    h.reads.after = (n) => (n === 1 ? h.store.transition('demo', { cond: { state: STATES.AWAKE }, set: { state: STATES.NAPPING } }) : null);
    await h.apply();
    assert.deepEqual([(await h.run()).scheduleApplied, h.logged('ScheduleApplied')], [undefined, []]);
  });

  test(named('maxNapDays wakes a workload asleep that long, cause maintenance, once due; not before, nor a failed one, nor when the wake did not start'), async () => {
    const due = await harness({ run: { state: STATES.ASLEEP, stateAt: at('08:00') - 7 * DAY }, schedule: stored({ maxNapDays: 7 }) });
    assert.deepEqual([...(await due.apply()).applied], [['demo', 'maintenance']]);
    assert.deepEqual(due.calls, [['wake', 'demo', STATES.ASLEEP, 'maintenance', null]]);
    assert.deepEqual(due.logged('ScheduleApplied'), []);
    for (const [run, wake] of [
      [{ state: STATES.ASLEEP, stateAt: at('08:00') - 7 * DAY + 1 }, true],
      [{ state: STATES.FAILED, stateAt: at('08:00') - 8 * DAY }, true],
      [{ state: STATES.ASLEEP, stateAt: at('08:00') - 8 * DAY }, false],
    ]) {
      const h = await harness({ run, schedule: stored({ maxNapDays: 7 }), wake });
      assert.deepEqual([...(await h.apply()).applied], [], JSON.stringify(run));
      assert.equal(h.calls.length, wake ? 0 : 1);
    }
  });

  test(named('no occurrence and no maximum nap: the run is not read; no run: nothing'), async () => {
    const quiet = await harness({ run: { state: STATES.AWAKE, awakeSince: 1 }, schedule: stored({ windows: [NIGHT] }) });
    assert.deepEqual([...(await quiet.apply()).applied], []);
    assert.equal(quiet.reads.count, 0);
    const none = await harness({ run: null, schedule: stored({ windows: [OFFICE] }) });
    assert.deepEqual([...(await none.apply()).applied], []);
    assert.deepEqual([none.calls, none.logged('ScheduleApplied')], [[], []]);
  });

  test(named('a schedule the router cannot read is said and left out: its run not read, not among the readable'), async () => {
    const h = await harness({ run: { state: STATES.ASLEEP }, schedule: stored({ timeZone: 'Mars/Olympus', windows: [OFFICE] }) });
    const { applied, readable } = await h.apply();
    assert.deepEqual([[...applied], [...readable], h.reads.count, h.calls], [[], [], 0, []]);
    const [skipped] = h.logged('ScheduleSkipped');
    assert.equal(skipped.workloadId, 'demo');
    assert.match(skipped.error, /Mars\/Olympus/);
  });

  test(named('a run that cannot be read fails that workload\'s pass, said'), async () => {
    const h = await harness({ run: { state: STATES.ASLEEP }, schedule: stored({ windows: [OFFICE] }) });
    h.reads.after = () => { throw new Error('throttled'); };
    assert.deepEqual([...(await h.apply()).applied], []);
    assert.deepEqual(h.logged('ScheduleFailed'), [{ workloadId: 'demo', error: 'throttled' }]);
  });

  test(named('windows ended more than the given days ago leave the schedule, between occurrences only, over the schedule as read, said'), async () => {
    const schedule = stored({ windows: [OFFICE, ENDED], exceptions: ['2025-01-01', '2026-12-25'] });
    const h = await harness({ run: { state: STATES.ASLEEP }, schedule, time: at('07:30') });
    await h.apply({ endedDays: 365 });
    assert.deepEqual(await h.store.getSchedule('demo'), stored({ windows: [OFFICE], exceptions: ['2026-12-25'] }));
    assert.deepEqual(h.logged('EndedWindowsRemoved'), [{ workloadId: 'demo', windows: 1, dates: 1, days: 365 }]);
    // An occurrence active: its id holds its window's index, nothing leaves. No days: nothing leaves.
    const active = await harness({ run: { state: STATES.ASLEEP }, schedule });
    await active.apply({ endedDays: 365 });
    const unset = await harness({ run: { state: STATES.ASLEEP }, schedule, time: at('07:30') });
    await unset.apply({ endedDays: null });
    for (const kept of [active, unset]) assert.deepEqual([await kept.store.getSchedule('demo'), kept.logged('EndedWindowsRemoved')], [schedule, []]);
    // Saved since the check read it: kept, nothing said.
    const newer = stored({ windows: [OFFICE, ENDED, NIGHT] });
    const saved = await harness({ run: { state: STATES.ASLEEP }, schedule: newer, time: at('07:30') });
    await saved.apply({ endedDays: 365, listed: schedule });
    assert.deepEqual([await saved.store.getSchedule('demo'), saved.logged('EndedWindowsRemoved')], [newer, []]);
    // Left with nothing: removed.
    const empty = await harness({ run: { state: STATES.ASLEEP }, schedule: stored({ windows: [ENDED] }), time: at('07:30') });
    await empty.apply({ endedDays: 365 });
    assert.equal(await empty.store.getSchedule('demo'), null);
    // A write that fails keeps them, said.
    const failing = await harness({ run: { state: STATES.ASLEEP }, schedule, time: at('07:30') });
    failing.store.replaceSchedule = async () => { throw new Error('throttled'); };
    await failing.apply({ endedDays: 365 });
    assert.deepEqual(failing.logged('EndedWindowsKept'), [{ workloadId: 'demo', error: 'throttled' }]);
  });
}
