import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  awakeStartWithin, localTime, maintenanceDue, nextEvents, normalizeSchedule, occurrenceAt, scheduleProblems,
} from '../src/lib/schedule.mjs';

const MINUTE = 60_000;
const DAY = 86_400_000;
const t = (text) => Date.parse(text);
const iso = (ms) => new Date(ms).toISOString();
const shown = (o) => o && { ...o, start: iso(o.start), end: iso(o.end) };

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];
const awake = (days, start, end) => ({ kind: 'awake', days, start, end });
const nap = (days, start, end, wake) => ({ kind: 'nap', days, start, end, ...(wake ? { wake } : {}) });
const paris = (windows, more = {}) => ({ timeZone: 'Europe/Paris', windows, ...more });
const newYork = (windows) => ({ timeZone: 'America/New_York', windows });
const lordHowe = (windows) => ({ timeZone: 'Australia/Lord_Howe', windows });
const sydney = (windows) => ({ timeZone: 'Australia/Sydney', windows });

// The design's example (section 3).
const EXAMPLE = paris([
  awake(WEEKDAYS, '08:30', '19:00'), nap(WEEKDAYS, '20:00', '07:00', 'header'), nap(['sat'], '00:00', '00:00', 'never'),
], { exceptions: ['2026-12-25', '2027-01-01'], maxNapDays: 7 });

test('valid schedules have no problems', () => {
  for (const s of [
    EXAMPLE,
    { maxNapDays: 7 },
    { timeZone: 'UTC', maxNapDays: 60 },
    { timeZone: 'Etc/GMT+1', maxNapDays: 7 },
    { maxNapDays: 7, by: 'alice@example.com', at: 1792915200000 },
    { timeZone: 'Europe/Paris', windows: [], maxNapDays: 1 },
    paris([awake(['mon'], '08:00', '19:00'), nap(['mon'], '19:00', '08:00')]),
    paris([awake(['mon'], '08:00', '12:00'), awake(['mon'], '10:00', '18:00')]),
    paris([nap(['sun'], '00:00', '00:00'), awake(['mon'], '00:00', '08:00')]),
    paris([awake(['sat'], '10:00', '11:00'), nap(['fri'], '20:00', '00:00')]),
    paris(Array.from({ length: 20 }, () => awake(['mon'], '08:00', '09:00')), { exceptions: Array(100).fill('2026-12-25') }),
  ]) assert.deepEqual(scheduleProblems(s), [], JSON.stringify(s));
});

const DAYS_PROBLEM = 'windows[0].days: one or more of mon, tue, wed, thu, fri, sat, sun, each once';
const START_PROBLEM = 'windows[0].start: HH:MM, minutes a multiple of 5';
const PROBLEMS = [
  ['not an object', null, 'schedule: an object'],
  ['a list', [], 'schedule: an object'],
  ['nothing to apply', { timeZone: 'Europe/Paris', windows: [], exceptions: ['2026-12-25'] }, 'schedule: windows or maxNapDays required'],
  ['an unknown time zone', { timeZone: 'Mars/Olympus', maxNapDays: 7 }, 'timeZone: an IANA time zone name, such as Europe/Paris'],
  ['a time zone not a string', { timeZone: 1, maxNapDays: 7 }, 'timeZone: an IANA time zone name, such as Europe/Paris'],
  ['an offset, not a zone name', { timeZone: '+01:00', maxNapDays: 7 }, 'timeZone: an IANA time zone name, such as Europe/Paris'],
  ['a negative offset', { timeZone: '-05:30', maxNapDays: 7 }, 'timeZone: an IANA time zone name, such as Europe/Paris'],
  ['an offset with a minus sign', { timeZone: '−05:00', maxNapDays: 7 }, 'timeZone: an IANA time zone name, such as Europe/Paris'],
  ['an unknown field', { maxNapDays: 7, foo: 1 }, 'foo: unknown field'],
  ['a parsed __proto__ key', JSON.parse('{"maxNapDays": 7, "__proto__": {"x": 1}}'), '__proto__: unknown field'],
  ['an unknown window field', paris([{ ...nap(['mon'], '20:00', '07:00'), wakeup: 'never' }]), 'windows[0].wakeup: unknown field'],
  ['a parsed constructor key in a window', paris([JSON.parse('{"kind": "awake", "days": ["mon"], "start": "08:00", "end": "09:00", "constructor": 1}')]),
    'windows[0].constructor: unknown field'],
  ['windows without a time zone', { windows: [awake(['mon'], '08:00', '19:00')] }, 'timeZone: required with windows'],
  ['windows not a list', paris({}), 'windows: a list'],
  ['21 windows', paris(Array.from({ length: 21 }, () => awake(['mon'], '08:00', '09:00'))), 'windows: at most 20'],
  ['a window not an object', paris(['mon 08:00']), 'windows[0]: an object with kind, days, start and end'],
  ['an unknown kind', paris([{ ...awake(['mon'], '08:00', '09:00'), kind: 'idle' }]), 'windows[0].kind: awake or nap'],
  ['no days', paris([awake([], '08:00', '09:00')]), DAYS_PROBLEM],
  ['days not a list', paris([awake('mon', '08:00', '09:00')]), DAYS_PROBLEM],
  ['a day in another case', paris([awake(['Mon'], '08:00', '09:00')]), DAYS_PROBLEM],
  ['a day twice', paris([awake(['mon', 'mon'], '08:00', '09:00')]), DAYS_PROBLEM],
  ['a start without its leading zero', paris([awake(['mon'], '8:00', '09:00')]), START_PROBLEM],
  ['a start at 24:00', paris([awake(['mon'], '24:00', '09:00')]), START_PROBLEM],
  ['a start not on 5 minutes', paris([awake(['mon'], '08:03', '09:00')]), START_PROBLEM],
  ['an end missing', paris([{ kind: 'awake', days: ['mon'], start: '08:00' }]), 'windows[0].end: HH:MM, minutes a multiple of 5'],
  ['an end not on 5 minutes', paris([awake(['mon'], '08:00', '18:59')]), 'windows[0].end: HH:MM, minutes a multiple of 5'],
  ['wake on an awake window', paris([{ ...awake(['mon'], '08:00', '09:00'), wake: 'never' }]), 'windows[0].wake: nap windows only'],
  ['an unknown wake', paris([nap(['mon'], '20:00', '07:00', 'always')]), 'windows[0].wake: never or header'],
  ['awake and nap on the same day', paris([awake(['mon'], '08:00', '19:00'), nap(['mon'], '18:00', '20:00')]),
    'windows[1]: the nap window overlaps the awake window windows[0] (mon 18:00–19:00)'],
  ['a night that spills into the next day', paris([awake(['sat'], '10:00', '12:00'), nap(['fri'], '22:00', '11:00')]),
    'windows[1]: the nap window overlaps the awake window windows[0] (sat 10:00–11:00)'],
  ['Sunday night into Monday', paris([nap(['sun'], '22:00', '08:00'), awake(['mon'], '07:00', '09:00')]),
    'windows[1]: the awake window overlaps the nap window windows[0] (mon 07:00–08:00)'],
  ['a 24-hour window', paris([nap(['sat'], '00:00', '00:00'), awake(['sat'], '10:00', '11:00')]),
    'windows[1]: the awake window overlaps the nap window windows[0] (sat 10:00–11:00)'],
  ['an overlap across midnight', paris([awake(['sun'], '20:00', '02:00'), nap(['sun'], '23:00', '01:00')]),
    'windows[1]: the nap window overlaps the awake window windows[0] (sun 23:00–mon 01:00)'],
  ['exceptions not a list', { maxNapDays: 7, exceptions: '2026-12-25' }, 'exceptions: a list'],
  ['101 exceptions', { maxNapDays: 7, exceptions: Array(101).fill('2026-12-25') }, 'exceptions: at most 100'],
  ['an exception not a date', { maxNapDays: 7, exceptions: ['2026-12-1'] }, 'exceptions[0]: a date YYYY-MM-DD'],
  ['an exception not in the calendar', { maxNapDays: 7, exceptions: ['2026-12-25', '2027-02-30'] }, 'exceptions[1]: a date YYYY-MM-DD'],
  ['maxNapDays 0', { maxNapDays: 0 }, 'maxNapDays: a whole number from 1 to 60'],
  ['maxNapDays 61', { maxNapDays: 61 }, 'maxNapDays: a whole number from 1 to 60'],
  ['maxNapDays not whole', { maxNapDays: 1.5 }, 'maxNapDays: a whole number from 1 to 60'],
  ['maxNapDays a string', { maxNapDays: '7' }, 'maxNapDays: a whole number from 1 to 60'],
];
for (const [name, s, problem] of PROBLEMS) {
  test(`refused: ${name}`, () => assert.deepEqual(scheduleProblems(s), [problem]));
}

test('every problem is reported, each naming its field', () => {
  const windows = [awake(['mon'], '8', '9'), { kind: 'nap', days: [], start: '20:00', end: '07:00', wake: 'x', note: 'y' }];
  assert.deepEqual(scheduleProblems(paris(windows, { maxNapDays: 0, extra: true })), [
    'windows[0].start: HH:MM, minutes a multiple of 5',
    'windows[0].end: HH:MM, minutes a multiple of 5',
    'windows[1].days: one or more of mon, tue, wed, thu, fri, sat, sun, each once',
    'windows[1].wake: never or header',
    'windows[1].note: unknown field',
    'maxNapDays: a whole number from 1 to 60',
    'extra: unknown field',
  ]);
});

test('an unknown field does not hide an overlap', () => {
  assert.deepEqual(scheduleProblems(paris([awake(['mon'], '08:00', '19:00'), { ...nap(['mon'], '18:00', '20:00'), note: 'x' }])), [
    'windows[1].note: unknown field',
    'windows[1]: the nap window overlaps the awake window windows[0] (mon 18:00–19:00)',
  ]);
});

test('a normalized schedule keeps only its fields: no by or at, no null field, each exception date once', () => {
  const stored = {
    timeZone: 'europe/paris', windows: [{ ...nap(['mon'], '20:00', '07:00'), wake: null }, awake(['tue'], '08:00', '19:00')],
    exceptions: ['2026-12-25', '2026-12-25', '2027-01-01'], maxNapDays: null, by: 'alice@example.com', at: 1792915200000,
  };
  assert.deepEqual(normalizeSchedule(stored), {
    timeZone: 'Europe/Paris', windows: [nap(['mon'], '20:00', '07:00'), awake(['tue'], '08:00', '19:00')], exceptions: ['2026-12-25', '2027-01-01'],
  });
  assert.deepEqual(normalizeSchedule(JSON.parse('{"maxNapDays": 7, "__proto__": {"x": 1}}')), { windows: [], maxNapDays: 7 });
});

test('a time zone Intl accepts in another case is valid and stored in its canonical form', () => {
  const s = paris([awake(['mon'], '08:00', '19:00')], { timeZone: 'europe/paris', maxNapDays: 7 });
  assert.deepEqual(scheduleProblems(s), []);
  assert.deepEqual(normalizeSchedule(s), { ...s, timeZone: 'Europe/Paris' });
  assert.equal(s.timeZone, 'europe/paris');
  assert.deepEqual(normalizeSchedule({ maxNapDays: 7 }), { windows: [], maxNapDays: 7 });
  assert.equal(occurrenceAt(s, t('2026-10-19T10:00:00+02:00')).start, t('2026-10-19T08:00:00+02:00'));
});

const OVERNIGHT = paris([nap(WEEKDAYS, '20:00', '07:00', 'header')]);
const SATURDAY = paris([nap(['sat'], '00:00', '00:00')]);
const HOLIDAY = paris([awake(WEEKDAYS, '08:30', '19:00'), nap(WEEKDAYS, '20:00', '07:00')], { exceptions: ['2026-12-25'] });
const LAYERED = paris([nap(WEEKDAYS, '20:00', '07:00', 'header'), nap(['sat'], '00:00', '00:00', 'never')]);
const MONDAY_NIGHT = { kind: 'nap', window: 0, id: '0@2026-10-19T18:00:00.000Z', start: '2026-10-19T18:00:00.000Z', end: '2026-10-20T05:00:00.000Z', wake: 'header' };
const WHOLE_SATURDAY = { kind: 'nap', window: 0, id: '0@2026-10-23T22:00:00.000Z', start: '2026-10-23T22:00:00.000Z', end: '2026-10-24T22:00:00.000Z', wake: 'never' };
const awakeAt = (window, start, end) => ({ kind: 'awake', window, id: `${window}@${start}`, start, end });
const napAt = (window, start, end, wake = 'never') => ({ kind: 'nap', window, id: `${window}@${start}`, start, end, wake });
const OCCURRENCES = [
  ['no windows', { maxNapDays: 7 }, '2026-10-19T23:00:00+02:00', null],
  ['no schedule', null, '2026-10-19T23:00:00+02:00', null],
  ['an overnight window at 23:00', OVERNIGHT, '2026-10-19T23:00:00+02:00', MONDAY_NIGHT],
  ['an overnight window at 06:00 the next day', OVERNIGHT, '2026-10-20T06:00:00+02:00', MONDAY_NIGHT],
  ['an overnight window not at 07:30', OVERNIGHT, '2026-10-20T07:30:00+02:00', null],
  ['an overnight window, at its first minute', OVERNIGHT, '2026-10-19T20:00:00+02:00', MONDAY_NIGHT],
  ['an overnight window, not at its end', OVERNIGHT, '2026-10-20T07:00:00+02:00', null],
  ['Friday night ends Saturday morning', OVERNIGHT, '2026-10-24T06:00:00+02:00', napAt(0, '2026-10-23T18:00:00.000Z', '2026-10-24T05:00:00.000Z', 'header')],
  ['no Saturday night: a window starts on its days', OVERNIGHT, '2026-10-25T06:00:00+01:00', null],
  ['Saturday 00:00–00:00 at 00:00', SATURDAY, '2026-10-24T00:00:00+02:00', WHOLE_SATURDAY],
  ['Saturday 00:00–00:00 at 23:55', SATURDAY, '2026-10-24T23:55:00+02:00', WHOLE_SATURDAY],
  ['Saturday 00:00–00:00 not on Sunday 00:00', SATURDAY, '2026-10-25T00:00:00+02:00', null],
  ['Saturday 00:00–00:00 not on Friday 23:55', SATURDAY, '2026-10-23T23:55:00+02:00', null],
  ['an exception date: no window that day', HOLIDAY, '2026-12-25T10:00:00+01:00', null],
  ['the day before an exception applies', HOLIDAY, '2026-12-24T10:00:00+01:00', awakeAt(0, '2026-12-24T07:30:00.000Z', '2026-12-24T18:00:00.000Z')],
  ['the working day after an exception applies', HOLIDAY, '2026-12-28T10:00:00+01:00', awakeAt(0, '2026-12-28T07:30:00.000Z', '2026-12-28T18:00:00.000Z')],
  ['a night that starts the day before an exception still applies', HOLIDAY, '2026-12-25T06:00:00+01:00', napAt(1, '2026-12-24T19:00:00.000Z', '2026-12-25T06:00:00.000Z')],
  ['a night that starts on an exception date does not', HOLIDAY, '2026-12-25T23:00:00+01:00', null],
  ['Paris 2027-03-28: a 02:30 start (skipped) applies at 03:00 CEST', paris([nap(['sun'], '02:30', '06:00')]), '2027-03-28T03:00:00+02:00',
    napAt(0, '2027-03-28T01:00:00.000Z', '2027-03-28T04:00:00.000Z')],
  ['Paris 2027-03-28: not at 01:59 CET', paris([nap(['sun'], '02:30', '06:00')]), '2027-03-28T01:59:00+01:00', null],
  ['Paris 2027-03-28: a window inside the skipped hour is empty', paris([awake(['sun'], '02:00', '02:30')]), '2027-03-28T03:00:00+02:00', null],
  ['Paris 2027-03-28: a 24-hour window from Saturday lasts 23 hours', paris([awake(['sat'], '12:00', '12:00')]), '2027-03-28T11:55:00+02:00',
    awakeAt(0, '2027-03-27T11:00:00.000Z', '2027-03-28T10:00:00.000Z')],
  ['Paris 2026-10-25: a 02:30 start (twice) applies at its first instance', paris([awake(['sun'], '02:30', '04:00')]), '2026-10-25T02:30:00+02:00',
    awakeAt(0, '2026-10-25T00:30:00.000Z', '2026-10-25T03:00:00.000Z')],
  ['Paris 2026-10-25: still active at the second 02:30', paris([awake(['sun'], '02:30', '04:00')]), '2026-10-25T02:30:00+01:00',
    awakeAt(0, '2026-10-25T00:30:00.000Z', '2026-10-25T03:00:00.000Z')],
  ['Paris 2026-10-25: not before the first 02:30', paris([awake(['sun'], '02:30', '04:00')]), '2026-10-25T02:25:00+02:00', null],
  ['Paris 2026-10-25: a 24-hour window from Saturday lasts 25 hours', paris([awake(['sat'], '12:00', '12:00')]), '2026-10-25T11:55:00+01:00',
    awakeAt(0, '2026-10-24T10:00:00.000Z', '2026-10-25T11:00:00.000Z')],
  ['New York 2027-03-14: a 02:30 start (skipped) applies at 03:00 EDT', newYork([awake(['sun'], '02:30', '09:00')]), '2027-03-14T03:00:00-04:00',
    awakeAt(0, '2027-03-14T07:00:00.000Z', '2027-03-14T13:00:00.000Z')],
  ['New York 2027-03-14: not at 01:59 EST', newYork([awake(['sun'], '02:30', '09:00')]), '2027-03-14T01:59:00-05:00', null],
  ['New York 2027-03-14: an end in the skipped hour is 03:00 EDT', newYork([nap(['sat'], '22:00', '02:30')]), '2027-03-14T01:59:00-05:00',
    napAt(0, '2027-03-14T03:00:00.000Z', '2027-03-14T07:00:00.000Z')],
  ['New York 2026-11-01: a 01:30 start (twice) applies at its first instance (EDT)', newYork([awake(['sun'], '01:30', '03:00')]), '2026-11-01T01:30:00-05:00',
    awakeAt(0, '2026-11-01T05:30:00.000Z', '2026-11-01T08:00:00.000Z')],
  ['same-kind windows: Friday 22:00 is the night, until the union ends', LAYERED, '2026-10-23T22:00:00+02:00',
    napAt(0, '2026-10-23T18:00:00.000Z', '2026-10-24T22:00:00.000Z', 'header')],
  ['same-kind windows: Saturday 03:00 is the window that started last, and never wins', LAYERED, '2026-10-24T03:00:00+02:00',
    napAt(1, '2026-10-23T22:00:00.000Z', '2026-10-24T22:00:00.000Z', 'never')],
  ['same-kind windows touching the same day: the union ends with the later one', paris([awake(['mon'], '08:00', '12:00'), awake(['mon'], '12:00', '18:00')]),
    '2026-10-19T10:00:00+02:00', awakeAt(0, '2026-10-19T06:00:00.000Z', '2026-10-19T16:00:00.000Z')],
  ['Lord Howe 2026-10-04: a 02:15 start (skipped half hour) applies at 02:30', lordHowe([awake(['sun'], '02:15', '04:00')]), '2026-10-04T02:30:00+11:00',
    awakeAt(0, '2026-10-03T15:30:00.000Z', '2026-10-03T17:00:00.000Z')],
  ['Lord Howe 2026-10-04: not at 01:59', lordHowe([awake(['sun'], '02:15', '04:00')]), '2026-10-04T01:59:00+10:30', null],
  ['Lord Howe 2027-04-04: a 01:45 start (repeated half hour) applies at its first instance', lordHowe([awake(['sun'], '01:45', '03:00')]),
    '2027-04-04T01:45:00+11:00', awakeAt(0, '2027-04-03T14:45:00.000Z', '2027-04-03T16:30:00.000Z')],
  ['Lord Howe 2027-04-04: still active at the second 01:45', lordHowe([awake(['sun'], '01:45', '03:00')]), '2027-04-04T01:45:00+10:30',
    awakeAt(0, '2027-04-03T14:45:00.000Z', '2027-04-03T16:30:00.000Z')],
  ['Sydney 2027-04-04: a Saturday night across the April change, at the first 02:30', sydney([nap(['sat'], '22:00', '07:00')]), '2027-04-04T02:30:00+11:00',
    napAt(0, '2027-04-03T11:00:00.000Z', '2027-04-03T21:00:00.000Z')],
  ['Sydney 2027-04-04: the same night at 06:55 AEST', sydney([nap(['sat'], '22:00', '07:00')]), '2027-04-04T06:55:00+10:00',
    napAt(0, '2027-04-03T11:00:00.000Z', '2027-04-03T21:00:00.000Z')],
  ['Sydney 2027-04-04: not at 07:00 AEST', sydney([nap(['sat'], '22:00', '07:00')]), '2027-04-04T07:00:00+10:00', null],
  ['a Sunday night read on Monday morning', paris([nap(['sun'], '22:00', '07:00')]), '2026-10-26T06:00:00+01:00',
    napAt(0, '2026-10-25T21:00:00.000Z', '2026-10-26T06:00:00.000Z')],
  ['a Sunday night read on Monday morning, Monday an exception', paris([nap(['sun'], '22:00', '07:00')], { exceptions: ['2026-10-26'] }), '2026-10-26T06:00:00+01:00',
    napAt(0, '2026-10-25T21:00:00.000Z', '2026-10-26T06:00:00.000Z')],
  ['a Sunday night read on Monday morning, Sunday an exception', paris([nap(['sun'], '22:00', '07:00')], { exceptions: ['2026-10-25'] }), '2026-10-26T06:00:00+01:00', null],
];
for (const [name, s, at, expected] of OCCURRENCES) {
  test(`occurrence: ${name}`, () => assert.deepEqual(shown(occurrenceAt(s, t(at))), expected));
}

test('next events cross the week boundary, in order, at most 5', () => {
  const s = paris([awake(WEEKDAYS, '08:30', '19:00'), nap(['sun'], '20:00', '07:00')]);
  assert.deepEqual(nextEvents(s, t('2026-10-25T22:00:00+01:00')), [
    { at: '2026-10-26T06:00:00.000Z', kind: 'nap-end', window: 1 },
    { at: '2026-10-26T07:30:00.000Z', kind: 'awake-start', window: 0 },
    { at: '2026-10-26T18:00:00.000Z', kind: 'awake-end', window: 0 },
    { at: '2026-10-27T07:30:00.000Z', kind: 'awake-start', window: 0 },
    { at: '2026-10-27T18:00:00.000Z', kind: 'awake-end', window: 0 },
  ]);
});

test('next events stay within 8 days (the second Monday is after the clocks change)', () => {
  const s = paris([awake(['mon'], '13:00', '14:00')]);
  const monday = t('2026-10-19T12:00:00+02:00');
  const events = [
    { at: '2026-10-19T11:00:00.000Z', kind: 'awake-start', window: 0 },
    { at: '2026-10-19T12:00:00.000Z', kind: 'awake-end', window: 0 },
    { at: '2026-10-26T12:00:00.000Z', kind: 'awake-start', window: 0 },
    { at: '2026-10-26T13:00:00.000Z', kind: 'awake-end', window: 0 },
  ];
  assert.deepEqual(nextEvents(s, monday), events);
  assert.deepEqual(nextEvents(s, monday, { horizonDays: 1 }), events.slice(0, 2));
  assert.deepEqual(nextEvents(s, monday, { count: 1 }), events.slice(0, 1));
  assert.deepEqual(nextEvents(s, t('2026-10-19T13:00:00+02:00')), events.slice(1), 'an event at t is not next');
});

test('next events: an end comes before a start at the same instant; exceptions remove both', () => {
  const s = paris([nap(['mon'], '19:00', '08:00'), awake(['mon'], '08:00', '19:00')], { exceptions: ['2026-10-26'] });
  assert.deepEqual(nextEvents(s, t('2026-10-19T18:00:00+02:00')), [
    { at: '2026-10-19T17:00:00.000Z', kind: 'awake-end', window: 1 },
    { at: '2026-10-19T17:00:00.000Z', kind: 'nap-start', window: 0 },
    { at: '2026-10-20T06:00:00.000Z', kind: 'nap-end', window: 0 },
  ]);
  assert.deepEqual(nextEvents({ maxNapDays: 7 }, t('2026-10-19T18:00:00+02:00')), []);
  assert.deepEqual(nextEvents(null, t('2026-10-19T18:00:00+02:00')), []);
});

test('next events follow the union of same-kind windows: the design\'s weekday night runs into the whole Saturday', () => {
  const events = nextEvents(EXAMPLE, t('2026-10-23T19:30:00+02:00'));
  assert.deepEqual(events, [
    { at: '2026-10-23T18:00:00.000Z', kind: 'nap-start', window: 1 },
    { at: '2026-10-23T22:00:00.000Z', kind: 'nap-start', window: 2 },
    { at: '2026-10-24T22:00:00.000Z', kind: 'nap-end', window: 2 },
    { at: '2026-10-26T07:30:00.000Z', kind: 'awake-start', window: 0 },
    { at: '2026-10-26T18:00:00.000Z', kind: 'awake-end', window: 0 },
  ]);
  // The nap ends when the occurrence active on Friday night says it does (the waiter page's napUntil).
  assert.equal(iso(occurrenceAt(EXAMPLE, t('2026-10-23T21:00:00+02:00')).end), events[2].at);
});

const UNIONS = [
  ['overlapping: the earlier end, inside the later window, is dropped', paris([awake(['mon'], '08:00', '12:00'), awake(['mon'], '10:00', '18:00')]), [
    { at: '2026-10-19T06:00:00.000Z', kind: 'awake-start', window: 0 },
    { at: '2026-10-19T08:00:00.000Z', kind: 'awake-start', window: 1 },
    { at: '2026-10-19T16:00:00.000Z', kind: 'awake-end', window: 1 },
  ]],
  ['contained: the inner end is dropped', paris([awake(['mon'], '08:00', '18:00'), awake(['mon'], '10:00', '12:00')]), [
    { at: '2026-10-19T06:00:00.000Z', kind: 'awake-start', window: 0 },
    { at: '2026-10-19T08:00:00.000Z', kind: 'awake-start', window: 1 },
    { at: '2026-10-19T16:00:00.000Z', kind: 'awake-end', window: 0 },
  ]],
  ['identical: one start and one end, from the lowest window', paris([awake(['mon'], '08:00', '09:00'), awake(['mon'], '08:00', '09:00'), awake(['mon'], '08:00', '09:00')]), [
    { at: '2026-10-19T06:00:00.000Z', kind: 'awake-start', window: 0 },
    { at: '2026-10-19T07:00:00.000Z', kind: 'awake-end', window: 0 },
  ]],
  ['touching: the end where the next one starts is dropped, that start is kept', paris([awake(['mon'], '08:00', '12:00'), awake(['mon'], '12:00', '18:00')]), [
    { at: '2026-10-19T06:00:00.000Z', kind: 'awake-start', window: 0 },
    { at: '2026-10-19T10:00:00.000Z', kind: 'awake-start', window: 1 },
    { at: '2026-10-19T16:00:00.000Z', kind: 'awake-end', window: 1 },
  ]],
  ['touching across midnight', paris([nap(['mon'], '20:00', '00:00'), nap(['tue'], '00:00', '07:00')]), [
    { at: '2026-10-19T18:00:00.000Z', kind: 'nap-start', window: 0 },
    { at: '2026-10-19T22:00:00.000Z', kind: 'nap-start', window: 1 },
    { at: '2026-10-20T05:00:00.000Z', kind: 'nap-end', window: 1 },
  ]],
  ['a window on an exception date does not extend the union', paris([nap(['mon'], '20:00', '07:00'), nap(['tue'], '00:00', '00:00')], { exceptions: ['2026-10-20'] }), [
    { at: '2026-10-19T18:00:00.000Z', kind: 'nap-start', window: 0 },
    { at: '2026-10-20T05:00:00.000Z', kind: 'nap-end', window: 0 },
  ]],
];
for (const [name, s, expected] of UNIONS) {
  test(`next events, same-kind windows ${name}`, () => assert.deepEqual(nextEvents(s, t('2026-10-19T07:00:00+02:00'), { horizonDays: 2 }), expected));
}

test('next events: 20 windows on every day over 8 days stay fast', () => {
  const hour = (i) => String(i).padStart(2, '0');
  const s = paris(Array.from({ length: 20 }, (_, i) => awake(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], `${hour(i)}:05`, `${hour(i)}:55`)));
  const begin = performance.now();
  const events = nextEvents(s, t('2026-11-02T00:00:00+01:00'), { count: 1000 });
  assert.equal(events.length, 20 * 8 * 2);
  assert.ok(performance.now() - begin < 1000, `${performance.now() - begin} ms`);
});

test('an awake window starts within 30 minutes: at 29 and 30 minutes, not at 31', () => {
  const s = paris([awake(WEEKDAYS, '08:30', '19:00'), nap(['sat'], '08:30', '19:00')], { exceptions: ['2026-10-21'] });
  const tuesday = t('2026-10-20T08:30:00+02:00');
  const within = 30 * MINUTE;
  assert.equal(awakeStartWithin(s, tuesday - 29 * MINUTE, within), true);
  assert.equal(awakeStartWithin(s, tuesday - 30 * MINUTE, within), true);
  assert.equal(awakeStartWithin(s, tuesday - 31 * MINUTE, within), false);
  assert.equal(awakeStartWithin(s, tuesday + MINUTE, within), false, 'already started');
  assert.equal(awakeStartWithin(s, tuesday + DAY - 29 * MINUTE, within), false, 'an exception date');
  assert.equal(awakeStartWithin(s, t('2026-10-24T08:30:00+02:00') - 29 * MINUTE, within), false, 'a nap window');
  assert.equal(awakeStartWithin(paris([awake(['mon'], '00:10', '08:00')]), t('2026-10-25T23:50:00+01:00'), within), true, 'across midnight and the week');
  assert.equal(awakeStartWithin(null, tuesday, within), false);
});

test('maintenance is due maxNapDays (elapsed days) after the workload fell asleep', () => {
  const since = t('2026-10-19T10:00:00Z');
  assert.equal(maintenanceDue(EXAMPLE, since), since + 7 * DAY);
  assert.equal(iso(maintenanceDue({ maxNapDays: 7 }, since)), '2026-10-26T10:00:00.000Z');
  assert.equal(maintenanceDue(paris([awake(['mon'], '08:00', '19:00')]), since), null);
  assert.equal(maintenanceDue(EXAMPLE, null), null);
  assert.equal(maintenanceDue(null, since), null);
});

test('local time is the weekday and HH:MM in the zone', () => {
  assert.equal(localTime(t('2026-10-20T05:00:00Z'), 'Europe/Paris'), 'Tue 07:00');
  assert.equal(localTime(t('2026-10-19T22:00:00Z'), 'Europe/Paris'), 'Tue 00:00');
  assert.equal(localTime(t('2027-03-14T07:00:00Z'), 'America/New_York'), 'Sun 03:00');
  assert.equal(localTime(t('2026-10-25T01:30:00Z'), 'Europe/Paris'), 'Sun 02:30');
});
