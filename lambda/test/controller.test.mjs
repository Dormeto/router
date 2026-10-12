import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../src/lib/controller-core.mjs';
import { STATES } from '../src/lib/state.mjs';
import { fakeClock, fakeCloudWatch, fakeEc2, fakeElbv2, fakeStore, routeOf, silentLog, testConfig } from './fakes.mjs';

function setup({ run, instance = 'running', target = 'app', healthy = 1, metric = [], cfg = testConfig() } = {}) {
  const clock = fakeClock();
  const store = fakeStore({ config: cfg, run, clock });
  const ec2 = fakeEc2(cfg.instanceIds, { state: instance });
  const elbv2 = fakeElbv2(cfg, { target, healthy });
  const cloudwatch = fakeCloudWatch(metric);
  let ids = 0;
  const handler = createController({
    store, ec2, elbv2, cloudwatch, now: clock.now, sleep: clock.sleep, newId: () => `wake-${++ids}`, log: silentLog,
  });
  return { handler, store, ec2, elbv2, cloudwatch, clock, cfg };
}

test('wake: starts the instance, waits for health, switches the route and becomes AWAKE', async () => {
  const s = setup({ run: { state: STATES.WAKING, wakeId: 'w1', holders: 3, pendingWake: true }, instance: 'stopped', target: 'waker', healthy: 0 });
  s.ec2.state.onStart.push(() => { s.clock.onSleep(() => { s.elbv2.state.healthy = 1; }); });
  const result = await s.handler({ action: 'wake', workloadId: 'demo', wakeId: 'w1' });
  assert.equal(result.state, STATES.AWAKE);
  assert.equal(s.ec2.state.started, 1);
  assert.equal(routeOf(s.elbv2, s.cfg), 'app');
  assert.equal(s.store.state.run.state, STATES.AWAKE);
  assert.equal(s.store.state.run.holders, 0);
  assert.equal('pendingWake' in s.store.state.run, false);
  assert.equal(s.store.state.run.awakeSince, s.clock.now());
});

test('wake: times out to FAILED and keeps the route on the waker', async () => {
  const s = setup({ run: { state: STATES.WAKING, wakeId: 'w1' }, instance: 'stopped', target: 'waker', healthy: 0 });
  const result = await s.handler({ action: 'wake', workloadId: 'demo', wakeId: 'w1' });
  assert.equal(result.state, STATES.FAILED);
  assert.equal(s.store.state.run.state, STATES.FAILED);
  assert.equal(s.store.state.run.failedAt, s.clock.now());
  assert.equal(routeOf(s.elbv2, s.cfg), 'waker');
});

test('wake: a superseded wakeId does not overwrite the state', async () => {
  const s = setup({ run: { state: STATES.WAKING, wakeId: 'newer' }, instance: 'stopped', target: 'waker' });
  const result = await s.handler({ action: 'wake', workloadId: 'demo', wakeId: 'older' });
  assert.equal(result.state, 'SUPERSEDED');
  assert.equal(s.store.state.run.state, STATES.WAKING);
  assert.equal(s.ec2.state.started, 0, 'no side effect');
  assert.equal(routeOf(s.elbv2, s.cfg), 'waker');
});

test('wake: a stale event after the workload went back to sleep has no side effect', async () => {
  const s = setup({ run: { state: STATES.ASLEEP }, instance: 'stopped', target: 'waker' });
  const result = await s.handler({ action: 'wake', workloadId: 'demo', wakeId: 'stale' });
  assert.equal(result.state, 'SUPERSEDED');
  assert.equal(s.ec2.state.started, 0);
  assert.equal(routeOf(s.elbv2, s.cfg), 'waker');
});

test('nap: switches to the waker, stops the instance and becomes ASLEEP', async () => {
  const s = setup({ run: { state: STATES.AWAKE } });
  const result = await s.handler({ action: 'nap', workloadId: 'demo' });
  assert.equal(result.state, STATES.ASLEEP);
  assert.equal(routeOf(s.elbv2, s.cfg), 'waker');
  assert.equal(s.ec2.state.instances[s.cfg.instanceIds[0]], 'stopped');
  assert.equal(s.store.state.run.state, STATES.ASLEEP);
  assert.equal('stopping' in s.store.state.run, false);
});

test('nap: skipped unless AWAKE', async () => {
  const s = setup({ run: { state: STATES.ASLEEP }, target: 'waker', instance: 'stopped' });
  assert.equal((await s.handler({ action: 'nap', workloadId: 'demo' })).state, 'SKIPPED');
});

test('nap: a request during the drain aborts the nap without stopping the instance', async () => {
  const s = setup({ run: { state: STATES.AWAKE } });
  s.clock.onSleep(() => { if (s.store.state.run.state === STATES.NAPPING) s.store.state.run.pendingWake = true; });
  const result = await s.handler({ action: 'nap', workloadId: 'demo' });
  assert.deepEqual(result, { state: STATES.AWAKE, aborted: true });
  assert.equal(s.ec2.state.stopped, 0);
  assert.equal(routeOf(s.elbv2, s.cfg), 'app');
  assert.equal(s.store.state.run.state, STATES.AWAKE);
  assert.equal('pendingWake' in s.store.state.run, false);
});

test('nap: a request after the stop commit wakes the workload right after the nap', async () => {
  const s = setup({ run: { state: STATES.AWAKE, wakeCount: 0 } });
  s.ec2.state.onStop.push(() => { s.store.state.run.pendingWake = true; });
  const result = await s.handler({ action: 'nap', workloadId: 'demo' });
  assert.equal(result.state, STATES.AWAKE);
  assert.equal(s.ec2.state.stopped, 1);
  assert.equal(s.ec2.state.started, 1);
  assert.equal(s.store.state.run.wakeCount, 1);
  assert.equal(routeOf(s.elbv2, s.cfg), 'app');
});

test('nap: a failure while stopping ends FAILED so that requests retry the wake', async () => {
  const s = setup({ run: { state: STATES.AWAKE } });
  s.ec2.stopInstances = async () => { throw new Error('UnauthorizedOperation'); };
  const result = await s.handler({ action: 'nap', workloadId: 'demo' });
  assert.equal(result.state, STATES.FAILED);
  assert.equal(s.store.state.run.state, STATES.FAILED);
});

test('check: naps an idle workload', async () => {
  const s = setup({ run: { state: STATES.AWAKE, awakeSince: 1 }, metric: [0, 0, 0] });
  const [result] = await s.handler({ action: 'check' });
  assert.equal(result.workloadId, 'demo');
  assert.equal(result.state, STATES.ASLEEP);
  const query = s.cloudwatch.calls[0];
  assert.equal(query.EndTime.getTime() - query.StartTime.getTime(), 15 * 60_000);
});

test('check: keeps a workload with requests awake', async () => {
  const s = setup({ run: { state: STATES.AWAKE, awakeSince: 1 }, metric: [0, 4] });
  const [result] = await s.handler({ action: 'check' });
  assert.deepEqual(result, { workloadId: 'demo', state: STATES.AWAKE, requests: 4 });
  assert.equal(s.ec2.state.stopped, 0);
});

test('check: starts the idle window on the first check after deployment instead of napping', async () => {
  const s = setup({ run: { state: STATES.AWAKE, awakeSince: 0 }, metric: [0, 0, 0] });
  const [result] = await s.handler({ action: 'check' });
  assert.deepEqual(result, { workloadId: 'demo', state: STATES.AWAKE });
  assert.equal(s.store.state.run.awakeSince, s.clock.now());
  assert.equal(s.ec2.state.stopped, 0);
  assert.equal(s.cloudwatch.calls.length, 0);
});

test('check: does not query metrics before idleMinutes of awake time', async () => {
  const s = setup({ run: { state: STATES.AWAKE } });
  s.store.state.run.awakeSince = s.clock.now() - 60_000;
  await s.handler({ action: 'check' });
  assert.equal(s.cloudwatch.calls.length, 0);
});

test('check: reconciles an instance started outside Dormeto', async () => {
  const s = setup({ run: { state: STATES.ASLEEP }, instance: 'running', target: 'waker', healthy: 1, metric: [1] });
  const [result] = await s.handler({ action: 'check' });
  assert.equal(result.state, STATES.AWAKE);
  assert.equal(routeOf(s.elbv2, s.cfg), 'app');
  assert.equal(s.store.state.run.awakeSince, s.clock.now());
});

test('check: reconciles an instance stopped outside Dormeto', async () => {
  const s = setup({ run: { state: STATES.AWAKE, awakeSince: 0 }, instance: 'stopped', target: 'app' });
  const [result] = await s.handler({ action: 'check' });
  assert.equal(result.state, STATES.ASLEEP);
  assert.equal(routeOf(s.elbv2, s.cfg), 'waker');
});

test('check: repairs a route reset while the workload sleeps', async () => {
  const s = setup({ run: { state: STATES.ASLEEP }, instance: 'stopped', target: 'app' });
  await s.handler({ action: 'check' });
  assert.equal(routeOf(s.elbv2, s.cfg), 'waker');
});

test('check: releases a nap stuck for 15 minutes to FAILED', async () => {
  const s = setup({ run: { state: STATES.NAPPING } });
  s.store.state.run.updatedAt = s.clock.now() - 16 * 60_000;
  const [result] = await s.handler({ action: 'check' });
  assert.equal(result.state, STATES.FAILED);
});

test('check: an error on one workload is reported, not thrown', async () => {
  const s = setup({ run: { state: STATES.AWAKE, awakeSince: 0 } });
  s.ec2.describeInstances = async () => { throw new Error('throttled'); };
  const [result] = await s.handler({ action: 'check' });
  assert.deepEqual(result, { workloadId: 'demo', error: 'throttled' });
});

test('ensure-awake switches the route back when the workload is awake and healthy', async () => {
  const s = setup({ run: { state: STATES.AWAKE }, target: 'waker', healthy: 1 });
  const result = await s.handler({ action: 'ensure-awake', workloadId: 'demo' });
  assert.equal(result.changed, true);
  assert.equal(routeOf(s.elbv2, s.cfg), 'app');
});

test('unknown actions are rejected', async () => {
  const s = setup({ run: { state: STATES.AWAKE } });
  await assert.rejects(s.handler({ action: 'dance' }), /unknown action/);
});

test('check: recovers FAILED with a running healthy instance to AWAKE', async () => {
  const s = setup({ run: { state: STATES.FAILED, failedAt: 1 }, instance: 'running', target: 'waker', healthy: 1 });
  const [result] = await s.handler({ action: 'check' });
  assert.equal(result.state, STATES.AWAKE);
  assert.equal(routeOf(s.elbv2, s.cfg), 'app');
});

test('check: recovers FAILED with a stopped instance to ASLEEP behind the waker', async () => {
  const s = setup({ run: { state: STATES.FAILED, failedAt: 1 }, instance: 'stopped', target: 'app', healthy: 0 });
  const [result] = await s.handler({ action: 'check' });
  assert.equal(result.state, STATES.ASLEEP);
  assert.equal(routeOf(s.elbv2, s.cfg), 'waker');
});

test('check: keeps a FAILED workload with an unhealthy instance behind the waker', async () => {
  const s = setup({ run: { state: STATES.FAILED, failedAt: 1 }, instance: 'running', target: 'app', healthy: 0 });
  const [result] = await s.handler({ action: 'check' });
  assert.equal(result.state, STATES.FAILED);
  assert.equal(routeOf(s.elbv2, s.cfg), 'waker');
});

test('check: releases a wake stuck beyond wakeTimeoutSeconds to FAILED', async () => {
  const s = setup({ run: { state: STATES.WAKING, wakeId: 'w' } });
  s.store.state.run.wakeStartedAt = s.clock.now() - 12 * 60_000;
  const [result] = await s.handler({ action: 'check' });
  assert.equal(result.state, STATES.FAILED);
});

// --- discovery mode (no static instanceIds) ---------------------------------------------------------------------

function discovery({ run, instances, tags, target = 'app' }) {
  const s = setup({ run, cfg: testConfig({ instanceIds: [] }), target });
  s.ec2.state.instances = Object.fromEntries(Object.entries(instances).map(([id, v]) => [id, v.state]));
  s.ec2.state.tags = tags;
  s.elbv2.state.targets = Object.entries(instances).map(([id, v]) => ({ Id: id, State: v.health }));
  return s;
}

test('nap (discovery): stops only the managed instances and records them', async () => {
  const s = discovery({
    run: { state: STATES.AWAKE },
    instances: { 'i-a': { state: 'running', health: 'healthy' }, 'i-x': { state: 'running', health: 'healthy' } },
    tags: { 'i-a': { 'dormeto:workload': 'demo' } },
  });
  const result = await s.handler({ action: 'nap', workloadId: 'demo' });
  assert.equal(result.state, STATES.ASLEEP);
  assert.equal(s.ec2.state.instances['i-a'], 'stopped');
  assert.equal(s.ec2.state.instances['i-x'], 'running', 'untagged target is never stopped');
  assert.equal(s.store.state.run.napInstances, '["i-a"]');
});

test('nap (discovery): skipped when no instance is managed', async () => {
  const s = discovery({
    run: { state: STATES.AWAKE },
    instances: { 'i-x': { state: 'running', health: 'healthy' } },
    tags: {},
  });
  const result = await s.handler({ action: 'nap', workloadId: 'demo' });
  assert.deepEqual(result, { state: 'SKIPPED', reason: 'no-instances' });
  assert.equal(s.store.state.run.state, STATES.AWAKE);
  assert.equal(routeOf(s.elbv2, s.cfg), 'app');
  assert.equal(s.ec2.state.stopped, 0);
});

test('wake (discovery): starts the instances recorded by the nap', async () => {
  const s = discovery({
    run: { state: STATES.WAKING, wakeId: 'w1', napInstances: '["i-a"]' },
    instances: { 'i-a': { state: 'stopped', health: 'unused' }, 'i-b': { state: 'stopped', health: 'unused' } },
    tags: { 'i-a': { 'dormeto:workload': 'demo' }, 'i-b': { 'dormeto:workload': 'demo' } },
    target: 'waker',
  });
  s.ec2.state.onStart.push(() => { s.elbv2.state.targets[0].State = 'healthy'; });
  const result = await s.handler({ action: 'wake', workloadId: 'demo', wakeId: 'w1' });
  assert.equal(result.state, STATES.AWAKE);
  assert.equal(s.ec2.state.instances['i-a'], 'running');
  assert.equal(s.ec2.state.instances['i-b'], 'stopped', 'only the napped instances are started');
  assert.equal('napInstances' in s.store.state.run, false);
});

test('check (discovery): reconciles on the discovered instances', async () => {
  const s = discovery({
    run: { state: STATES.ASLEEP },
    instances: { 'i-a': { state: 'running', health: 'healthy' } },
    tags: { 'i-a': { 'dormeto:workload': 'demo' } },
    target: 'waker',
  });
  const [result] = await s.handler({ action: 'check' });
  assert.equal(result.state, STATES.AWAKE);
  assert.equal(routeOf(s.elbv2, s.cfg), 'app');
});

test('check (discovery): no managed instance leaves the state alone and keeps the route consistent', async () => {
  const s = discovery({ run: { state: STATES.ASLEEP }, instances: {}, tags: {}, target: 'app' });
  const [result] = await s.handler({ action: 'check' });
  assert.equal(result.state, STATES.ASLEEP);
  assert.equal(routeOf(s.elbv2, s.cfg), 'waker');
});

test('check (discovery): an AWAKE workload without managed instance is not marked ASLEEP', async () => {
  const s = discovery({ run: { state: STATES.AWAKE, awakeSince: 1 }, instances: {}, tags: {}, target: 'app' });
  await s.handler({ action: 'check' });
  assert.notEqual(s.store.state.run.state, STATES.ASLEEP);
  assert.equal(routeOf(s.elbv2, s.cfg), 'app');
});
