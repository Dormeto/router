import { test } from 'node:test';
import assert from 'node:assert/strict';
import { healthyCount, instanceDetails, instanceStates, startInstances, stopInstances } from '../src/lib/instances.mjs';
import { lastRequestAt } from '../src/lib/metrics.mjs';
import { fakeClock, fakeEc2 } from './fakes.mjs';

function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

function ec2With(states, transitions = {}) {
  const calls = [];
  return {
    calls,
    async describeInstances({ InstanceIds }) {
      for (const id of InstanceIds) if (transitions[id]?.length) states[id] = transitions[id].shift();
      return { Reservations: [{ Instances: InstanceIds.map((id) => ({ InstanceId: id, State: { Name: states[id] } })) }] };
    },
    async startInstances(input) { calls.push(['start', input.InstanceIds]); for (const id of input.InstanceIds) states[id] = 'pending'; },
    async stopInstances(input) { calls.push(['stop', input.InstanceIds]); for (const id of input.InstanceIds) states[id] = 'stopping'; },
  };
}

test('instanceStates maps ids to state names', async () => {
  assert.deepEqual(await instanceStates(ec2With({ a: 'running', b: 'stopped' }), ['a', 'b']), { a: 'running', b: 'stopped' });
});

test('startInstances waits for stopping instances then starts stopped ones only', async () => {
  const c = clock();
  const ec2 = ec2With({ a: 'stopping', b: 'running' }, { a: ['stopping', 'stopping', 'stopped'] });
  await startInstances(ec2, ['a', 'b'], { ...c, deadline: 60_000 });
  assert.deepEqual(ec2.calls, [['start', ['a']]]);
  assert.ok(c.now() >= 6000, 'waited for the stopping instance');
});

test('startInstances times out when an instance stays stopping', async () => {
  const c = clock();
  await assert.rejects(startInstances(ec2With({ a: 'stopping' }), ['a'], { ...c, deadline: 10_000 }), /timeout/);
});

test('stopInstances stops running instances and waits until stopped', async () => {
  const c = clock();
  const ec2 = ec2With({ a: 'running', b: 'stopped' }, { a: ['running', 'stopping', 'stopped'] });
  await stopInstances(ec2, ['a', 'b'], { ...c, deadline: 60_000 });
  assert.deepEqual(ec2.calls, [['stop', ['a']]]);
});

// --- Hibernation -----------------------------------------------------------------------------------------------------

const HIBERNATE = 'Client.UserInitiatedHibernate';
const logOf = () => {
  const entries = [];
  const entry = (level) => (event, fields) => entries.push([level, event, fields]);
  return { entries, info: entry('info'), warn: entry('warn'), error: entry('error') };
};
const timingOf = (clock, ms = 300_000) => ({ sleep: clock.sleep, now: clock.now, deadline: clock.now() + ms });

test('stopInstances without hibernate: one plain call, even for instances launched with hibernation', async () => {
  const ec2 = fakeEc2(['a', 'b']);
  ec2.state.configured = { a: true, b: true };
  const result = await stopInstances(ec2, ['a', 'b'], timingOf(fakeClock()));
  assert.deepEqual(ec2.state.stops, [{ InstanceIds: ['a', 'b'] }]);
  assert.deepEqual(result, { hibernated: [], refused: [] });
});

test('stopInstances with hibernate: a running instance launched with it on its own type is hibernated, the others stopped', async () => {
  const ec2 = fakeEc2(['a', 'b', 'c', 'd']);
  ec2.state.configured = { a: true, c: true, d: true };
  ec2.state.instances.c = 'pending';
  ec2.state.tags.d = { 'dormeto:instance-type': 't3.medium' };
  const recorded = [];
  const onHibernated = async (ids) => { await new Promise((resolve) => setImmediate(resolve)); recorded.push(ids); };
  const result = await stopInstances(ec2, ['a', 'b', 'c', 'd'], timingOf(fakeClock()), { hibernate: true, onHibernated });
  assert.deepEqual(ec2.state.stops, [{ InstanceIds: ['a'], Hibernate: true }, { InstanceIds: ['b', 'c', 'd'] }]);
  assert.deepEqual(result, { hibernated: ['a'], refused: [] });
  assert.deepEqual(recorded, [['a']], 'called once with the hibernated ids, and awaited');
  assert.deepEqual(Object.values(ec2.state.instances), ['stopped', 'stopped', 'stopped', 'stopped']);
});

test('stopInstances: a hibernation AWS refuses stops every instance of the call plainly, none left running (review 3)', async () => {
  const ec2 = fakeEc2(['a', 'b', 'c']);
  ec2.state.configured = { a: true, b: true };
  ec2.state.refuseHibernation = Object.assign(new Error('Instance i-b cannot be hibernated within 2 minutes of launch.'), { name: 'UnsupportedOperation' });
  const log = logOf();
  const recorded = [];
  const result = await stopInstances(ec2, ['a', 'b', 'c'], timingOf(fakeClock()), { hibernate: true, onHibernated: (ids) => recorded.push(ids), log });
  assert.deepEqual(ec2.state.stops, [{ InstanceIds: ['a', 'b'], Hibernate: true }, { InstanceIds: ['a', 'b', 'c'] }]);
  assert.deepEqual(result, { hibernated: [], refused: ['a', 'b'] });
  assert.deepEqual(recorded, [], 'nothing hibernated, nothing recorded');
  assert.deepEqual(log.entries, [['warn', 'HibernationRefused', { instances: ['a', 'b'], error: 'Instance i-b cannot be hibernated within 2 minutes of launch.' }]]);
  assert.deepEqual(Object.values(ec2.state.instances), ['stopped', 'stopped', 'stopped']);
});

test('stopInstances: an accepted hibernation still stopping at the deadline completes the stop; a plain stop still stopping fails as today', async () => {
  const ec2 = fakeEc2(['a']);
  ec2.state.configured = { a: true };
  ec2.state.slowStops = ['a'];
  const log = logOf();
  const clock = fakeClock();
  const result = await stopInstances(ec2, ['a'], timingOf(clock), { hibernate: true, log });
  assert.deepEqual(result, { hibernated: ['a'], refused: [] });
  assert.deepEqual(log.entries, [['info', 'HibernationOngoing', { instances: ['a'] }]]);
  assert.ok(clock.now() >= 1_700_000_300_000, 'waited until the deadline');

  const plain = fakeEc2(['b']);
  plain.state.slowStops = ['b'];
  await assert.rejects(stopInstances(plain, ['b'], timingOf(fakeClock()), { hibernate: true }), /timeout waiting for instances/);
  const mixed = fakeEc2(['a', 'b']);
  mixed.state.configured = { a: true };
  mixed.state.slowStops = ['a', 'b'];
  await assert.rejects(stopInstances(mixed, ['a', 'b'], timingOf(fakeClock()), { hibernate: true }), /timeout waiting for instances/);
});

test('stopInstances: a failing record of the hibernation is logged and never fails the stop', async () => {
  const ec2 = fakeEc2(['a']);
  ec2.state.configured = { a: true };
  const log = logOf();
  const result = await stopInstances(ec2, ['a'], timingOf(fakeClock()), { hibernate: true, log, onHibernated: async () => { throw new Error('throttled'); } });
  assert.deepEqual(result, { hibernated: ['a'], refused: [] });
  assert.deepEqual(log.entries, [['error', 'HibernatedNotRecorded', { instances: ['a'], error: 'throttled' }]]);
  assert.equal(ec2.state.instances.a, 'stopped');
});

test('instanceDetails reads the state, HibernationOptions.Configured, the hibernate state reason and the fallback type tag', async () => {
  const ec2 = fakeEc2(['a', 'b', 'c', 'd', 'e']);
  ec2.state.configured = { a: true, b: true, c: true };
  Object.assign(ec2.state.instances, { b: 'stopped', c: 'stopping', d: 'stopped' });
  Object.assign(ec2.state.reasons, { b: HIBERNATE, c: HIBERNATE, d: 'Client.UserInitiatedShutdown' });
  ec2.state.tags.e = { 'dormeto:instance-type': 't3.medium' };
  const details = await instanceDetails(ec2, ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(Object.fromEntries(details), {
    a: { state: 'running', configured: true, hibernated: false, fallbackType: false },
    b: { state: 'stopped', configured: true, hibernated: true, fallbackType: false },
    c: { state: 'stopping', configured: true, hibernated: true, fallbackType: false },
    d: { state: 'stopped', configured: false, hibernated: false, fallbackType: false },
    e: { state: 'running', configured: false, hibernated: false, fallbackType: true },
  });
  const none = await instanceDetails({ describeInstances: async () => ({ Reservations: [] }) }, ['x']);
  assert.equal(none.has('x'), false, 'an instance AWS does not return is absent');
});

test('startInstances: a wake right after a nap waits for a hibernation still stopping, then starts it (review 4)', async () => {
  const ec2 = fakeEc2(['a'], { state: 'stopping' });
  ec2.state.configured = { a: true };
  ec2.state.reasons = { a: HIBERNATE };
  const start = ec2.startInstances;
  ec2.startInstances = async (input) => {
    if (input.InstanceIds.some((id) => ec2.state.instances[id] !== 'stopped')) throw Object.assign(new Error('not stopped'), { name: 'IncorrectInstanceState' });
    return start(input);
  };
  const clock = fakeClock();
  const begin = clock.now();
  clock.onSleep((t) => { if (t - begin >= 60_000) ec2.state.instances.a = 'stopped'; });
  await startInstances(ec2, ['a'], timingOf(clock, 600_000));
  assert.equal(ec2.state.instances.a, 'running');
  assert.ok(clock.now() - begin >= 60_000, 'waited for the hibernation to end');
});

test('healthyCount counts healthy targets only', async () => {
  const elbv2 = { describeTargetHealth: async () => ({ TargetHealthDescriptions: [
    { TargetHealth: { State: 'healthy' } }, { TargetHealth: { State: 'initial' } }, { TargetHealth: { State: 'healthy' } },
  ] }) };
  assert.equal(await healthyCount(elbv2, 'tg'), 2);
});

test('lastRequestAt reads RequestCount of the app target group per minute: the end of the last minute with a request', async () => {
  let input;
  const cloudwatch = { getMetricData: async (i) => { input = i; return { MetricDataResults: [{ Id: 'requests', Values: [2, 3, 0], Timestamps: [new Date(60_000), new Date(120_000), new Date(180_000)] }] }; } };
  const cfg = { loadBalancerDimension: 'app/lb/1', appTargetGroupDimension: 'targetgroup/tg/2' };
  assert.equal(await lastRequestAt(cloudwatch, cfg, 0, 900_000), 180_000);
  const stat = input.MetricDataQueries[0].MetricStat;
  assert.equal(stat.Metric.MetricName, 'RequestCount');
  assert.deepEqual(stat.Metric.Dimensions, [{ Name: 'LoadBalancer', Value: 'app/lb/1' }, { Name: 'TargetGroup', Value: 'targetgroup/tg/2' }]);
  assert.equal(stat.Stat, 'Sum');
  assert.equal(input.EndTime.getTime(), 900_000);
});

test('lastRequestAt also reads the other target groups the requests may take (a grouped Ingress: Dormeto\'s own)', async () => {
  let input;
  const cloudwatch = { getMetricData: async (i) => { input = i; return { MetricDataResults: [{ Id: 'requests', Values: [], Timestamps: [] }, { Id: 'requests1', Values: [4], Timestamps: [new Date(240_000)] }] }; } };
  const cfg = { loadBalancerDimension: 'app/lb/1', appTargetGroupDimension: 'targetgroup/tg/2' };
  assert.equal(await lastRequestAt(cloudwatch, cfg, 0, 900_000, ['targetgroup/k8s-demo-web/3']), 300_000);
  assert.deepEqual(input.MetricDataQueries.map((q) => [q.Id, q.MetricStat.Metric.Dimensions[1].Value]), [['requests', 'targetgroup/tg/2'], ['requests1', 'targetgroup/k8s-demo-web/3']]);
});

test('lastRequestAt is null without a request', async () => {
  const cloudwatch = { getMetricData: async () => ({ MetricDataResults: [{ Id: 'requests', Values: [] }] }) };
  assert.equal(await lastRequestAt(cloudwatch, {}, 0, 1), null);
});
