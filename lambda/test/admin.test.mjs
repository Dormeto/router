import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdmin, hashSecret, napEstimate, parseAdminPath } from '../src/lib/admin.mjs';
import { lastRequestAt } from '../src/lib/metrics.mjs';
import { createWaker } from '../src/lib/waker-core.mjs';
import { STATES } from '../src/lib/state.mjs';
import { albEvent, asgGroup, ecsService, fakeAppScaling, fakeEcs, fakeRds, fakeRdsTagging, fakeTagging, fakeAutoScaling, fakeClock, fakeCloudWatch, fakeEc2, fakeElbv2, fakeStore, silentLog, testConfig } from './fakes.mjs';

const SECRET = 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z';
const BASE = `/_dormeto/${SECRET}`;
const adminConfig = (enabled = true) => testConfig({ admin: { enabled, secretHash: hashSecret(SECRET) } });

function setup({ run, cfg = adminConfig(), metric = [], timestamps = [], defaultRules, listCache } = {}) {
  const clock = fakeClock();
  const store = fakeStore({ config: cfg, run, clock });
  const ec2 = fakeEc2(cfg.instanceIds, { state: run.state === STATES.AWAKE ? 'running' : 'stopped' });
  const elbv2 = fakeElbv2(cfg, { target: run.state === STATES.AWAKE ? 'app' : 'waker', healthy: run.state === STATES.AWAKE ? 1 : 0 });
  const cloudwatch = fakeCloudWatch(metric, timestamps);
  const invocations = [];
  const invokeController = async (payload) => { invocations.push(payload); };
  const autoscaling = fakeAutoScaling();
  const ecs = fakeEcs();
  const tagging = fakeTagging(ecs);
  const appscaling = fakeAppScaling();
  const admin = createAdmin({ ec2, elbv2, cloudwatch, autoscaling, ecs, tagging, appscaling, invokeController, now: clock.now, log: silentLog, version: { version: '0.3.0', build: 'abc123def456' } });
  const handler = createWaker({
    store, invokeController, prefix: 'dmt-dev-', now: clock.now, sleep: clock.sleep,
    newId: () => 'wake-1', log: silentLog, getAdmin: async () => admin, defaultRules, listCache,
  });
  return { handler, store, clock, invocations, cloudwatch, ec2, elbv2, autoscaling, ecs };
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
  assert.match(res.body, /http-equiv="refresh" content="10; url=/);
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

test('a wrong secret gets a 404 and never wakes the workload', async () => {
  const { handler, store, invocations } = setup({ run: { state: STATES.ASLEEP }, cfg: adminConfig() });
  const res = await handler(albEvent({ path: '/_dormeto/not-the-secret/', headers: { accept: 'application/json' } }));
  assert.equal(res.statusCode, 404);
  assert.equal(store.state.run.state, STATES.ASLEEP);
  assert.equal(invocations.length, 0);
  assert.doesNotMatch(res.body, /workloadId/);
});

test('a wrong secret while awake gets a 404, not a redirect loop', async () => {
  const { handler, invocations } = setup({ run: { state: STATES.AWAKE }, cfg: adminConfig() });
  const res = await handler(albEvent({ path: '/_dormeto/not-the-secret/status.json' }));
  assert.equal(res.statusCode, 404);
  assert.equal(invocations.length, 0);
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

test('status.json (discovery) lists the managed instances and the ignored targets', async () => {
  const cfg = testConfig({ instanceIds: [], admin: { enabled: true, secretHash: hashSecret(SECRET) } });
  const { handler, ec2, elbv2 } = setup({ run: { state: STATES.AWAKE }, cfg });
  ec2.state.instances = { 'i-a': 'running', 'i-x': 'running' };
  ec2.state.tags = { 'i-a': { 'dormeto:workload': 'demo' } };
  elbv2.state.targets = [{ Id: 'i-a', State: 'healthy' }, { Id: 'i-x', State: 'healthy' }];
  const status = JSON.parse((await handler(albEvent({ path: `${BASE}/status.json` }))).body);
  assert.equal(status.discovery, 'discovery');
  assert.deepEqual(status.instances, [{ id: 'i-a', state: 'running' }]);
  assert.deepEqual(status.ignoredTargets, [{ id: 'i-x', reason: 'untagged' }]);
});

test('the dashboard refresh drops the action message', async () => {
  const { handler } = setup({ run: { state: STATES.AWAKE } });
  const res = await handler(albEvent({ path: `${BASE}/`, query: { action: ['nap'] } }));
  assert.match(res.body, new RegExp(`http-equiv="refresh" content="10; url=${BASE}/"`));
});

test('HEAD is accepted on the dashboard routes without a body', async () => {
  const { handler } = setup({ run: { state: STATES.AWAKE } });
  for (const path of [`${BASE}/`, `${BASE}/status.json`]) {
    const res = await handler(albEvent({ method: 'HEAD', path }));
    assert.equal(res.statusCode, 200, path);
    assert.equal(res.body, '');
  }
});

test('status.json lists every backend with its status, including Auto Scaling groups', async () => {
  const cfg = testConfig({ instanceIds: [], admin: { enabled: true, secretHash: hashSecret(SECRET) } });
  const { handler, ec2, elbv2, autoscaling } = setup({ run: { state: STATES.AWAKE }, cfg });
  ec2.state.instances = { 'i-a': 'running' };
  ec2.state.tags = { 'i-a': { 'dormeto:workload': 'demo' } };
  elbv2.state.targets = [{ Id: 'i-a', State: 'healthy' }];
  autoscaling.state.groups = [asgGroup('asg-demo', { min: 1, max: 2, desired: 1, targetGroups: [cfg.appTargetGroupArn], tags: { 'dormeto:workload': 'demo' } })];
  const res = await handler(albEvent({ path: `${BASE}/status.json` }));
  const status = JSON.parse(res.body);
  assert.deepEqual(status.backends, [
    { kind: 'instance', id: 'i-a', status: 'running' },
    { kind: 'asg', id: 'asg-demo', status: 'running', min: 1, max: 2, desired: 1, warmPool: false },
  ]);
  assert.deepEqual(status.instances, [{ id: 'i-a', state: 'running' }]);
  const html = await handler(albEvent({ path: `${BASE}/` }));
  assert.match(html.body, /asg-demo: running \(min 1, desired 1, max 2\)/);
});

test('status.json and the dashboard show the router version and build', async () => {
  const { handler } = setup({ run: { state: STATES.AWAKE } });
  const status = JSON.parse((await handler(albEvent({ path: `${BASE}/status.json` }))).body);
  assert.deepEqual(status.router, { version: '0.3.0', build: 'abc123def456' });
  const html = (await handler(albEvent({ path: `${BASE}/` }))).body;
  assert.match(html, /Router 0\.3\.0 \(build abc123def456\)/);
});

test('status.json lists an ECS service backend', async () => {
  const cfg = testConfig({ instanceIds: [], admin: { enabled: true, secretHash: hashSecret(SECRET) } });
  const { handler, ecs } = setup({ run: { state: STATES.AWAKE }, cfg });
  ecs.state.services = [ecsService('web', { desired: 2, targetGroups: [cfg.appTargetGroupArn], tags: { 'dormeto:workload': 'demo' } })];
  const status = JSON.parse((await handler(albEvent({ path: `${BASE}/status.json` }))).body);
  assert.deepEqual(status.backends, [{ kind: 'ecs', id: 'arn:aws:ecs:eu-west-1:111122223333:service/dmt-dev/web', status: 'running', desired: 2, scalable: null }]);
  const html = (await handler(albEvent({ path: `${BASE}/` }))).body;
  assert.match(html, /service\/dmt-dev\/web: running \(desired 2\)/);
});

test('status.json lists a database companion with its status', async () => {
  const cfg = testConfig({ admin: { enabled: true, secretHash: hashSecret(SECRET) } });
  const clock = fakeClock();
  const store = fakeStore({ config: cfg, run: { state: STATES.AWAKE }, clock });
  const rds = fakeRds({ instances: { appdb: { status: 'available', tags: { 'dormeto:workload': 'demo' } } } });
  const admin = createAdmin({
    ec2: fakeEc2(cfg.instanceIds), elbv2: fakeElbv2(cfg), cloudwatch: fakeCloudWatch(), autoscaling: fakeAutoScaling(),
    ecs: fakeEcs(), tagging: fakeRdsTagging(rds), appscaling: fakeAppScaling(), rds,
    invokeController: async () => {}, now: clock.now, log: silentLog,
  });
  const handler = createWaker({ store, invokeController: async () => {}, prefix: 'dmt-dev-', now: clock.now, sleep: clock.sleep, log: silentLog, getAdmin: async () => admin });
  const status = JSON.parse((await handler(albEvent({ path: `${BASE}/status.json` }))).body);
  assert.deepEqual(status.backends.at(-1), { kind: 'rds-instance', id: 'appdb', status: 'running', companion: true });
  const html = (await handler(albEvent({ path: `${BASE}/` }))).body;
  assert.match(html, /appdb \(database\): running/);
});

test('status.json and the dashboard list the router and workload no-wake rules', async () => {
  const cfg = testConfig({
    admin: { enabled: true, secretHash: hashSecret(SECRET) },
    noWakeRules: [{ name: 'office', sourceIps: ['198.51.100.0/24'], pathPattern: null }, { name: 'broken', userAgentPattern: '(' }],
  });
  const defaultRules = [{ name: 'e2e', headers: [{ name: 'x-dormeto-e2e', value: 'no-wake' }] }];
  const { handler } = setup({ run: { state: STATES.AWAKE }, cfg, defaultRules });
  const status = JSON.parse((await handler(albEvent({ path: `${BASE}/status.json`, headers: { accept: 'application/json' } }))).body);
  assert.deepEqual(status.noWakeRules.map((r) => [r.name, r.level]), [['e2e', 'router'], ['office', 'workload'], ['broken', 'workload']]);
  assert.deepEqual(status.noWakeRules[1].conditions, { sourceIps: ['198.51.100.0/24'] });
  assert.match(status.noWakeRules[2].invalid, /userAgentPattern/);
  const page = (await handler(albEvent({ path: `${BASE}/` }))).body;
  assert.match(page, /No-wake rules/);
  assert.match(page, /e2e \(router\): header x-dormeto-e2e = no-wake/);
  assert.match(page, /office \(workload\): source 198\.51\.100\.0\/24/);
  assert.match(page, /broken \(workload\): invalid/);
});

test('status.json and the dashboard show the wake mode and the wake rules', async () => {
  const cfg = testConfig({
    admin: { enabled: true, secretHash: hashSecret(SECRET) },
    wakeMode: 'browser',
    wakeRules: [{ name: 'api', pathPrefixes: ['/api/'] }],
  });
  const { handler } = setup({ run: { state: STATES.AWAKE }, cfg });
  const status = JSON.parse((await handler(albEvent({ path: `${BASE}/status.json`, headers: { accept: 'application/json' } }))).body);
  assert.equal(status.wakeMode, 'browser');
  assert.deepEqual(status.wakeRules, [{ name: 'api', level: 'wake', conditions: { pathPrefixes: ['/api/'] } }]);
  const page = (await handler(albEvent({ path: `${BASE}/` }))).body;
  assert.match(page, /Wake mode<\/th><td>browser: the waiter page probe, the x-dormeto-wake header or a wake rule wakes/);
  assert.match(page, /api \(wake\): path \/api\/\*/);
});

test('the wake mode defaults to any', async () => {
  const { handler } = setup({ run: { state: STATES.AWAKE } });
  const status = JSON.parse((await handler(albEvent({ path: `${BASE}/status.json`, headers: { accept: 'application/json' } }))).body);
  assert.equal(status.wakeMode, 'any');
  assert.deepEqual(status.wakeRules, []);
});

test('status.json and the dashboard show the statistics of the last 7 days', async () => {
  const { handler, store } = setup({ run: { state: STATES.AWAKE } });
  store.state.stats = { 'ignored:HEAD': 2, 'ignored:rule office': 1, 'deferred:browser mode': 3, 'wake:probe': 4 };
  const status = JSON.parse((await handler(albEvent({ path: `${BASE}/status.json`, headers: { accept: 'application/json' } }))).body);
  assert.equal(status.stats.days, 7);
  assert.deepEqual(status.stats.total, { ignored: { HEAD: 2, 'rule office': 1 }, deferred: { 'browser mode': 3 }, wakes: { probe: 4 } });
  const page = (await handler(albEvent({ path: `${BASE}/` }))).body;
  assert.match(page, /Ignored requests \(today · 7 days\)<\/th><td>HEAD 2 · 2, rule office 1 · 1/);
  assert.match(page, /Deferred requests \(today · 7 days\)<\/th><td>browser mode 3 · 3/);
  assert.match(page, /Wakes by trigger \(today · 7 days\)<\/th><td>probe 4 · 4/);
});

test('statistics that cannot be read do not break the status', async () => {
  const { handler, store } = setup({ run: { state: STATES.AWAKE } });
  store.getStats = async () => { throw new Error('AccessDenied'); };
  const status = JSON.parse((await handler(albEvent({ path: `${BASE}/status.json`, headers: { accept: 'application/json' } }))).body);
  assert.equal(status.state, STATES.AWAKE);
  assert.deepEqual(status.stats, { error: 'AccessDenied' });
});

test('status.json and the dashboard show the IP lists', async () => {
  const listCache = {
    get: async () => [],
    describe: async () => [
      { name: 'ipsum', action: 'defer', entries: 109695, dropped: 0, fetchedAt: '2026-10-04T10:00:00.000Z' },
      { name: 'cloud', action: 'defer', entries: 0, dropped: 0, fetchedAt: null, error: 'not downloaded yet' },
    ],
  };
  const { handler } = setup({ run: { state: STATES.AWAKE }, listCache });
  const status = JSON.parse((await handler(albEvent({ path: `${BASE}/status.json`, headers: { accept: 'application/json' } }))).body);
  assert.deepEqual(status.ipLists.map((l) => [l.name, l.entries]), [['ipsum', 109695], ['cloud', 0]]);
  const page = (await handler(albEvent({ path: `${BASE}/` }))).body;
  assert.match(page, /IP lists<\/th><td>ipsum \(defer\): 109695 entries, 2026-10-04T10:00:00.000Z; cloud \(defer\): not downloaded yet/);
});
