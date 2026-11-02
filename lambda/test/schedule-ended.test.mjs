// Windows that ended long ago leave the schedule (the user, 2026-11-02): "expired windows are the ones having no valid occurrence
// (start/end) since 1y and none in the future". Valid: its pattern, its range, its own dates and the schedule's. `days`: 365 by
// default, set by the organization (workloads.endedWindowDays, 0 keeps them). The dates without a window as old leave too, the
// schedule's and a window's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENDED_DAYS_DEFAULT, isEndedDays, scheduleProblems, withoutEnded } from '../src/lib/schedule.mjs';
import { parseManagerSettings } from '../src/lib/hibernation.mjs';

const t = (text) => Date.parse(text);
const NOW = t('2027-06-01T12:00:00Z');
const awake = (more = {}) => ({ kind: 'awake', days: ['mon'], start: '08:00', end: '12:00', ...more });
const once = (date) => ({ kind: 'awake', start: '08:00', end: '12:00', repeat: { pattern: 'daily' }, from: date, until: date });

test('removes a window whose last occurrence ended more than 365 days ago, keeps one that ended since, and the others', () => {
  // 10:00 on 1 June 2027: a year before is 10:00 on 1 June 2026, inside the occurrence of that day (08:00 to 12:00).
  const s = { timeZone: 'UTC', windows: [once('2026-05-31'), once('2026-06-01'), awake({ until: '2026-01-01' }), awake()], by: 'ana', at: 5 };
  assert.equal(ENDED_DAYS_DEFAULT, 365);
  const out = withoutEnded(s, t('2027-06-01T10:00:00Z'));
  assert.deepEqual(out, { schedule: { timeZone: 'UTC', windows: [once('2026-06-01'), awake()], by: 'ana', at: 5 }, windows: 2, dates: 0 });
  assert.deepEqual(scheduleProblems(out.schedule, { now: NOW }), []);
});

test('removes the dates without a window as old, the schedule\'s and a window\'s, a window\'s list gone when empty', () => {
  const s = { timeZone: 'UTC', windows: [awake({ exceptions: ['2026-05-04'] }), awake({ days: ['tue'], exceptions: ['2026-05-05', '2027-01-05'] })], exceptions: ['2025-12-25', '2027-12-25'] };
  assert.deepEqual(withoutEnded(s, NOW), {
    schedule: { timeZone: 'UTC', windows: [awake(), awake({ days: ['tue'], exceptions: ['2027-01-05'] })], exceptions: ['2027-12-25'] }, windows: 0, dates: 3,
  });
  assert.deepEqual(withoutEnded({ ...s, exceptions: ['2026-01-01'] }, NOW).schedule.exceptions, undefined);
});

test('nothing to remove is null, and so is 0 days: they are kept', () => {
  assert.equal(withoutEnded({ timeZone: 'UTC', windows: [awake(), once('2026-06-02')] }, NOW), null);
  assert.equal(withoutEnded({ timeZone: 'UTC', windows: [once('2020-01-01')] }, NOW, 0), null);
  assert.equal(withoutEnded({ maxNapDays: 7 }, NOW), null);
  assert.equal(withoutEnded(null, NOW), null);
});

test('the organization\'s days, and the occurrence\'s instants in the schedule\'s zone', () => {
  assert.deepEqual(withoutEnded({ timeZone: 'UTC', windows: [once('2027-04-21'), awake()] }, NOW, 30).schedule.windows, [awake()]);
  assert.equal(withoutEnded({ timeZone: 'UTC', windows: [once('2027-05-03'), awake()] }, NOW, 30), null);
  // 20:00 to 23:00 on 31 May 2026 ends at 23:00 UTC, before a year ago (05:00 on 1 June 2026); in Honolulu, at 09:00 UTC, after.
  const night = (timeZone) => ({ timeZone, windows: [{ ...once('2026-05-31'), start: '20:00', end: '23:00' }, awake()] });
  assert.equal(withoutEnded(night('UTC'), t('2027-06-01T05:00:00Z')).windows, 1);
  assert.equal(withoutEnded(night('Pacific/Honolulu'), t('2027-06-01T05:00:00Z')), null);
});

test('a range that ends lately but whose last valid occurrence is older leaves: the pattern and the dates without a window decide', () => {
  // Yearly on 25 Dec until 20 Dec 2026: its last occurrence is 25 Dec 2025, more than a year before.
  const yearly = { kind: 'nap', start: '00:00', end: '00:00', repeat: { pattern: 'monthly', interval: 12, day: 25 }, from: '2025-12-01', until: '2026-12-20', wake: 'never' };
  assert.deepEqual(withoutEnded({ timeZone: 'UTC', windows: [yearly, awake()] }, NOW).schedule.windows, [awake()]);
  assert.equal(withoutEnded({ timeZone: 'UTC', windows: [{ ...yearly, until: '2026-12-31' }, awake()] }, NOW), null);
  // Mondays until 7 Dec 2026, the last ones its own dates or the schedule's: the last valid one is 4 May 2026.
  const mondays = awake({ until: '2026-12-07', exceptions: ['2026-06-08', '2026-06-15'] });
  const skipped = { timeZone: 'UTC', windows: [mondays, awake({ days: ['tue'] })], exceptions: [] };
  const every = (from, to) => { const out = []; for (let d = t(`${from}T00:00:00Z`); d <= t(`${to}T00:00:00Z`); d += 7 * 86_400_000) out.push(new Date(d).toISOString().slice(0, 10)); return out; };
  skipped.windows[0] = { ...mondays, exceptions: every('2026-06-01', '2026-12-07') };
  assert.deepEqual(withoutEnded(skipped, NOW).windows, 1);
  skipped.windows[0] = { ...mondays, exceptions: every('2026-06-08', '2026-12-07') };
  assert.equal(withoutEnded(skipped, t('2027-06-01T10:00:00Z')), null, 'the Monday 1 June 2026 still ends after a year ago');
});

test('a window without an end date never leaves, nor does one starting later, nor one with an occurrence to come', () => {
  const s = { timeZone: 'UTC', windows: [awake({ from: '2020-01-06' }), once('2027-07-01'), awake({ days: ['tue'], until: '2030-01-01' })] };
  assert.equal(withoutEnded(s, NOW), null);
  // A window of one date that the schedule skips has no valid occurrence, now or to come.
  assert.deepEqual(withoutEnded({ ...s, exceptions: ['2027-07-01'] }, NOW).windows, 1);
});

test('nothing left: no window and no maximum nap is no schedule; a maximum nap keeps it', () => {
  assert.deepEqual(withoutEnded({ timeZone: 'UTC', windows: [once('2020-01-01')], joinMinutes: 30 }, NOW), { schedule: null, windows: 1, dates: 0 });
  assert.deepEqual(withoutEnded({ timeZone: 'UTC', windows: [once('2020-01-01')], maxNapDays: 7 }, NOW), { schedule: { timeZone: 'UTC', windows: [], maxNapDays: 7 }, windows: 1, dates: 0 });
});

test('the days: 0, or 30 to 3650', () => {
  for (const days of [0, 30, 365, 3650]) assert.equal(isEndedDays(days), true, String(days));
  for (const days of [1, 29, 3651, -1, 1.5, '365', null, undefined]) assert.equal(isEndedDays(days), false, String(days));
});

test('settings.json: workloads.endedWindowDays, unset when it is not one', () => {
  assert.equal(parseManagerSettings('{"workloads":{"endedWindowDays":90}}').endedWindowDays, 90);
  assert.equal(parseManagerSettings('{"workloads":{"endedWindowDays":0}}').endedWindowDays, 0);
  for (const bad of ['10', '"365"', 'null', '4000']) assert.equal(parseManagerSettings(`{"workloads":{"endedWindowDays":${bad}}}`).endedWindowDays, null, bad);
  assert.equal(parseManagerSettings('{}').endedWindowDays, null);
});
