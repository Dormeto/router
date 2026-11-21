// The activity of a standalone workload (vision standalone workloads design §4): its idle signals, CPU, network and one custom
// metric, read from CloudWatch for its backends in one GetMetricData call, 5-minute points. A signal is under while each of its
// points is under its threshold; the workload is idle when one signal applies or more and each is under at every point of the
// window. A missing point, or a read that fails, is never idle. `'off'` is read here and nowhere else: the signal does not apply.
export const PERIOD_MS = 5 * 60_000;
// CloudWatch publishes a point minutes after its period ends (EC2's basic monitoring the latest): a window ending now would
// always miss its last point, so it ends 10 minutes behind, at a 5-minute boundary.
export const METRIC_LAG_MS = 10 * 60_000;
const PERIOD_S = PERIOD_MS / 1000;
const PERIOD_MINUTES = PERIOD_MS / 60_000;
const RESOURCE = '${resource}';
const same = (value) => value;
const NO_ECS_NETWORK = 'an ECS service has no network metric without Container Insights';

// The idle window at `nowMs`: its idle minutes, as whole points, ending at the last 5-minute boundary METRIC_LAG_MS behind.
export function idleWindow(cfg, nowMs) {
  const endMs = Math.floor((nowMs - METRIC_LAG_MS) / PERIOD_MS) * PERIOD_MS;
  return { startMs: endMs - Math.ceil((cfg.idleMinutes * 60_000) / PERIOD_MS) * PERIOD_MS, endMs };
}

const lastSegment = (arn) => String(arn ?? '').split('/').at(-1);
const isDatabase = (b) => b.kind === 'rds-instance' || b.kind === 'rds-cluster';
const rdsDimension = (b) => ({ Name: b.kind === 'rds-cluster' ? 'DBClusterIdentifier' : 'DBInstanceIdentifier', Value: b.id });

// Each backend's own id, as `${resource}` is replaced and its metrics are named.
function resourceIdOf(b) {
  if (b.kind === 'asg') return b.name;
  if (b.kind === 'ecs') return lastSegment(b.id);
  return b.id;
}

function cpuMetric(b) {
  if (b.kind === 'instance') return { namespace: 'AWS/EC2', dimensions: [{ Name: 'InstanceId', Value: b.id }] };
  if (b.kind === 'asg') return { namespace: 'AWS/EC2', dimensions: [{ Name: 'AutoScalingGroupName', Value: b.name }] };
  if (b.kind === 'ecs') return { namespace: 'AWS/ECS', dimensions: [{ Name: 'ClusterName', Value: lastSegment(b.cluster) }, { Name: 'ServiceName', Value: lastSegment(b.id) }] };
  if (isDatabase(b)) return { namespace: 'AWS/RDS', dimensions: [rdsDimension(b)] };
  return null;
}

// Bytes in and out: EC2's are 5-minute sums (a minute: divided by 5), RDS's bytes a second (a minute: times 60); ECS has none.
function networkMetrics(b) {
  if (b.kind === 'instance' || b.kind === 'asg') {
    const { dimensions } = cpuMetric(b);
    return { namespace: 'AWS/EC2', names: ['NetworkIn', 'NetworkOut'], stat: 'Sum', dimensions, perMinute: (sum) => sum / PERIOD_MINUTES };
  }
  if (isDatabase(b)) return { namespace: 'AWS/RDS', names: ['NetworkReceiveThroughput', 'NetworkTransmitThroughput'], stat: 'Average', dimensions: [rdsDimension(b)], perMinute: (sum) => sum * 60 };
  return null;
}

const query = (id, namespace, name, dimensions, stat) => ({
  Id: id, ReturnData: true, MetricStat: { Metric: { Namespace: namespace, MetricName: name, Dimensions: dimensions }, Period: PERIOD_S, Stat: stat },
});

const notApplying = (signal, below, reason) => ({ signal, below, value: null, underSince: null, applies: false, reason });

// What each signal reads: its queries and how its series combine into one value a point (`series`: [{ ids, scale }], each series
// its queries' sum, scaled), or why it does not apply. CPU and network are the primary backends'
// (the database's when the workload's resource is the database): a database companion's CPU is not near zero.
function plan(cfg, backends) {
  const primaries = backends.filter((b) => !isDatabase(b));
  const own = primaries.length ? primaries : backends.filter(isDatabase);
  const signals = [];
  const queries = [];

  if (cfg.idleCpuPercent === 'off') signals.push(notApplying('cpu', null, 'off'));
  else if (!own.length) signals.push(notApplying('cpu', cfg.idleCpuPercent, 'no backend to read'));
  else {
    const series = own.map((b, i) => {
      const { namespace, dimensions } = cpuMetric(b);
      queries.push(query(`cpu_${i}`, namespace, 'CPUUtilization', dimensions, 'Maximum'));
      return { ids: [`cpu_${i}`], scale: same };
    });
    signals.push({ signal: 'cpu', below: cfg.idleCpuPercent, series });
  }

  if (cfg.idleNetworkBytes === 'off') signals.push(notApplying('network', null, 'off'));
  else {
    const read = own.map((b, i) => [b, i, networkMetrics(b)]).filter(([, , m]) => m);
    if (!read.length) signals.push(notApplying('network', cfg.idleNetworkBytes, own.length ? NO_ECS_NETWORK : 'no backend to read'));
    else {
      const series = read.map(([, i, m]) => ({
        ids: m.names.map((name, k) => {
          const id = `net_${i}_${k ? 'out' : 'in'}`;
          queries.push(query(id, m.namespace, name, m.dimensions, m.stat));
          return id;
        }),
        scale: m.perMinute,
      }));
      signals.push({ signal: 'network', below: cfg.idleNetworkBytes, series });
    }
  }

  const metric = cfg.idleMetric;
  if (metric === 'off' || !metric) signals.push(notApplying('metric', null, 'off'));
  else {
    const resource = own[0] ? resourceIdOf(own[0]) : null;
    // A list of dimensions (the type databases' built-in with several databases): each read, each must be under.
    const sets = Array.isArray(metric.dimensions) ? metric.dimensions : [metric.dimensions ?? {}];
    const values = sets.flatMap((d) => Object.values(d));
    if (resource === null && values.some((v) => v.includes(RESOURCE))) signals.push(notApplying('metric', metric.below, `no backend to replace ${RESOURCE}`));
    else {
      const series = sets.map((d, i) => {
        const id = Array.isArray(metric.dimensions) ? `metric_${i}` : 'metric';
        queries.push(query(id, metric.namespace, metric.name, Object.entries(d).map(([Name, v]) => ({ Name, Value: v.replaceAll(RESOURCE, resource) })), metric.statistic));
        return { ids: [id], scale: same };
      });
      signals.push({ signal: 'metric', below: metric.below, series });
    }
  }
  return { signals, queries };
}

// A signal's value at each point of the window (the largest of its series; missing when one of them is), its last value and since
// when every point up to the last is under its threshold (null when the last is over or missing).
function measured({ signal, below, series }, points, window) {
  const at = (t) => {
    let worst = null;
    for (const { ids, scale } of series) {
      let sum = 0;
      for (const id of ids) {
        const v = points.get(id)?.get(t);
        if (v === undefined) return undefined;
        sum += v;
      }
      worst = worst === null ? scale(sum) : Math.max(worst, scale(sum));
    }
    return worst ?? undefined;
  };
  const times = [];
  for (let t = window.startMs; t < window.endMs; t += PERIOD_MS) times.push(t);
  let value = null;
  for (const t of times) {
    const v = at(t);
    if (v !== undefined) value = v;
  }
  let underSince = null;
  for (let i = times.length - 1; i >= 0; i -= 1) {
    const v = at(times[i]);
    if (v === undefined || !(v < below)) break;
    underSince = times[i];
  }
  return { signal, below, value, underSince, applies: true };
}

// idleSignals(cfg, backends, window) → [{ signal, below, value, underSince, applies, reason? }], cfg the effective configuration
// (its signals resolved by the levels), backends the workload's (backends.mjs's), window { startMs, endMs } (idleWindow's).
// Nothing applying: no call. A failed read is logged and every applying signal is unread, never under.
export function createIdleSignals({ cloudwatch, log }) {
  return async function idleSignals(cfg, backends, window) {
    const { signals, queries } = plan(cfg, backends ?? []);
    const applying = signals.filter((s) => s.series);
    if (!applying.length) return signals;
    let out;
    try {
      // At most 288 points a query (a day) and a few queries: one call holds them all, with no next page.
      out = await cloudwatch.getMetricData({ StartTime: new Date(window.startMs), EndTime: new Date(window.endMs), ScanBy: 'TimestampAscending', MetricDataQueries: queries });
    } catch (err) {
      log.warn('IdleSignalsUnread', { workloadId: cfg.workloadId, error: `${err.name}: ${err.message}` });
      return signals.map((s) => (s.series ? { signal: s.signal, below: s.below, value: null, underSince: null, applies: true, reason: `the metrics could not be read: ${err.name}` } : s));
    }
    const points = new Map();
    for (const result of out?.MetricDataResults ?? []) {
      const series = new Map();
      (result.Timestamps ?? []).forEach((timestamp, i) => {
        const v = result.Values?.[i];
        if (typeof v === 'number' && Number.isFinite(v)) series.set(new Date(timestamp).getTime(), v);
      });
      points.set(result.Id, series);
    }
    return signals.map((s) => (s.series ? measured(s, points, window) : s));
  };
}

// Idle: one signal applies or more, and each is under since the window's start.
export function isIdle(signals, window) {
  const applying = (signals ?? []).filter((s) => s.applies);
  return applying.length > 0 && applying.every((s) => s.underSince !== null && s.underSince <= window.startMs);
}
