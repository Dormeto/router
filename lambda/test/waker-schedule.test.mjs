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
