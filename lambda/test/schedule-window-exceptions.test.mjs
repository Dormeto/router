// A window's own dates without it (`exceptions` on a window): the dashboard moves one occurrence of a series by skipping its
// date on the series and adding a window of that one date. The schedule's `exceptions` skip every window; a window's, itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextEvents, normalizeSchedule, occurrenceAt, scheduleProblems, EXCEPTIONS_MAX, WINDOWS_MAX } from '../src/lib/schedule.mjs';

const t = (text) => Date.parse(text);
const iso = (ms) => new Date(ms).toISOString();
const NOW = t('2027-01-01T12:00:00Z');
const utc = (windows, more = {}) => ({ timeZone: 'UTC', windows, ...more });
const problems = (s) => scheduleProblems(s, { now: NOW });
const daily = (kind, start, end, more = {}) => ({ kind, start, end, repeat: { pattern: 'daily' }, ...(kind === 'nap' ? { wake: 'never' } : {}), ...more });
const starts = (s, kind, count = 4) => nextEvents(s, t('2027-01-04T00:00:00Z'), { count: count * 4 })
  .filter((e) => e.kind === `${kind}-start`).slice(0, count).map((e) => e.at.slice(0, 16).replace('T', ' '));

test('a window\'s own dates skip its starts, and only its own', () => {
  const s = utc([daily('awake', '08:00', '09:00', { exceptions: ['2027-01-05'] }), daily('nap', '20:00', '21:00')]);
  assert.deepEqual(problems(s), []);
  assert.deepEqual(starts(s, 'awake'), ['2027-01-04 08:00', '2027-01-06 08:00', '2027-01-07 08:00', '2027-01-08 08:00']);
  assert.deepEqual(starts(s, 'nap'), ['2027-01-04 20:00', '2027-01-05 20:00', '2027-01-06 20:00', '2027-01-07 20:00']);
  assert.equal(occurrenceAt(s, t('2027-01-05T08:30:00Z')), null);
  assert.equal(occurrenceAt(s, t('2027-01-06T08:30:00Z'))?.window, 0);
});

test('a date is the local date of the start: a night that starts on it is skipped, the one that ends on it is not', () => {
  const s = { timeZone: 'Europe/Paris', windows: [{ kind: 'nap', days: ['mon', 'tue', 'wed'], start: '20:00', end: '07:00', wake: 'never', exceptions: ['2027-01-05'] }] };
  assert.equal(occurrenceAt(s, t('2027-01-05T05:00:00Z'))?.window, 0);
  assert.equal(occurrenceAt(s, t('2027-01-05T20:00:00Z')), null);
  assert.equal(occurrenceAt(s, t('2027-01-06T20:00:00Z'))?.window, 0);
});

test('a skipped start does not join: the gap before it stays a gap', () => {
  const s = utc([daily('nap', '08:00', '12:00'), daily('nap', '12:10', '18:00', { exceptions: ['2027-01-05'] })], { joinMinutes: 15 });
  assert.equal(iso(occurrenceAt(s, t('2027-01-04T09:00:00Z')).end), '2027-01-04T18:00:00.000Z');
  assert.equal(iso(occurrenceAt(s, t('2027-01-05T09:00:00Z')).end), '2027-01-05T12:00:00.000Z');
});

test('the overlap check passes over a window\'s skipped date, a plain weekly window included', () => {
  const series = { kind: 'awake', days: ['mon'], start: '08:00', end: '12:00' };
  const once = daily('nap', '09:00', '10:00', { from: '2027-01-04', until: '2027-01-04' });
  assert.deepEqual(problems(utc([{ ...series, exceptions: ['2027-01-04'] }, once])), []);
  assert.deepEqual(problems(utc([series, once])), ['windows[1]: the nap window overlaps the awake window windows[0] (2027-01-04 09:00–10:00)']);
  // Two plain weekly windows, one with a skipped date: read day by day, the next Monday still overlaps.
  assert.deepEqual(problems(utc([{ ...series, exceptions: ['2027-01-04'] }, { kind: 'nap', days: ['mon'], start: '11:00', end: '13:00', wake: 'never' }])),
    ['windows[1]: the nap window overlaps the awake window windows[0] (2027-01-11 11:00–12:00)']);
});

test('refused as the schedule\'s are, each problem naming its field', () => {
  const w = (exceptions) => problems(utc([daily('awake', '08:00', '09:00', { exceptions })]));
  assert.deepEqual(w([]), []);
  assert.deepEqual(w('2027-01-05'), ['windows[0].exceptions: a list']);
  assert.deepEqual(w(['2027-01-05', '2027-02-30', 5]), ['windows[0].exceptions[1]: a date YYYY-MM-DD', 'windows[0].exceptions[2]: a date YYYY-MM-DD']);
  const many = Array.from({ length: EXCEPTIONS_MAX + 1 }, (_, i) => iso(t('2027-01-01T00:00:00Z') + i * 86_400_000).slice(0, 10));
  assert.deepEqual(w(many), [`windows[0].exceptions: at most ${EXCEPTIONS_MAX}`]);
});

test('stored once each, in their order, and an empty list not at all', () => {
  const stored = normalizeSchedule(utc([daily('awake', '08:00', '09:00', { exceptions: ['2027-01-07', '2027-01-05', '2027-01-07'] }), daily('awake', '10:00', '11:00', { exceptions: [] })]));
  assert.deepEqual(stored.windows[0].exceptions, ['2027-01-07', '2027-01-05']);
  assert.equal('exceptions' in stored.windows[1], false);
});

test('a schedule takes 100 windows: occurrences moved one at a time are windows of their own', () => {
  assert.equal(WINDOWS_MAX, 100);
  const once = (i) => daily('awake', '08:00', '09:00', { from: iso(t('2027-01-01T00:00:00Z') + i * 86_400_000).slice(0, 10), until: iso(t('2027-01-01T00:00:00Z') + i * 86_400_000).slice(0, 10) });
  assert.deepEqual(problems(utc(Array.from({ length: 100 }, (_, i) => once(i)))), []);
  assert.deepEqual(problems(utc(Array.from({ length: 101 }, (_, i) => once(i)))), ['windows: at most 100']);
});
