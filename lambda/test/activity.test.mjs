// The activity of a standalone workload (vision standalone workloads design §4): its idle signals read from CloudWatch, in one
// GetMetricData call, 5-minute points; idle when one signal applies or more and each is under its threshold at every point of the
// window. A missing point, or a read that fails, is never idle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { METRIC_LAG_MS, PERIOD_MS, createIdleSignals, idleWindow, isIdle } from '../src/lib/activity.mjs';

const NOW = Date.UTC(2026, 10, 21, 12, 3, 20);
const MIN = 60_000;
// A window of 15 minutes: three points, 11:35, 11:40, 11:45 (it ends 10 minutes behind, at the 5-minute boundary).
const WINDOW = { startMs: Date.UTC(2026, 10, 21, 11, 35), endMs: Date.UTC(2026, 10, 21, 11, 50) };
const POINTS = [0, 1, 2].map((k) => WINDOW.startMs + k * PERIOD_MS);

const instance = { kind: 'instance', id: 'i-0aaa' };
const group = { kind: 'asg', name: 'workers', min: 0, max: 2, desired: 1 };
const service = { kind: 'ecs', id: 'arn:aws:ecs:eu-west-1:111122223333:service/jobs/worker', cluster: 'arn:aws:ecs:eu-west-1:111122223333:cluster/jobs', desired: 1 };
const db = { kind: 'rds-instance', id: 'orders' };
const cluster = { kind: 'rds-cluster', id: 'ledger' };
const cfg = (overrides = {}) => ({ workloadId: 'batch', kind: 'standalone', idleMinutes: 15, idleCpuPercent: 5, idleNetworkBytes: 'off', idleMetric: 'off', ...overrides });

// A CloudWatch that answers each query from `series[id]` ([value per point, null for a missing one]), in time order.
function fakeCloudWatch(series = {}, { failure = null } = {}) {
  const calls = [];
  return {
    calls,
    async getMetricData(input) {
      calls.push(input);
      if (failure) throw failure;
      return {
        MetricDataResults: input.MetricDataQueries.map((q) => {
          const values = series[q.Id] ?? [];
          const kept = POINTS.map((t, i) => [t, values[i]]).filter(([, v]) => v !== null && v !== undefined);
          return { Id: q.Id, StatusCode: 'Complete', Timestamps: kept.map(([t]) => new Date(t)), Values: kept.map(([, v]) => v) };
        }),
      };
    },
  };
}
const logs = () => {
  const lines = [];
  return { lines, info: (e, d) => lines.push(['info', e, d]), warn: (e, d) => lines.push(['warn', e, d]), error: (e, d) => lines.push(['error', e, d]) };
};
const read = async (config, backends, series, options) => {
  const cloudwatch = fakeCloudWatch(series, options);
  const log = logs();
  const signals = await createIdleSignals({ cloudwatch, log })(config, backends, WINDOW);
  return { signals, cloudwatch, log, queries: cloudwatch.calls[0]?.MetricDataQueries ?? [] };
};
const stat = (q) => [q.Id, q.MetricStat.Metric.Namespace, q.MetricStat.Metric.MetricName, q.MetricStat.Metric.Dimensions, q.MetricStat.Stat, q.MetricStat.Period];

test('the window: the idle minutes, ending at the last 5-minute boundary 10 minutes behind, so every point is published', () => {
  assert.equal(METRIC_LAG_MS, 10 * MIN);
  assert.equal(PERIOD_MS, 5 * MIN);
  assert.deepEqual(idleWindow({ idleMinutes: 15 }, NOW), WINDOW);
  // A window that is not a multiple of 5 minutes takes the whole points that cover it.
  assert.deepEqual(idleWindow({ idleMinutes: 12 }, NOW), WINDOW);
  assert.deepEqual(idleWindow({ idleMinutes: 120 }, NOW), { startMs: WINDOW.endMs - 120 * MIN, endMs: WINDOW.endMs });
});

test('each kind\'s CPU query: namespace, metric, dimensions, Maximum, period 300', async () => {
  const cases = [
    [instance, 'AWS/EC2', [{ Name: 'InstanceId', Value: 'i-0aaa' }]],
    [group, 'AWS/EC2', [{ Name: 'AutoScalingGroupName', Value: 'workers' }]],
    [service, 'AWS/ECS', [{ Name: 'ClusterName', Value: 'jobs' }, { Name: 'ServiceName', Value: 'worker' }]],
    [db, 'AWS/RDS', [{ Name: 'DBInstanceIdentifier', Value: 'orders' }]],
    [cluster, 'AWS/RDS', [{ Name: 'DBClusterIdentifier', Value: 'ledger' }]],
  ];
  for (const [backend, namespace, dimensions] of cases) {
    const { queries, cloudwatch } = await read(cfg(), [backend], {});
    assert.deepEqual(queries.map(stat), [['cpu_0', namespace, 'CPUUtilization', dimensions, 'Maximum', 300]], backend.kind);
    assert.deepEqual([cloudwatch.calls[0].StartTime, cloudwatch.calls[0].EndTime, cloudwatch.calls[0].ScanBy], [new Date(WINDOW.startMs), new Date(WINDOW.endMs), 'TimestampAscending']);
  }
});

test('each kind\'s network queries: in and out, Sum for EC2, Average for RDS; none for ECS, said', async () => {
  const net = cfg({ idleCpuPercent: 'off', idleNetworkBytes: 1000 });
  assert.deepEqual((await read(net, [instance], {})).queries.map(stat), [
    ['net_0_in', 'AWS/EC2', 'NetworkIn', [{ Name: 'InstanceId', Value: 'i-0aaa' }], 'Sum', 300],
    ['net_0_out', 'AWS/EC2', 'NetworkOut', [{ Name: 'InstanceId', Value: 'i-0aaa' }], 'Sum', 300],
  ]);
  assert.deepEqual((await read(net, [group], {})).queries.map(stat).map((q) => q.slice(1, 4)), [
    ['AWS/EC2', 'NetworkIn', [{ Name: 'AutoScalingGroupName', Value: 'workers' }]], ['AWS/EC2', 'NetworkOut', [{ Name: 'AutoScalingGroupName', Value: 'workers' }]],
  ]);
  assert.deepEqual((await read(net, [cluster], {})).queries.map(stat), [
    ['net_0_in', 'AWS/RDS', 'NetworkReceiveThroughput', [{ Name: 'DBClusterIdentifier', Value: 'ledger' }], 'Average', 300],
    ['net_0_out', 'AWS/RDS', 'NetworkTransmitThroughput', [{ Name: 'DBClusterIdentifier', Value: 'ledger' }], 'Average', 300],
  ]);
  const ecs = await read(net, [service], {});
  assert.deepEqual(ecs.queries, []);
  assert.equal(ecs.cloudwatch.calls.length, 0, 'nothing to read: no call');
  assert.deepEqual(ecs.signals.find((s) => s.signal === 'network'), {
    signal: 'network', below: 1000, value: null, underSince: null, applies: false, reason: 'an ECS service has no network metric without Container Insights',
  });
});

test('the custom metric: its namespace, name, statistic, ${resource} replaced by the resource\'s own id', async () => {
  const metric = { namespace: 'Batch', name: 'QueueDepth', dimensions: { Queue: 'jobs-${resource}', Env: 'prod' }, statistic: 'Sum', below: 1 };
  const cases = [[instance, 'i-0aaa'], [group, 'workers'], [service, 'worker'], [db, 'orders']];
  for (const [backend, id] of cases) {
    const { queries } = await read(cfg({ idleCpuPercent: 'off', idleMetric: metric }), [backend], {});
    assert.deepEqual(queries.map(stat), [['metric', 'Batch', 'QueueDepth', [{ Name: 'Queue', Value: `jobs-${id}` }, { Name: 'Env', Value: 'prod' }], 'Sum', 300]], backend.kind);
  }
});

test('the CPU and the network are the server\'s, not its companion database\'s; the connections metric is the database\'s', async () => {
  const connections = { namespace: 'AWS/RDS', name: 'DatabaseConnections', dimensions: { DBInstanceIdentifier: 'orders' }, statistic: 'Maximum', below: 1 };
  const { queries } = await read(cfg({ idleNetworkBytes: 10, idleMetric: connections }), [instance, db], {});
  assert.deepEqual(queries.map((q) => [q.Id, q.MetricStat.Metric.MetricName, q.MetricStat.Metric.Dimensions[0].Value]), [
    ['cpu_0', 'CPUUtilization', 'i-0aaa'], ['net_0_in', 'NetworkIn', 'i-0aaa'], ['net_0_out', 'NetworkOut', 'i-0aaa'], ['metric', 'DatabaseConnections', 'orders'],
  ]);
});

test('every signal in one GetMetricData call a workload', async () => {
  const { cloudwatch } = await read(cfg({ idleNetworkBytes: 10, idleMetric: { namespace: 'N', name: 'M', dimensions: {}, statistic: 'Average', below: 2 } }), [group], {});
  assert.equal(cloudwatch.calls.length, 1);
  assert.equal(cloudwatch.calls[0].MetricDataQueries.length, 4);
});

test('under at every point: idle, under since the window\'s start, its last value', async () => {
  const { signals } = await read(cfg(), [instance], { cpu_0: [1, 4.9, 2] });
  assert.deepEqual(signals, [
    { signal: 'cpu', below: 5, value: 2, underSince: WINDOW.startMs, applies: true },
    { signal: 'network', below: null, value: null, underSince: null, applies: false, reason: 'off' },
    { signal: 'metric', below: null, value: null, underSince: null, applies: false, reason: 'off' },
  ]);
  assert.equal(isIdle(signals, WINDOW), true);
});

test('over at one point: busy, under since the point after it; at the threshold is not under', async () => {
  const over = (await read(cfg(), [instance], { cpu_0: [1, 30, 2] })).signals[0];
  assert.deepEqual([over.value, over.underSince], [2, POINTS[2]]);
  assert.equal(isIdle([over], WINDOW), false);
  const at = (await read(cfg(), [instance], { cpu_0: [1, 2, 5] })).signals[0];
  assert.deepEqual([at.value, at.underSince], [5, null]);
  assert.equal(isIdle([at], WINDOW), false);
});

test('a missing point is not idle', async () => {
  const gap = (await read(cfg(), [instance], { cpu_0: [1, null, 2] })).signals[0];
  assert.deepEqual([gap.value, gap.underSince], [2, POINTS[2]]);
  assert.equal(isIdle([gap], WINDOW), false);
  const none = (await read(cfg(), [instance], {})).signals[0];
  assert.deepEqual([none.value, none.underSince, none.applies], [null, null, true]);
  assert.equal(isIdle([none], WINDOW), false);
  // The network needs both directions at a point.
  const half = (await read(cfg({ idleCpuPercent: 'off', idleNetworkBytes: 1000 }), [instance], { net_0_in: [1, 1, 1], net_0_out: [1, null, 1] })).signals[1];
  assert.equal(isIdle([half], WINDOW), false);
});

test('the network: the bytes in and out a minute, EC2\'s 5-minute sums divided by 5, RDS\'s bytes a second times 60', async () => {
  const ec2 = (await read(cfg({ idleCpuPercent: 'off', idleNetworkBytes: 1000 }), [instance], { net_0_in: [2000, 2000, 2000], net_0_out: [2000, 2000, 2999] })).signals[1];
  assert.deepEqual([ec2.value, ec2.underSince], [999.8, WINDOW.startMs]);
  const rds = (await read(cfg({ idleCpuPercent: 'off', idleNetworkBytes: 1000 }), [db], { net_0_in: [10, 10, 10], net_0_out: [6, 6, 7] })).signals[1];
  assert.deepEqual([rds.value, rds.underSince], [1020, null]);
});

test('several signals: each must be idle; one busy is busy', async () => {
  const both = cfg({ idleMetric: { namespace: 'AWS/RDS', name: 'DatabaseConnections', dimensions: { DBInstanceIdentifier: 'orders' }, statistic: 'Maximum', below: 1 } });
  const idle = await read(both, [instance, db], { cpu_0: [1, 1, 1], metric: [0, 0, 0] });
  assert.equal(isIdle(idle.signals, WINDOW), true);
  const busy = await read(both, [instance, db], { cpu_0: [1, 1, 1], metric: [0, 1, 0] });
  assert.equal(isIdle(busy.signals, WINDOW), false);
});

test('no signal applying: never idle, and nothing read', async () => {
  const { signals, cloudwatch } = await read(cfg({ idleCpuPercent: 'off' }), [instance], {});
  assert.deepEqual(signals.map((s) => [s.signal, s.applies, s.reason]), [['cpu', false, 'off'], ['network', false, 'off'], ['metric', false, 'off']]);
  assert.equal(cloudwatch.calls.length, 0);
  assert.equal(isIdle(signals, WINDOW), false);
  assert.equal(isIdle([], WINDOW), false);
});

test('a throttled call is not idle and is logged', async () => {
  const failure = Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });
  const { signals, log } = await read(cfg({ idleNetworkBytes: 10 }), [instance], {}, { failure });
  assert.deepEqual(signals.slice(0, 2), [
    { signal: 'cpu', below: 5, value: null, underSince: null, applies: true, reason: 'the metrics could not be read: ThrottlingException' },
    { signal: 'network', below: 10, value: null, underSince: null, applies: true, reason: 'the metrics could not be read: ThrottlingException' },
  ]);
  assert.equal(isIdle(signals, WINDOW), false);
  assert.deepEqual(log.lines, [['warn', 'IdleSignalsUnread', { workloadId: 'batch', error: 'ThrottlingException: Rate exceeded' }]]);
});

test('final review, Minor 8: a metric with a list of dimensions reads each, and is under when each is', async () => {
  const connections = { namespace: 'AWS/RDS', name: 'DatabaseConnections', dimensions: [{ DBInstanceIdentifier: 'orders' }, { DBClusterIdentifier: 'ledger' }], statistic: 'Maximum', below: 1 };
  const config = cfg({ idleCpuPercent: 'off', idleMetric: connections });
  const idle = await read(config, [instance, db, cluster], { metric_0: [0, 0, 0], metric_1: [0, 0, 0] });
  assert.deepEqual(idle.queries.map(stat), [
    ['metric_0', 'AWS/RDS', 'DatabaseConnections', [{ Name: 'DBInstanceIdentifier', Value: 'orders' }], 'Maximum', 300],
    ['metric_1', 'AWS/RDS', 'DatabaseConnections', [{ Name: 'DBClusterIdentifier', Value: 'ledger' }], 'Maximum', 300],
  ]);
  assert.equal(isIdle(idle.signals, WINDOW), true);
  const busy = await read(config, [instance, db, cluster], { metric_0: [0, 0, 0], metric_1: [0, 2, 0] });
  assert.equal(isIdle(busy.signals, WINDOW), false);
});
