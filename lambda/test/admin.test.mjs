import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdmin, hashSecret, napEstimate, parseAdminPath } from '../src/lib/admin.mjs';
import { lastRequestAt } from '../src/lib/metrics.mjs';
import { createWaker } from '../src/lib/waker-core.mjs';
import { STATES } from '../src/lib/state.mjs';
import { albEvent, fakeClock, fakeCloudWatch, fakeEc2, fakeElbv2, fakeStore, silentLog, testConfig } from './fakes.mjs';

const SECRET = 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z';
const BASE = `/_dormeto/${SECRET}`;
const adminConfig = (enabled = true) => testConfig({ admin: { enabled, secretHash: hashSecret(SECRET) } });

function setup({ run, cfg = adminConfig(), metric = [], timestamps = [] } = {}) {
  const clock = fakeClock();
  const store = fakeStore({ config: cfg, run, clock });
  const ec2 = fakeEc2(cfg.instanceIds, { state: run.state === STATES.AWAKE ? 'running' : 'stopped' });
  const elbv2 = fakeElbv2(cfg, { target: run.state === STATES.AWAKE ? 'app' : 'waker', healthy: run.state === STATES.AWAKE ? 1 : 0 });
  const cloudwatch = fakeCloudWatch(metric, timestamps);
  const invocations = [];
  const invokeController = async (payload) => { invocations.push(payload); };
  const admin = createAdmin({ ec2, elbv2, cloudwatch, invokeController, now: clock.now, log: silentLog });
  const handler = createWaker({
    store, invokeController, prefix: 'dmt-dev-', now: clock.now, sleep: clock.sleep,
    newId: () => 'wake-1', log: silentLog, getAdmin: async () => admin,
  });
  return { handler, store, clock, invocations, cloudwatch };
}

const headerOf = (res, name) => res.multiValueHeaders[name]?.[0];

test('parseAdminPath accepts only the configured secret', () => {
  const cfg = adminConfig();
  assert.deepEqual(parseAdminPath(BASE, cfg), { base: BASE, route: '' });
  assert.deepEqual(parseAdminPath(`${BASE}/`, cfg), { base: BASE, route: '' });
  assert.deepEqual(parseAdminPath(`${BASE}/status.json`, cfg), { base: BASE, route: 'status.json' });
  assert.equal(parseAdminPath('/_dormeto/wrong/status.json', cfg), null);
  assert.equal(parseAdminPath('/_dormeto/', cfg), null);
  assert.equal(parseAdminPath('/orders', cfg), null);
  assert.equal(parseAdminPath(BASE, adminConfig(false)), null);
  assert.equal(parseAdminPath(BASE, testConfig()), null);
});

test('napEstimate uses the latest of awakeSince and the last request', () => {
  const now = 10_000_000;
  const cfg = testConfig({ idleMinutes: 15 });
  const estimate = napEstimate({ cfg, run: { state: STATES.AWAKE, awakeSince: now - 600_000 }, lastRequest: now - 120_000, now });
  assert.deepEqual(estimate, { eligibleAt: now + 780_000, latestAt: now + 1_080_000, inSeconds: 780 });
  assert.equal(napEstimate({ cfg, run: { state: STATES.AWAKE, awakeSince: 0 }, lastRequest: null, now }).inSeconds, 0);
  assert.equal(napEstimate({ cfg, run: { state: STATES.ASLEEP }, lastRequest: null, now }), null);
});

test('lastRequestAt returns the end of the last minute with requests', async () => {
  const cloudwatch = fakeCloudWatch([0, 3, 0], [new Date(180_000), new Date(120_000), new Date(60_000)]);
  assert.equal(await lastRequestAt(cloudwatch, testConfig(), 0, 240_000), 180_000);
  assert.equal(await lastRequestAt(fakeCloudWatch([0], [new Date(60_000)]), testConfig(), 0, 120_000), null);
});

test('dashboard shows the state, time before nap and underlying resources', async () => {
  const { handler } = setup({ run: { state: STATES.AWAKE, awakeSince: 0, wakeCount: 4 } });
  const res = await handler(albEvent({ path: `${BASE}/` }));
  assert.equal(res.statusCode, 200);
  assert.match(headerOf(res, 'content-type'), /text\/html/);
  assert.equal(headerOf(res, 'cache-control'), 'no-store');
  assert.equal(headerOf(res, 'referrer-policy'), 'no-referrer');
  assert.match(headerOf(res, 'content-security-policy'), /default-src 'none'/);
  assert.match(res.body, /AWAKE/);
  assert.match(res.body, /i-0123456789abcdef0/);
  assert.match(res.body, new RegExp(`action="${BASE}/nap"`));
  assert.match(res.body, new RegExp(`action="${BASE}/wake"`));
  assert.match(res.body, /http-equiv="refresh" content="10"/);
  assert.doesNotMatch(res.body, /<script/);
});

test('status.json returns the same data as JSON', async () => {
  const { handler } = setup({ run: { state: STATES.AWAKE, wakeCount: 2, holders: 0 } });
  const res = await handler(albEvent({ path: `${BASE}/status.json`, headers: { accept: 'application/json' } }));
  const status = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.equal(status.workloadId, 'demo');
  assert.equal(status.state, STATES.AWAKE);
  assert.equal(status.route, 'app');
  assert.deepEqual(status.instances, [{ id: 'i-0123456789abcdef0', state: 'running' }]);
  assert.deepEqual(status.targets, [{ id: 'i-0', state: 'healthy' }]);
  assert.equal(status.wakeCount, 2);
  assert.equal(status.settings.idleMinutes, 15);
  assert.equal(typeof status.nap.inSeconds, 'number');
});

test('viewing the dashboard while asleep does not wake the workload', async () => {
  const { handler, store, invocations } = setup({ run: { state: STATES.ASLEEP } });
  const res = await handler(albEvent({ path: `${BASE}/status.json` }));
  assert.equal(JSON.parse(res.body).nap, null);
  assert.equal(JSON.parse(res.body).route, 'waker');
  assert.equal(store.state.run.state, STATES.ASLEEP);
  assert.equal(invocations.length, 0);
});

test('force nap invokes the controller and redirects to the dashboard', async () => {
  const { handler, invocations } = setup({ run: { state: STATES.AWAKE } });
  const res = await handler(albEvent({ method: 'POST', path: `${BASE}/nap` }));
  assert.equal(res.statusCode, 303);
  assert.equal(headerOf(res, 'location'), `${BASE}/?action=nap`);
  assert.deepEqual(invocations, [{ action: 'nap', workloadId: 'demo' }]);
});

test('force awake wakes an asleep workload, and a failed one without waiting for the retry delay', async () => {
  const asleep = setup({ run: { state: STATES.ASLEEP } });
  const res = await asleep.handler(albEvent({ method: 'POST', path: `${BASE}/wake` }));
  assert.equal(res.statusCode, 303);
  assert.equal(headerOf(res, 'location'), `${BASE}/?action=wake`);
  assert.equal(asleep.store.state.run.state, STATES.WAKING);
  assert.deepEqual(asleep.invocations, [{ action: 'wake', workloadId: 'demo', wakeId: 'wake-1' }]);

  const failed = setup({ run: { state: STATES.FAILED } });
  failed.store.state.run.failedAt = failed.clock.now() - 1_000;
  await failed.handler(albEvent({ method: 'POST', path: `${BASE}/wake` }));
  assert.equal(failed.store.state.run.state, STATES.WAKING);
});

test('force awake during a nap marks a pending wake', async () => {
  const { handler, store } = setup({ run: { state: STATES.NAPPING } });
  await handler(albEvent({ method: 'POST', path: `${BASE}/wake` }));
  assert.equal(store.state.run.pendingWake, true);
});

test('actions require POST and unknown routes are 404', async () => {
  const { handler, invocations } = setup({ run: { state: STATES.AWAKE } });
  assert.equal((await handler(albEvent({ path: `${BASE}/nap` }))).statusCode, 405);
  assert.equal((await handler(albEvent({ method: 'POST', path: `${BASE}/status.json` }))).statusCode, 405);
  assert.equal((await handler(albEvent({ path: `${BASE}/secrets` }))).statusCode, 404);
  assert.equal(invocations.length, 0);
});

test('a wrong secret is handled as a normal request', async () => {
  const { handler, store, invocations } = setup({ run: { state: STATES.ASLEEP }, cfg: adminConfig() });
  const res = await handler(albEvent({ path: '/_dormeto/not-the-secret/', headers: { accept: 'application/json' } }));
  assert.equal(res.statusCode, 503);
  assert.equal(store.state.run.state, STATES.WAKING);
  assert.equal(invocations[0].action, 'wake');
  assert.doesNotMatch(res.body, /workloadId/);
});

test('with the feature flag off the secret path is handled as a normal request', async () => {
  const { handler, store } = setup({ run: { state: STATES.ASLEEP }, cfg: adminConfig(false) });
  const res = await handler(albEvent({ path: `${BASE}/status.json`, headers: { accept: 'application/json' } }));
  assert.equal(res.statusCode, 503);
  assert.equal(store.state.run.state, STATES.WAKING);
});

test('the action message only reflects known actions', async () => {
  const { handler } = setup({ run: { state: STATES.AWAKE } });
  const ok = await handler(albEvent({ path: `${BASE}/`, query: { action: ['nap'] } }));
  assert.match(ok.body, /Nap requested/);
  const evil = await handler(albEvent({ path: `${BASE}/`, query: { action: ['%3Cscript%3E'] } }));
  assert.doesNotMatch(evil.body, /%3Cscript%3E|<script/);
});
