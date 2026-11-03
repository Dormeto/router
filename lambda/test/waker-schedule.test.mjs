// The waker keeps nap windows (R12 design, section 4): the waiter page, or the wake header when the window allows it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWaker } from '../src/lib/waker-core.mjs';
import { STATES } from '../src/lib/state.mjs';
import { albEvent, fakeClock, fakeStore, testConfig } from './fakes.mjs';

// Monday 2026-10-19 at 23:00 in Paris (CEST): inside the night window, which ends Tuesday at 07:00.
const NOW = Date.parse('2026-10-19T23:00:00+02:00');
const night = (wake) => ({ timeZone: 'Europe/Paris', windows: [{ kind: 'nap', days: ['mon'], start: '20:00', end: '07:00', ...(wake ? { wake } : {}) }], by: 'ops', at: NOW });

function setup({ run = { state: STATES.ASLEEP }, schedule = night(), now = NOW, cfg = testConfig({ waitSeconds: 0 }) } = {}) {
  const clock = fakeClock(now);
  const store = fakeStore({ config: cfg, run, clock });
  if (schedule) store.state.schedules.demo = schedule;
  const invocations = [];
  const logs = [];
  const log = { info() {}, error() {}, warn: (event, fields) => logs.push({ event, ...fields }) };
  let ids = 0;
  const handler = createWaker({
    store, invokeController: async (p) => { invocations.push(p); }, prefix: 'dmt-dev-', now: clock.now, sleep: clock.sleep,
    newId: () => `wake-${++ids}`, log,
  });
  return { handler, store, invocations, logs, clock };
}
const json = { accept: 'application/json' };
const counters = (store) => JSON.stringify(store.state.stats);

test('never: a request in a nap window gets the waiter page and starts nothing', async () => {
  const { handler, store, invocations } = setup();
  const res = await handler(albEvent());
  assert.equal(res.statusCode, 503);
  assert.deepEqual(invocations, []);
  assert.equal(store.state.run.state, STATES.ASLEEP);
  assert.match(counters(store), /ignored:schedule/);
  assert.match(res.body, /Napping on schedule until Tue 07:00 \(Europe\/Paris\)\./);
});

test('never: the wake header does not wake either', async () => {
  const { handler, invocations } = setup();
  const res = await handler(albEvent({ headers: { 'x-dormeto-wake': '1' } }));
  assert.equal(res.statusCode, 503);
  assert.deepEqual(invocations, []);
});

test('the JSON answer says when the nap ends, local time and zone', async () => {
  const { handler } = setup();
  const res = await handler(albEvent({ headers: json }));
  const body = JSON.parse(res.body);
  assert.deepEqual(body.napUntil, { at: '2026-10-20T05:00:00.000Z', local: 'Tue 07:00', timeZone: 'Europe/Paris' });
  assert.equal(body.status, 'asleep');
});

test('header: a plain request gets the waiter page, one with the wake header wakes with cause header', async () => {
  const { handler, store, invocations } = setup({ schedule: night('header') });
  const plain = await handler(albEvent({ headers: json }));
  assert.equal(plain.statusCode, 503);
  assert.deepEqual(invocations, []);
  assert.match(counters(store), /ignored:schedule/);
  assert.ok(JSON.parse(plain.body).napUntil);
  const woken = await handler(albEvent({ headers: { ...json, 'x-dormeto-wake': '1' } }));
  assert.equal(woken.statusCode, 503);
  assert.deepEqual(invocations, [{ action: 'wake', workloadId: 'demo', wakeId: 'wake-1' }]);
  assert.equal(store.state.run.state, STATES.WAKING);
  assert.match(counters(store), /wake:header/);
  assert.equal(JSON.parse(woken.body).napUntil, undefined);
});

test('header: a no-wake rule still wins over the header', async () => {
  const cfg = testConfig({ waitSeconds: 0, noWakeRules: [{ name: 'health', pathPrefixes: ['/health'] }] });
  const { handler, invocations } = setup({ schedule: night('header'), cfg });
  const res = await handler(albEvent({ path: '/health', headers: { 'x-dormeto-wake': '1' } }));
  assert.equal(res.statusCode, 503);
  assert.deepEqual(invocations, []);
});

test('NAPPING: no pending wake inside a nap window, unless the header case applies', async () => {
  const { handler, store } = setup({ run: { state: STATES.NAPPING } });
  await handler(albEvent());
  assert.ok(!store.state.run.pendingWake);
  const h = setup({ run: { state: STATES.NAPPING }, schedule: night('header') });
  await h.handler(albEvent());
  assert.ok(!h.store.state.run.pendingWake);
  await h.handler(albEvent({ headers: { 'x-dormeto-wake': '1' } }));
  assert.ok(h.store.state.run.pendingWake);
});

test('outside any window the behavior is unchanged', async () => {
  const { handler, invocations } = setup({ now: Date.parse('2026-10-19T12:00:00+02:00') });
  const res = await handler(albEvent({ headers: json }));
  assert.deepEqual(invocations, [{ action: 'wake', workloadId: 'demo', wakeId: 'wake-1' }]);
  assert.equal(JSON.parse(res.body).napUntil, undefined);
});

test('an awake workload does not read the schedule', async () => {
  const { handler, store } = setup({ run: { state: STATES.AWAKE, awakeSince: 0 } });
  store.getSchedule = async () => { throw new Error('read'); };
  const res = await handler(albEvent());
  assert.equal(res.statusCode, 307);
});

test('a bad stored schedule behaves as none and is logged once per request', async () => {
  const { handler, invocations, logs } = setup({ schedule: { ...night(), timeZone: 'Nowhere/Land' } });
  await handler(albEvent());
  assert.equal(invocations.length, 1);
  assert.deepEqual(logs.filter((l) => l.event === 'ScheduleSkipped').length, 1);
});

test('browser mode: the JSON advertises the wake header only outside a nap window or in a header window', async () => {
  const browser = testConfig({ waitSeconds: 0, wakeMode: 'browser' });
  const hint = async (schedule, now = NOW) => JSON.parse((await setup({ schedule, cfg: browser, now }).handler(albEvent({ headers: json }))).body).wakeHeader;
  assert.equal(await hint(night()), undefined, 'never window: no hint');
  assert.ok(await hint(night('header')), 'header window: hint');
  assert.ok(await hint(null), 'no schedule: hint');
  assert.ok(await hint(night(), Date.parse('2026-10-20T10:00:00+02:00')), 'outside the window: hint');
});

test('a cron nap window: the waiter page until its end, in wall time', async () => {
  const schedule = { timeZone: 'Europe/Paris', windows: [{ kind: 'nap', repeat: { pattern: 'cron', cron: '0 20 19 10 *', minutes: 660 } }], by: 'ops', at: NOW };
  const { handler, invocations } = setup({ schedule });
  const res = await handler(albEvent());
  assert.equal(res.statusCode, 503);
  assert.deepEqual(invocations, []);
  assert.match(res.body, /Napping on schedule until Tue 07:00 \(Europe\/Paris\)\./);
});

test('a nap window past its until wakes as if there were none', async () => {
  const schedule = { timeZone: 'Europe/Paris', windows: [{ kind: 'nap', start: '20:00', end: '07:00', repeat: { pattern: 'daily' }, until: '2026-10-18' }], by: 'ops', at: NOW };
  const { handler, invocations } = setup({ schedule });
  await handler(albEvent());
  assert.equal(invocations.length, 1);
});

// Joined windows (design, section 11): Monday's nap ends at 23:55, Tuesday's starts at 00:05; 23:58 is the gap between them.
const GAP = Date.parse('2026-10-19T23:58:00+02:00');
const joined = (more = {}) => ({
  timeZone: 'Europe/Paris', by: 'ops', at: NOW, ...more,
  windows: [{ kind: 'nap', days: ['mon'], start: '20:00', end: '23:55' }, { kind: 'nap', days: ['tue'], start: '00:05', end: '07:00' }],
});

test('a request in a joined gap gets the waiter page until the union ends', async () => {
  const { handler, invocations } = setup({ schedule: joined(), now: GAP });
  const res = await handler(albEvent());
  assert.equal(res.statusCode, 503);
  assert.deepEqual(invocations, []);
  assert.match(res.body, /Napping on schedule until Tue 07:00 \(Europe\/Paris\)\./);
});

test('the waker follows the levels: the schedule\'s, the router\'s, the organization\'s', async () => {
  const wakes = async (schedule, levels = {}) => {
    const s = setup({ schedule, now: GAP });
    if (levels.router !== undefined) await s.store.putRouterSettings({ joinMinutes: levels.router, by: 'ana', at: 1 });
    if (levels.manager !== undefined) await s.store.putManagerSettings({ hibernate: true, joinMinutes: levels.manager, etag: null, readAt: 1, error: null });
    await s.handler(albEvent());
    return s.invocations.length;
  };
  assert.equal(await wakes(joined()), 0, 'the default');
  assert.equal(await wakes(joined(), { manager: 0 }), 1, 'the organization');
  assert.equal(await wakes(joined(), { router: 0, manager: 30 }), 1, 'the router');
  assert.equal(await wakes(joined(), { router: 30, manager: 0 }), 0, 'the router again');
  assert.equal(await wakes(joined({ joinMinutes: 0 }), { router: 30 }), 1, 'the workload');
  assert.equal(await wakes(joined({ joinMinutes: 30 }), { router: 0 }), 0, 'the workload again');
});

test('a level the waker cannot read falls through, is logged once and fails nothing', async () => {
  const s = setup({ schedule: joined(), now: GAP });
  await s.store.putManagerSettings({ hibernate: true, joinMinutes: 0, etag: null, readAt: 1, error: null });
  s.store.getRouterSettings = async () => { throw new Error('ThrottlingException'); };
  await s.handler(albEvent());
  assert.equal(s.invocations.length, 1, 'the organization\'s 0, the router\'s unread');
  assert.deepEqual(s.logs.filter((l) => l.event === 'JoinLevelUnreadable'), [{ event: 'JoinLevelUnreadable', workloadId: 'demo', level: 'router', error: 'ThrottlingException' }]);
  const both = setup({ schedule: joined(), now: GAP });
  both.store.getRouterSettings = async () => { throw new Error('ThrottlingException'); };
  both.store.getManagerSettings = async () => { throw new Error('ThrottlingException'); };
  assert.equal((await both.handler(albEvent())).statusCode, 503, 'then 15');
  assert.deepEqual(both.invocations, []);
});

// Settings at scale (design §6): every request's settings come from the levels, read once a minute through the cache.
test('the waker reads each level once, whatever the workload: its settings come from them', async () => {
  const counted = (options) => {
    const s = setup(options);
    s.reads = 0;
    for (const name of ['getRouterSettings', 'getManagerSettings']) {
      const read = s.store[name];
      s.store[name] = async () => { s.reads++; return read(); };
    }
    return s;
  };
  const sets = counted({ schedule: joined(), now: GAP });
  await sets.handler(albEvent());
  assert.equal(sets.reads, 2);
  const own = counted({ schedule: joined({ joinMinutes: 15 }), now: GAP });
  await own.handler(albEvent());
  assert.equal(own.reads, 2);
  const none = counted({ schedule: null, now: GAP });
  await none.handler(albEvent());
  assert.equal(none.reads, 2);
  const up = counted({ schedule: joined(), now: GAP, run: { state: STATES.AWAKE } });
  await up.handler(albEvent());
  assert.equal(up.reads, 2);
});

// An end that is only the horizon: a daily nap 00:00–23:45, joined at the default, never actually ends.
const WEDNESDAY = Date.parse('2027-01-13T11:00:00+01:00');
const endless = (more = {}) => ({ timeZone: 'Europe/Paris', by: 'ops', at: WEDNESDAY, windows: [{ kind: 'nap', start: '00:00', end: '23:45', repeat: { pattern: 'daily' } }], ...more });

test('a nap with no end known: the page and the JSON say so, with no date to believe', async () => {
  const s = setup({ schedule: endless(), now: WEDNESDAY });
  const page = await s.handler(albEvent());
  assert.equal(page.statusCode, 503);
  assert.deepEqual(s.invocations, []);
  assert.match(page.body, />Napping on schedule\.</);
  assert.doesNotMatch(page.body, /Napping on schedule until/);
  // The probe keeps saying it is a nap, by the header's presence.
  assert.equal(page.multiValueHeaders['x-dormeto-nap-until'][0], 'unknown');
  const answer = await s.handler(albEvent({ headers: json }));
  assert.deepEqual(JSON.parse(answer.body), { status: 'asleep', retryAfter: testConfig().pollSeconds, napUntil: { at: null, local: null, timeZone: 'Europe/Paris' } });
});

test('a known end more than 6 days away reads with its date, a nearer one as a weekday', async () => {
  const ending = async (exception) => {
    const s = setup({ schedule: endless({ exceptions: [exception] }), now: WEDNESDAY });
    return JSON.parse((await s.handler(albEvent({ headers: json }))).body).napUntil;
  };
  assert.deepEqual(await ending('2027-01-20'), { at: '2027-01-19T22:45:00.000Z', local: 'Tue 2027-01-19 23:45', timeZone: 'Europe/Paris' });
  assert.deepEqual(await ending('2027-01-18'), { at: '2027-01-17T22:45:00.000Z', local: 'Sun 23:45', timeZone: 'Europe/Paris' });
});

// The levels of joinMinutes, kept 60 seconds per instance: they sit on the partition of the check and the health.
function counting(options) {
  const s = setup(options);
  s.reads = { getRouterSettings: 0, getManagerSettings: 0 };
  for (const name of Object.keys(s.reads)) {
    const read = s.store[name];
    s.store[name] = async () => { s.reads[name]++; return read(); };
  }
  s.burst = async (n = 20) => { for (let i = 0; i < n; i++) await s.handler(albEvent()); };
  return s;
}
const SECOND = 1000;

test('a burst reads each level once, and a read again only after 60 seconds', async () => {
  const s = counting({ schedule: joined(), now: GAP });
  await s.burst();
  assert.deepEqual(s.reads, { getRouterSettings: 1, getManagerSettings: 1 });
  s.clock.advance(60 * SECOND - 1);
  await s.burst();
  assert.deepEqual(s.reads, { getRouterSettings: 1, getManagerSettings: 1 });
  s.clock.advance(1);
  await s.burst();
  assert.deepEqual(s.reads, { getRouterSettings: 2, getManagerSettings: 2 });
});

test('requests at once share the read', async () => {
  const s = counting({ schedule: joined(), now: GAP });
  await Promise.all(Array.from({ length: 10 }, () => s.handler(albEvent())));
  assert.deepEqual(s.reads, { getRouterSettings: 1, getManagerSettings: 1 });
});

test('a change at a level takes effect within 60 seconds', async () => {
  for (const change of [
    (s) => s.store.putRouterSettings({ joinMinutes: 0, by: 'ana', at: 1 }),
    (s) => s.store.putManagerSettings({ hibernate: true, joinMinutes: 0, etag: null, readAt: 1, error: null }),
  ]) {
    const s = counting({ schedule: joined(), now: GAP - 59 * SECOND });
    await s.handler(albEvent());
    await change(s);
    s.clock.advance(59 * SECOND);
    await s.handler(albEvent());
    assert.equal(s.invocations.length, 0, 'still the value read: 15 joins the gap');
    s.clock.advance(SECOND);
    await s.handler(albEvent());
    assert.equal(s.invocations.length, 1, 'read again: 0 joins nothing');
  }
});

test('a failed read is no value: unset for that request, tried again soon, not at every request of a burst', async () => {
  // The router's 0 would wake on the request: unread, the default of 15 joins the gap and the page answers.
  const s = counting({ schedule: joined(), now: GAP });
  await s.store.putRouterSettings({ joinMinutes: 0, by: 'ana', at: 1 });
  const read = s.store.getRouterSettings;
  let failing = true;
  s.store.getRouterSettings = async () => {
    if (!failing) return read();
    s.reads.getRouterSettings++;
    throw new Error('ThrottlingException');
  };
  const unreadable = () => s.logs.filter((l) => l.event === 'JoinLevelUnreadable').length;
  await s.burst(10);
  assert.equal(s.reads.getRouterSettings, 1, 'one read in the burst');
  assert.equal(unreadable(), 1, 'logged once');
  assert.deepEqual(s.invocations, []);
  // Soon, not in 60 seconds, and the other level stays kept.
  s.clock.advance(5 * SECOND - 1);
  await s.handler(albEvent());
  assert.equal(s.reads.getRouterSettings, 1);
  s.clock.advance(1);
  await s.handler(albEvent());
  assert.equal(s.reads.getRouterSettings, 2);
  assert.equal(unreadable(), 2);
  assert.equal(s.reads.getManagerSettings, 1);
  assert.deepEqual(s.invocations, []);
  // Back: its value applies at the next try.
  failing = false;
  s.clock.advance(5 * SECOND);
  await s.handler(albEvent());
  assert.equal(s.reads.getRouterSettings, 3);
  assert.equal(s.invocations.length, 1, 'the router\'s 0 joins nothing');
});

test('a failed read keeps the last value: the router\'s 30 still joins the gap (review, 2026-11-04)', async () => {
  const s = counting({ schedule: joined(), now: GAP - 60 * SECOND });
  await s.store.putRouterSettings({ joinMinutes: 30, by: 'ana', at: 1 });
  await s.store.putManagerSettings({ hibernate: true, joinMinutes: 0, etag: null, readAt: 1, error: null });
  await s.handler(albEvent());
  assert.equal(s.reads.getRouterSettings, 1);
  s.store.getRouterSettings = async () => { throw new Error('ThrottlingException'); };
  s.clock.advance(60 * SECOND);
  await s.handler(albEvent());
  assert.equal(s.invocations.length, 0, 'the router\'s 30, read before');
});

test('a burst reads each level once a minute, a schedule with its own value too', async () => {
  const s = counting({ schedule: joined({ joinMinutes: 15 }), now: GAP });
  await s.burst();
  s.clock.advance(120 * SECOND);
  await s.burst();
  assert.deepEqual(s.reads, { getRouterSettings: 2, getManagerSettings: 2 });
});
