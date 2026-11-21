// A standalone workload's idle signals on Google Cloud (vision standalone workloads design §4; plan 5's Interfaces): CPU, network and
// one custom metric, read from Cloud Monitoring for its backends, in AWS's shape and by AWS's rule (lambda/src/lib/activity.mjs: the
// window, the measure of a signal, isIdle). `'off'` is read here and nowhere else on Google Cloud: the signal does not apply. A failed
// read, a VM with no series or a missing point is never idle. HTTP's request activity is activity.mjs, not this.
//
// Cloud Monitoring's timeSeries.list takes one metric type a filter: one call a metric type (CPU; the network's received and sent;
// the custom metric, one a filter of the built-in list), all of a workload's at once, each paged. Each call aligns its points to the
// window's 5-minute periods (aggregation.alignmentPeriod 300s, a per-series aligner). An aligned point is keyed by its period's start
// (its interval's end minus 300 s), as AWS's are by their timestamp. How late Google Cloud's points come is not known here: the window
// keeps AWS's 10-minute lag (idleWindow), to measure live (design §12).
import { measureSignal, notApplying, PERIOD_MS } from '../../lambda/src/lib/activity.mjs';

const MONITORING = 'https://monitoring.googleapis.com/v3';
const RESOURCE = '${resource}';
const PERIOD_MINUTES = PERIOD_MS / 60_000;

// What it calls (the router's role in access.json holds it: test/idle-signals.test.mjs).
export const CALLS = { idleSignals: ['monitoring.timeSeries.list'] };

// Compute Engine's CPU utilization is a ratio from 0 to 1 (a GAUGE), its network counters bytes a sampling period (DELTA), labelled by
// the VM's name (`instance_name`) and by `loadbalanced`; Cloud SQL's CPU utilization a ratio, by `database_id`, `<project>:<instance>`.
const CPU = 'compute.googleapis.com/instance/cpu/utilization';
const RECEIVED = 'compute.googleapis.com/instance/network/received_bytes_count';
const SENT = 'compute.googleapis.com/instance/network/sent_bytes_count';
const SQL_CPU = 'cloudsql.googleapis.com/database/cpu/utilization';
const NO_SQL_NETWORK = 'a Cloud SQL instance\'s network is not read: its connections are its signal';

const same = (value) => value;
// The CPU's ratio as the percentage its threshold is (idleCpuPercent: 0 to 100, as on AWS).
const percent = (ratio) => ratio * 100;
// A 5-minute sum of bytes as bytes a minute (idleNetworkBytes), as AWS's EC2 sums.
const perMinute = (sum) => sum / PERIOD_MINUTES;
const max = (a, b) => (a === undefined ? b : Math.max(a, b));
const sum = (a, b) => (a === undefined ? b : a + b);
const quoted = (value) => JSON.stringify(String(value));
const isDatabase = (b) => b?.kind === 'cloudsql';
// A VM's name, or a group's VMs' names as the router lists them (compute.mjs listManagedInstances: names or `{ name }`).
const vmsOf = (b) => (b.kind === 'vm' ? [b.name] : (Array.isArray(b.instances) ? b.instances : []).map((i) => (typeof i === 'string' ? i : i?.name)).filter(Boolean));
const vmFilter = (type, names) => `metric.type = "${type}" AND resource.type = "gce_instance" AND metric.labels.instance_name = one_of(${names.map(quoted).join(', ')})`;
const instanceName = (series) => series.metric?.labels?.instance_name ?? '';

// What each signal reads (`specs`: a call each, its points merged by `label` with `merge`) and how its series combine into one value a
// point (`series`: [{ ids, scale }], AWS's form), or why it does not apply.
function plan(cfg, backends, project) {
  const primaries = backends.filter((b) => !isDatabase(b));
  const own = primaries.length ? primaries : backends.filter(isDatabase);
  const signals = [];
  const specs = [];
  const unknownGroup = own.find((b) => b.kind === 'mig' && !vmsOf(b).length);

  if (cfg.idleCpuPercent === 'off') signals.push(notApplying('cpu', null, 'off'));
  else if (!own.length) signals.push(notApplying('cpu', cfg.idleCpuPercent, 'no backend to read'));
  else if (unknownGroup) signals.push({ signal: 'cpu', below: cfg.idleCpuPercent, value: null, underSince: null, applies: true, reason: `the VMs of group ${unknownGroup.name} are not known` });
  else {
    const series = own.flatMap((b, i) => {
      const id = `cpu_${i}`;
      if (isDatabase(b)) {
        specs.push({ id, filter: `metric.type = "${SQL_CPU}" AND resource.labels.database_id = "${project}:${b.name}"`, aligner: 'ALIGN_MAX', label: () => 'db', merge: max });
        return [{ ids: [`${id}:db`], scale: percent }];
      }
      specs.push({ id, filter: vmFilter(CPU, vmsOf(b)), aligner: 'ALIGN_MAX', label: instanceName, merge: max });
      // Every VM must be under: a series each.
      return vmsOf(b).map((name) => ({ ids: [`${id}:${name}`], scale: percent }));
    });
    signals.push({ signal: 'cpu', below: cfg.idleCpuPercent, series });
  }

  if (cfg.idleNetworkBytes === 'off') signals.push(notApplying('network', null, 'off'));
  else if (!own.length) signals.push(notApplying('network', cfg.idleNetworkBytes, 'no backend to read'));
  else if (own.every(isDatabase)) signals.push(notApplying('network', cfg.idleNetworkBytes, NO_SQL_NETWORK));
  else if (unknownGroup) signals.push({ signal: 'network', below: cfg.idleNetworkBytes, value: null, underSince: null, applies: true, reason: `the VMs of group ${unknownGroup.name} are not known` });
  else {
    const series = own.filter((b) => !isDatabase(b)).map((b, i) => {
      const names = vmsOf(b);
      // A VM's series (loadbalanced or not) add up; a backend's VMs too, in and out: its bytes.
      specs.push({ id: `rx_${i}`, filter: vmFilter(RECEIVED, names), aligner: 'ALIGN_SUM', label: instanceName, merge: sum });
      specs.push({ id: `tx_${i}`, filter: vmFilter(SENT, names), aligner: 'ALIGN_SUM', label: instanceName, merge: sum });
      return { ids: names.flatMap((name) => [`rx_${i}:${name}`, `tx_${i}:${name}`]), scale: perMinute };
    });
    signals.push({ signal: 'network', below: cfg.idleNetworkBytes, series });
  }

  const metric = cfg.idleMetric;
  if (metric === 'off' || !metric) signals.push(notApplying('metric', null, 'off'));
  else {
    // `${resource}`: the resource's own name (the VM, the group, the Cloud SQL instance).
    const resource = own[0]?.name ?? null;
    const filters = Array.isArray(metric.filter) ? metric.filter : [metric.filter ?? null];
    if (resource === null && filters.some((f) => typeof f === 'string' && f.includes(RESOURCE))) signals.push(notApplying('metric', metric.below, `no backend to replace ${RESOURCE}`));
    else {
      const series = filters.map((f, j) => {
        const id = `metric_${j}`;
        const extra = typeof f === 'string' && f ? ` AND (${f.replaceAll(RESOURCE, resource)})` : '';
        // Every series the filter selects: the largest a point (one filter, one value).
        specs.push({ id, filter: `metric.type = "${metric.type}"${extra}`, aligner: metric.aligner, label: () => 'all', merge: max });
        return { ids: [`${id}:all`], scale: same };
      });
      signals.push({ signal: 'metric', below: metric.below, series });
    }
  }
  return { signals, specs };
}

// createIdleSignals({ google, project, log })(cfg, backends, window) → [cpu, network, metric]: { signal, below, value, underSince,
// applies, reason? }, AWS's shape. `cfg`: the effective configuration (levels.mjs effectiveOf); `backends`: the workload's (vm, mig with
// its VMs' `instances`, cloudsql); `window`: idleWindow's. Nothing applying: no call.
export function createIdleSignals({ google, project, log }) {
  async function read(spec, window, points) {
    let page = '';
    do {
      const query = new URLSearchParams({
        filter: spec.filter,
        'interval.startTime': new Date(window.startMs).toISOString(),
        'interval.endTime': new Date(window.endMs).toISOString(),
        'aggregation.alignmentPeriod': `${PERIOD_MS / 1000}s`,
        'aggregation.perSeriesAligner': spec.aligner,
        ...(page ? { pageToken: page } : {}),
      });
      const answer = await google.request('GET', `${MONITORING}/projects/${project}/timeSeries?${query}`);
      for (const series of answer.timeSeries ?? []) {
        const key = `${spec.id}:${spec.label(series)}`;
        const at = points.get(key) ?? new Map();
        for (const point of series.points ?? []) {
          const t = Date.parse(point.interval?.endTime) - PERIOD_MS;
          const v = Number(point.value?.doubleValue ?? point.value?.int64Value);
          if (Number.isFinite(t) && Number.isFinite(v)) at.set(t, spec.merge(at.get(t), v));
        }
        points.set(key, at);
      }
      page = answer.nextPageToken ?? '';
    } while (page);
  }

  return async function idleSignals(cfg, backends, window) {
    const { signals, specs } = plan(cfg, backends ?? [], project);
    if (!signals.some((s) => s.series)) return signals;
    const points = new Map();
    try {
      await Promise.all(specs.map((spec) => read(spec, window, points)));
    } catch (err) {
      const why = err.status || err.name;
      log.warn('IdleSignalsUnread', { workloadId: cfg.workloadId, error: `${why}: ${err.message}` });
      return signals.map((s) => (s.series ? { signal: s.signal, below: s.below, value: null, underSince: null, applies: true, reason: `the metrics could not be read: ${why}` } : s));
    }
    return signals.map((s) => (s.series ? measureSignal(s, points, window) : s));
  };
}
