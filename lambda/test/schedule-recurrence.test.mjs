// Recurrences (schedule recurrence design, sections 2 to 4): `from`, `until` and `repeat` on a window, the cron grammar,
// the overlap check day by day, and the time limits of the 5-minute check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  awakeStartWithin, nextEvents, normalizeSchedule, occurrenceAt, scheduleProblems,
} from '../src/lib/schedule.mjs';

const t = (text) => Date.parse(text);
const iso = (ms) => new Date(ms).toISOString();
const NOW = t('2026-11-01T12:00:00Z');

const utc = (windows, more = {}) => ({ timeZone: 'UTC', windows, ...more });
const paris = (windows, more = {}) => ({ timeZone: 'Europe/Paris', windows, ...more });
const problems = (s, now = NOW) => scheduleProblems(s, { now });
const awake = (fields) => ({ kind: 'awake', start: '08:00', end: '12:00', ...fields });
const nap = (fields) => ({ kind: 'nap', start: '08:00', end: '12:00', ...fields });
const cron = (expression, minutes = 5, kind = 'awake', more = {}) => ({ kind, repeat: { pattern: 'cron', cron: expression, minutes }, ...more });

// The starts a window's occurrences have after `after`, in UTC, "2027-01-04 08:00".
const startsOf = (window, after = '2027-01-01T00:00:00Z', count = 6, more = {}) => nextEvents(utc([window], more), t(after), { count: count * 2 })
  .filter((e) => e.kind.endsWith('-start')).slice(0, count).map((e) => e.at.slice(0, 16).replace('T', ' '));
const at8 = (...dates) => dates.map((date) => `${date} 08:00`);
const shown = (o) => o && { ...o, start: iso(o.start), end: iso(o.end) };

// --- The format (section 2) -----------------------------------------------------------------------------------------

test('the design\'s examples are valid, and the old form still is', () => {
  for (const window of [
    { kind: 'awake', days: ['mon', 'fri'], start: '08:30', end: '19:00' },
    { kind: 'awake', start: '08:00', end: '12:00', repeat: { pattern: 'daily', interval: 3 }, from: '2027-01-04' },
    { kind: 'nap', start: '20:00', end: '07:00', repeat: { pattern: 'weekly', interval: 2, days: ['mon', 'thu'] }, from: '2027-01-04', until: '2027-06-30', wake: 'header' },
    { kind: 'awake', start: '08:00', end: '18:00', repeat: { pattern: 'monthly', interval: 1, day: 15 } },
    { kind: 'awake', start: '08:00', end: '18:00', repeat: { pattern: 'monthly', interval: 3, nth: 1, weekday: 'mon' }, from: '2027-01-01' },
    { kind: 'nap', start: '00:00', end: '00:00', repeat: { pattern: 'monthly', interval: 12, day: 25 }, from: '2026-12-01' },
    { kind: 'awake', repeat: { pattern: 'cron', cron: '30 8 * * 1-5', minutes: 630 } },
  ]) assert.deepEqual(problems(paris([window])), [], JSON.stringify(window));
});

test('valid: each of from and until alone, on weekly days too, one day long, and null for what is absent', () => {
  for (const window of [
    awake({ days: ['mon'], from: '2027-01-04' }),
    awake({ days: ['mon'], until: '2027-01-04' }),
    awake({ days: ['mon'], from: '2027-01-04', until: '2027-01-04' }),
    awake({ days: ['mon'], from: null, until: null, repeat: null }),
    awake({ days: null, repeat: { pattern: 'daily', interval: null } }),
    awake({ repeat: { pattern: 'daily' }, until: '2020-01-01' }),
    awake({ repeat: { pattern: 'monthly', day: null, nth: -1, weekday: 'sun' } }),
    cron('0 8 * * *', 10080),
    cron('0 8 * * *', 5),
    cron('0 8 29 2 *'),
  ]) assert.deepEqual(problems(utc([window])), [], JSON.stringify(window));
});

const DAYS_LIST = 'one or more of mon, tue, wed, thu, fri, sat, sun, each once';
const FIVE_FIELDS = 'five fields: minute hour day-of-month month day-of-week';
const WINDOW_PROBLEMS = [
  ['from not a date', awake({ days: ['mon'], from: '2027-1-4' }), 'windows[0].from: a date YYYY-MM-DD'],
  ['from not in the calendar', awake({ days: ['mon'], from: '2027-02-30' }), 'windows[0].from: a date YYYY-MM-DD'],
  ['until not a date', awake({ days: ['mon'], until: 20270104 }), 'windows[0].until: a date YYYY-MM-DD'],
  ['until before from', awake({ days: ['mon'], from: '2027-01-05', until: '2027-01-04' }), 'windows[0].until: not before from'],
  ['days and repeat', awake({ days: ['mon'], repeat: { pattern: 'daily' } }), 'windows[0].days: days or repeat, never both'],
  ['neither days nor repeat', awake({}), `windows[0].days: ${DAYS_LIST}`],
  ['repeat not an object', awake({ repeat: 'daily' }), 'windows[0].repeat: an object with a pattern'],
  ['a repeat with no pattern', awake({ repeat: { interval: 2 } }), 'windows[0].repeat.pattern: daily, weekly, monthly or cron'],
  ['an unknown pattern', awake({ repeat: { pattern: 'yearly' } }), 'windows[0].repeat.pattern: daily, weekly, monthly or cron'],
  ['an unknown repeat field', awake({ repeat: { pattern: 'daily', every: 2 } }), 'windows[0].repeat.every: unknown field'],
  ['a parsed __proto__ key in a repeat', awake({ repeat: JSON.parse('{"pattern": "daily", "__proto__": 1}') }), 'windows[0].repeat.__proto__: unknown field'],
  ['a field of another pattern', awake({ repeat: { pattern: 'daily', days: ['mon'] } }), 'windows[0].repeat.days: not with the daily pattern'],
  ['an interval of 0', awake({ repeat: { pattern: 'daily', interval: 0 } }), 'windows[0].repeat.interval: a whole number from 1 to 99'],
  ['an interval of 100', awake({ repeat: { pattern: 'daily', interval: 100 }, from: '2027-01-04' }), 'windows[0].repeat.interval: a whole number from 1 to 99'],
  ['an interval not whole', awake({ repeat: { pattern: 'daily', interval: 1.5 } }), 'windows[0].repeat.interval: a whole number from 1 to 99'],
  ['an interval as text', awake({ repeat: { pattern: 'daily', interval: '2' } }), 'windows[0].repeat.interval: a whole number from 1 to 99'],
  ['daily above 1 without from', awake({ repeat: { pattern: 'daily', interval: 2 } }), 'windows[0].from: required when repeat.interval is above 1, it anchors the count'],
  ['weekly above 1 without from', awake({ repeat: { pattern: 'weekly', interval: 2, days: ['mon'] } }), 'windows[0].from: required when repeat.interval is above 1, it anchors the count'],
  ['monthly above 1 without from', awake({ repeat: { pattern: 'monthly', interval: 2, day: 1 } }), 'windows[0].from: required when repeat.interval is above 1, it anchors the count'],
  ['yearly without from', awake({ repeat: { pattern: 'monthly', interval: 12, day: 25 } }), 'windows[0].from: required when repeat.interval is above 1, it anchors the count'],
  ['weekly with no days', awake({ repeat: { pattern: 'weekly' } }), `windows[0].repeat.days: ${DAYS_LIST}`],
  ['weekly with empty days', awake({ repeat: { pattern: 'weekly', days: [] } }), `windows[0].repeat.days: ${DAYS_LIST}`],
  ['weekly with a day twice', awake({ repeat: { pattern: 'weekly', days: ['mon', 'mon'] } }), `windows[0].repeat.days: ${DAYS_LIST}`],
  ['weekly with an unknown day', awake({ repeat: { pattern: 'weekly', days: ['Mon'] } }), `windows[0].repeat.days: ${DAYS_LIST}`],
  ['monthly with neither', awake({ repeat: { pattern: 'monthly' } }), 'windows[0].repeat: monthly takes day, or nth with weekday'],
  ['monthly with both', awake({ repeat: { pattern: 'monthly', day: 1, nth: 1, weekday: 'mon' } }), 'windows[0].repeat: monthly takes day, or nth with weekday'],
  ['monthly with day and weekday', awake({ repeat: { pattern: 'monthly', day: 1, weekday: 'mon' } }), 'windows[0].repeat: monthly takes day, or nth with weekday'],
  ['monthly with a weekday alone', awake({ repeat: { pattern: 'monthly', weekday: 'mon' } }), 'windows[0].repeat: monthly takes day, or nth with weekday'],
  ['a day of 0', awake({ repeat: { pattern: 'monthly', day: 0 } }), 'windows[0].repeat.day: a whole number from 1 to 31'],
  ['a day of 32', awake({ repeat: { pattern: 'monthly', day: 32 } }), 'windows[0].repeat.day: a whole number from 1 to 31'],
  ['an nth of 5', awake({ repeat: { pattern: 'monthly', nth: 5, weekday: 'mon' } }), 'windows[0].repeat.nth: 1, 2, 3, 4, or -1 for the last'],
  ['an nth of -2', awake({ repeat: { pattern: 'monthly', nth: -2, weekday: 'mon' } }), 'windows[0].repeat.nth: 1, 2, 3, 4, or -1 for the last'],
  ['an nth with no weekday', awake({ repeat: { pattern: 'monthly', nth: 1 } }), 'windows[0].repeat.weekday: one of mon, tue, wed, thu, fri, sat, sun'],
  ['an unknown weekday', awake({ repeat: { pattern: 'monthly', nth: 1, weekday: 'Monday' } }), 'windows[0].repeat.weekday: one of mon, tue, wed, thu, fri, sat, sun'],
  ['a non-cron repeat without start', { kind: 'awake', end: '12:00', repeat: { pattern: 'daily' } }, 'windows[0].start: HH:MM, minutes a multiple of 5'],
  ['a non-cron repeat without end', { kind: 'awake', start: '08:00', repeat: { pattern: 'daily' } }, 'windows[0].end: HH:MM, minutes a multiple of 5'],
  ['a cron with start', { ...cron('0 8 * * *'), start: '08:00' }, 'windows[0].start: not with the cron pattern, repeat.minutes says how long'],
  ['a cron with end', { ...cron('0 8 * * *'), end: '12:00' }, 'windows[0].end: not with the cron pattern, repeat.minutes says how long'],
  ['a cron with interval', { kind: 'awake', repeat: { pattern: 'cron', cron: '0 8 * * *', minutes: 5, interval: 2 }, from: '2027-01-04' }, 'windows[0].repeat.interval: not with the cron pattern'],
  ['a cron with no minutes', { kind: 'awake', repeat: { pattern: 'cron', cron: '0 8 * * *' } }, 'windows[0].repeat.minutes: a multiple of 5 from 5 to 10080'],
  ['minutes of 0', cron('0 8 * * *', 0), 'windows[0].repeat.minutes: a multiple of 5 from 5 to 10080'],
  ['minutes not a multiple of 5', cron('0 8 * * *', 7), 'windows[0].repeat.minutes: a multiple of 5 from 5 to 10080'],
  ['minutes above 7 days', cron('0 8 * * *', 10085), 'windows[0].repeat.minutes: a multiple of 5 from 5 to 10080'],
  ['minutes as text', cron('0 8 * * *', '60'), 'windows[0].repeat.minutes: a multiple of 5 from 5 to 10080'],
  ['a cron with no expression', { kind: 'awake', repeat: { pattern: 'cron', minutes: 5 } }, `windows[0].repeat.cron: ${FIVE_FIELDS}`],
  ['wake on an awake repeat', awake({ repeat: { pattern: 'daily' }, wake: 'never' }), 'windows[0].wake: nap windows only'],
];
for (const [name, window, problem] of WINDOW_PROBLEMS) {
  test(`refused: ${name}`, () => assert.deepEqual(problems(utc([window])), [problem]));
}

test('a refusal names its window', () => {
  assert.deepEqual(problems(utc([awake({ days: ['mon'] }), cron('* 8 * * *', 5, 'nap')])).map((p) => p.split(':')[0]), ['windows[1].repeat.cron']);
});

// --- The range and the patterns -------------------------------------------------------------------------------------

test('from and until are both included, and an occurrence started on until runs past it', () => {
  const s = utc([{ kind: 'nap', start: '20:00', end: '07:00', repeat: { pattern: 'daily' }, from: '2027-01-04', until: '2027-01-06' }]);
  assert.equal(occurrenceAt(s, t('2027-01-03T23:00:00Z')), null, 'before from');
  assert.equal(occurrenceAt(s, t('2027-01-04T19:55:00Z')), null, 'before its first start');
  assert.equal(iso(occurrenceAt(s, t('2027-01-04T20:00:00Z')).start), '2027-01-04T20:00:00.000Z', 'on from');
  assert.equal(iso(occurrenceAt(s, t('2027-01-06T20:00:00Z')).start), '2027-01-06T20:00:00.000Z', 'on until');
  const past = occurrenceAt(s, t('2027-01-07T06:55:00Z'));
  assert.equal(iso(past.start), '2027-01-06T20:00:00.000Z', 'started on until, running past it');
  assert.equal(iso(past.end), '2027-01-07T07:00:00.000Z');
  assert.equal(occurrenceAt(s, t('2027-01-07T07:00:00Z')), null, 'its end');
  assert.equal(occurrenceAt(s, t('2027-01-07T20:00:00Z')), null, 'after until');
});

test('from and until apply to plain weekly days, and each works alone', () => {
  const monday = (more) => ({ kind: 'awake', days: ['mon'], start: '08:00', end: '09:00', ...more });
  assert.deepEqual(startsOf(monday({ from: '2027-01-11' }), undefined, 2), at8('2027-01-11', '2027-01-18'));
  assert.deepEqual(startsOf(monday({ until: '2027-01-11' }), '2027-01-08T00:00:00Z'), at8('2027-01-11'));
  assert.deepEqual(startsOf(monday({ from: '2027-01-11', until: '2027-01-18' })), at8('2027-01-11', '2027-01-18'));
  assert.deepEqual(startsOf(monday({ until: '2026-12-31' })), [], 'an end date in the past: no occurrence');
  assert.equal(occurrenceAt(utc([monday({ until: '2027-01-11' })]), t('2027-01-18T08:30:00Z')), null);
});

test('daily counts days from from', () => {
  assert.deepEqual(startsOf(awake({ repeat: { pattern: 'daily', interval: 3 }, from: '2027-01-04' }), undefined, 4), at8('2027-01-04', '2027-01-07', '2027-01-10', '2027-01-13'));
  assert.deepEqual(startsOf(awake({ repeat: { pattern: 'daily' } }), undefined, 3), at8('2027-01-01', '2027-01-02', '2027-01-03'));
  // Read long after from, across the end of a month and a year.
  assert.deepEqual(startsOf(awake({ repeat: { pattern: 'daily', interval: 10 }, from: '2026-12-25' }), '2027-01-01T00:00:00Z', 2), at8('2027-01-04', '2027-01-14'));
});

test('weekly counts weeks, Monday to Sunday, from the week of from', () => {
  // From a Wednesday: its Monday is not an occurrence, its Thursday is, then every second week.
  assert.deepEqual(startsOf(awake({ repeat: { pattern: 'weekly', interval: 2, days: ['mon', 'thu'] }, from: '2027-01-06' }), undefined, 5),
    at8('2027-01-07', '2027-01-18', '2027-01-21', '2027-02-01', '2027-02-04'));
  // From a Sunday: it ends the week of Monday the 4th, so the next week is the 18th's. A week from Sunday would say the 11th.
  assert.deepEqual(startsOf(awake({ repeat: { pattern: 'weekly', interval: 2, days: ['mon', 'sun'] }, from: '2027-01-10' }), undefined, 4),
    at8('2027-01-10', '2027-01-18', '2027-01-24', '2027-02-01'));
  assert.deepEqual(startsOf(awake({ repeat: { pattern: 'weekly', days: ['fri'] } }), undefined, 2), at8('2027-01-01', '2027-01-08'));
});

test('monthly counts months from the month of from', () => {
  // The 15th of the month of from is before from: not an occurrence, but its month is the one counted from.
  assert.deepEqual(startsOf(awake({ repeat: { pattern: 'monthly', interval: 3, day: 15 }, from: '2027-01-20' }), undefined, 3), at8('2027-04-15', '2027-07-15', '2027-10-15'));
  assert.deepEqual(startsOf(awake({ repeat: { pattern: 'monthly', interval: 2, day: 15 }, from: '2026-11-15' }), undefined, 3), at8('2027-01-15', '2027-03-15', '2027-05-15'));
  assert.deepEqual(startsOf(awake({ repeat: { pattern: 'monthly', day: 15 } }), undefined, 2), at8('2027-01-15', '2027-02-15'));
});

test('a day past the month\'s end falls on the month\'s last day', () => {
  assert.deepEqual(startsOf(awake({ repeat: { pattern: 'monthly', day: 31 } }), undefined, 5), at8('2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30', '2027-05-31'));
  assert.deepEqual(startsOf(awake({ repeat: { pattern: 'monthly', day: 30 } }), undefined, 3), at8('2027-01-30', '2027-02-28', '2027-03-30'));
  assert.deepEqual(startsOf(awake({ repeat: { pattern: 'monthly', day: 29 } }), '2028-02-01T00:00:00Z', 2), at8('2028-02-29', '2028-03-29'), 'a leap year');
  assert.deepEqual(startsOf(awake({ repeat: { pattern: 'monthly', day: 31 } }), '2028-02-01T00:00:00Z', 1), at8('2028-02-29'));
});

test('nth weekdays: first to fourth, and -1 the last', () => {
  const on = (nth, weekday) => startsOf(awake({ repeat: { pattern: 'monthly', nth, weekday } }), undefined, 3);
  assert.deepEqual(on(1, 'mon'), at8('2027-01-04', '2027-02-01', '2027-03-01'));
  assert.deepEqual(on(2, 'mon'), at8('2027-01-11', '2027-02-08', '2027-03-08'));
  assert.deepEqual(on(3, 'mon'), at8('2027-01-18', '2027-02-15', '2027-03-15'));
  assert.deepEqual(on(4, 'mon'), at8('2027-01-25', '2027-02-22', '2027-03-22'));
  assert.deepEqual(on(-1, 'mon'), at8('2027-01-25', '2027-02-22', '2027-03-29'), 'March has five');
  assert.deepEqual(on(-1, 'sun'), at8('2027-01-31', '2027-02-28', '2027-03-28'));
  assert.deepEqual(on(1, 'fri'), at8('2027-01-01', '2027-02-05', '2027-03-05'));
  assert.deepEqual(startsOf(awake({ repeat: { pattern: 'monthly', interval: 3, nth: 1, weekday: 'mon' }, from: '2027-01-01' }), undefined, 4),
    at8('2027-01-04', '2027-04-05', '2027-07-05', '2027-10-04'));
});

test('yearly is monthly, interval 12, its month given by from', () => {
  const christmas = { kind: 'nap', start: '00:00', end: '00:00', repeat: { pattern: 'monthly', interval: 12, day: 25 }, from: '2026-12-01' };
  const s = paris([christmas]);
  const day = shown(occurrenceAt(s, t('2027-12-25T12:00:00+01:00')));
  assert.deepEqual(day, {
    kind: 'nap', window: 0, id: '0@2027-12-24T23:00:00.000Z', start: '2027-12-24T23:00:00.000Z', end: '2027-12-25T23:00:00.000Z', wake: 'never',
  });
  assert.equal(occurrenceAt(s, t('2027-11-25T12:00:00+01:00')), null, 'another month');
  assert.equal(occurrenceAt(s, t('2027-12-24T12:00:00+01:00')), null, 'another day');
  assert.notEqual(occurrenceAt(s, t('2028-12-25T12:00:00+01:00')), null, 'the year after');
});

// --- The cron grammar -----------------------------------------------------------------------------------------------

const cronStarts = (expression, after = '2027-01-01T00:00:00Z', count = 6) => startsOf(cron(expression), after, count);
const CRON_STARTS = [
  ['a number', '30 8 * * *', ['2027-01-01 08:30', '2027-01-02 08:30']],
  ['a list of minutes', '0,30 8 * * *', ['2027-01-01 08:00', '2027-01-01 08:30', '2027-01-02 08:00']],
  ['a step over the minute field', '*/30 8 * * *', ['2027-01-01 08:00', '2027-01-01 08:30', '2027-01-02 08:00']],
  ['a step over a range', '0-30/15 8 * * *', ['2027-01-01 08:00', '2027-01-01 08:15', '2027-01-01 08:30', '2027-01-02 08:00']],
  ['a range of hours', '0 8-10 * * *', ['2027-01-01 08:00', '2027-01-01 09:00', '2027-01-01 10:00', '2027-01-02 08:00']],
  ['a step over hours', '0 */12 * * *', ['2027-01-01 12:00', '2027-01-02 00:00', '2027-01-02 12:00']],
  ['a list of ranges and steps', '0 1-2,20-22/2 * * *', ['2027-01-01 01:00', '2027-01-01 02:00', '2027-01-01 20:00', '2027-01-01 22:00', '2027-01-02 01:00']],
  ['a list holding *', '0 8 *,5 * *', ['2027-01-01 08:00', '2027-01-02 08:00']],
  ['a day of the month', '0 8 15 * *', at8('2027-01-15', '2027-02-15')],
  ['a month by its number', '0 8 15 3 *', at8('2027-03-15')],
  ['a month by its name', '0 8 15 MAR *', at8('2027-03-15')],
  ['a month name in another case', '0 8 15 mAr *', at8('2027-03-15')],
  ['a range of month names', '0 8 15 mar-may *', at8('2027-03-15', '2027-04-15', '2027-05-15')],
  ['a weekday by its number', '0 8 * * 1', at8('2027-01-04', '2027-01-11')],
  ['a weekday by its name', '0 8 * * MON', at8('2027-01-04', '2027-01-11')],
  ['a weekday name in lower case', '0 8 * * mon', at8('2027-01-04', '2027-01-11')],
  ['a range of weekday names', '0 8 * * MON-WED', at8('2027-01-04', '2027-01-05', '2027-01-06', '2027-01-11')],
  ['a weekday 0 is Sunday', '0 8 * * 0', at8('2027-01-03', '2027-01-10')],
  ['a weekday 7 is Sunday', '0 8 * * 7', at8('2027-01-03', '2027-01-10')],
  ['a weekday range up to 7', '0 8 * * 5-7', at8('2027-01-01', '2027-01-02', '2027-01-03', '2027-01-08')],
  ['a weekday range ending on the name SUN', '0 8 * * FRI-SUN', at8('2027-01-01', '2027-01-02', '2027-01-03', '2027-01-08')],
  ['a weekday range from SUN', '0 8 * * SUN-MON', at8('2027-01-03', '2027-01-04', '2027-01-10')],
  ['a weekday step', '0 8 * * */3', at8('2027-01-02', '2027-01-03', '2027-01-06', '2027-01-09')],
  ['? in the day of the month', '0 8 ? * 1', at8('2027-01-04', '2027-01-11')],
  ['? in the day of the week', '0 8 15 * ?', at8('2027-01-15', '2027-02-15')],
  ['both day fields restricted: either matches', '0 8 15 * MON', at8('2027-01-04', '2027-01-11', '2027-01-15', '2027-01-18', '2027-01-25', '2027-02-01')],
  ['either matches for a step too', '0 8 */10 * MON', at8('2027-01-01', '2027-01-04', '2027-01-11', '2027-01-18', '2027-01-21', '2027-01-25')],
  ['? in both', '0 8 ? * ?', at8('2027-01-01', '2027-01-02')],
  ['extra spaces', '  0   8 15 *  * ', at8('2027-01-15', '2027-02-15')],
  ['a day only a month can have', '0 8 31 1,2 *', at8('2027-01-31', '2028-01-31')],
];
for (const [name, expression, expected] of CRON_STARTS) {
  test(`cron: ${name}`, () => {
    assert.deepEqual(problems(utc([cron(expression)])), []);
    assert.deepEqual(cronStarts(expression).slice(0, expected.length), expected);
  });
}

test('cron: February 29 is valid, and comes in a leap year', () => {
  assert.deepEqual(problems(utc([cron('0 8 29 2 *')])), []);
  assert.deepEqual(cronStarts('0 8 29 2 *'), [], 'not within the 400 days from 2027');
  assert.deepEqual(cronStarts('0 8 29 2 *', '2028-01-01T00:00:00Z'), at8('2028-02-29'));
});

const CRON_PROBLEMS = [
  ['* in the minutes', '* 8 * * *', /must be multiples of 5.*\*\/5/],
  ['a minute not a multiple of 5', '3 8 * * *', /multiples of 5/],
  ['a list with one minute not a multiple of 5', '0,31 8 * * *', /multiples of 5/],
  ['a step not on 5', '*/7 8 * * *', /multiples of 5/],
  ['a step from a minute not on 5', '1-59/5 8 * * *', /multiples of 5/],
  ['cron(...)', 'cron(0 8 * * ? *)', FIVE_FIELDS],
  ['cron(...) with five fields', 'cron(0 8 * * 1)', FIVE_FIELDS],
  ['six fields', '0 8 * * ? *', FIVE_FIELDS],
  ['four fields', '0 8 * *', FIVE_FIELDS],
  ['an alias', '@daily', FIVE_FIELDS],
  ['nothing', '   ', FIVE_FIELDS],
  ['L in the day of the month', '0 8 L * *', FIVE_FIELDS],
  ['L in a list', '0 8 1,L * *', FIVE_FIELDS],
  ['L-3', '0 8 L-3 * *', FIVE_FIELDS],
  ['L after a weekday number', '0 8 * * 5L', FIVE_FIELDS],
  ['L after a weekday name', '0 8 * * FRIL', FIVE_FIELDS],
  ['W', '0 8 15W * *', FIVE_FIELDS],
  ['LW', '0 8 LW * *', FIVE_FIELDS],
  ['#', '0 8 * * MON#2', FIVE_FIELDS],
  ['a date no month has', '0 8 31 2 *', /never matches/],
  ['dates no month has, in a list', '0 8 30,31 2 *', /never matches/],
  ['April 31', '0 8 31 APR *', /never matches/],
  ['an hour out of range', '0 24 * * *', /hour field/],
  ['a minute out of range', '60 8 * * *', /minute field/],
  ['a day of the month of 0', '0 8 0 * *', /day-of-month field/],
  ['a day of the month of 32', '0 8 32 * *', /day-of-month field/],
  ['a month of 0', '0 8 * 0 *', /month field/],
  ['a month of 13', '0 8 * 13 *', /month field/],
  ['a weekday of 8', '0 8 * * 8', /day-of-week field/],
  ['a weekday name in the month field', '0 8 * MON *', /month field/],
  ['a month name in the weekday field', '0 8 * * JAN', /day-of-week field/],
  ['a name in the hours', '0 MON * * *', /hour field/],
  ['? in the minutes', '? 8 * * *', /minute field/],
  ['? in the hours', '0 ? * * *', /hour field/],
  ['? in the months', '0 8 * ? *', /month field/],
  ['? in a list', '0 8 ?,1 * *', /day-of-month field/],
  ['? with a step', '0 8 ?/2 * *', /day-of-month field/],
  ['a reversed range', '0 10-8 * * *', /hour field/],
  ['a reversed weekday range', '0 8 * * 5-1', /day-of-week field/],
  ['a step of 0', '*/0 8 * * *', /minute field/],
  ['a step over a number', '5/5 8 * * *', /minute field/],
  ['an empty list item', '0,,30 8 * * *', /minute field/],
  ['a negative number', '-5 8 * * *', /minute field/],
  ['a word', '0 eight * * *', /hour field/],
];
for (const [name, expression, why] of CRON_PROBLEMS) {
  test(`cron refused: ${name}`, () => {
    const found = problems(utc([cron(expression)]));
    assert.equal(found.length, 1, found.join('; '));
    assert.ok(found[0].startsWith('windows[0].repeat.cron: '), found[0]);
    if (typeof why === 'string') assert.equal(found[0], `windows[0].repeat.cron: ${why}`);
    else assert.match(found[0], why);
  });
}

test('cron: at most 200 characters', () => {
  const long = `0 8 ${Array(70).fill('1').join(',')} * *`;
  assert.ok(long.length > 100 && long.length <= 200);
  assert.deepEqual(problems(utc([cron(long)])), []);
  assert.deepEqual(problems(utc([cron(`0 8 ${Array(100).fill('1').join(',')} * *`)])), ['windows[0].repeat.cron: at most 200 characters']);
});

// --- minutes --------------------------------------------------------------------------------------------------------

test('minutes up to 7 days: occurrenceAt looks back far enough', () => {
  const week = utc([cron('0 8 1 * *', 10080)]);
  assert.equal(iso(occurrenceAt(week, t('2027-01-01T08:00:00Z')).start), '2027-01-01T08:00:00.000Z');
  const late = occurrenceAt(week, t('2027-01-08T07:55:00Z'));
  assert.equal(iso(late.start), '2027-01-01T08:00:00.000Z');
  assert.equal(iso(late.end), '2027-01-08T08:00:00.000Z');
  assert.equal(occurrenceAt(week, t('2027-01-08T08:00:00Z')), null);
  assert.equal(occurrenceAt(week, t('2027-01-01T07:55:00Z')), null);
  // Started at the last minute of a day: its end is on the seventh day after.
  const lastMinute = occurrenceAt(utc([cron('55 23 1 * *', 10080)]), t('2027-01-08T23:50:00Z'));
  assert.equal(iso(lastMinute.end), '2027-01-08T23:55:00.000Z');
  // A little over a day.
  const longer = occurrenceAt(utc([cron('0 0 1 * *', 1445)]), t('2027-01-02T00:02:00Z'));
  assert.equal(iso(longer.end), '2027-01-02T00:05:00.000Z');
});

test('minutes up to 7 days: nextEvents finds the end of an occurrence started long ago', () => {
  assert.deepEqual(nextEvents(utc([cron('0 8 1 * *', 10080)]), t('2027-01-07T12:00:00Z'), { count: 2 }), [
    { at: '2027-01-08T08:00:00.000Z', kind: 'awake-end', window: 0 },
    { at: '2027-02-01T08:00:00.000Z', kind: 'awake-start', window: 0 },
  ]);
});

test('minutes: an occurrence ends in wall time, the cron window keeps its kind and wake', () => {
  const s = paris([cron('0 22 * * FRI', 600, 'nap', { })]);
  assert.deepEqual(shown(occurrenceAt(s, t('2027-01-09T07:00:00+01:00'))), {
    kind: 'nap', window: 0, id: '0@2027-01-08T21:00:00.000Z', start: '2027-01-08T21:00:00.000Z', end: '2027-01-09T07:00:00.000Z', wake: 'never',
  });
  const header = paris([{ ...cron('0 22 * * FRI', 600, 'nap'), wake: 'header' }]);
  assert.equal(occurrenceAt(header, t('2027-01-09T07:00:00+01:00')).wake, 'header');
});

test('a cron window: each start is its own occurrence, whose id changes, and they join as a union', () => {
  const s = utc([cron('0,30 8 * * *', 30)]);
  const first = occurrenceAt(s, t('2027-01-04T08:10:00Z'));
  const second = occurrenceAt(s, t('2027-01-04T08:40:00Z'));
  assert.equal(first.id, '0@2027-01-04T08:00:00.000Z');
  assert.equal(second.id, '0@2027-01-04T08:30:00.000Z');
  assert.equal(iso(first.end), '2027-01-04T09:00:00.000Z', 'the union');
  assert.deepEqual(nextEvents(s, t('2027-01-04T07:00:00Z'), { count: 3 }), [
    { at: '2027-01-04T08:00:00.000Z', kind: 'awake-start', window: 0 },
    { at: '2027-01-04T08:30:00.000Z', kind: 'awake-start', window: 0 },
    { at: '2027-01-04T09:00:00.000Z', kind: 'awake-end', window: 0 },
  ]);
});

// --- Exceptions and clock changes -----------------------------------------------------------------------------------

test('an exception date removes the occurrences that start on it, of every pattern', () => {
  const more = { exceptions: ['2027-01-15'] };
  const on15 = t('2027-01-15T09:00:00Z');
  for (const window of [
    awake({ repeat: { pattern: 'daily' } }),
    awake({ repeat: { pattern: 'weekly', days: ['fri'] } }),
    awake({ repeat: { pattern: 'monthly', day: 15 } }),
    awake({ repeat: { pattern: 'monthly', nth: 3, weekday: 'fri' } }),
    cron('0 8 15 * *', 240),
    cron('0,30 8 * * *', 240),
  ]) {
    assert.notEqual(occurrenceAt(utc([window]), on15), null, JSON.stringify(window));
    assert.equal(occurrenceAt(utc([window], more), on15), null, JSON.stringify(window));
  }
});

test('an occurrence started before an exception date runs through it; one started on it does not', () => {
  const s = utc([cron('0 8 14 * *', 2880)], { exceptions: ['2027-01-15'] });
  assert.equal(iso(occurrenceAt(s, t('2027-01-15T09:00:00Z')).start), '2027-01-14T08:00:00.000Z');
  const onIt = utc([cron('0 8 15 * *', 2880)], { exceptions: ['2027-01-15'] });
  assert.equal(occurrenceAt(onIt, t('2027-01-16T09:00:00Z')), null);
  assert.deepEqual(nextEvents(onIt, t('2027-01-01T00:00:00Z'), { count: 1 }), [{ at: '2027-02-15T08:00:00.000Z', kind: 'awake-start', window: 0 }]);
});

const CLOCK_CHANGES = [
  ['a daily 02:30 start, skipped, applies at 03:00 CEST', paris([{ kind: 'awake', start: '02:30', end: '06:00', repeat: { pattern: 'daily', interval: 2 }, from: '2027-03-26' }]),
    '2027-03-28T03:00:00+02:00', '2027-03-28T01:00:00.000Z', '2027-03-28T04:00:00.000Z'],
  ['a monthly first instance of a repeated hour', paris([{ kind: 'awake', start: '02:30', end: '04:00', repeat: { pattern: 'monthly', nth: -1, weekday: 'sun' } }]),
    '2027-10-31T02:30:00+01:00', '2027-10-31T00:30:00.000Z', '2027-10-31T03:00:00.000Z'],
  ['a cron start in the skipped hour applies at 03:00 CEST, its end in wall time', paris([cron('30 2 * * *', 60)]),
    '2027-03-28T03:10:00+02:00', '2027-03-28T01:00:00.000Z', '2027-03-28T01:30:00.000Z'],
  ['a cron start in the repeated hour applies at its first instance, its end in wall time', paris([cron('30 2 * * *', 60)]),
    '2027-10-31T02:40:00+01:00', '2027-10-31T00:30:00.000Z', '2027-10-31T02:30:00.000Z'],
  ['a cron of 24 hours of wall time across the spring change lasts 23', paris([cron('0 12 27 3 *', 1440)]),
    '2027-03-28T11:55:00+02:00', '2027-03-27T11:00:00.000Z', '2027-03-28T10:00:00.000Z'],
  ['a cron of 24 hours of wall time across the autumn change lasts 25', paris([cron('0 12 30 10 *', 1440)]),
    '2027-10-31T11:55:00+01:00', '2027-10-30T10:00:00.000Z', '2027-10-31T11:00:00.000Z'],
  ['a cron of 7 days across the spring change ends at the same wall time', paris([cron('0 8 25 3 *', 10080)]),
    '2027-03-31T12:00:00+02:00', '2027-03-25T07:00:00.000Z', '2027-04-01T06:00:00.000Z'],
];
for (const [name, s, at, start, end] of CLOCK_CHANGES) {
  test(`clock change: ${name}`, () => {
    const o = occurrenceAt(s, t(at));
    assert.equal(iso(o.start), start);
    assert.equal(iso(o.end), end);
  });
}

test('clock change: every other day keeps its wall time on each side of it', () => {
  const s = paris([awake({ repeat: { pattern: 'daily', interval: 2 }, from: '2027-03-26' })]);
  assert.deepEqual(nextEvents(s, t('2027-03-26T00:00:00+01:00'), { count: 6 }).filter((e) => e.kind === 'awake-start').map((e) => e.at), [
    '2027-03-26T07:00:00.000Z', '2027-03-28T06:00:00.000Z', '2027-03-30T06:00:00.000Z',
  ]);
});

test('clock change: a */5 cron makes no empty occurrence in the skipped hour, and starts no second time in the repeated one', () => {
  const skipped = paris([cron('*/5 2 28 3 *', 5)]);
  assert.deepEqual(nextEvents(skipped, t('2027-03-28T00:00:00+01:00'), { count: 1, horizonDays: 2 }), []);
  assert.equal(occurrenceAt(skipped, t('2027-03-28T03:00:00+02:00')), null);
  const repeated = paris([cron('*/5 2 31 10 *', 5)]);
  const events = nextEvents(repeated, t('2027-10-31T00:00:00+02:00'), { count: 100, horizonDays: 2 });
  assert.equal(events.filter((e) => e.kind === 'awake-start').length, 12);
  assert.equal(events[0].at, '2027-10-31T00:00:00.000Z');
  assert.equal(events.at(-2).at, '2027-10-31T00:55:00.000Z');
  // 02:55 ends at 03:00 of wall time: after the second pass of 02:xx.
  assert.deepEqual(events.at(-1), { at: '2027-10-31T02:00:00.000Z', kind: 'awake-end', window: 0 });
  assert.equal(occurrenceAt(repeated, t('2027-10-31T02:30:00+01:00')).id, '0@2027-10-31T00:55:00.000Z');
});

test('an awake occurrence starting soon is found for every pattern, across midnight', () => {
  const soon = t('2027-01-14T23:50:00Z');
  for (const window of [
    { kind: 'awake', start: '00:10', end: '08:00', repeat: { pattern: 'monthly', day: 15 } },
    cron('10 0 15 * *', 60),
  ]) {
    assert.equal(awakeStartWithin(utc([window]), soon, 30 * 60_000), true);
    assert.equal(awakeStartWithin(utc([window]), soon, 10 * 60_000), false);
    assert.equal(awakeStartWithin(utc([{ ...window, until: '2027-01-14' }]), soon, 30 * 60_000), false);
  }
});

// --- Overlaps (section 3) -------------------------------------------------------------------------------------------

const OVERLAPS = [
  ['the design\'s words', [
    awake({ repeat: { pattern: 'monthly', day: 15 }, from: '2027-03-01' }),
    { kind: 'nap', start: '00:00', end: '00:00', repeat: { pattern: 'monthly', day: 15 }, from: '2027-03-01' },
  ], 'windows[1]: the nap window overlaps the awake window windows[0] (2027-03-15 08:00–12:00)'],
  ['a pattern against plain weekly days', [
    { kind: 'awake', days: ['mon'], start: '08:00', end: '19:00' },
    { kind: 'nap', start: '18:00', end: '20:00', repeat: { pattern: 'monthly', nth: 1, weekday: 'mon' }, from: '2027-01-01' },
  ], 'windows[1]: the nap window overlaps the awake window windows[0] (2027-01-04 18:00–19:00)'],
  ['from on a window of plain weekly days', [
    { kind: 'awake', days: ['mon'], start: '08:00', end: '19:00' },
    { kind: 'nap', days: ['mon'], start: '18:00', end: '20:00', from: '2027-03-01' },
  ], 'windows[1]: the nap window overlaps the awake window windows[0] (2027-03-01 18:00–19:00)'],
  ['until on a window of plain weekly days: the first date is the next one', [
    { kind: 'awake', days: ['mon'], start: '08:00', end: '19:00' },
    { kind: 'nap', days: ['mon'], start: '18:00', end: '20:00', until: '2027-03-01' },
  ], 'windows[1]: the nap window overlaps the awake window windows[0] (2026-11-02 18:00–19:00)'],
  ['the later from decides the first date', [
    awake({ repeat: { pattern: 'daily' }, from: '2027-01-01', until: '2027-06-30' }),
    nap({ repeat: { pattern: 'daily' }, from: '2027-02-10' }),
  ], 'windows[1]: the nap window overlaps the awake window windows[0] (2027-02-10 08:00–12:00)'],
  ['a night spilling into the next day', [
    { kind: 'nap', start: '22:00', end: '09:00', repeat: { pattern: 'weekly', days: ['sun'] } },
    { kind: 'awake', start: '08:00', end: '12:00', repeat: { pattern: 'monthly', day: 1 }, from: '2027-02-01' },
  ], 'windows[1]: the awake window overlaps the nap window windows[0] (2027-02-01 08:00–09:00)'],
  ['a span across midnight says both dates', [
    { kind: 'awake', start: '20:00', end: '02:00', repeat: { pattern: 'monthly', day: 15 } },
    { kind: 'nap', start: '23:00', end: '01:00', repeat: { pattern: 'monthly', day: 15 } },
  ], 'windows[1]: the nap window overlaps the awake window windows[0] (2026-11-15 23:00–2026-11-16 01:00)'],
  ['a cron against a pattern', [
    cron('30 8 * * 1-5', 630),
    { kind: 'nap', start: '18:00', end: '20:00', repeat: { pattern: 'daily' }, from: '2027-01-04' },
  ], 'windows[1]: the nap window overlaps the awake window windows[0] (2027-01-04 18:00–19:00)'],
  ['a long cron against its own later start', [
    cron('0 8 1 * *', 10080),
    { kind: 'nap', start: '20:00', end: '21:00', repeat: { pattern: 'monthly', day: 7 }, from: '2027-01-01' },
  ], 'windows[1]: the nap window overlaps the awake window windows[0] (2027-01-07 20:00–21:00)'],
  ['an occurrence started before the first date still counts where it reaches it', [
    cron('0 8 1 * *', 10080),
    { kind: 'nap', start: '00:00', end: '00:00', repeat: { pattern: 'daily' }, from: '2027-01-03', until: '2027-01-03' },
  ], 'windows[1]: the nap window overlaps the awake window windows[0] (2027-01-03 00:00–2027-01-04 00:00)'],
  ['a yearly date, a year after the first date', [
    { kind: 'nap', start: '00:00', end: '00:00', repeat: { pattern: 'monthly', interval: 12, day: 25 }, from: '2026-10-01' },
    awake({ days: ['wed'], from: '2027-10-26' }),
  ], 'windows[1]: the awake window overlaps the nap window windows[0] (2028-10-25 08:00–12:00)'],
];
for (const [name, windows, problem] of OVERLAPS) {
  test(`overlap: ${name}`, () => assert.deepEqual(problems(utc(windows)), [problem]));
}

test('overlap: two occurrences started before today, overlapping still, say today', () => {
  const windows = [cron('0 8 1 * *', 10080), cron('0 9 1 * *', 10080, 'nap')];
  assert.deepEqual(problems(utc(windows), t('2027-01-03T12:00:00Z')), ['windows[1]: the nap window overlaps the awake window windows[0] (2027-01-03 00:00–2027-01-08 08:00)']);
});

const APART = [
  ['every other day, on different days', [
    awake({ repeat: { pattern: 'daily', interval: 2 }, from: '2027-01-04' }),
    nap({ repeat: { pattern: 'daily', interval: 2 }, from: '2027-01-05' }),
  ]],
  ['every other week, on different weeks', [
    awake({ repeat: { pattern: 'weekly', interval: 2, days: ['mon'] }, from: '2027-01-04' }),
    nap({ repeat: { pattern: 'weekly', interval: 2, days: ['mon'] }, from: '2027-01-11' }),
  ]],
  ['every other month, on different months', [
    awake({ repeat: { pattern: 'monthly', interval: 2, day: 1 }, from: '2027-01-01' }),
    nap({ repeat: { pattern: 'monthly', interval: 2, day: 1 }, from: '2027-02-01' }),
  ]],
  ['one until before the other\'s from', [
    awake({ days: ['mon'], until: '2027-05-31' }),
    nap({ days: ['mon'], from: '2027-06-01' }),
  ]],
  ['touching is not overlapping', [
    { kind: 'nap', start: '20:00', end: '08:00', repeat: { pattern: 'daily' } },
    awake({ repeat: { pattern: 'daily' } }),
  ]],
  ['a cron touching its neighbour', [cron('0 8 * * *', 240), { kind: 'nap', start: '12:00', end: '13:00', repeat: { pattern: 'daily' } }]],
  ['two of one kind may', [awake({ repeat: { pattern: 'daily' } }), awake({ repeat: { pattern: 'daily' } })]],
  ['in the past only', [
    awake({ days: ['mon'], until: '2026-10-31' }),
    nap({ days: ['mon'] }),
  ]],
];
for (const [name, windows] of APART) {
  test(`no overlap: ${name}`, () => assert.deepEqual(problems(utc(windows)), []));
}

test('overlap: only the plain weekly pairs keep today\'s words', () => {
  const s = utc([
    { kind: 'awake', days: ['mon'], start: '08:00', end: '19:00' },
    { kind: 'nap', days: ['mon'], start: '18:00', end: '20:00' },
    { kind: 'nap', days: ['mon'], start: '18:00', end: '20:00', from: '2027-03-01' },
  ]);
  assert.deepEqual(problems(s), [
    'windows[1]: the nap window overlaps the awake window windows[0] (mon 18:00–19:00)',
    'windows[2]: the nap window overlaps the awake window windows[0] (2027-03-01 18:00–19:00)',
  ]);
});

test('overlap: 400 days from today, included from day 0 to day 399', () => {
  // Monthly, every 24 months, from January 2026: the next one is 2028-01-05.
  const windows = [
    awake({ repeat: { pattern: 'monthly', interval: 24, day: 5 }, from: '2026-01-01' }),
    nap({ repeat: { pattern: 'monthly', interval: 24, day: 5 }, from: '2026-01-01' }),
  ];
  assert.deepEqual(problems(utc(windows), t('2026-12-02T12:00:00Z')), ['windows[1]: the nap window overlaps the awake window windows[0] (2028-01-05 08:00–12:00)']);
  assert.deepEqual(problems(utc(windows), t('2026-12-01T12:00:00Z')), []);
});

test('overlap: 400 days from the later from, not from today', () => {
  const windows = [
    awake({ repeat: { pattern: 'monthly', interval: 24, day: 5 }, from: '2028-01-01' }),
    nap({ days: ['wed'], from: '2029-11-01' }),
  ];
  // The 400 days run from 2029-11-01: 2030-01-05 is a Saturday, and they end before January 2030's window repeats.
  assert.deepEqual(problems(utc(windows)), []);
  const onAWednesday = [windows[0], nap({ days: ['wed'], from: '2027-12-01' })];
  assert.deepEqual(problems(utc(onAWednesday)), ['windows[1]: the nap window overlaps the awake window windows[0] (2028-01-05 08:00–12:00)']);
});

test('overlap: today is the schedule\'s own, in its zone', () => {
  const windows = [awake({ days: ['mon'], until: '2026-11-02' }), nap({ days: ['mon'] })];
  // Monday 2026-11-02 08:00 in Paris; an overlap on that day, then none.
  const message = 'windows[1]: the nap window overlaps the awake window windows[0] (2026-11-02 08:00–12:00)';
  assert.deepEqual(problems(paris(windows), t('2026-11-02T22:59:00Z')), [message]);
  assert.deepEqual(problems(paris(windows), t('2026-11-02T23:00:00Z')), [], 'Tuesday already in Paris');
  assert.deepEqual(problems(utc(windows), t('2026-11-02T23:00:00Z')), [message], 'still Monday in UTC');
});

test('overlap: `now` defaults to the clock', () => {
  const windows = [awake({ days: ['mon'], until: '2020-01-06' }), nap({ days: ['mon'] })];
  assert.deepEqual(scheduleProblems(utc(windows)), []);
  const coming = [awake({ days: ['mon'], until: '2999-01-01' }), nap({ days: ['mon'] })];
  assert.equal(scheduleProblems(utc(coming)).length, 1);
});

test('overlap: beyond 400 days it is not refused, and at run time the occurrence that started last applies', () => {
  const windows = [
    { kind: 'awake', start: '08:00', end: '12:00', repeat: { pattern: 'monthly', interval: 24, day: 25 }, from: '2025-12-01' },
    { kind: 'nap', start: '10:00', end: '14:00', repeat: { pattern: 'monthly', interval: 36, day: 25 }, from: '2026-12-01' },
  ];
  assert.deepEqual(problems(utc(windows)), []);
  const s = utc(windows);
  assert.equal(occurrenceAt(s, t('2029-12-25T09:00:00Z')).kind, 'awake');
  assert.equal(occurrenceAt(s, t('2029-12-25T11:00:00Z')).kind, 'nap');
});

test('overlap: a date the exceptions remove is no overlap; the next one is', () => {
  const windows = [
    awake({ repeat: { pattern: 'monthly', day: 15 }, until: '2027-01-31' }),
    nap({ repeat: { pattern: 'monthly', day: 15 } }),
  ];
  assert.deepEqual(problems(utc(windows)), ['windows[1]: the nap window overlaps the awake window windows[0] (2026-11-15 08:00–12:00)']);
  assert.deepEqual(problems(utc(windows, { exceptions: ['2026-11-15'] })), ['windows[1]: the nap window overlaps the awake window windows[0] (2026-12-15 08:00–12:00)']);
  assert.deepEqual(problems(utc(windows, { exceptions: ['2026-11-15', '2026-12-15', '2027-01-15'] })), []);
});

test('overlap: an invalid window is reported, and the others still compared; a bad time zone hides nothing', () => {
  const windows = [awake({ repeat: { pattern: 'daily' } }), nap({ repeat: { pattern: 'daily' } }), cron('* * * * *', 5, 'nap')];
  const found = problems(utc(windows));
  assert.equal(found.length, 2);
  assert.match(found[0], /^windows\[2\]\.repeat\.cron/);
  assert.match(found[1], /^windows\[1\]: the nap window overlaps/);
  assert.deepEqual(problems({ ...utc(windows.slice(0, 2)), timeZone: 'Mars/Olympus' }), [
    'timeZone: an IANA time zone name, such as Europe/Paris',
    'windows[1]: the nap window overlaps the awake window windows[0] (2026-11-01 08:00–12:00)',
  ]);
});

// --- normalizeSchedule ----------------------------------------------------------------------------------------------

test('a normalized schedule keeps from, until and repeat, without its null fields', () => {
  const windows = [
    { kind: 'nap', start: '20:00', end: '07:00', repeat: { pattern: 'weekly', interval: 2, days: ['mon', 'thu'] }, from: '2027-01-04', until: '2027-06-30', wake: 'header' },
    { kind: 'awake', repeat: { pattern: 'cron', cron: '30 8 * * 1-5', minutes: 630 } },
    { kind: 'awake', start: '08:00', end: '09:00', repeat: { pattern: 'monthly', day: 15 } },
  ];
  assert.deepEqual(normalizeSchedule(paris(windows)).windows, windows);
  const nulled = [{ ...windows[2], days: null, from: null, until: null, wake: null, repeat: { ...windows[2].repeat, nth: null, weekday: null, interval: null } }];
  assert.deepEqual(normalizeSchedule(paris(nulled)).windows, [windows[2]]);
  assert.deepEqual(problems(normalizeSchedule(paris(windows))), []);
  // A plain window comes back as it was, with no new field.
  assert.deepEqual(Object.keys(normalizeSchedule(paris([{ kind: 'awake', days: ['mon'], start: '08:00', end: '09:00' }])).windows[0]), ['kind', 'days', 'start', 'end']);
});

// --- nextEvents' horizon --------------------------------------------------------------------------------------------

test('a yearly window is still found by nextEvents', () => {
  const s = paris([{ kind: 'nap', start: '00:00', end: '00:00', repeat: { pattern: 'monthly', interval: 12, day: 25 }, from: '2026-12-01' }]);
  assert.deepEqual(nextEvents(s, t('2027-01-15T12:00:00+01:00')), [
    { at: '2027-12-24T23:00:00.000Z', kind: 'nap-start', window: 0 },
    { at: '2027-12-25T23:00:00.000Z', kind: 'nap-end', window: 0 },
  ]);
});

test('the horizon is 400 days with a repeat or a from, 8 days otherwise, and a given horizon wins', () => {
  const after = t('2027-01-01T00:00:00Z');
  const firstAt = (s, options) => nextEvents(s, after, options)[0]?.at;
  assert.equal(firstAt(utc([awake({ repeat: { pattern: 'monthly', interval: 12, day: 31 }, from: '2027-12-01' })])), '2027-12-31T08:00:00.000Z');
  assert.equal(firstAt(utc([awake({ days: ['mon'], from: '2027-12-01' })])), '2027-12-06T08:00:00.000Z');
  assert.equal(firstAt(utc([awake({ days: ['mon'], from: '2028-03-01' })])), undefined, 'over 400 days');
  assert.equal(firstAt(utc([awake({ days: ['mon'], until: '2027-12-01' })])), '2027-01-04T08:00:00.000Z');
  assert.equal(firstAt(utc([awake({ days: ['mon'], start: '08:00' })]), { horizonDays: 2 }), undefined);
  assert.equal(firstAt(utc([awake({ repeat: { pattern: 'monthly', day: 15 } })]), { horizonDays: 8 }), undefined);
  assert.equal(firstAt(utc([awake({ repeat: { pattern: 'monthly', day: 15 } })]), { horizonDays: 20 }), '2027-01-15T08:00:00.000Z');
  assert.equal(firstAt(utc([awake({ repeat: { pattern: 'monthly', day: 15 } }), awake({ days: ['sat'] })])), '2027-01-02T08:00:00.000Z', 'one such window is enough');
  assert.equal(nextEvents(utc([awake({ days: ['mon'] }), awake({ repeat: { pattern: 'daily' } })]), after, { count: 1000 }).at(-1).at, '2028-02-04T12:00:00.000Z', 'every event of the 400 days');
});

test('stopping early gives what the whole horizon would give', () => {
  const after = t('2027-01-04T07:00:00Z');
  for (const windows of [
    [cron('*/5 * * * *'), { kind: 'nap', start: '23:00', end: '02:00', repeat: { pattern: 'monthly', day: 20 }, wake: 'header' }],
    [{ kind: 'awake', start: '22:00', end: '00:00', repeat: { pattern: 'daily' } }, { kind: 'awake', start: '00:00', end: '02:00', repeat: { pattern: 'daily' } }],
    [cron('0 8 * * MON', 10080), cron('0 9 * * WED', 300), { kind: 'nap', start: '18:00', end: '19:00', days: ['sat'], until: '2027-01-30' }],
    [cron('0 23 4 1 *', 120), cron('0 0 5 1 *', 120)],
  ]) {
    const whole = nextEvents(utc(windows), after, { count: 100_000 });
    for (const count of [1, 2, 3, 4, 5, 7, 10, 50, 500]) {
      assert.deepEqual(nextEvents(utc(windows), after, { count }), whole.slice(0, count), `${count} of ${JSON.stringify(windows)}`);
    }
  }
});

test('stopping early never takes an end the next day\'s occurrence holds', () => {
  // The first's end is at midnight, the second starts there: no end there, whatever the count.
  const s = utc([{ kind: 'awake', start: '22:00', end: '00:00', repeat: { pattern: 'daily' } }, { kind: 'awake', start: '00:00', end: '02:00', repeat: { pattern: 'daily' } }]);
  assert.deepEqual(nextEvents(s, t('2027-01-04T21:00:00Z'), { count: 2 }), [
    { at: '2027-01-04T22:00:00.000Z', kind: 'awake-start', window: 0 },
    { at: '2027-01-05T00:00:00.000Z', kind: 'awake-start', window: 1 },
  ]);
});

// --- Time limits (section 4) ----------------------------------------------------------------------------------------

const within = (limit, run, name) => {
  const begin = performance.now();
  const result = run();
  const spent = performance.now() - begin;
  assert.ok(spent < limit, `${name}: ${spent} ms, the limit is ${limit} ms`);
  return result;
};
const ALL_DAY = t('2027-01-06T12:02:00Z');

test('a */5 window: occurrenceAt and nextEvents stay fast', () => {
  const s = paris([cron('*/5 * * * *')]);
  const found = within(100, () => {
    let o;
    for (let i = 0; i < 10; i++) o = occurrenceAt(s, ALL_DAY);
    return o;
  }, '10 occurrenceAt');
  assert.equal(found.id, '0@2027-01-06T12:00:00.000Z');
  const events = within(50, () => nextEvents(s, ALL_DAY), 'nextEvents');
  assert.equal(events.length, 5);
});

test('a */5 window of 7 days: occurrenceAt and nextEvents stay fast', () => {
  const s = paris([cron('*/5 * * * *', 10080)]);
  assert.equal(within(100, () => occurrenceAt(s, ALL_DAY), 'occurrenceAt').id, '0@2027-01-06T12:00:00.000Z');
  assert.equal(within(100, () => nextEvents(s, ALL_DAY), 'nextEvents').length, 5);
});

test('20 */5 windows of 7 days, the worst schedule: still within a check\'s means', () => {
  const s = paris(Array.from({ length: 20 }, () => cron('*/5 * * * *', 10080)));
  assert.deepEqual(problems(s), []);
  assert.equal(within(500, () => occurrenceAt(s, ALL_DAY), 'occurrenceAt').kind, 'awake');
  assert.equal(within(500, () => nextEvents(s, ALL_DAY), 'nextEvents').length, 5);
  assert.equal(within(500, () => awakeStartWithin(s, ALL_DAY, 30 * 60_000), 'awakeStartWithin'), true);
});

test('a yearly window: nextEvents reads 400 days quickly', () => {
  const s = paris([cron('*/5 * 25 12 *', 5), { kind: 'awake', start: '08:00', end: '09:00', repeat: { pattern: 'monthly', interval: 12, day: 24 }, from: '2026-12-01' }]);
  assert.equal(within(100, () => nextEvents(s, t('2027-01-15T12:00:00Z')), 'nextEvents').length, 5);
});

test('the overlap check stays fast: 20 windows of */5 crons that never meet, over 400 days', () => {
  const hours = (kind, i) => cron(`*/5 ${kind === 'awake' ? '0-11' : '12-23'} * * *`, 5, kind, { from: `2026-11-${String(i + 1).padStart(2, '0')}` });
  const s = utc(Array.from({ length: 20 }, (_, i) => hours(i % 2 ? 'nap' : 'awake', i)));
  // Touching at noon and at midnight, overlapping nowhere.
  assert.deepEqual(within(1000, () => problems(s), 'scheduleProblems'), []);
});

test('a weekly schedule stays cheap: 1000 reads of the design\'s example', () => {
  const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];
  const s = paris([
    { kind: 'awake', days: WEEKDAYS, start: '08:30', end: '19:00' },
    { kind: 'nap', days: WEEKDAYS, start: '20:00', end: '07:00', wake: 'header' },
    { kind: 'nap', days: ['sat'], start: '00:00', end: '00:00', wake: 'never' },
  ], { exceptions: ['2026-12-25', '2027-01-01'], maxNapDays: 7 });
  within(1000, () => {
    for (let i = 0; i < 1000; i++) occurrenceAt(s, t('2027-01-05T23:00:00Z') + i * 300_000);
  }, '1000 occurrenceAt');
});

// --- A stored schedule of before keeps its meaning ----------------------------------------------------------------

test('old schedules: a window with no new field reads as it did, nulls included', () => {
  const plain = { kind: 'nap', days: ['fri'], start: '20:00', end: '07:00', wake: 'header' };
  const s = paris([plain]);
  const friday = t('2026-10-23T23:00:00+02:00');
  assert.deepEqual(shown(occurrenceAt(s, friday)), {
    kind: 'nap', window: 0, id: '0@2026-10-23T18:00:00.000Z', start: '2026-10-23T18:00:00.000Z', end: '2026-10-24T05:00:00.000Z', wake: 'header',
  });
  assert.deepEqual(occurrenceAt(paris([{ ...plain, from: null, until: null, repeat: null }]), friday), occurrenceAt(s, friday));
  assert.equal(nextEvents(s, friday, { count: 50 }).length, 3, 'still 8 days');
});

test('a stored window the router cannot read has no occurrence, rather than an error', () => {
  const stored = [
    { kind: 'awake', repeat: { pattern: 'cron', cron: 'not cron', minutes: 60 } },
    { kind: 'awake', start: '08:00', end: '09:00', repeat: { pattern: 'hourly' } },
  ];
  for (const window of stored) {
    assert.equal(occurrenceAt(utc([window]), NOW), null);
    assert.deepEqual(nextEvents(utc([window]), NOW), []);
  }
});
