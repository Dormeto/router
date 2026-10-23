import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCALING_PROCESSES, backendStatuses, resolveBackends, resumeBackends, sleepBackends, wakeBackends } from '../src/lib/backends.mjs';
import { asgGroup, fakeAutoScaling, fakeClock, fakeEc2, fakeElbv2, testConfig } from './fakes.mjs';

const TAG = { 'dormeto:workload': 'demo' };

function clients({ targets = [], tags = {}, groups = [], states = {} } = {}) {
  const cfg = testConfig({ instanceIds: [] });
  const elbv2 = fakeElbv2(cfg);
  elbv2.state.targets = targets;
  const ec2 = fakeEc2([]);
  ec2.state.instances = { ...states };
  ec2.state.tags = tags;
  const autoscaling = fakeAutoScaling(groups);
  return { cfg, elbv2, ec2, autoscaling };
}

test('discovers standalone instances and Auto Scaling groups feeding the app target group', async () => {
  const c = clients({
    targets: [{ Id: 'i-a', State: 'healthy' }, { Id: 'i-g1', State: 'healthy' }, { Id: 'i-u', State: 'healthy' }],
    tags: {
      'i-a': TAG,
      'i-g1': { ...TAG, 'aws:autoscaling:groupName': 'asg-demo' },
      'i-u': { ...TAG, 'aws:autoscaling:groupName': 'asg-x' },
    },
    states: { 'i-a': 'running', 'i-g1': 'running', 'i-u': 'running' },
  });
  c.autoscaling.state.groups = [
    asgGroup('asg-demo', { targetGroups: [c.cfg.appTargetGroupArn], tags: TAG, instances: [{ InstanceId: 'i-g1', LifecycleState: 'InService' }] }),
    asgGroup('asg-other', { targetGroups: ['arn:other'], tags: TAG }),
  ];
  const result = await resolveBackends(c, c.cfg);
  assert.equal(result.mode, 'discovery');
  assert.deepEqual(result.backends, [
    { kind: 'instance', id: 'i-a' },
    { kind: 'asg', name: 'asg-demo', min: 1, max: 2, desired: 1, instances: ['i-g1'], warmPool: null, wakeDesired: null },
  ]);
  assert.deepEqual(result.ignored, [
    { id: 'i-u', reason: 'member of Auto Scaling group asg-x (not managed)' },
    { id: 'asg-other', reason: 'Auto Scaling group does not feed the target group' },
  ]);
});

test('discovers a group scaled to zero while the workload sleeps', async () => {
  const c = clients();
  c.autoscaling.state.groups = [asgGroup('asg-demo', { min: 0, desired: 0, targetGroups: [c.cfg.appTargetGroupArn], tags: { ...TAG, 'dormeto:wake-desired': '2' } })];
  const { backends } = await resolveBackends(c, c.cfg);
  assert.deepEqual(backends, [{ kind: 'asg', name: 'asg-demo', min: 0, max: 2, desired: 0, instances: [], warmPool: null, wakeDesired: 2 }]);
});

test('without an Auto Scaling client only instances are resolved', async () => {
  const c = clients({ targets: [{ Id: 'i-a', State: 'healthy' }], tags: { 'i-a': TAG }, states: { 'i-a': 'running' } });
  const { backends } = await resolveBackends({ ec2: c.ec2, elbv2: c.elbv2 }, c.cfg);
  assert.deepEqual(backends, [{ kind: 'instance', id: 'i-a' }]);
});

test('backend statuses for instances and groups', async () => {
  const c = clients({ states: { 'i-a': 'running', 'i-b': 'stopped' } });
  c.autoscaling.state.groups = [
    asgGroup('up', {}),
    asgGroup('down', { min: 0, desired: 0 }),
    asgGroup('starting', { instances: [{ InstanceId: 'i-p', LifecycleState: 'Pending' }] }),
  ];
  const statuses = await backendStatuses(c, [
    { kind: 'instance', id: 'i-a' }, { kind: 'instance', id: 'i-b' },
    { kind: 'asg', name: 'up' }, { kind: 'asg', name: 'down' }, { kind: 'asg', name: 'starting' },
  ]);
  assert.deepEqual(statuses, {
    'instance:i-a': 'running', 'instance:i-b': 'stopped', 'asg:up': 'running', 'asg:down': 'stopped', 'asg:starting': 'transitioning',
  });
});

test('sleep records sizes, suspends scaling, scales the group to zero and stops instances', async () => {
  const c = clients({ states: { 'i-a': 'running' } });
  c.autoscaling.state.groups = [asgGroup('asg-demo', { min: 1, max: 3, desired: 2 })];
  const clock = fakeClock();
  const records = await sleepBackends(c, [
    { kind: 'instance', id: 'i-a' },
    { kind: 'asg', name: 'asg-demo', min: 1, max: 3, desired: 2, instances: [], warmPool: null, wakeDesired: null },
  ], { sleep: clock.sleep, now: clock.now, deadline: clock.now() + 300_000 });
  assert.deepEqual(records, [{ kind: 'instance', id: 'i-a' }, { kind: 'asg', name: 'asg-demo', min: 1, max: 3, desired: 2 }]);
  assert.deepEqual(c.autoscaling.state.suspended['asg-demo'], SCALING_PROCESSES);
  assert.deepEqual(c.autoscaling.state.updates, [{ AutoScalingGroupName: 'asg-demo', MinSize: 0, DesiredCapacity: 0 }]);
  assert.equal(c.ec2.state.instances['i-a'], 'stopped');
});

test('sleep passes the hibernation options to the instance stop, its records unchanged', async () => {
  const c = clients({ states: { 'i-a': 'running' } });
  c.ec2.state.configured = { 'i-a': true };
  const clock = fakeClock();
  const recorded = [];
  const records = await sleepBackends(c, [{ kind: 'instance', id: 'i-a' }], { sleep: clock.sleep, now: clock.now, deadline: clock.now() + 300_000 }, {
    hibernate: true, onHibernated: (ids) => recorded.push(ids),
  });
  assert.deepEqual(records, [{ kind: 'instance', id: 'i-a' }]);
  assert.deepEqual(c.ec2.state.stops, [{ InstanceIds: ['i-a'], Hibernate: true }]);
  assert.deepEqual(recorded, [['i-a']]);
});

test('wake restores the recorded sizes then resumes scaling', async () => {
  const c = clients({ states: { 'i-a': 'stopped' } });
  c.autoscaling.state.groups = [asgGroup('asg-demo', { min: 0, max: 3, desired: 0 })];
  const clock = fakeClock();
  await wakeBackends(c, [{ kind: 'instance', id: 'i-a' }, { kind: 'asg', name: 'asg-demo', min: 1, max: 3, desired: 2 }],
    { sleep: clock.sleep, now: clock.now, deadline: clock.now() + 300_000 });
  assert.deepEqual(c.autoscaling.state.updates, [{ AutoScalingGroupName: 'asg-demo', MinSize: 1, MaxSize: 3, DesiredCapacity: 2 }]);
  assert.deepEqual(c.autoscaling.state.resumed, [{ name: 'asg-demo', processes: SCALING_PROCESSES }]);
  assert.equal(c.ec2.state.instances['i-a'], 'running');
});

test('wake without recorded sizes uses dormeto:wake-desired or 1', async () => {
  const c = clients();
  c.autoscaling.state.groups = [asgGroup('a', { min: 0, max: 1, desired: 0 }), asgGroup('b', { min: 0, max: 5, desired: 0 })];
  const clock = fakeClock();
  await wakeBackends(c, [
    { kind: 'asg', name: 'a', min: 0, max: 1, desired: 0, wakeDesired: null },
    { kind: 'asg', name: 'b', min: 0, max: 5, desired: 0, wakeDesired: 3 },
  ], { sleep: clock.sleep, now: clock.now, deadline: clock.now() + 300_000 });
  assert.deepEqual(c.autoscaling.state.updates, [
    { AutoScalingGroupName: 'a', MinSize: 1, MaxSize: 1, DesiredCapacity: 1 },
    { AutoScalingGroupName: 'b', MinSize: 1, MaxSize: 5, DesiredCapacity: 3 },
  ]);
});

test('resume releases napped groups without changing their desired capacity', async () => {
  const c = clients();
  c.autoscaling.state.groups = [asgGroup('asg-demo', { min: 0, max: 3, desired: 1 })];
  await resumeBackends(c, [{ kind: 'instance', id: 'i-a' }, { kind: 'asg', name: 'asg-demo', min: 2, max: 3, desired: 2 }]);
  assert.deepEqual(c.autoscaling.state.updates, [{ AutoScalingGroupName: 'asg-demo', MinSize: 1, MaxSize: 3 }]);
  assert.deepEqual(c.autoscaling.state.resumed, [{ name: 'asg-demo', processes: SCALING_PROCESSES }]);
});

test('a warm pool is described from DescribeAutoScalingGroups', async () => {
  const c = clients();
  c.autoscaling.state.groups = [{
    ...asgGroup('asg-demo', { targetGroups: [c.cfg.appTargetGroupArn], tags: TAG }),
    WarmPoolConfiguration: { PoolState: 'Stopped', MinSize: 0, InstanceReusePolicy: { ReuseOnScaleIn: true }, Status: 'Active' },
    WarmPoolSize: 1,
  }];
  const { backends: [group] } = await resolveBackends(c, c.cfg);
  assert.deepEqual(group.warmPool, { state: 'Stopped', minSize: 0, maxPrepared: null, reuseOnScaleIn: true, size: 1 });
});
