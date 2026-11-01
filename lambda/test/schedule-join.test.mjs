// Joined windows (schedule recurrence design, section 11): two occurrences of one kind separated by a short gap count as
// one. The default is 15 minutes, a workload's schedule, a router and an organization can each set it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  awakeStartWithin, isJoinMinutes, JOIN_DEFAULT_MINUTES, localTime, napEndHeader, napEndOf, nextEvents, normalizeSchedule, occurrenceAt, resolveJoin, scheduleProblems,
} from '../src/lib/schedule.mjs';

const t = (text) => Date.parse(text);
const iso = (ms) => new Date(ms).toISOString();
const paris = (windows, more = {}) => ({ timeZone: 'Europe/Paris', windows, ...more });
const utc = (windows, more = {}) => ({ timeZone: 'UTC', windows, ...more });
const awake = (days, start, end, more = {}) => ({ kind: 'awake', days, start, end, ...more });
const nap = (days, start, end, more = {}) => ({ kind: 'nap', days, start, end, ...more });
const cron = (expression, minutes, kind = 'awake') => ({ kind, repeat: { pattern: 'cron', cron: expression, minutes } });
const shown = (o) => o && { ...o, start: iso(o.start), end: iso(o.end) };
const MINUTE = 60_000;

// Monday 2026-10-19 in UTC, so the times read as written.
const MONDAY = (time) => t(`2026-10-19T${time}:00Z`);
const TWO = (gapStart) => utc([awake(['mon'], '08:00', '12:00'), awake(['mon'], gapStart, '18:00')]);

test('a gap of exactly 15 joins by default: the first occurrence reaches the second start', () => {
  const s = TWO('12:15');
  const inGap = occurrenceAt(s, MONDAY('12:05'));
  assert.deepEqual(shown(inGap), {
    kind: 'awake', window: 0, id: '0@2026-10-19T08:00:00.000Z', start: '2026-10-19T08:00:00.000Z', end: '2026-10-19T18:00:00.000Z',
  });
  assert.equal(occurrenceAt(s, MONDAY('12:14')).window, 0);
  assert.equal(occurrenceAt(s, MONDAY('12:15')).id, '1@2026-10-19T12:15:00.000Z', 'the second start is still a new occurrence');
  assert.equal(iso(occurrenceAt(s, MONDAY('10:00')).end), '2026-10-19T18:00:00.000Z', 'the union, from before the gap too');
  assert.equal(occurrenceAt(s, MONDAY('18:00')), null);
});

test('a gap of 20 does not join at 15; it does at 20 and above, given as an option', () => {
  const s = TWO('12:20');
  assert.equal(occurrenceAt(s, MONDAY('12:05')), null);
  assert.equal(iso(occurrenceAt(s, MONDAY('10:00')).end), '2026-10-19T12:00:00.000Z');
  assert.equal(occurrenceAt(s, MONDAY('12:05'), { joinMinutes: 15 }), null);
  assert.equal(occurrenceAt(s, MONDAY('12:05'), { joinMinutes: 20 }).window, 0);
  assert.equal(occurrenceAt(s, MONDAY('12:05'), { joinMinutes: 120 }).window, 0);
});

test('a value of 0 never joins', () => {
  const s = TWO('12:05');
  assert.equal(occurrenceAt(s, MONDAY('12:02'), { joinMinutes: 0 }), null);
  assert.equal(iso(occurrenceAt(s, MONDAY('10:00'), { joinMinutes: 0 }).end), '2026-10-19T12:00:00.000Z');
  assert.equal(nextEvents(s, MONDAY('07:00'), { joinMinutes: 0, horizonDays: 1 }).length, 4);
  assert.equal(occurrenceAt({ ...s, joinMinutes: 0 }, MONDAY('12:02')), null, 'on the schedule');
});

test('the value: the option, else the schedule\'s, else 15; an invalid one counts as unset', () => {
  const s = TWO('12:20');
  assert.equal(JOIN_DEFAULT_MINUTES, 15);
  assert.equal(occurrenceAt({ ...s, joinMinutes: 30 }, MONDAY('12:05')).window, 0);
  assert.equal(occurrenceAt({ ...s, joinMinutes: 30 }, MONDAY('12:05'), { joinMinutes: 0 }), null);
  assert.equal(occurrenceAt({ ...s, joinMinutes: 0 }, MONDAY('12:05'), { joinMinutes: 20 }).window, 0);
  assert.equal(occurrenceAt({ ...s, joinMinutes: 'x' }, MONDAY('12:05')), null);
  assert.equal(occurrenceAt(TWO('12:15'), MONDAY('12:05'), { joinMinutes: 7 }).window, 0, 'an invalid option: 15');
});

test('a gap across midnight joins', () => {
  const s = paris([nap(['mon'], '20:00', '23:55'), nap(['tue'], '00:05', '07:00')]);
  const o = occurrenceAt(s, t('2026-10-19T23:58:00+02:00'));
  assert.equal(o.window, 0);
  assert.equal(iso(o.end), '2026-10-20T05:00:00.000Z');
  assert.equal(occurrenceAt(s, t('2026-10-20T00:02:00+02:00')).window, 0, 'read on the next day: it looks back');
  assert.deepEqual(nextEvents(s, t('2026-10-19T19:00:00+02:00'), { count: 3 }), [
    { at: '2026-10-19T18:00:00.000Z', kind: 'nap-start', window: 0 },
    { at: '2026-10-19T22:05:00.000Z', kind: 'nap-start', window: 1 },
    { at: '2026-10-20T05:00:00.000Z', kind: 'nap-end', window: 1 },
  ]);
});

test('the gap is elapsed time: across the spring change, 70 minutes of wall time are 10', () => {
  const s = paris([awake(['sun'], '00:00', '01:55'), awake(['sun'], '03:05', '05:00')]);
  const o = occurrenceAt(s, t('2027-03-28T01:58:00+01:00'));
  assert.equal(o.window, 0);
  assert.equal(iso(o.end), '2027-03-28T03:00:00.000Z');
  assert.equal(occurrenceAt(s, t('2027-03-28T01:58:00+01:00'), { joinMinutes: 0 }), null);
});

test('the gap is elapsed time: a second start in the skipped hour is the change itself', () => {
  const s = paris([awake(['sun'], '00:00', '01:50'), awake(['sun'], '02:30', '05:00')]);
  assert.equal(occurrenceAt(s, t('2027-03-28T01:55:00+01:00')).window, 0);
  assert.equal(iso(occurrenceAt(s, t('2027-03-28T01:55:00+01:00')).end), '2027-03-28T03:00:00.000Z');
});

test('the gap is elapsed time: across the autumn change, 15 minutes of wall time are 75', () => {
  const s = paris([awake(['sun'], '01:00', '02:50'), awake(['sun'], '03:05', '05:00')]);
  assert.equal(occurrenceAt(s, t('2027-10-31T02:55:00+02:00')), null);
  assert.equal(occurrenceAt(s, t('2027-10-31T02:55:00+02:00'), { joinMinutes: 75 }).window, 0);
  // Within one offset, on either side of the change, 15 is 15.
  const after = paris([awake(['sun'], '03:30', '04:00'), awake(['sun'], '04:15', '05:00')]);
  assert.equal(occurrenceAt(after, t('2027-10-31T04:05:00+01:00')).window, 0);
});

test('not joined: a second start an exception date or a range removes', () => {
  const windows = [nap(['mon'], '20:00', '23:55'), nap(['tue'], '00:05', '07:00')];
  const inGap = t('2026-10-19T23:58:00Z');
  assert.equal(occurrenceAt(utc(windows), inGap).window, 0);
  assert.equal(occurrenceAt(utc(windows, { exceptions: ['2026-10-20'] }), inGap), null);
  assert.equal(iso(occurrenceAt(utc(windows, { exceptions: ['2026-10-20'] }), t('2026-10-19T21:00:00Z')).end), '2026-10-19T23:55:00.000Z');
  assert.equal(occurrenceAt(utc([windows[0], { ...windows[1], from: '2026-10-21' }]), inGap), null);
  assert.equal(occurrenceAt(utc([windows[0], { ...windows[1], until: '2026-10-19' }]), inGap), null);
  // The first occurrence's own date being an exception: nothing to join from.
  assert.equal(occurrenceAt(utc(windows, { exceptions: ['2026-10-19'] }), inGap), null);
});

test('not joined: another kind in the gap, at any point of it, or the other kind as the next start', () => {
  const inGap = MONDAY('12:02');
  const around = (start, end) => utc([awake(['mon'], '08:00', '12:00'), nap(['mon'], start, end), awake(['mon'], '12:15', '18:00')]);
  assert.equal(occurrenceAt(around('12:05', '12:10'), inGap), null, 'inside');
  assert.equal(occurrenceAt(around('12:00', '12:05'), inGap).kind, 'nap', 'from the gap\'s first minute');
  assert.equal(iso(occurrenceAt(around('12:00', '12:05'), MONDAY('10:00')).end), '2026-10-19T12:00:00.000Z');
  assert.equal(occurrenceAt(around('12:10', '12:15'), inGap), null, 'up to its last minute');
  assert.equal(iso(occurrenceAt(around('12:05', '12:10'), MONDAY('10:00')).end), '2026-10-19T12:00:00.000Z');
  // Starting with the second start, it is not in the gap (refused on save, but it can come beyond the 400 days).
  assert.equal(occurrenceAt(around('12:15', '12:30'), inGap).kind, 'awake');
  // Awake then nap is never joined.
  assert.equal(occurrenceAt(utc([awake(['mon'], '08:00', '12:00'), nap(['mon'], '12:05', '13:00')]), inGap), null);
  // A nap that a range or an exception removes holds nothing.
  const gone = utc([awake(['mon'], '08:00', '12:00'), nap(['mon'], '12:05', '12:10', { until: '2026-10-18' }), awake(['mon'], '12:15', '18:00')]);
  assert.equal(occurrenceAt(gone, inGap).kind, 'awake');
});

test('nextEvents reports no end around a joined gap, and the second start stays', () => {
  assert.deepEqual(nextEvents(TWO('12:15'), MONDAY('07:00'), { horizonDays: 1 }), [
    { at: '2026-10-19T08:00:00.000Z', kind: 'awake-start', window: 0 },
    { at: '2026-10-19T12:15:00.000Z', kind: 'awake-start', window: 1 },
    { at: '2026-10-19T18:00:00.000Z', kind: 'awake-end', window: 1 },
  ]);
  assert.deepEqual(nextEvents(TWO('12:20'), MONDAY('07:00'), { horizonDays: 1 }), [
    { at: '2026-10-19T08:00:00.000Z', kind: 'awake-start', window: 0 },
    { at: '2026-10-19T12:00:00.000Z', kind: 'awake-end', window: 0 },
    { at: '2026-10-19T12:20:00.000Z', kind: 'awake-start', window: 1 },
    { at: '2026-10-19T18:00:00.000Z', kind: 'awake-end', window: 1 },
  ]);
  assert.deepEqual(nextEvents({ ...TWO('12:20'), joinMinutes: 20 }, MONDAY('07:00'), { count: 2 })[1], { at: '2026-10-19T12:20:00.000Z', kind: 'awake-start', window: 1 });
  assert.deepEqual(nextEvents(TWO('12:20'), MONDAY('07:00'), { joinMinutes: 20 })[1], { at: '2026-10-19T12:20:00.000Z', kind: 'awake-start', window: 1 });
  // Read from inside the gap.
  assert.deepEqual(nextEvents(TWO('12:15'), MONDAY('12:05'), { count: 2 }), [
    { at: '2026-10-19T12:15:00.000Z', kind: 'awake-start', window: 1 },
    { at: '2026-10-19T18:00:00.000Z', kind: 'awake-end', window: 1 },
  ]);
});

test('nextEvents stopping early gives what the whole horizon gives, with joins', () => {
  const after = t('2027-01-04T07:00:00Z');
  for (const windows of [
    [cron('*/15 * * * *', 5), { kind: 'nap', start: '23:00', end: '02:00', repeat: { pattern: 'monthly', day: 20 }, wake: 'header' }],
    [{ kind: 'awake', start: '22:00', end: '23:55', repeat: { pattern: 'daily' } }, { kind: 'awake', start: '00:05', end: '02:00', repeat: { pattern: 'daily' } }],
    [cron('0 8 * * MON', 10080), cron('10 8 * * MON', 60)],
    [cron('55 23 4 1 *', 5), cron('10 0 5 1 *', 120)],
  ]) {
    const whole = nextEvents(utc(windows), after, { count: 100_000 });
    for (const count of [1, 2, 3, 4, 5, 7, 10, 50, 500]) {
      assert.deepEqual(nextEvents(utc(windows), after, { count }), whole.slice(0, count), `${count} of ${JSON.stringify(windows)}`);
    }
  }
});

test('a nap\'s wake mode: the occurrences active, so in the gap the first one\'s', () => {
  const windows = (first, second) => utc([nap(['mon'], '08:00', '12:00', { wake: first }), nap(['mon'], '12:10', '18:00', { wake: second })]);
  assert.equal(occurrenceAt(windows('header', 'never'), MONDAY('12:05')).wake, 'header');
  assert.equal(occurrenceAt(windows('header', 'never'), MONDAY('12:10')).wake, 'never');
  assert.equal(occurrenceAt(windows('never', 'header'), MONDAY('12:05')).wake, 'never');
  assert.equal(occurrenceAt(windows('never', 'header'), MONDAY('12:10')).wake, 'header');
});

test('chains join: */15 lasting 5 is one union, up to the 8-day horizon, each start a new id', () => {
  const s = utc([cron('*/15 * * * *', 5)]);
  const o = occurrenceAt(s, MONDAY('08:07'));
  assert.equal(o.id, '0@2026-10-19T08:00:00.000Z');
  assert.equal(occurrenceAt(s, MONDAY('08:15')).id, '0@2026-10-19T08:15:00.000Z');
  assert.ok(o.end > MONDAY('08:07') + 8 * 86_400_000, iso(o.end));
  assert.ok(o.end < MONDAY('08:07') + 11 * 86_400_000, iso(o.end));
  assert.equal(nextEvents(s, MONDAY('08:07')).filter((e) => e.kind === 'awake-end').length, 0);
  assert.equal(occurrenceAt(s, MONDAY('08:07'), { joinMinutes: 5 }), null);
  assert.equal(occurrenceAt(s, MONDAY('08:07'), { joinMinutes: 10 }).id, '0@2026-10-19T08:00:00.000Z');
});

test('an occurrence read from its joined gap is found however long it lasted', () => {
  const long = utc([cron('0 8 1 * *', 10080), cron('10 8 8 * *', 60)]);
  const o = occurrenceAt(long, t('2027-01-08T08:05:00Z'));
  assert.equal(o.id, '0@2027-01-01T08:00:00.000Z');
  assert.equal(iso(o.end), '2027-01-08T09:10:00.000Z');
  // 24 hours of a Saturday, then Sunday 00:10.
  const whole = utc([nap(['sat'], '00:00', '00:00'), nap(['sun'], '00:10', '06:00')]);
  assert.equal(occurrenceAt(whole, t('2026-10-25T00:05:00Z')).window, 0);
  // Ending late in a day, and read the day after its end.
  const lateWeek = utc([cron('50 23 1 * *', 10080), cron('5 0 9 * *', 60)]);
  assert.equal(occurrenceAt(lateWeek, t('2027-01-09T00:02:00Z')).id, '0@2027-01-01T23:50:00.000Z');
  const lateDay = utc([awake(['sat'], '23:50', '23:50'), awake(['mon'], '00:05', '06:00')]);
  assert.equal(occurrenceAt(lateDay, t('2026-10-26T00:02:00Z')).window, 0);
  // A gap of 2 hours across midnight.
  const wide = utc([awake(['mon'], '20:00', '23:30'), awake(['tue'], '01:30', '06:00')]);
  assert.equal(occurrenceAt(wide, t('2026-10-20T01:00:00Z'), { joinMinutes: 120 }).window, 0);
  assert.equal(occurrenceAt(wide, t('2026-10-20T01:00:00Z')), null);
});

test('a same-kind start exactly at an end is no gap: as touching windows are today', () => {
  const s = utc([awake(['mon'], '08:00', '12:00'), awake(['mon'], '12:00', '13:00'), awake(['mon'], '13:10', '14:00')]);
  assert.equal(iso(occurrenceAt(s, MONDAY('09:00')).end), '2026-10-19T14:00:00.000Z');
  assert.equal(occurrenceAt(s, MONDAY('13:05')).window, 1);
});

test('joining changes no start: awakeStartWithin says what it said', () => {
  const s = TWO('12:15');
  assert.equal(awakeStartWithin(s, MONDAY('12:05'), 30 * MINUTE), true);
  assert.equal(awakeStartWithin(s, MONDAY('12:05'), 5 * MINUTE), false);
  assert.equal(awakeStartWithin(s, MONDAY('12:05'), 10 * MINUTE), true);
});

test('the overlap check on save compares windows as written', () => {
  // Awake then nap in the gap, and two same-kind windows that join around nothing: valid, no gap makes a refusal.
  assert.deepEqual(scheduleProblems(utc([awake(['mon'], '08:00', '12:00'), nap(['mon'], '12:05', '12:10'), awake(['mon'], '12:15', '18:00')])), []);
  assert.deepEqual(scheduleProblems(utc([awake(['mon'], '08:00', '12:00'), nap(['mon'], '12:00', '12:15')], { joinMinutes: 120 })), []);
});

test('joinMinutes on a schedule: valid from 0 to 120 on multiples of 5, null is absent, refused naming its field', () => {
  for (const joinMinutes of [0, 5, 15, 120, null]) {
    assert.deepEqual(scheduleProblems(utc([awake(['mon'], '08:00', '09:00')], { joinMinutes })), [], String(joinMinutes));
    assert.deepEqual(scheduleProblems({ maxNapDays: 7, joinMinutes }), [], String(joinMinutes));
  }
  for (const joinMinutes of [-5, 7, 125, 1.5, '15', true, []]) {
    assert.deepEqual(scheduleProblems({ maxNapDays: 7, joinMinutes }), ['joinMinutes: a whole number from 0 to 120, a multiple of 5'], JSON.stringify(joinMinutes));
  }
  assert.deepEqual(scheduleProblems({ timeZone: 'UTC', joinMinutes: 5 }), ['schedule: windows or maxNapDays required']);
});

test('a normalized schedule keeps joinMinutes, 0 included, and drops a null one', () => {
  const windows = [awake(['mon'], '08:00', '09:00')];
  assert.equal(normalizeSchedule(utc(windows, { joinMinutes: 30 })).joinMinutes, 30);
  assert.equal(normalizeSchedule(utc(windows, { joinMinutes: 0 })).joinMinutes, 0);
  assert.equal('joinMinutes' in normalizeSchedule(utc(windows, { joinMinutes: null })), false);
  assert.equal('joinMinutes' in normalizeSchedule(utc(windows)), false);
});

test('isJoinMinutes', () => {
  for (const value of [0, 5, 120]) assert.equal(isJoinMinutes(value), true);
  for (const value of [-5, 3, 125, null, undefined, '5', NaN, 2.5]) assert.equal(isJoinMinutes(value), false, String(value));
});

const RESOLVED = [
  [{}, 15, 'default'],
  [undefined, 15, 'default'],
  [{ manager: 30 }, 30, 'organization'],
  [{ router: 10, manager: 30 }, 10, 'router'],
  [{ workload: 5, router: 10, manager: 30 }, 5, 'workload'],
  [{ workload: 0, router: 10, manager: 30 }, 0, 'workload'],
  [{ router: 0, manager: 30 }, 0, 'router'],
  [{ manager: 0 }, 0, 'organization'],
  [{ workload: null, router: null, manager: null }, 15, 'default'],
  [{ workload: 7, router: 'x', manager: 125 }, 15, 'default'],
];
for (const [levels, joinMinutes, from] of RESOLVED) {
  test(`resolveJoin ${JSON.stringify(levels)}: ${joinMinutes} from ${from}`, () => assert.deepEqual(resolveJoin(levels), { joinMinutes, from }));
}

// --- An end that is only the horizon -----------------------------------------------------------------------------------

// A daily nap 00:00–23:45, joined at the default: it never actually ends. Wednesday 13 January 2027, 11:00 in Paris.
const ENDLESS = { kind: 'nap', start: '00:00', end: '23:45', repeat: { pattern: 'daily' } };
const WEDNESDAY = t('2027-01-13T11:00:00+01:00');

test('occurrenceAt says when its end is only the horizon', () => {
  const o = occurrenceAt(paris([ENDLESS]), WEDNESDAY);
  assert.equal(o.endKnown, false);
  assert.equal(o.kind, 'nap');
  assert.equal(iso(o.end), '2027-01-21T23:00:00.000Z', 'where the reading stopped: the controller\'s until');
});

test('endKnown false: every shape of a chain that goes on past the horizon', () => {
  const every = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  for (const [name, s, options] of [
    ['touching days, joining nothing', utc([nap(every, '00:00', '00:00')]), { joinMinutes: 0 }],
    ['*/15 lasting 5', utc([cron('*/15 * * * *', 5, 'nap')]), {}],
    ['a week long, each week', utc([cron('0 8 * * MON', 10080, 'nap')]), { joinMinutes: 0 }],
    ['a week long, joined to the next', utc([cron('0 8 * * MON', 10075, 'nap')]), {}],
    ['awake too', utc([awake(every, '00:00', '00:00')]), {}],
  ]) assert.equal(occurrenceAt(s, WEDNESDAY, options).endKnown, false, name);
});

test('a known end says nothing more: no endKnown key, whatever its distance', () => {
  const known = [
    ['one nap', paris([nap(['wed'], '08:00', '20:00')])],
    ['the chain at 0', paris([ENDLESS], { joinMinutes: 0 })],
    ['an exception in 5 days', paris([ENDLESS], { exceptions: ['2027-01-18'] })],
    ['an exception on the last day read', paris([ENDLESS], { exceptions: ['2027-01-22'] })],
    ['until in 7 days', paris([{ ...ENDLESS, until: '2027-01-20' }])],
    ['ending just past the last day read', paris([{ ...ENDLESS, end: '00:00', until: '2027-01-21' }])],
  ];
  for (const [name, s] of known) assert.equal('endKnown' in occurrenceAt(s, WEDNESDAY), false, name);
  // Long, but its true end: the week a cron lasts, read on its first day.
  assert.equal('endKnown' in occurrenceAt(utc([cron('0 8 13 1 *', 10080, 'nap')]), t('2027-01-13T09:00:00Z')), false);
  assert.equal(iso(occurrenceAt(paris([ENDLESS], { exceptions: ['2027-01-18'] }), WEDNESDAY).end), '2027-01-17T22:45:00.000Z');
});

test('localTime prints the date of an end more than 6 days from now; without now, as ever', () => {
  const end = t('2027-01-19T23:45:00+01:00');
  assert.equal(localTime(end, 'Europe/Paris'), 'Tue 23:45');
  assert.equal(localTime(end, 'Europe/Paris', { now: WEDNESDAY }), 'Tue 2027-01-19 23:45');
  const sixDays = 6 * 86_400_000;
  assert.equal(localTime(WEDNESDAY + sixDays, 'Europe/Paris', { now: WEDNESDAY }), 'Tue 11:00', 'exactly 6 days');
  assert.equal(localTime(WEDNESDAY + sixDays + MINUTE, 'Europe/Paris', { now: WEDNESDAY }), 'Tue 2027-01-19 11:01');
  // The local date, not the UTC one.
  assert.equal(localTime(t('2027-01-24T23:30:00Z'), 'Europe/Paris', { now: WEDNESDAY }), 'Mon 2027-01-25 00:30');
});

test('napEndOf: the end as the page and the JSON say it, none when it is only the horizon', () => {
  const zone = 'Europe/Paris';
  assert.deepEqual(napEndOf({ end: t('2027-01-13T20:00:00+01:00') }, zone, WEDNESDAY), { at: '2027-01-13T19:00:00.000Z', local: 'Wed 20:00', timeZone: zone });
  assert.deepEqual(napEndOf({ end: t('2027-01-25T08:00:00+01:00') }, zone, WEDNESDAY), { at: '2027-01-25T07:00:00.000Z', local: 'Mon 2027-01-25 08:00', timeZone: zone });
  const none = napEndOf(occurrenceAt(paris([ENDLESS]), WEDNESDAY), zone, WEDNESDAY);
  assert.deepEqual(none, { at: null, local: null, timeZone: zone });
  assert.equal(napEndHeader(none), 'unknown');
  assert.equal(napEndHeader({ at: '2027-01-13T19:00:00.000Z', local: 'Wed 20:00', timeZone: zone }), '2027-01-13T19:00:00.000Z');
});

// --- Time limits (section 4) ----------------------------------------------------------------------------------------

const within = (limit, run, name) => {
  const begin = performance.now();
  const result = run();
  const spent = performance.now() - begin;
  assert.ok(spent < limit, `${name}: ${spent} ms, the limit is ${limit} ms`);
  return result;
};

test('chains stay bounded in cost: 20 windows of */15 lasting 5, and of */5 lasting 7 days', () => {
  for (const window of [cron('*/15 * * * *', 5), cron('*/5 * * * *', 10080)]) {
    const s = paris(Array.from({ length: 20 }, () => window));
    assert.equal(within(500, () => occurrenceAt(s, MONDAY('12:02')), 'occurrenceAt').kind, 'awake');
    assert.equal(within(500, () => nextEvents(s, MONDAY('12:02')), 'nextEvents').length, 5);
  }
});

test('a */15 window: occurrenceAt and nextEvents stay fast', () => {
  const s = paris([cron('*/15 * * * *', 5)]);
  within(100, () => {
    for (let i = 0; i < 10; i++) occurrenceAt(s, MONDAY('12:02'));
  }, '10 occurrenceAt');
  within(50, () => nextEvents(s, MONDAY('12:02')), 'nextEvents');
});

test('a weekly schedule stays cheap with the default', () => {
  const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];
  const s = paris([awake(WEEKDAYS, '08:30', '19:00'), nap(WEEKDAYS, '20:00', '07:00', { wake: 'header' }), nap(['sat'], '00:00', '00:00', { wake: 'never' })]);
  within(1000, () => {
    for (let i = 0; i < 1000; i++) occurrenceAt(s, t('2027-01-05T23:00:00Z') + i * 300_000);
  }, '1000 occurrenceAt');
});
