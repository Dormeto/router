// A standalone workload in Google Cloud's controller (vision standalone workloads design §3, §4, §5; plan 5, R30): naps, wakes, releases,
// reconciles and is checked with no URL map, backend service, forwarding rule, target proxy, load balancer log or request count call; its
// backends from its record; AWAKE at full size; plan 1's rulings, each a case. The fakes record any forbidden call and every test ends
// with none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATES } from '../../lambda/src/lib/state.mjs';
import { STANDALONE_KEYS } from '../../lambda/src/lib/settings-levels.mjs';
import { PERIOD_MS } from '../../lambda/src/lib/activity.mjs';
import { fakeClock, fakeStore } from '../../lambda/test/fakes.mjs';
import { createController } from '../src/controller-core.mjs';
import { fromFields, toFields } from '../src/firestore.mjs';
import { GoogleError } from '../src/google.mjs';
import { createIdleSignals } from '../src/idle-signals.mjs';
import { clockTimers, heartbeatStore, idleReadsStore, sweepStore } from './world.mjs';

const MINUTE = 60_000;
const ZONE = 'europe-west1-b';
const V1 = 'https://compute.googleapis.com/compute/v1/projects/p';
const START = Date.UTC(2026, 10, 23, 10, 0);
const RESOURCES = {
  vm: { resource: `projects/p/zones/${ZONE}/instances/batch`, backends: [{ kind: 'vm', location: ZONE, name: 'batch' }] },
  mig: { resource: `projects/p/zones/${ZONE}/instanceGroupManagers/workers`, backends: [{ kind: 'mig', location: ZONE, name: 'workers' }] },
  cloudsql: { resource: 'projects/p/instances/orders', backends: [{ kind: 'cloudsql', name: 'orders' }] },
};
const vmUrl = (name) => `${V1}/zones/${ZONE}/instances/${name}`;

// What a standalone workload must never call: the route's, the backend service's, the load balancer's logs and request count.
function forbidden(calls, name) {
  return new Proxy({}, {
    get(_, method) {
      if (method === 'then' || typeof method === 'symbol') return undefined;
      return async () => {
        calls.push(`${name}.${String(method)}`);
        throw new Error(`forbidden: ${name}.${String(method)}`);
      };
    },
  });
}

// kind: the resource's; up: whether it runs; companion: a Cloud SQL instance beside it; cpu(t): its CPU ratio at a point (undefined: none).
function setup({ kind = 'vm', up = true, companion = false, run: initial, cfg: overrides = {}, cpu = () => 0.01, size = 2 } = {}) {
  const clock = fakeClock(START);
  const calls = { forbidden: [], changes: [], tasks: [], monitoring: [] };
  const world = { vms: {}, groups: {}, sql: {} };
  if (kind === 'vm') world.vms.batch = { status: up ? 'RUNNING' : 'TERMINATED', machineType: `${V1}/zones/${ZONE}/machineTypes/e2-small` };
  if (kind === 'mig') {
    world.groups.workers = { targetSize: size, instances: Array.from({ length: size }, (_, i) => ({ instance: vmUrl(`workers-${i}`), instanceStatus: up ? 'RUNNING' : 'TERMINATED', currentAction: 'NONE' })) };
  }
  const sqlUp = (on) => ({ state: 'RUNNABLE', settings: { activationPolicy: on ? 'ALWAYS' : 'NEVER' } });
  if (kind === 'cloudsql') world.sql.orders = sqlUp(up);
  if (companion) world.sql.side = sqlUp(up);
  const backends = [...RESOURCES[kind].backends, ...(companion ? [{ kind: 'cloudsql', name: 'side' }] : [])];
  const config = { workloadId: 'batch', kind: 'standalone', resource: RESOURCES[kind].resource, name: 'Batch', tags: {}, backends, inherits: STANDALONE_KEYS, ...overrides };
  const store = fakeStore({ config, run: initial ?? { state: up ? STATES.AWAKE : STATES.ASLEEP, ...(up ? { awakeSince: START - 10 * 60 * MINUTE } : {}) }, clock });
  const { every } = clockTimers(clock);
  Object.assign(store, heartbeatStore(() => store.state.run, clock.now), sweepStore(clock.now), idleReadsStore(() => store.state.run));
  store.putCheck = async (summary) => { store.state.check = fromFields(toFields(summary)); };
  store.getManagerSettings = async () => structuredClone(store.state.managerSettings ?? null);
  store.getRouterPause = async () => structuredClone(store.state.pauses.find((p) => p.workloadId === null) ?? null);
  store.addPause = (id, pause) => store.putPause(id, fromFields(toFields(pause)));
  store.removePauses = async (id, { at, exclusionId } = {}) => {
    const found = store.state.pauses.find((p) => p.workloadId === id && (p.exclusionId ?? null) === (exclusionId ?? null) && (at === undefined || p.at === at));
    store.state.pauses = store.state.pauses.filter((p) => p !== found);
    return Boolean(found);
  };
  const gone = (what) => new GoogleError(`Google: ${what}: 404 not found`, { code: 404 });
  const STATUS = { stop: 'TERMINATED', start: 'RUNNING', suspend: 'SUSPENDED', resume: 'RUNNING' };
  const allowed = {
    getInstance: async (zone, name) => {
      if (!world.vms[name]) throw gone(`instance ${name}`);
      return structuredClone(world.vms[name]);
    },
    getMachineType: async () => ({ memoryMb: 2048 }),
    setMachineType: async () => {},
    listManagedInstances: async ({ name }) => {
      if (!world.groups[name]) throw gone(`group ${name}`);
      return structuredClone(world.groups[name].instances);
    },
    getManagedGroup: async ({ name }) => {
      if (!world.groups[name]) throw gone(`group ${name}`);
      return { name, targetSize: world.groups[name].targetSize, status: {} };
    },
    getAutoscaler: async () => { throw gone('autoscaler'); },
    setAutoscalerMode: async () => {},
  };
  for (const [action, status] of Object.entries(STATUS)) {
    allowed[`${action}Instance`] = async (zone, name) => {
      calls.changes.push(`${action} ${name}`);
      world.vms[name].status = status;
    };
    allowed[`${action}Instances`] = async ({ name }, urls) => {
      calls.changes.push(`${action} ${name}`);
      for (const m of world.groups[name].instances) if (urls.includes(m.instance)) m.instanceStatus = world.onGroup?.(m, status) ?? status;
    };
  }
  // Compute Engine: what a standalone workload needs; anything else (backend services, NEGs, groups' listings) forbidden.
  const compute = new Proxy(allowed, {
    get(target, method) {
      if (method in target) return target[method];
      if (method === 'then' || typeof method === 'symbol') return undefined;
      return async () => {
        calls.forbidden.push(`compute.${String(method)}`);
        throw new Error(`forbidden: compute.${String(method)}`);
      };
    },
  });
  const cloudsql = {
    get: async (name) => {
      if (!world.sql[name]) throw gone(`Cloud SQL instance ${name}`);
      return structuredClone(world.sql[name]);
    },
    setActivation: async (name, policy) => {
      calls.changes.push(`sql ${name} ${policy}`);
      world.sql[name].settings.activationPolicy = policy;
      return `op-${name}`;
    },
    listOperations: async () => [],
    getOperation: async () => ({ status: 'DONE' }),
  };
  // Cloud Monitoring as the idle signals read it: each VM's CPU, `cpu(t)` a point.
  const google = {
    request: async (method, url) => {
      const q = Object.fromEntries(new URL(url).searchParams);
      calls.monitoring.push(q.filter);
      const names = /instance_name = one_of\(([^)]*)\)/.exec(q.filter)?.[1].match(/"[^"]+"/g)?.map((n) => JSON.parse(n)) ?? ['db'];
      const start = Date.parse(q['interval.startTime']);
      const end = Date.parse(q['interval.endTime']);
      return {
        timeSeries: names.map((name) => ({
          metric: { labels: { instance_name: name } },
          points: Array.from({ length: (end - start) / PERIOD_MS }, (_, k) => start + k * PERIOD_MS).filter((t) => cpu(t) !== undefined)
            .map((t) => ({ interval: { endTime: new Date(t + PERIOD_MS).toISOString() }, value: { doubleValue: cpu(t) } })),
        })),
      };
    },
  };
  const logs = [];
  const log = Object.fromEntries(['info', 'warn', 'error'].map((level) => [level, (event, fields = {}) => logs.push({ level, event, ...fields })]));
  const core = createController({
    store, compute, cloudsql,
    gke: forbidden(calls.forbidden, 'gke'), urlmaps: forbidden(calls.forbidden, 'urlmaps'), regionalUrlmaps: forbidden(calls.forbidden, 'regionalUrlmaps'),
    monitoring: forbidden(calls.forbidden, 'monitoring'), logs: forbidden(calls.forbidden, 'logs'),
    idleSignals: createIdleSignals({ google, project: 'p', log }),
    tasks: { enqueue: async (task) => { calls.tasks.push(task.body); } },
    config: { project: 'p', region: 'europe-west1', controllerUrl: 'https://controller', version: '0.42.0' },
    now: clock.now, sleep: clock.sleep, every, log, newId: () => `id-${calls.tasks.length}-${calls.changes.length}`,
    fetch: async () => { calls.forbidden.push('fetch'); throw new Error('no network'); },
  });
  const run = () => store.state.run;
  const logged = (event) => logs.filter((l) => l.event === event);
  const waking = () => { store.state.run = { ...store.state.run, state: STATES.WAKING, wakeId: 'w9', wakeStartedAt: clock.now() }; };
  return { core, store, clock, world, calls, run, logged, waking, cfg: config };
}

const causes = (s) => s.logged('StateChanged').map((l) => [l.to, l.cause ?? null]);
const KINDS = Object.keys(RESOURCES);

for (const kind of KINDS) {
  test(`a standalone ${kind}: napped and woken with no route, backend service or load balancer call`, async () => {
    const s = setup({ kind });
    assert.equal((await s.core.nap('batch', { cause: 'manager', by: 'ana', requestedAt: s.clock.now() })).state, STATES.ASLEEP);
    assert.deepEqual(causes(s), [[STATES.NAPPING, 'manager'], [STATES.ASLEEP, null]]);
    s.waking();
    assert.equal((await s.core.wake('batch', 'w9')).state, STATES.AWAKE);
    assert.equal(s.run().state, STATES.AWAKE);
    assert.deepEqual(s.calls.forbidden, []);
  });
}

test('a VM with a companion Cloud SQL instance: the VM stops before the database, the database starts first', async () => {
  // Not suspended (the built-in hibernation of a VM that can), so that it stops plainly.
  const s = setup({ companion: true, cfg: { hibernate: false } });
  await s.core.nap('batch', { cause: 'manager', requestedAt: s.clock.now() });
  assert.deepEqual(s.calls.changes, ['stop batch', 'sql side NEVER']);
  s.waking();
  await s.core.wake('batch', 'w9');
  assert.deepEqual(s.calls.changes.slice(2), ['sql side ALWAYS', 'start batch']);
  assert.deepEqual(s.calls.forbidden, []);
});

test('plan 1\'s ruling: AWAKE at full size: a group at its target size with every VM running; short of it, the wake times out', async () => {
  const s = setup({ kind: 'mig', size: 3 });
  await s.core.nap('batch', { cause: 'manager', requestedAt: s.clock.now() });
  // Only the first VM comes back.
  s.world.onGroup = (m, status) => (status === 'RUNNING' && !m.instance.endsWith('-0') ? 'STAGING' : status);
  s.waking();
  const failed = await s.core.wake('batch', 'w9');
  assert.equal(failed.state, STATES.FAILED);
  assert.match(failed.error, /not every backend runs: mig:workers has 1 of its 3 VMs running/);
  assert.deepEqual(s.calls.forbidden, []);
});

test('plan 1\'s ruling: an outside start is AWAKE with external-start, its companion started; an outside stop ASLEEP with external-stop', async () => {
  const s = setup({ up: false, companion: true });
  s.world.vms.batch.status = 'RUNNING';
  await s.core.check();
  assert.deepEqual(causes(s), [[STATES.AWAKE, 'external-start']]);
  assert.deepEqual(s.calls.changes, ['sql side ALWAYS']);
  const stop = setup();
  stop.world.vms.batch.status = 'TERMINATED';
  await stop.core.check();
  assert.deepEqual(causes(stop), [[STATES.ASLEEP, 'external-stop']]);
  assert.deepEqual([s.calls.forbidden, stop.calls.forbidden], [[], []]);
});

test('plan 1\'s ruling: a failed wake is retried by the check with the router\'s own backoff, held by a keepAsleep pause; an outside stop ends it', async () => {
  const failure = JSON.stringify({ kind: 'timeout', step: 'wake', message: 'x' });
  const s = setup({ up: false, run: { state: STATES.FAILED, failedAt: START, consecutiveFailures: 1, failure, failedRetrySeconds: 600 } });
  s.world.vms.batch.status = 'STAGING';
  assert.deepEqual((await s.core.check())[0], { workloadId: 'batch', state: STATES.FAILED });
  s.clock.advance(61_000);
  await s.store.putPause('batch', { by: 'ops', at: s.clock.now(), reason: 'x', keepAsleep: true });
  assert.deepEqual((await s.core.check())[0], { workloadId: 'batch', state: STATES.FAILED, retry: 'held', reason: 'a keepAsleep pause' });
  s.store.state.pauses = [];
  assert.deepEqual((await s.core.check())[0], { workloadId: 'batch', state: STATES.WAKING, retry: 'requested' });
  assert.deepEqual(causes(s).at(-1), [STATES.WAKING, 'retry']);
  assert.equal(s.calls.tasks.at(-1).action, 'wake');
  const stopped = setup({ up: false, run: { state: STATES.FAILED, failedAt: START, consecutiveFailures: 1, failure } });
  stopped.clock.advance(61_000);
  await stopped.core.check();
  assert.deepEqual(causes(stopped), [[STATES.ASLEEP, 'recovered']]);
  stopped.clock.advance(60 * MINUTE);
  await stopped.core.check();
  assert.deepEqual(stopped.calls.tasks, []);
  assert.deepEqual([s.calls.forbidden, stopped.calls.forbidden], [[], []]);
});

test('plan 1\'s ruling: a resource deleted stops nothing, its companion included, marks resourceMissing and warns in the health', async () => {
  const s = setup({ companion: true });
  delete s.world.vms.batch;
  const [answer] = await s.core.check();
  assert.deepEqual(answer, { workloadId: 'batch', state: STATES.AWAKE, resource: 'missing' });
  assert.deepEqual(s.calls.changes, []);
  assert.equal(s.run().resourceMissing, true);
  assert.deepEqual(s.logged('ResourceMissing').map((l) => l.resource), [RESOURCES.vm.resource]);
  assert.deepEqual(s.logged('CheckNotRecorded'), []);
  assert.deepEqual(s.store.state.check.health.problems.filter((p) => p.code === 'resource-missing'), [{ level: 'warning', code: 'resource-missing', text: '1 standalone workload without its resource: deleted (see the workloads)' }]);
  assert.deepEqual((await s.core.nap('batch', { cause: 'manager', requestedAt: s.clock.now() })).state, 'SKIPPED');
  s.waking();
  const failed = await s.core.wake('batch', 'w9');
  assert.match(failed.error, /the resource is missing/);
  assert.deepEqual(s.calls.forbidden, []);
});

test('plan 1\'s ruling: idle for the whole window: the nap asked, and its task reads the signals again; busy, none; awake less than the window, no read', async () => {
  const s = setup();
  assert.deepEqual((await s.core.check())[0], { workloadId: 'batch', state: STATES.AWAKE, nap: 'requested' });
  const [task] = s.calls.tasks;
  assert.deepEqual([task.action, task.cause], ['nap', undefined]);
  const reads = s.calls.monitoring.length;
  assert.equal((await s.core.nap('batch', { requestedAt: task.requestedAt })).state, STATES.ASLEEP);
  assert.ok(s.calls.monitoring.length > reads, 'read again');
  const busy = setup({ cpu: (t) => (t === Date.UTC(2026, 10, 23, 9, 20) ? 0.5 : 0.01) });
  const [answer] = await busy.core.check();
  assert.deepEqual(answer, { workloadId: 'batch', state: STATES.AWAKE, idle: false, idleNotBefore: Date.UTC(2026, 10, 23, 9, 25) + 130 * MINUTE });
  assert.equal(busy.run().idleNotBefore, answer.idleNotBefore);
  const recent = setup({ run: { state: STATES.AWAKE, awakeSince: Date.UTC(2026, 10, 23, 9, 0) } });
  await recent.core.check();
  assert.deepEqual([recent.calls.monitoring, recent.calls.tasks], [[], []]);
  assert.deepEqual([s.calls.forbidden, busy.calls.forbidden, recent.calls.forbidden], [[], [], []]);
});

test('plan 1\'s rulings: an idle nap busy by the time it runs is skipped; a person\'s or a schedule\'s nap is never read against the signals', async () => {
  const s = setup({ cpu: () => 0.6 });
  assert.deepEqual(await s.core.nap('batch', { requestedAt: s.clock.now() }), { state: 'SKIPPED', reason: 'busy since it was requested' });
  for (const cause of ['manager', 'schedule']) {
    const busy = setup({ cpu: () => 0.6 });
    assert.equal((await busy.core.nap('batch', { cause, requestedAt: busy.clock.now() })).state, STATES.ASLEEP, cause);
    assert.deepEqual(busy.calls.monitoring, [], cause);
  }
  assert.deepEqual(s.calls.forbidden, []);
});

test('plan 1\'s ruling: a missing point or a failed read never naps', async () => {
  const gap = setup({ cpu: (t) => (t === Date.UTC(2026, 10, 23, 9, 0) ? undefined : 0.01) });
  assert.equal((await gap.core.check())[0].idle, false);
  assert.deepEqual(gap.calls.tasks, []);
  const none = setup({ cfg: { idleCpuPercent: 'off', inherits: ['idleMinutes', 'wakeTimeoutSeconds', 'idleNetworkBytes', 'idleMetric'] } });
  assert.deepEqual((await none.core.check())[0], { workloadId: 'batch', state: STATES.AWAKE, idle: false });
  assert.deepEqual(none.calls.tasks, []);
});

test('a schedule\'s nap window naps it with no read of the signals; a pause keeps it from an idle nap and wakes it asleep', async () => {
  const s = setup({ cpu: () => 0.6 });
  s.store.state.schedules.batch = { timeZone: 'UTC', windows: [{ kind: 'nap', days: ['mon'], start: '09:00', end: '18:00' }], by: 'ops', at: Date.UTC(2026, 10, 20) };
  await s.core.check();
  const task = s.calls.tasks.find((t) => t.action === 'nap');
  assert.equal(task.cause, 'schedule');
  assert.equal((await s.core.nap('batch', { cause: task.cause, requestedAt: task.requestedAt, until: task.until })).state, STATES.ASLEEP);
  const paused = setup();
  await paused.core.pause('batch', { by: 'ops', reason: 'release day' });
  assert.deepEqual((await paused.core.check())[0], { workloadId: 'batch', state: STATES.AWAKE, paused: true });
  const asleep = setup({ up: false });
  await asleep.core.pause('batch', { by: 'ops', reason: 'release day' });
  assert.deepEqual(causes(asleep), [[STATES.WAKING, 'pause']]);
  assert.deepEqual([s.calls.forbidden, paused.calls.forbidden, asleep.calls.forbidden], [[], [], []]);
});

test('the maintenance wake of a long nap, and a failed nap released after its idle window, with no forbidden call', async () => {
  const s = setup({ up: false, run: { state: STATES.ASLEEP, stateAt: START - 3 * 86_400_000 } });
  s.store.state.schedules.batch = { timeZone: 'UTC', windows: [{ kind: 'nap', days: ['sat'], start: '00:00', end: '23:00' }], maxNapDays: 2, by: 'ops', at: Date.UTC(2026, 10, 1) };
  await s.core.check();
  assert.deepEqual(causes(s), [[STATES.WAKING, 'maintenance']]);
  const failed = setup({ run: { state: STATES.FAILED, failedAt: START - 3 * 60 * MINUTE, failure: JSON.stringify({ kind: 'unknown', step: 'nap', message: 'x' }) } });
  failed.world.vms.batch.status = 'STAGING';
  assert.deepEqual((await failed.core.check())[0], { workloadId: 'batch', state: STATES.FAILED, release: 'requested' });
  failed.world.vms.batch.status = 'RUNNING';
  assert.equal((await failed.core.release('batch')).state, STATES.ASLEEP);
  assert.deepEqual(causes(failed), [[STATES.ASLEEP, 'failed-released']]);
  assert.deepEqual([s.calls.forbidden, failed.calls.forbidden], [[], []]);
});

test('plan 1\'s ruling: a settings write that touches the idle window or a signal clears the pending idle hold; another keeps it', async () => {
  const { setup: worldOf } = await import('./world.mjs');
  const t = worldOf();
  const cfg = { workloadId: 'batch', kind: 'standalone', resource: RESOURCES.vm.resource, name: 'Batch', tags: {}, backends: RESOURCES.vm.backends, inherits: STANDALONE_KEYS, source: 'cli' };
  t.store.configs.set('batch', cfg);
  const hold = Date.UTC(2026, 10, 24);
  t.store.runs.set('batch', { state: STATES.AWAKE, awakeSince: 1, idleNotBefore: hold });
  await t.onboarding.setSettings('batch', { hibernate: false, by: 'ana' });
  assert.equal(t.store.runs.get('batch').idleNotBefore, hold);
  for (const settings of [{ idleCpuPercent: 10 }, { idleMinutes: 60 }, { idleMetric: null }]) {
    t.store.runs.get('batch').idleNotBefore = hold;
    await t.onboarding.setSettings('batch', { ...settings, by: 'ana' });
    assert.equal('idleNotBefore' in t.store.runs.get('batch'), false, JSON.stringify(settings));
  }
});
