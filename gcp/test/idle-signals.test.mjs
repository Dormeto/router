// A standalone workload's idle signals on Google Cloud (vision standalone workloads design §4; plan 5, R29): Cloud Monitoring's
// timeSeries.list, 5-minute aligned points over the idle window, the same signals and the same idle rule as AWS's (activity.mjs).
// Against a fake Google: no call leaves the test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PERIOD_MS, isIdle } from '../../lambda/src/lib/activity.mjs';
import { CALLS, createIdleSignals } from '../src/idle-signals.mjs';

// A window of 15 minutes: three points, starting 11:35, 11:40, 11:45.
const WINDOW = { startMs: Date.UTC(2026, 10, 21, 11, 35), endMs: Date.UTC(2026, 10, 21, 11, 50) };
const POINTS = [0, 1, 2].map((k) => WINDOW.startMs + k * PERIOD_MS);
const vm = { kind: 'vm', location: 'europe-west1-b', name: 'batch' };
const group = { kind: 'mig', location: 'europe-west1', name: 'workers', instances: ['workers-a1', 'workers-b2'] };
const sql = { kind: 'cloudsql', name: 'orders' };
const cfg = (overrides = {}) => ({ workloadId: 'batch', kind: 'standalone', resource: 'projects/p/zones/europe-west1-b/instances/batch', idleMinutes: 15, idleCpuPercent: 5, idleNetworkBytes: 'off', idleMetric: 'off', ...overrides });

// series: [{ type, labels: { instance_name? }, resource: {}, values: [one a point, null: none] }]; points newest first, as Google gives them.
function fakeGoogle(series = [], { failure = null } = {}) {
  const calls = [];
  return {
    calls,
    async request(method, url) {
      const u = new URL(url);
      const q = Object.fromEntries(u.searchParams);
      calls.push({ method, path: u.origin + u.pathname, ...q });
      if (failure) throw failure;
      const type = /metric\.type = "([^"]+)"/.exec(q.filter)[1];
      const names = /instance_name = one_of\(([^)]*)\)/.exec(q.filter)?.[1].match(/"[^"]+"/g)?.map((n) => JSON.parse(n));
      return {
        timeSeries: series.filter((s) => s.type === type && (!names || names.includes(s.labels?.instance_name))).map((s) => ({
          metric: { type, labels: s.labels ?? {} }, resource: { type: 'gce_instance', labels: s.resource ?? {} },
          points: POINTS.map((t, i) => [t, s.values[i]]).filter(([, v]) => v !== null && v !== undefined).reverse()
            .map(([t, v]) => ({ interval: { startTime: new Date(t).toISOString(), endTime: new Date(t + PERIOD_MS).toISOString() }, value: Number.isInteger(v) && s.int ? { int64Value: String(v) } : { doubleValue: v } })),
        })),
      };
    },
  };
}
const logs = () => {
  const lines = [];
  return { lines, info: () => {}, warn: (e, d) => lines.push([e, d]), error: () => {} };
};
async function read(config, backends, series, options) {
  const google = fakeGoogle(series, options);
  const log = logs();
  const signals = await createIdleSignals({ google, project: 'p', log })(config, backends, WINDOW);
  return { signals, calls: google.calls, log };
}
const CPU = 'compute.googleapis.com/instance/cpu/utilization';
const RX = 'compute.googleapis.com/instance/network/received_bytes_count';
const TX = 'compute.googleapis.com/instance/network/sent_bytes_count';
const SQL_CPU = 'cloudsql.googleapis.com/database/cpu/utilization';

test('each kind\'s query: timeSeries.list, the metric, the resource\'s filter, aligned to 300 s, over the window', async () => {
  const { calls } = await read(cfg(), [vm], []);
  assert.deepEqual(calls, [{
    method: 'GET', path: 'https://monitoring.googleapis.com/v3/projects/p/timeSeries',
    filter: `metric.type = "${CPU}" AND resource.type = "gce_instance" AND metric.labels.instance_name = one_of("batch")`,
    'interval.startTime': '2026-11-21T11:35:00.000Z', 'interval.endTime': '2026-11-21T11:50:00.000Z',
    'aggregation.alignmentPeriod': '300s', 'aggregation.perSeriesAligner': 'ALIGN_MAX',
  }]);
  // A group: its VMs by name, as the router lists them (listManagedInstances).
  assert.match((await read(cfg(), [group], [])).calls[0].filter, /metric\.labels\.instance_name = one_of\("workers-a1", "workers-b2"\)$/);
  // A Cloud SQL resource: its CPU by database_id, <project>:<instance>.
  assert.equal((await read(cfg(), [sql], [])).calls[0].filter, `metric.type = "${SQL_CPU}" AND resource.labels.database_id = "p:orders"`);
  // The network: received and sent, ALIGN_SUM.
  const net = await read(cfg({ idleCpuPercent: 'off', idleNetworkBytes: 1000 }), [vm], []);
  assert.deepEqual(net.calls.map((c) => [/metric\.type = "([^"]+)"/.exec(c.filter)[1], c['aggregation.perSeriesAligner']]), [[RX, 'ALIGN_SUM'], [TX, 'ALIGN_SUM']]);
});

test('the CPU is a ratio: its threshold a percentage (multiplied by 100 here); under at every point is idle', async () => {
  const { signals } = await read(cfg(), [vm], [{ type: CPU, labels: { instance_name: 'batch' }, values: [0.01, 0.049, 0.02] }]);
  assert.deepEqual(signals[0], { signal: 'cpu', below: 5, value: 2, underSince: WINDOW.startMs, applies: true });
  assert.deepEqual(signals.slice(1).map((s) => [s.signal, s.applies, s.reason]), [['network', false, 'off'], ['metric', false, 'off']]);
  assert.equal(isIdle(signals, WINDOW), true);
  const over = (await read(cfg(), [vm], [{ type: CPU, labels: { instance_name: 'batch' }, values: [0.01, 0.3, 0.02] }])).signals;
  assert.deepEqual([over[0].underSince, isIdle(over, WINDOW)], [POINTS[2], false]);
});

test('a group: every VM must be under; one VM with no series, or a missing point, is not idle', async () => {
  const both = [{ type: CPU, labels: { instance_name: 'workers-a1' }, values: [0.01, 0.01, 0.01] }, { type: CPU, labels: { instance_name: 'workers-b2' }, values: [0.01, 0.01, 0.01] }];
  assert.equal(isIdle((await read(cfg(), [group], both)).signals, WINDOW), true);
  const busy = [both[0], { ...both[1], values: [0.01, 0.4, 0.01] }];
  assert.equal(isIdle((await read(cfg(), [group], busy)).signals, WINDOW), false);
  assert.equal(isIdle((await read(cfg(), [group], [both[0]])).signals, WINDOW), false, 'a VM with no series');
  const gap = [both[0], { ...both[1], values: [0.01, null, 0.01] }];
  assert.equal(isIdle((await read(cfg(), [group], gap)).signals, WINDOW), false, 'a missing point');
  // A group whose VMs are not known: not idle, said.
  const unknown = (await read(cfg(), [{ ...group, instances: [] }], [])).signals[0];
  assert.deepEqual([unknown.applies, unknown.reason, isIdle([unknown], WINDOW)], [true, 'the VMs of group workers are not known', false]);
});

test('the network: received and sent, summed over the VM\'s series, their 5-minute sums a minute (divided by 5)', async () => {
  const series = [
    { type: RX, labels: { instance_name: 'batch', loadbalanced: 'false' }, values: [1000, 1000, 1000], int: true },
    { type: RX, labels: { instance_name: 'batch', loadbalanced: 'true' }, values: [500, 500, 500], int: true },
    { type: TX, labels: { instance_name: 'batch', loadbalanced: 'false' }, values: [2000, 2000, 2499], int: true },
  ];
  const [, net] = (await read(cfg({ idleCpuPercent: 'off', idleNetworkBytes: 1000 }), [vm], series)).signals;
  assert.deepEqual([net.value, net.underSince], [799.8, WINDOW.startMs]);
  const half = (await read(cfg({ idleCpuPercent: 'off', idleNetworkBytes: 1000 }), [vm], series.slice(0, 2))).signals[1];
  assert.equal(isIdle([half], WINDOW), false, 'sent missing');
  const sqlNet = (await read(cfg({ idleCpuPercent: 'off', idleNetworkBytes: 1000 }), [sql], [])).signals[1];
  assert.deepEqual([sqlNet.applies, sqlNet.reason], [false, 'a Cloud SQL instance\'s network is not read: its connections are its signal']);
});

test('the custom metric: its type, its filter with ${resource} replaced by the resource\'s name, its aligner; the built-in list of filters each read', async () => {
  const metric = { type: 'custom.googleapis.com/queue/depth', filter: 'metric.labels.queue = "${resource}-jobs"', aligner: 'ALIGN_MEAN', below: 1 };
  const one = await read(cfg({ idleCpuPercent: 'off', idleMetric: metric }), [vm], [{ type: metric.type, labels: {}, values: [0, 0, 0] }]);
  assert.deepEqual(one.calls.map((c) => [c.filter, c['aggregation.perSeriesAligner']]), [['metric.type = "custom.googleapis.com/queue/depth" AND (metric.labels.queue = "batch-jobs")', 'ALIGN_MEAN']]);
  assert.equal(isIdle(one.signals, WINDOW), true);
  const noFilter = await read(cfg({ idleCpuPercent: 'off', idleMetric: { ...metric, filter: undefined } }), [vm], []);
  assert.equal(noFilter.calls[0].filter, 'metric.type = "custom.googleapis.com/queue/depth"');
  const connections = { type: 'cloudsql.googleapis.com/database/network/connections', filter: ['resource.labels.database_id = ends_with(":a")', 'resource.labels.database_id = ends_with(":b")'], aligner: 'ALIGN_MAX', below: 1 };
  const two = await read(cfg({ idleCpuPercent: 'off', idleMetric: connections }), [vm, sql], [{ type: connections.type, labels: {}, values: [0, 0, 0] }]);
  assert.equal(two.calls.length, 2);
  assert.equal(isIdle(two.signals, WINDOW), true);
});

test('no signal applying: no call, never idle; a failed read: never idle, logged', async () => {
  const none = await read(cfg({ idleCpuPercent: 'off' }), [vm], []);
  assert.deepEqual([none.calls.length, isIdle(none.signals, WINDOW)], [0, false]);
  const failure = Object.assign(new Error('Quota exceeded'), { name: 'GoogleError', code: 429, status: 'RESOURCE_EXHAUSTED' });
  const failed = await read(cfg({ idleNetworkBytes: 10 }), [vm], [], { failure });
  assert.deepEqual(failed.signals.slice(0, 2).map((s) => [s.applies, s.value, s.underSince, s.reason]), [
    [true, null, null, 'the metrics could not be read: RESOURCE_EXHAUSTED'], [true, null, null, 'the metrics could not be read: RESOURCE_EXHAUSTED'],
  ]);
  assert.equal(isIdle(failed.signals, WINDOW), false);
  assert.deepEqual(failed.log.lines, [['IdleSignalsUnread', { workloadId: 'batch', error: 'RESOURCE_EXHAUSTED: Quota exceeded' }]]);
});

test('its one permission, monitoring.timeSeries.list, is in the router\'s grants of access.json', async () => {
  assert.deepEqual(CALLS, { idleSignals: ['monitoring.timeSeries.list'] });
  const manifest = JSON.parse(await readFile(new URL('../access.json', import.meta.url), 'utf8'));
  const permissions = new Set();
  for (const { role } of manifest.router) {
    const custom = /\/roles\/(.+)$/.exec(role)?.[1];
    for (const p of custom ? manifest.roles[custom].permissions : manifest.predefined[role] ?? []) permissions.add(p);
  }
  for (const p of CALLS.idleSignals) assert.ok(permissions.has(p), p);
});
