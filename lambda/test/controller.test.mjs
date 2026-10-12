import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../src/lib/controller-core.mjs';
import { STATES } from '../src/lib/state.mjs';
import { asgGroup, ecsService, fakeAppScaling, fakeEcs, fakeRds, fakeRdsTagging, fakeTagging, fakeAutoScaling, fakeClock, fakeCloudWatch, fakeEc2, fakeElbv2, fakeStore, routeOf, silentLog, testConfig } from './fakes.mjs';

function setup({ run, instance = 'running', target = 'app', healthy = 1, metric = [], cfg = testConfig(), groups = [], services = [], databases } = {}) {
  const clock = fakeClock();
  const store = fakeStore({ config: cfg, run, clock });
  const ec2 = fakeEc2(cfg.instanceIds, { state: instance });
  const elbv2 = fakeElbv2(cfg, { target, healthy });
  const cloudwatch = fakeCloudWatch(metric);
  const autoscaling = fakeAutoScaling(groups);
  const ecs = fakeEcs(services);
  const rds = databases ? fakeRds(databases) : undefined;
  const ecsTagging = fakeTagging(ecs);
  const rdsTagging = rds ? fakeRdsTagging(rds) : null;
  const tagging = { getResources: (input) => (input.ResourceTypeFilters.includes('ecs:service') || !rdsTagging ? ecsTagging : rdsTagging).getResources(input) };
  const appscaling = fakeAppScaling();
  let ids = 0;
  const invocations = [];
  const handler = createController({
    store, ec2, elbv2, cloudwatch, autoscaling, ecs, tagging, appscaling, rds, invokeSelf: async (payload) => { invocations.push(payload); }, now: clock.now, sleep: clock.sleep, newId: () => `wake-${++ids}`, log: silentLog,
  });
  return { handler, store, ec2, elbv2, cloudwatch, autoscaling, ecs, appscaling, rds, clock, cfg, invocations };
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

test('check: requests the nap of an idle workload asynchronously, without napping inline', async () => {
  const s = setup({ run: { state: STATES.AWAKE, awakeSince: 1 }, metric: [0, 0, 0] });
  const [result] = await s.handler({ action: 'check' });
  assert.deepEqual(result, { workloadId: 'demo', state: STATES.AWAKE, nap: 'requested' });
  assert.deepEqual(s.invocations, [{ action: 'nap', workloadId: 'demo' }]);
  assert.equal(s.ec2.state.stopped, 0, 'the check itself does not stop anything');
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
  assert.deepEqual(JSON.parse(s.store.state.run.napBackends), [{ kind: 'instance', id: 'i-a' }]);
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

// --- cleanup: holders, time budget, config errors ----------------------------------------------------------------

test('wake failure resets the held-request counter', async () => {
  const s = setup({ run: { state: STATES.WAKING, wakeId: 'w1', holders: 3 }, instance: 'stopped', target: 'waker', healthy: 0 });
  await s.handler({ action: 'wake', workloadId: 'demo', wakeId: 'w1' });
  assert.equal(s.store.state.run.state, STATES.FAILED);
  assert.equal(s.store.state.run.holders, 0);
});

test('a completed nap resets the held-request counter', async () => {
  const s = setup({ run: { state: STATES.AWAKE, holders: 2 } });
  await s.handler({ action: 'nap', workloadId: 'demo' });
  assert.equal(s.store.state.run.state, STATES.ASLEEP);
  assert.equal(s.store.state.run.holders, 0);
});

test('check clears a leaked held-request counter outside a wake', async () => {
  const s = setup({ run: { state: STATES.AWAKE, awakeSince: 1, holders: 4 }, metric: [1] });
  await s.handler({ action: 'check' });
  assert.equal(s.store.state.run.holders, 0);
});

test('wake hands over to a new invocation before the Lambda timeout instead of failing', async () => {
  const s = setup({ run: { state: STATES.WAKING, wakeId: 'w1' }, instance: 'stopped', target: 'waker', healthy: 0 });
  s.store.state.run.wakeStartedAt = s.clock.now();
  const start = s.clock.now();
  const result = await s.handler({ action: 'wake', workloadId: 'demo', wakeId: 'w1' }, { getRemainingTimeInMillis: () => 60_000 });
  assert.deepEqual(result, { state: STATES.WAKING, continued: true });
  assert.ok(s.clock.now() - start <= 33_000, `handed over after ${s.clock.now() - start} ms`);
  assert.deepEqual(s.invocations, [{ action: 'wake', workloadId: 'demo', wakeId: 'w1' }]);
});

test('a configuration read error during wake ends FAILED instead of a stuck WAKING', async () => {
  const s = setup({ run: { state: STATES.WAKING, wakeId: 'w1' } });
  s.store.getConfig = async () => { throw new Error('ProvisionedThroughputExceededException'); };
  const result = await s.handler({ action: 'wake', workloadId: 'demo', wakeId: 'w1' });
  assert.equal(result.state, STATES.FAILED);
  assert.equal(s.store.state.run.state, STATES.FAILED);
});

// --- Auto Scaling group backends -------------------------------------------------------------------------------

const ASG_TAGS = { 'dormeto:workload': 'demo' };

function asgSetup({ run, desired = 1, target = 'app', healthy = 1 }) {
  const cfg = testConfig({ instanceIds: [] });
  const s = setup({
    run, cfg, target, healthy,
    groups: [asgGroup('asg-demo', { min: desired, max: 3, desired, targetGroups: [cfg.appTargetGroupArn], tags: ASG_TAGS })],
  });
  s.elbv2.state.healthy = healthy;
  return s;
}

test('nap (asg): records the group sizes, suspends scaling and scales the group to zero', async () => {
  const s = asgSetup({ run: { state: STATES.AWAKE }, desired: 2 });
  const result = await s.handler({ action: 'nap', workloadId: 'demo' });
  assert.equal(result.state, STATES.ASLEEP);
  assert.deepEqual(JSON.parse(s.store.state.run.napBackends), [{ kind: 'asg', name: 'asg-demo', min: 2, max: 3, desired: 2 }]);
  const group = s.autoscaling.state.groups[0];
  assert.equal(group.DesiredCapacity, 0);
  assert.equal(group.MinSize, 0);
  assert.ok(s.autoscaling.state.suspended['asg-demo']);
  assert.equal(routeOf(s.elbv2, s.cfg), 'waker');
});

test('wake (asg): restores the recorded sizes, resumes scaling and switches the route back', async () => {
  const s = asgSetup({
    run: { state: STATES.WAKING, wakeId: 'w1', napBackends: JSON.stringify([{ kind: 'asg', name: 'asg-demo', min: 2, max: 3, desired: 2 }]) },
    desired: 0, target: 'waker', healthy: 0,
  });
  const update = s.autoscaling.updateAutoScalingGroup;
  s.autoscaling.updateAutoScalingGroup = async (input) => { await update(input); s.elbv2.state.healthy = input.DesiredCapacity; };
  const result = await s.handler({ action: 'wake', workloadId: 'demo', wakeId: 'w1' });
  assert.equal(result.state, STATES.AWAKE);
  const group = s.autoscaling.state.groups[0];
  assert.deepEqual([group.MinSize, group.MaxSize, group.DesiredCapacity], [2, 3, 2]);
  assert.equal(s.autoscaling.state.resumed.length, 1);
  assert.equal(routeOf(s.elbv2, s.cfg), 'app');
  assert.equal('napBackends' in s.store.state.run, false);
});

test('check (asg): a group scaled up outside Dormeto while asleep is reconciled to AWAKE', async () => {
  const s = asgSetup({ run: { state: STATES.ASLEEP }, desired: 1, target: 'waker', healthy: 1 });
  const [result] = await s.handler({ action: 'check' });
  assert.equal(result.state, STATES.AWAKE);
  assert.equal(routeOf(s.elbv2, s.cfg), 'app');
});

test('check (asg): a group scaled to zero outside Dormeto while awake is reconciled to ASLEEP', async () => {
  const s = asgSetup({ run: { state: STATES.AWAKE, awakeSince: 1 }, desired: 0, target: 'app', healthy: 0 });
  const [result] = await s.handler({ action: 'check' });
  assert.equal(result.state, STATES.ASLEEP);
  assert.equal(routeOf(s.elbv2, s.cfg), 'waker');
});

test('check (asg): an external scale-up resumes the suspended processes and restores MinSize', async () => {
  const s = asgSetup({
    run: { state: STATES.ASLEEP, napBackends: JSON.stringify([{ kind: 'asg', name: 'asg-demo', min: 2, max: 3, desired: 2 }]) },
    desired: 1, target: 'waker', healthy: 1,
  });
  const group = s.autoscaling.state.groups[0];
  group.MinSize = 0;
  s.autoscaling.state.suspended['asg-demo'] = ['AlarmNotification'];
  const [result] = await s.handler({ action: 'check' });
  assert.equal(result.state, STATES.AWAKE);
  assert.equal(s.autoscaling.state.resumed.length, 1);
  assert.equal(group.MinSize, 1, 'MinSize restored, capped by the externally chosen capacity');
  assert.equal(group.DesiredCapacity, 1, 'the externally chosen capacity is kept');
  assert.equal('napBackends' in s.store.state.run, false);
});

// --- ECS service backends --------------------------------------------------------------------------------------

function ecsSetup({ run, desired = 1, target = 'app', healthy = 1 }) {
  const cfg = testConfig({ instanceIds: [] });
  const s = setup({ run, cfg, target, healthy, services: [ecsService('web', { desired, targetGroups: [cfg.appTargetGroupArn], tags: { 'dormeto:workload': 'demo' } })] });
  s.elbv2.state.healthy = healthy;
  return s;
}

test('nap (ecs): records the desired count and scales the service to zero', async () => {
  const s = ecsSetup({ run: { state: STATES.AWAKE }, desired: 2 });
  const result = await s.handler({ action: 'nap', workloadId: 'demo' });
  assert.equal(result.state, STATES.ASLEEP);
  const [record] = JSON.parse(s.store.state.run.napBackends);
  assert.equal(record.kind, 'ecs');
  assert.equal(record.desired, 2);
  assert.equal(s.ecs.state.services[0].desiredCount, 0);
  assert.equal(routeOf(s.elbv2, s.cfg), 'waker');
});

test('nap (ecs): becomes ASLEEP only once the target group released the stopped tasks', async () => {
  // ECS reports no running task before the target group drops its target: a wake right after the nap must not see it.
  const s = ecsSetup({ run: { state: STATES.AWAKE }, desired: 1 });
  s.elbv2.state.targets = [{ Id: '10.0.0.5', State: 'healthy' }];
  const describe = s.elbv2.describeTargetHealth;
  let afterStop = 0;
  s.elbv2.describeTargetHealth = async (input) => {
    if (s.ecs.state.services[0].desiredCount === 0) {
      afterStop += 1;
      s.elbv2.state.targets = afterStop === 1 ? [{ Id: '10.0.0.5', State: 'healthy' }] : afterStop === 2 ? [{ Id: '10.0.0.5', State: 'draining' }] : [];
    }
    return describe(input);
  };
  const result = await s.handler({ action: 'nap', workloadId: 'demo' });
  assert.equal(result.state, STATES.ASLEEP);
  assert.deepEqual(s.elbv2.state.targets, []);
  assert.ok(afterStop >= 3);
});

test('nap: stopped instance targets (unused) do not delay the nap; stuck targets end the wait after a timeout', async () => {
  const s = setup({ run: { state: STATES.AWAKE } });
  s.elbv2.state.targets = [{ Id: 'i-0123456789abcdef0', State: 'unused' }];
  const start = s.clock.now();
  assert.equal((await s.handler({ action: 'nap', workloadId: 'demo' })).state, STATES.ASLEEP);
  const quick = s.clock.now() - start;

  const stuck = setup({ run: { state: STATES.AWAKE } });
  stuck.elbv2.state.targets = [{ Id: 'i-0123456789abcdef0', State: 'draining' }];
  const t0 = stuck.clock.now();
  assert.equal((await stuck.handler({ action: 'nap', workloadId: 'demo' })).state, STATES.ASLEEP);
  assert.ok(stuck.clock.now() - t0 >= quick + 120_000, 'waited up to the release timeout');
});

test('wake (ecs): restores the desired count and switches the route back', async () => {
  const s = ecsSetup({ run: { state: STATES.WAKING, wakeId: 'w1' }, desired: 0, target: 'waker', healthy: 0 });
  const [service] = s.ecs.state.services;
  s.store.state.run.napBackends = JSON.stringify([{ kind: 'ecs', id: service.serviceArn, cluster: service.clusterArn, desired: 2, scalable: null }]);
  const update = s.ecs.updateService;
  s.ecs.updateService = async (input) => { await update(input); s.elbv2.state.healthy = input.desiredCount; };
  const result = await s.handler({ action: 'wake', workloadId: 'demo', wakeId: 'w1' });
  assert.equal(result.state, STATES.AWAKE);
  assert.equal(s.ecs.state.services[0].desiredCount, 2);
  assert.equal(routeOf(s.elbv2, s.cfg), 'app');
});

test('check (ecs): a service scaled up outside Dormeto while asleep is reconciled to AWAKE', async () => {
  const s = ecsSetup({ run: { state: STATES.ASLEEP }, desired: 1, target: 'waker', healthy: 1 });
  const [result] = await s.handler({ action: 'check' });
  assert.equal(result.state, STATES.AWAKE);
});

// --- RDS companions --------------------------------------------------------------------------------------------

const DB_TAG = { 'dormeto:workload': 'demo' };

function rdsSetup({ run, instance = 'running', db = 'available', target = 'app', healthy = 1, wakeTimeoutSeconds = 1800 }) {
  const cfg = testConfig({ wakeTimeoutSeconds });
  return setup({ run, cfg, instance, target, healthy, databases: { instances: { appdb: { status: db, tags: DB_TAG } } } });
}

test('nap (rds): stops the database after the application, without waiting for it', async () => {
  const s = rdsSetup({ run: { state: STATES.AWAKE } });
  const result = await s.handler({ action: 'nap', workloadId: 'demo' });
  assert.equal(result.state, STATES.ASLEEP);
  assert.equal(s.ec2.state.instances[s.cfg.instanceIds[0]], 'stopped');
  assert.deepEqual(s.rds.state.calls, [['stop', 'appdb']]);
  assert.deepEqual(JSON.parse(s.store.state.run.napBackends).map((b) => b.kind), ['instance', 'rds-instance']);
});

test('wake (rds): starts the database first and waits until it is available, then the application', async () => {
  const s = rdsSetup({ run: { state: STATES.WAKING, wakeId: 'w1' }, instance: 'stopped', db: 'stopped', target: 'waker' });
  s.store.state.run.wakeStartedAt = s.clock.now();
  s.store.state.run.napBackends = JSON.stringify([{ kind: 'instance', id: s.cfg.instanceIds[0] }, { kind: 'rds-instance', id: 'appdb' }]);
  const order = [];
  const startDb = s.rds.startDBInstance;
  s.rds.startDBInstance = async (input) => { order.push('db'); return startDb(input); };
  const startEc2 = s.ec2.startInstances;
  s.ec2.startInstances = async (input) => { order.push(`app (db ${s.rds.state.instances.appdb.status})`); return startEc2(input); };
  const result = await s.handler({ action: 'wake', workloadId: 'demo', wakeId: 'w1' });
  assert.equal(result.state, STATES.AWAKE);
  assert.deepEqual(order, ['db', 'app (db available)']);
});

test('wake (rds): continues in a new invocation when the budget runs out before the wake deadline', async () => {
  const s = rdsSetup({ run: { state: STATES.WAKING, wakeId: 'w1' }, instance: 'stopped', db: 'stopped', target: 'waker' });
  s.store.state.run.wakeStartedAt = s.clock.now();
  s.store.state.run.napBackends = JSON.stringify([{ kind: 'rds-instance', id: 'appdb' }]);
  s.rds.startDBInstance = async () => { s.rds.state.instances.appdb.status = 'starting'; s.rds.state.instances.appdb.slow = true; };
  const describe = s.rds.describeDBInstances;
  s.rds.describeDBInstances = async (input) => { const out = await describe(input); if (s.rds.state.instances.appdb.slow) s.rds.state.instances.appdb.status = 'starting'; return out; };
  const result = await s.handler({ action: 'wake', workloadId: 'demo', wakeId: 'w1' }, { getRemainingTimeInMillis: () => 120_000 });
  assert.deepEqual(result, { state: STATES.WAKING, continued: true });
  assert.deepEqual(s.invocations, [{ action: 'wake', workloadId: 'demo', wakeId: 'w1' }]);
  assert.equal(s.store.state.run.state, STATES.WAKING, 'not FAILED');
});

test('wake: the deadline counts from wakeStartedAt, so a continuation past it fails', async () => {
  const s = rdsSetup({ run: { state: STATES.WAKING, wakeId: 'w1' }, instance: 'stopped', db: 'available', target: 'waker', healthy: 0, wakeTimeoutSeconds: 600 });
  s.store.state.run.wakeStartedAt = s.clock.now() - 590_000;
  const result = await s.handler({ action: 'wake', workloadId: 'demo', wakeId: 'w1' }, { getRemainingTimeInMillis: () => 900_000 });
  assert.equal(result.state, STATES.FAILED);
  assert.equal(s.invocations.length, 0);
});

test('check (rds): stops a database started by AWS while the workload sleeps', async () => {
  const s = rdsSetup({ run: { state: STATES.ASLEEP }, instance: 'stopped', db: 'available', target: 'waker', healthy: 0 });
  await s.handler({ action: 'check' });
  assert.deepEqual(s.rds.state.calls, [['stop', 'appdb']]);
  assert.equal(s.store.state.run.state, STATES.ASLEEP);
});

test('check (rds): an external wake of the application starts the database', async () => {
  const s = rdsSetup({ run: { state: STATES.ASLEEP }, instance: 'running', db: 'stopped', target: 'waker', healthy: 1 });
  const [result] = await s.handler({ action: 'check' });
  assert.equal(result.state, STATES.AWAKE, 'the application decides: primaries running and healthy');
  assert.deepEqual(s.rds.state.calls, [['start', 'appdb']]);
});

// --- IP reputation lists --------------------------------------------------------------------------------------------

function listsSetup(dueNames) {
  const calls = [];
  const lists = {
    async due() { return dueNames; },
    async refresh(names) { calls.push(names); return names.map((name) => ({ name, entries: 1 })); },
  };
  const s = setup({ run: { state: STATES.AWAKE, awakeSince: 0 } });
  const handler = createController({
    store: s.store, ec2: s.ec2, elbv2: s.elbv2, cloudwatch: s.cloudwatch, autoscaling: s.autoscaling, ecs: s.ecs,
    appscaling: s.appscaling, invokeSelf: async (payload) => { s.invocations.push(payload); }, now: s.clock.now,
    sleep: s.clock.sleep, log: silentLog, lists,
  });
  return { ...s, handler, calls };
}

test('check requests an asynchronous refresh of the due lists only', async () => {
  const due = listsSetup(['ipsum']);
  await due.handler({ action: 'check' });
  assert.deepEqual(due.invocations.filter((i) => i.action === 'refresh-lists'), [{ action: 'refresh-lists', names: ['ipsum'] }]);
  const fresh = listsSetup([]);
  await fresh.handler({ action: 'check' });
  assert.equal(fresh.invocations.filter((i) => i.action === 'refresh-lists').length, 0);
});

test('refresh-lists refreshes the requested lists', async () => {
  const s = listsSetup([]);
  assert.deepEqual(await s.handler({ action: 'refresh-lists', names: ['ipsum'] }), [{ name: 'ipsum', entries: 1 }]);
  assert.deepEqual(s.calls, [['ipsum']]);
});

// --- Manager interface ----------------------------------------------------------------------------------------------

function managerSetup({ run, defaultRules = [], lists = [] }) {
  const s = setup({ run });
  const handler = createController({
    store: s.store, ec2: s.ec2, elbv2: s.elbv2, cloudwatch: s.cloudwatch, autoscaling: s.autoscaling, ecs: s.ecs,
    appscaling: s.appscaling, invokeSelf: async (payload) => { s.invocations.push(payload); }, now: s.clock.now,
    sleep: s.clock.sleep, newId: () => 'w-manager', log: silentLog,
    router: { name: 'dmt-dev', version: '0.11.0', build: 'abc', checkSchedule: 'rate(5 minutes)' }, defaultRules, ipLists: lists,
  });
  return { ...s, handler };
}

test('list returns the router and its workloads from the state table', async () => {
  const s = managerSetup({ run: { state: STATES.ASLEEP, wakeCount: 3, updatedAt: 1_700_000_000_000 } });
  const result = await s.handler({ action: 'list' });
  assert.deepEqual(result.router, { name: 'dmt-dev', version: '0.11.0', build: 'abc', checkSchedule: 'rate(5 minutes)', lastScheduledCheckAt: null });
  const [workload] = result.workloads;
  assert.equal(workload.workloadId, 'demo');
  assert.equal(workload.state, STATES.ASLEEP);
  assert.equal(workload.wakeCount, 3);
  assert.equal(workload.wakeMode, 'any');
  assert.equal(workload.updatedAt, '2023-11-14T22:13:20.000Z');
  assert.equal(workload.settings.idleMinutes, 15);
  assert.deepEqual(workload.stats7d, { ignored: 0, deferred: 0, wakes: 0 });
});

test('list adds the 7-day totals of each workload, null when they cannot be read', async () => {
  const s = managerSetup({ run: { state: STATES.AWAKE } });
  s.store.state.stats = { 'ignored:HEAD': 2, 'ignored:bot user agent': 3, 'deferred:browser mode': 1, 'wake:probe': 4 };
  assert.deepEqual((await s.handler({ action: 'list' })).workloads[0].stats7d, { ignored: 5, deferred: 1, wakes: 4 });
  s.store.getStats = async () => { throw new Error('AccessDenied'); };
  assert.equal((await s.handler({ action: 'list' })).workloads[0].stats7d, null);
});

test('status returns the live status of a workload, with router rules, statistics and lists', async () => {
  const s = managerSetup({
    run: { state: STATES.AWAKE, awakeSince: 0 },
    defaultRules: [{ name: 'e2e', headers: [{ name: 'x-e2e', value: '1' }] }],
    lists: [{ name: 'ipsum', url: 'https://x', action: 'defer', refreshHours: 24 }],
  });
  s.store.state.lists.ipsum = { meta: { version: 'v1', format: 'ranges-v1', entries: 42, fetchedAt: 1_700_000_000_000 }, parts: {} };
  s.store.state.stats = { 'ignored:HEAD': 2 };
  const status = await s.handler({ action: 'status', workloadId: 'demo' });
  assert.equal(status.workloadId, 'demo');
  assert.equal(status.state, STATES.AWAKE);
  assert.equal(status.route, 'app');
  assert.deepEqual(status.router, { version: '0.11.0', build: 'abc' });
  assert.deepEqual(status.noWakeRules.map((r) => [r.name, r.level]), [['e2e', 'router']]);
  assert.deepEqual(status.stats.total.ignored, { HEAD: 2 });
  assert.deepEqual(status.ipLists.map((l) => [l.name, l.entries]), [['ipsum', 42]]);
});

test('status of an unknown workload is an error', async () => {
  const s = managerSetup({ run: { state: STATES.AWAKE } });
  await assert.rejects(s.handler({ action: 'status', workloadId: 'nope' }), /workload not configured: nope/);
});

test('force-wake wakes an asleep or failed workload, marks a pending wake during a nap, and is counted', async () => {
  for (const state of [STATES.ASLEEP, STATES.FAILED]) {
    const s = managerSetup({ run: { state, failedAt: 1 } });
    assert.deepEqual(await s.handler({ action: 'force-wake', workloadId: 'demo', by: 'ops@example.com' }), { state: STATES.WAKING });
    assert.deepEqual(s.invocations.filter((i) => i.action === 'wake'), [{ action: 'wake', workloadId: 'demo', wakeId: 'w-manager' }]);
    assert.equal(s.store.state.stats['wake:manager'], 1);
  }
  const napping = managerSetup({ run: { state: STATES.NAPPING } });
  assert.deepEqual(await napping.handler({ action: 'force-wake', workloadId: 'demo' }), { state: STATES.NAPPING, pendingWake: true });
  assert.equal(napping.store.state.run.pendingWake, true);
  const awake = managerSetup({ run: { state: STATES.AWAKE } });
  assert.deepEqual(await awake.handler({ action: 'force-wake', workloadId: 'demo' }), { state: STATES.AWAKE });
});

test('discover runs the discovery with the controller clients', async () => {
  const s = managerSetup({ run: { state: STATES.AWAKE } });
  s.elbv2.describeLoadBalancers = async () => ({ LoadBalancers: [] });
  s.elbv2.describeTargetGroups = async () => ({ TargetGroups: [] });
  s.elbv2.describeTags = async () => ({ TagDescriptions: [] });
  s.ecs.listClusters = async () => ({ clusterArns: [] });
  const result = await s.handler({ action: 'discover' });
  assert.deepEqual(result.candidates, []);
  assert.match(result.generatedAt, /^\d{4}-\d\d-\d\dT/);
});

// --- Scheduled check health -----------------------------------------------------------------------------------------

test('a scheduled check records its time; other checks do not hide a broken scheduler', async () => {
  const s = managerSetup({ run: { state: STATES.ASLEEP } });
  await s.handler({ action: 'check' });
  assert.equal(s.store.state.check?.lastScheduledCheckAt, undefined);
  await s.handler({ action: 'check', source: 'schedule' });
  assert.equal(s.store.state.check.lastScheduledCheckAt, s.clock.now());
});

test('list gives the last scheduled check and the schedule of the router', async () => {
  const s = managerSetup({ run: { state: STATES.ASLEEP } });
  await s.handler({ action: 'check', source: 'schedule' });
  const { router } = await s.handler({ action: 'list' });
  assert.equal(router.lastScheduledCheckAt, new Date(s.clock.now()).toISOString());
  assert.equal(router.checkSchedule, 'rate(5 minutes)');
});
