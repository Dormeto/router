import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../src/lib/http.mjs';
import { compileRules } from '../src/lib/no-wake.mjs';
import { renderJson, renderPage } from '../src/lib/page.mjs';
import { createWaker } from '../src/lib/waker-core.mjs';
import { STATES } from '../src/lib/state.mjs';
import { albEvent, fakeClock, fakeStore, testConfig } from './fakes.mjs';

const PROBE = { 'x-dormeto-probe': '1', accept: '*/*' };
const browser = (extra = {}) => ({ browserMode: true, ...extra });

test('classify: filters apply before the waiter probe, in both modes', () => {
  assert.deepEqual(classify(albEvent({ headers: { ...PROBE, 'user-agent': 'Googlebot/2.1' } })), { kind: 'no-wake', reason: 'bot user agent' });
  assert.deepEqual(classify(albEvent({ path: '/.env', headers: PROBE })), { kind: 'no-wake', reason: 'scanner path' });
  assert.deepEqual(classify(albEvent({ method: 'HEAD', headers: PROBE }), [], browser()), { kind: 'no-wake', reason: 'HEAD' });
  assert.deepEqual(classify(albEvent({ headers: PROBE })), { kind: 'probe' });
});

test('classify: browser mode wakes on the probe, the wake header or a wake rule only', () => {
  const wakeRules = compileRules([{ name: 'api', pathPrefixes: ['/api/'] }], { level: 'wake' });
  const noWake = compileRules([{ name: 'office', headers: [{ name: 'x-office', value: '1' }] }]);
  assert.deepEqual(classify(albEvent(), [], browser({ wakeRules })), { kind: 'normal', deferred: true, reason: 'browser mode' });
  assert.deepEqual(classify(albEvent({ headers: PROBE }), [], browser()), { kind: 'probe' });
  assert.deepEqual(classify(albEvent({ headers: { 'x-dormeto-wake': '1' } }), [], browser()), { kind: 'normal', trigger: 'header' });
  assert.deepEqual(classify(albEvent({ path: '/api/orders' }), [], browser({ wakeRules })), { kind: 'normal', trigger: 'rule api' });
  assert.deepEqual(classify(albEvent({ path: '/api/orders', headers: { 'x-office': '1' } }), noWake, browser({ wakeRules })),
    { kind: 'no-wake', reason: 'rule office' }, 'no-wake rules win over wake rules');
  assert.deepEqual(classify(albEvent({ headers: { 'x-dormeto-wake': '1' } })), { kind: 'normal', trigger: 'header' }, 'explicit in any mode too');
});

test('the waiter page probes at once, then every pollSeconds', () => {
  const page = renderPage({ state: STATES.ASLEEP, pollSeconds: 3 });
  assert.match(page, /\n {2}probe\(\);\n/);
  assert.doesNotMatch(page, /setTimeout\(probe, pollMs\);\n\}\)\(\);/);
});

test('the JSON answer names the wake header when asked to', () => {
  assert.deepEqual(JSON.parse(renderJson({ state: STATES.ASLEEP, pollSeconds: 3, wakeHeader: 'x-dormeto-wake' })),
    { status: 'asleep', retryAfter: 3, wakeHeader: 'x-dormeto-wake' });
  assert.deepEqual(JSON.parse(renderJson({ state: STATES.WAKING, pollSeconds: 3 })), { status: 'waking', retryAfter: 3 });
});

function setup({ state = STATES.ASLEEP, cfg = {} } = {}) {
  const entries = [];
  const log = { info: (event, fields) => entries.push([event, fields]), warn() {}, error() {} };
  const clock = fakeClock();
  const config = testConfig({ waitSeconds: 20, wakeMode: 'browser', ...cfg });
  const store = fakeStore({ config, run: { state }, clock });
  const invocations = [];
  let ids = 0;
  const handler = createWaker({
    store, invokeController: async (payload) => { invocations.push(payload); }, prefix: 'dmt-dev-',
    now: clock.now, sleep: clock.sleep, newId: () => `w${++ids}`, log,
  });
  return { handler, store, clock, entries, invocations, wakes: () => invocations.filter((i) => i.action === 'wake').length };
}

const headerOf = (res, name) => res.multiValueHeaders[name]?.[0];

test('browser mode: a plain request gets the waiter page at once without waking', async () => {
  const { handler, store, clock, entries, wakes } = setup();
  const start = clock.now();
  const res = await handler(albEvent({ path: '/orders' }));
  assert.equal(res.statusCode, 503);
  assert.equal(headerOf(res, 'x-dormeto-state'), STATES.ASLEEP);
  assert.match(res.body, /x-dormeto-probe/);
  assert.equal(clock.now(), start, 'no hold');
  assert.equal(wakes(), 0);
  assert.equal(store.state.run.state, STATES.ASLEEP);
  const [, fields] = entries.find(([e]) => e === 'WakeDeferred');
  assert.equal(fields.trigger.path, '/orders');

  const api = await handler(albEvent({ headers: { accept: 'application/json' } }));
  assert.equal(JSON.parse(api.body).wakeHeader, 'x-dormeto-wake');
});

test('browser mode: the page probe starts the wake', async () => {
  const { handler, store, entries, wakes } = setup();
  const res = await handler(albEvent({ headers: PROBE }));
  assert.equal(res.statusCode, 503);
  assert.equal(wakes(), 1);
  assert.equal(store.state.run.state, STATES.WAKING);
  assert.equal(entries.find(([e]) => e === 'WakeRequested')[1].trigger.kind, 'probe');
});

test('browser mode: the wake header and wake rules start the wake and hold the request', async () => {
  for (const [event, kind] of [
    [albEvent({ headers: { 'x-dormeto-wake': '1', accept: 'application/json' } }), 'header'],
    [albEvent({ path: '/api/orders', headers: { accept: 'application/json' } }), 'rule api'],
  ]) {
    const { handler, store, clock, entries, wakes } = setup({ cfg: { wakeRules: [{ name: 'api', pathPrefixes: ['/api/'] }] } });
    const start = clock.now();
    clock.onSleep((t) => { if (t - start >= 4000) store.state.run.state = STATES.AWAKE; });
    const res = await handler(event);
    assert.equal(res.statusCode, 307, kind);
    assert.equal(wakes(), 1);
    assert.equal(entries.find(([e]) => e === 'WakeRequested')[1].trigger.kind, kind);
  }
});

test('browser mode: a plain request is held while a wake is in progress', async () => {
  const { handler, store, clock, wakes } = setup({ state: STATES.WAKING });
  store.state.run.wakeStartedAt = clock.now();
  const start = clock.now();
  clock.onSleep((t) => { if (t - start >= 3000) store.state.run.state = STATES.AWAKE; });
  const res = await handler(albEvent());
  assert.equal(res.statusCode, 307);
  assert.equal(wakes(), 0);
});

test('browser mode: a plain request during a nap does not mark a pending wake, the probe does', async () => {
  const { handler, store, clock } = setup({ state: STATES.NAPPING });
  const start = clock.now();
  await handler(albEvent());
  assert.equal(clock.now(), start, 'no hold while napping');
  assert.notEqual(store.state.run.pendingWake, true);
  await handler(albEvent({ headers: PROBE }));
  assert.equal(store.state.run.pendingWake, true);
});
