import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '../src/lib/log.mjs';
import { createWaker } from '../src/lib/waker-core.mjs';
import { STATES } from '../src/lib/state.mjs';
import { albEvent, fakeClock, fakeStore, testConfig } from './fakes.mjs';

function setup({ state = STATES.ASLEEP, cfg = {}, failCount = false } = {}) {
  const entries = [];
  const log = { info: (event, fields) => entries.push([event, fields]), warn: (event, fields) => entries.push([event, fields]), error() {} };
  const clock = fakeClock();
  const store = fakeStore({ config: testConfig({ waitSeconds: 0, ...cfg }), run: { state }, clock });
  if (failCount) store.count = async () => { throw new Error('throttled'); };
  const handler = createWaker({
    store, invokeController: async () => {}, prefix: 'dmt-dev-', now: clock.now, sleep: clock.sleep, newId: () => 'w1', log,
  });
  return { handler, store, entries };
}

test('ignored requests are counted per reason while the workload is not awake', async () => {
  const { handler, store } = setup();
  await handler(albEvent({ method: 'HEAD' }));
  await handler(albEvent({ headers: { 'user-agent': 'Googlebot/2.1' } }));
  await handler(albEvent({ headers: { 'user-agent': 'Googlebot/2.1' } }));
  assert.deepEqual(store.state.stats, { 'ignored:HEAD': 1, 'ignored:bot user agent': 2 });
});

test('requests reaching the waker while awake are not counted', async () => {
  const { handler, store } = setup({ state: STATES.AWAKE });
  await handler(albEvent({ method: 'HEAD' }));
  assert.deepEqual(store.state.stats, {});
});

test('wakes are counted per trigger, deferred requests in browser mode too', async () => {
  const { handler, store } = setup({ cfg: { wakeMode: 'browser' } });
  await handler(albEvent());
  await handler(albEvent({ headers: { 'x-dormeto-probe': '1', accept: '*/*' } }));
  assert.deepEqual(store.state.stats, { deferred: 1, 'wake:probe': 1 });
});

test('the pending wake of a nap is counted once', async () => {
  const { handler, store } = setup({ state: STATES.NAPPING });
  await handler(albEvent());
  await handler(albEvent());
  assert.deepEqual(store.state.stats, { 'wake:normal': 1 });
});

test('a failed counter update is logged and does not change the answer', async () => {
  const { handler, store, entries } = setup({ failCount: true });
  const res = await handler(albEvent({ method: 'HEAD' }));
  assert.equal(res.statusCode, 503);
  assert.equal(store.state.run.state, STATES.ASLEEP);
  assert.equal(entries.find(([e]) => e === 'StatsWriteFailed')[1].error, 'throttled');
  const wake = await handler(albEvent());
  assert.equal(wake.statusCode, 503);
  assert.equal(store.state.run.state, STATES.WAKING);
});

test('with metrics, counted events are written as CloudWatch embedded metric documents', () => {
  const lines = [];
  const raw = [];
  const log = createLogger({ metrics: { router: 'dmt-dev' }, out: (l) => lines.push(l), raw: (l) => raw.push(l), now: () => 1_700_000_000_000 });
  log.info('WakeIgnored', { workloadId: 'demo', reason: 'HEAD' });
  log.info('WakeRequested', { workloadId: 'demo', trigger: { kind: 'probe' } });
  log.info('WakeCompleted', { workloadId: 'demo' });
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), { level: 'info', event: 'WakeCompleted', workloadId: 'demo' });
  const [ignored, wake] = raw.map((l) => JSON.parse(l));
  assert.deepEqual(ignored, {
    level: 'info', event: 'WakeIgnored', workloadId: 'demo', reason: 'HEAD',
    Router: 'dmt-dev', WorkloadId: 'demo', IgnoredRequests: 1,
    _aws: { Timestamp: 1_700_000_000_000, CloudWatchMetrics: [{ Namespace: 'Dormeto', Dimensions: [['Router', 'WorkloadId']], Metrics: [{ Name: 'IgnoredRequests', Unit: 'Count' }] }] },
  });
  assert.equal(wake.Wakes, 1);
});

test('without metrics, the logger writes plain JSON lines', () => {
  const lines = [];
  const log = createLogger({ out: (l) => lines.push(l), raw: () => assert.fail('no raw line') });
  log.info('WakeIgnored', { workloadId: 'demo', reason: 'HEAD' });
  assert.deepEqual(JSON.parse(lines[0]), { level: 'info', event: 'WakeIgnored', workloadId: 'demo', reason: 'HEAD' });
});
