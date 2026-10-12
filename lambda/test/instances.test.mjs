import { test } from 'node:test';
import assert from 'node:assert/strict';
import { healthyCount, instanceStates, startInstances, stopInstances } from '../src/lib/instances.mjs';
import { lastRequestAt } from '../src/lib/metrics.mjs';

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
