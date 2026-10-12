import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWaker } from '../src/lib/waker-core.mjs';
import { STATES } from '../src/lib/state.mjs';
import { albEvent, fakeClock, fakeStore, silentLog, testConfig } from './fakes.mjs';

function setup({ run, cfg = testConfig(), invoke } = {}) {
  const clock = fakeClock();
  const store = fakeStore({ config: cfg, run, clock });
  const invocations = [];
  let ids = 0;
  const handler = createWaker({
    store,
    invokeController: invoke ?? (async (payload) => { invocations.push(payload); }),
    prefix: 'dmt-dev-',
    now: clock.now,
    sleep: clock.sleep,
    newId: () => `wake-${++ids}`,
    log: silentLog,
  });
  return { handler, store, clock, invocations, cfg };
}

const headerOf = (res, name) => res.multiValueHeaders[name]?.[0];

test('ASLEEP: starts exactly one wake and serves the waiter page when waitSeconds is 0', async () => {
  const { handler, store, invocations } = setup({ run: { state: STATES.ASLEEP }, cfg: testConfig({ waitSeconds: 0 }) });
  const res = await handler(albEvent());
  assert.equal(res.statusCode, 503);
  assert.equal(headerOf(res, 'x-dormeto-state'), STATES.WAKING);
  assert.equal(headerOf(res, 'retry-after'), '3');
  assert.equal(headerOf(res, 'cache-control'), 'no-store');
  assert.match(headerOf(res, 'content-type'), /text\/html/);
  assert.match(res.body, /Waking up/);
  assert.deepEqual(invocations, [{ action: 'wake', workloadId: 'demo', wakeId: 'wake-1' }]);
  assert.equal(store.state.run.state, STATES.WAKING);
  assert.equal(store.state.run.wakeCount, 1);
});

test('ASLEEP: concurrent requests trigger a single wake', async () => {
  const { handler, store, invocations } = setup({ run: { state: STATES.ASLEEP }, cfg: testConfig({ waitSeconds: 0 }) });
  const responses = await Promise.all(Array.from({ length: 20 }, () => handler(albEvent())));
  assert.ok(responses.every((r) => r.statusCode === 503));
  assert.equal(invocations.filter((i) => i.action === 'wake').length, 1);
  assert.equal(store.state.run.wakeCount, 1);
});

test('holds the request and redirects once the workload is awake', async () => {
  const { handler, store, clock } = setup({ run: { state: STATES.ASLEEP } });
  const start = clock.now();
  clock.onSleep((t) => { if (t - start >= 5000) store.state.run.state = STATES.AWAKE; });
  const res = await handler(albEvent({ path: '/orders', query: { page: ['2'] } }));
  assert.equal(res.statusCode, 307);
  assert.equal(headerOf(res, 'location'), '/orders?page=2');
  assert.match(headerOf(res, 'set-cookie'), /^dmt_r=1; Max-Age=30; Path=\/; Secure; HttpOnly; SameSite=Lax$/);
  assert.equal(store.state.run.holders, 0);
  assert.ok(clock.now() - start < 20_000);
});

test('returns the waiter page after waitSeconds and releases the holder', async () => {
  const { handler, store, clock } = setup({ run: { state: STATES.ASLEEP } });
  const start = clock.now();
  const res = await handler(albEvent());
  assert.equal(res.statusCode, 503);
  assert.ok(clock.now() - start >= 20_000);
  assert.equal(store.state.run.holders, 0);
});

test('does not hold when maxHolders is reached', async () => {
  const { handler, clock } = setup({ run: { state: STATES.WAKING, wakeId: 'w', wakeStartedAt: Date.now(), holders: 5 } });
  const start = clock.now();
  const res = await handler(albEvent());
  assert.equal(res.statusCode, 503);
  assert.equal(clock.now(), start, 'answered immediately');
});

test('probes trigger the wake but are never held', async () => {
  const { handler, clock, invocations } = setup({ run: { state: STATES.ASLEEP } });
  const start = clock.now();
  const res = await handler(albEvent({ headers: { 'x-dormeto-probe': '1', accept: '*/*' } }));
  assert.equal(res.statusCode, 503);
  assert.equal(clock.now(), start);
  assert.equal(invocations.length, 1);
  assert.deepEqual(JSON.parse(res.body), { status: 'waking', retryAfter: 3 });
});

test('bots and HEAD requests never trigger a wake', async () => {
  const { handler, store, invocations } = setup({ run: { state: STATES.ASLEEP } });
  const bot = await handler(albEvent({ headers: { 'user-agent': 'Googlebot/2.1' } }));
  const head = await handler(albEvent({ method: 'HEAD' }));
  assert.equal(bot.statusCode, 503);
  assert.equal(head.body, '');
  assert.equal(headerOf(head, 'x-dormeto-state'), STATES.ASLEEP);
  assert.equal(invocations.length, 0);
  assert.equal(store.state.run.state, STATES.ASLEEP);
});

test('NAPPING: marks a pending wake', async () => {
  const { handler, store } = setup({ run: { state: STATES.NAPPING }, cfg: testConfig({ waitSeconds: 0 }) });
  await handler(albEvent());
  assert.equal(store.state.run.pendingWake, true);
});

test('FAILED: retries only after failedRetrySeconds', async () => {
  const recent = setup({ run: { state: STATES.FAILED, failedAt: Date.now() }, cfg: testConfig({ waitSeconds: 0 }) });
  recent.store.state.run.failedAt = recent.clock.now() - 10_000;
  await recent.handler(albEvent());
  assert.equal(recent.invocations.length, 0);

  const old = setup({ run: { state: STATES.FAILED }, cfg: testConfig({ waitSeconds: 0 }) });
  old.store.state.run.failedAt = old.clock.now() - 61_000;
  const res = await old.handler(albEvent());
  assert.equal(old.invocations.length, 1);
  assert.equal(old.store.state.run.state, STATES.WAKING);
  assert.equal('failedAt' in old.store.state.run, false);
  assert.equal(headerOf(res, 'x-dormeto-state'), STATES.WAKING);
});

test('WAKING: retakes a stuck wake after wakeTimeoutSeconds plus grace', async () => {
  const { handler, store, clock, invocations } = setup({ run: { state: STATES.WAKING, wakeId: 'old' }, cfg: testConfig({ waitSeconds: 0 }) });
  store.state.run.wakeStartedAt = clock.now() - 661_000;
  await handler(albEvent());
  assert.deepEqual(invocations, [{ action: 'wake', workloadId: 'demo', wakeId: 'wake-1' }]);
  assert.equal(store.state.run.wakeId, 'wake-1');
});

test('WAKING: a recent wake is only followed', async () => {
  const { handler, store, clock, invocations } = setup({ run: { state: STATES.WAKING, wakeId: 'w' }, cfg: testConfig({ waitSeconds: 0 }) });
  store.state.run.wakeStartedAt = clock.now() - 5_000;
  await handler(albEvent());
  assert.equal(invocations.length, 0);
});

test('controller invoke failure marks the wake as FAILED', async () => {
  const { handler, store } = setup({
    run: { state: STATES.ASLEEP },
    cfg: testConfig({ waitSeconds: 0 }),
    invoke: async () => { throw new Error('TooManyRequestsException'); },
  });
  const res = await handler(albEvent());
  assert.equal(store.state.run.state, STATES.FAILED);
  assert.equal(typeof store.state.run.failedAt, 'number');
  assert.equal(headerOf(res, 'x-dormeto-state'), STATES.FAILED);
});

test('AWAKE: repairs the route and redirects, with a loop guard', async () => {
  const { handler, invocations } = setup({ run: { state: STATES.AWAKE } });
  const first = await handler(albEvent({ path: '//evil.example/x' }));
  assert.equal(first.statusCode, 307);
  assert.equal(headerOf(first, 'location'), '/evil.example/x');
  assert.deepEqual(invocations, [{ action: 'ensure-awake', workloadId: 'demo' }]);
  const looping = await handler(albEvent({ headers: { cookie: 'dmt_r=2' } }));
  assert.equal(looping.statusCode, 503);
  assert.equal(headerOf(looping, 'x-dormeto-state'), STATES.AWAKE);
});

test('AWAKE: asks the controller to repair the route at most every 10 s per workload', async () => {
  const { handler, invocations, clock } = setup({ run: { state: STATES.AWAKE } });
  await handler(albEvent());
  await handler(albEvent());
  assert.equal(invocations.filter((i) => i.action === 'ensure-awake').length, 1);
  clock.advance(10_000);
  await handler(albEvent());
  assert.equal(invocations.filter((i) => i.action === 'ensure-awake').length, 2);
});

test('unknown workload configuration answers FAILED without throwing', async () => {
  const { handler } = setup({ run: { state: STATES.ASLEEP }, cfg: testConfig({ workloadId: 'other' }) });
  const res = await handler(albEvent());
  assert.equal(res.statusCode, 503);
  assert.equal(headerOf(res, 'x-dormeto-state'), STATES.FAILED);
});

test('AWAKE within the route grace window: waiter page, no redirect and no ensure-awake', async () => {
  const { handler, store, clock, invocations } = setup({ run: { state: STATES.AWAKE }, cfg: testConfig({ waitSeconds: 0 }) });
  store.state.run.awakeSince = clock.now() - 5_000;
  const res = await handler(albEvent());
  assert.equal(res.statusCode, 503);
  assert.equal(headerOf(res, 'x-dormeto-state'), STATES.AWAKE);
  assert.match(res.body, /Almost there/);
  assert.deepEqual(invocations, []);
});

test('probes never invoke ensure-awake', async () => {
  const { handler, invocations } = setup({ run: { state: STATES.AWAKE } });
  const res = await handler(albEvent({ headers: { 'x-dormeto-probe': '1' } }));
  assert.equal(res.statusCode, 307);
  assert.deepEqual(invocations, []);
});

test('a held request redirects only after the route grace window', async () => {
  const { handler, store, clock } = setup({ run: { state: STATES.ASLEEP } });
  const start = clock.now();
  clock.onSleep((t) => {
    if (t - start >= 2_000 && store.state.run.state !== STATES.AWAKE) Object.assign(store.state.run, { state: STATES.AWAKE, awakeSince: t });
  });
  const res = await handler(albEvent());
  assert.equal(res.statusCode, 307);
  assert.ok(clock.now() - start >= 17_000, `redirected after ${clock.now() - start} ms`);
});

test('logs the request that triggers a wake or a pending wake', async () => {
  const entries = [];
  const log = { info: (event, fields) => entries.push([event, fields]), warn() {}, error() {} };
  const clock = fakeClock();
  const cfg = testConfig({ waitSeconds: 0 });
  const store = fakeStore({ config: cfg, run: { state: STATES.ASLEEP }, clock });
  const handler = createWaker({ store, invokeController: async () => {}, prefix: 'dmt-dev-', now: clock.now, sleep: clock.sleep, newId: () => 'w1', log });
  await handler(albEvent({ path: '/orders', headers: { 'user-agent': 'curl/8.4', 'x-forwarded-for': '203.0.113.9, 198.51.100.7' } }));
  const [event, fields] = entries.find(([e]) => e === 'WakeRequested');
  assert.equal(event, 'WakeRequested');
  assert.deepEqual(fields.trigger, { kind: 'normal', method: 'GET', path: '/orders', userAgent: 'curl/8.4', sourceIp: '198.51.100.7' });

  store.state.run.state = STATES.NAPPING;
  await handler(albEvent({ path: '/', headers: { 'x-dormeto-probe': '1' } }));
  const pending = entries.find(([e]) => e === 'PendingWake');
  assert.equal(pending[1].trigger.kind, 'probe');
});

function rulesSetup({ cfg, defaultRules } = {}) {
  const entries = [];
  const log = { info: (event, fields) => entries.push([event, fields]), warn: (event, fields) => entries.push([event, fields]), error() {} };
  const clock = fakeClock();
  const store = fakeStore({ config: cfg ?? testConfig({ waitSeconds: 0 }), run: { state: STATES.ASLEEP }, clock });
  const invocations = [];
  const handler = createWaker({
    store, invokeController: async (payload) => { invocations.push(payload); }, prefix: 'dmt-dev-',
    now: clock.now, sleep: clock.sleep, newId: () => 'w1', log, defaultRules,
  });
  return { handler, store, entries, invocations };
}

test('a request matching a workload no-wake rule gets the waiter page without waking, and is logged', async () => {
  const cfg = testConfig({ waitSeconds: 20, noWakeRules: [{ name: 'office', sourceIps: ['198.51.100.0/24'] }] });
  const { handler, store, entries, invocations } = rulesSetup({ cfg });
  const res = await handler(albEvent({ path: '/orders', headers: { 'x-forwarded-for': '198.51.100.20' } }));
  assert.equal(res.statusCode, 503);
  assert.equal(headerOf(res, 'x-dormeto-state'), STATES.ASLEEP);
  assert.equal(invocations.length, 0);
  assert.equal(store.state.run.state, STATES.ASLEEP);
  const [, fields] = entries.find(([e]) => e === 'WakeIgnored');
  assert.equal(fields.reason, 'rule office');
  assert.equal(fields.trigger.sourceIp, '198.51.100.20');
  assert.equal(fields.trigger.path, '/orders');

  await handler(albEvent({ headers: { 'x-forwarded-for': '192.0.2.1' } }));
  assert.equal(store.state.run.state, STATES.WAKING);
});

test('router default rules apply to every workload, waiter probes included', async () => {
  const defaultRules = [{ name: 'e2e', headers: [{ name: 'x-dormeto-e2e', value: 'no-wake' }] }];
  const { handler, store, invocations, entries } = rulesSetup({ defaultRules });
  await handler(albEvent({ headers: { 'x-dormeto-e2e': 'no-wake' } }));
  await handler(albEvent({ headers: { 'x-dormeto-e2e': 'no-wake', 'x-dormeto-probe': '1', accept: '*/*' } }));
  assert.equal(invocations.length, 0);
  assert.equal(store.state.run.state, STATES.ASLEEP);
  assert.equal(entries.filter(([e, f]) => e === 'WakeIgnored' && f.reason === 'rule e2e').length, 2);
});

test('built-in no-wake requests are logged with their reason; invalid rules are reported once', async () => {
  const cfg = testConfig({ waitSeconds: 0, noWakeRules: [{ name: 'broken', pathPattern: '(' }] });
  const { handler, entries, store } = rulesSetup({ cfg });
  await handler(albEvent({ headers: { 'user-agent': 'Googlebot/2.1' } }));
  await handler(albEvent({ method: 'HEAD' }));
  assert.deepEqual(entries.filter(([e]) => e === 'WakeIgnored').map(([, f]) => f.reason), ['bot user agent', 'HEAD']);
  assert.equal(entries.filter(([e]) => e === 'NoWakeRuleInvalid').length, 1);
  await handler(albEvent());
  assert.equal(store.state.run.state, STATES.WAKING, 'an invalid rule never blocks a wake');
});

test('a controller that cannot be invoked records why (R7a)', async () => {
  const { handler, store } = setup({
    run: { state: STATES.ASLEEP },
    cfg: testConfig({ waitSeconds: 0 }),
    invoke: async () => { throw Object.assign(new Error('Rate Exceeded.'), { name: 'TooManyRequestsException' }); },
  });
  await handler(albEvent());
  const failure = JSON.parse(store.state.run.failure);
  assert.deepEqual([failure.kind, failure.step, failure.backend, failure.message], ['throttled', 'wake', 'controller', 'Rate Exceeded.']);
  assert.equal(store.state.run.consecutiveFailures, 1);
});

test('FAILED: the retry delay doubles with each consecutive failure, at most 30 minutes (R7a)', async () => {
  for (const [failures, waitMs] of [[1, 60_000], [2, 120_000], [3, 240_000], [6, 1_800_000], [10, 1_800_000]]) {
    const before = setup({ run: { state: STATES.FAILED, consecutiveFailures: failures }, cfg: testConfig({ waitSeconds: 0 }) });
    before.store.state.run.failedAt = before.clock.now() - waitMs + 1000;
    await before.handler(albEvent());
    assert.equal(before.invocations.length, 0, `${failures} failures: not before ${waitMs} ms`);
    const after = setup({ run: { state: STATES.FAILED, consecutiveFailures: failures }, cfg: testConfig({ waitSeconds: 0 }) });
    after.store.state.run.failedAt = after.clock.now() - waitMs - 1000;
    await after.handler(albEvent());
    assert.equal(after.invocations.length, 1, `${failures} failures: after ${waitMs} ms`);
  }
});

test('FAILED: the waiting page says why and when the next attempt is (R7a)', async () => {
  const s = setup({ run: { state: STATES.FAILED, consecutiveFailures: 2, failure: JSON.stringify({ kind: 'capacity', step: 'wake', message: 'no capacity', at: 0 }) }, cfg: testConfig({ waitSeconds: 0 }) });
  s.store.state.run.failedAt = s.clock.now() - 30_000;
  const res = await s.handler(albEvent({ headers: { accept: 'text/html' } }));
  assert.equal(headerOf(res, 'x-dormeto-failure'), 'capacity');
  assert.equal(headerOf(res, 'x-dormeto-retry-at'), new Date(s.clock.now() + 90_000).toISOString());
  assert.match(res.body, /AWS has no capacity for this application right now: the start is retried, next attempt in 2 minutes/);
});
