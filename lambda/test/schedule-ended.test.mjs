// Windows that ended long ago leave the schedule (the user, 2026-11-02): a window whose `until` is more than `days` days before
// today, in the schedule's zone, 365 by default and set by the organization (workloads.endedWindowDays, 0 keeps them), and
// the dates without a window as old, the schedule's and a window's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENDED_DAYS_DEFAULT, isEndedDays, scheduleProblems, withoutEnded } from '../src/lib/schedule.mjs';
import { parseManagerSettings } from '../src/lib/hibernation.mjs';

const t = (text) => Date.parse(text);
const NOW = t('2027-06-01T12:00:00Z');
const awake = (more = {}) => ({ kind: 'awake', days: ['mon'], start: '08:00', end: '12:00', ...more });
const once = (date) => ({ kind: 'awake', start: '08:00', end: '12:00', repeat: { pattern: 'daily' }, from: date, until: date });

test('removes a window that ended more than 365 days ago, keeps the one that ended 365 days ago, and the others', () => {
  const s = { timeZone: 'UTC', windows: [once('2026-05-31'), once('2026-06-01'), awake({ until: '2026-01-01' }), awake()], by: 'ana', at: 5 };
  assert.equal(ENDED_DAYS_DEFAULT, 365);
  const out = withoutEnded(s, NOW);
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
  assert.equal(withoutEnded({ timeZone: 'UTC', windows: [awake(), once('2026-06-01')] }, NOW), null);
  assert.equal(withoutEnded({ timeZone: 'UTC', windows: [once('2020-01-01')] }, NOW, 0), null);
  assert.equal(withoutEnded({ maxNapDays: 7 }, NOW), null);
  assert.equal(withoutEnded(null, NOW), null);
});

test('the organization\'s days, and today in the schedule\'s zone', () => {
  assert.deepEqual(withoutEnded({ timeZone: 'UTC', windows: [once('2027-04-21'), awake()] }, NOW, 30).schedule.windows, [awake()]);
  assert.equal(withoutEnded({ timeZone: 'UTC', windows: [once('2027-05-02'), awake()] }, NOW, 30), null);
  // 05:00 UTC on 1 June is 31 May in Honolulu: a year before is 31 May 2026.
  const honolulu = (date) => ({ timeZone: 'Pacific/Honolulu', windows: [once(date), awake()] });
  assert.equal(withoutEnded(honolulu('2026-05-31'), t('2027-06-01T05:00:00Z')), null);
  assert.deepEqual(withoutEnded(honolulu('2026-05-30'), t('2027-06-01T05:00:00Z')).windows, 1);
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
