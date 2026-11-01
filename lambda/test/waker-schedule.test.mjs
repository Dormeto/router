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

test('the waker reads the levels only for a workload not awake with a schedule, and one that sets its own reads none', async () => {
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
  assert.equal(own.reads, 0);
  const none = counted({ schedule: null, now: GAP });
  await none.handler(albEvent());
  assert.equal(none.reads, 0);
  const up = counted({ schedule: joined(), now: GAP, run: { state: STATES.AWAKE } });
  await up.handler(albEvent());
  assert.equal(up.reads, 0);
});
