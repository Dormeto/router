import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATES } from '../../lambda/src/lib/state.mjs';
import { fakeClock, fakeStore } from '../../lambda/test/fakes.mjs';
import { createController } from '../src/controller-core.mjs';
import { GoogleError, OPERATION_NOT_DONE } from '../src/google.mjs';
import { createUrlMaps, withErrorPolicy } from '../src/urlmaps.mjs';

const V1 = 'https://compute.googleapis.com/compute/v1/projects/p';
const ZONE = 'europe-west1-b';
const CONTROLLER = 'https://dmtr-europe-west1-controller-123.europe-west1.run.app';
const WAKER = 'dmtr-europe-west1-demo';
const WAKER_URL = `${V1}/global/backendServices/${WAKER}`;
const APP_URL = `${V1}/global/backendServices/app`;
const MINUTE = 60_000;
const REQUEST_LIMIT = 900_000;
const vmUrl = (name) => `${V1}/zones/${ZONE}/instances/${name}`;
const VM_A = { kind: 'vm', location: ZONE, name: 'vm-a' };
const VM_B = { kind: 'vm', location: ZONE, name: 'vm-b' };
const MIG = { kind: 'mig', location: ZONE, name: 'mig' };

const mapOf = () => ({
  name: 'lb',
  fingerprint: 'f1',
  defaultService: `${V1}/global/backendServices/other`,
  hostRules: [{ hosts: ['demo.example.com'], pathMatcher: 'm' }],
  pathMatchers: [{ name: 'm', defaultService: APP_URL, pathRules: [{ paths: ['/_dormeto/*'], service: WAKER_URL }] }],
});
const asleepMap = () => withErrorPolicy(mapOf(), 'app', WAKER_URL).map;
const hasPolicy = (map) => map.pathMatchers[0].defaultCustomErrorResponsePolicy !== undefined;
const hasRoute = (map) => (map.pathMatchers[0].pathRules ?? []).length > 0;

const managed = (name, status, currentAction = 'NONE', extra = {}) => ({ instance: vmUrl(name), instanceStatus: status, currentAction, ...extra });
const notDone = () => new GoogleError('Google: operation op not done in time', { reason: OPERATION_NOT_DONE });

// The world as Compute Engine, the URL map and Monitoring see it. `calls`: what changed, in order, with the nap's wait.
// `on[line]`: runs when that change is asked; it may throw (refused), or answer 'under way' (done later): not applied.
function setup({
  run = { state: STATES.AWAKE, awakeSince: 1 }, cfg = {}, vms = {}, groups = {}, autoscalers = {}, machineTypes = {}, map = mapOf(), requests = 0, unhealthyPolls = 0,
} = {}) {
  const clock = fakeClock();
  const world = {
    vms: Object.fromEntries(Object.entries(vms).map(([name, vm]) => [name, { machineType: `${V1}/zones/${ZONE}/machineTypes/e2-small`, ...vm }])),
    groups,
    autoscalers,
    machineTypes: { 'e2-small': { memoryMb: 2048 }, ...machineTypes },
    map,
    requests,
    unhealthyPolls,
    calls: [],
    on: {},
    groupsRead: [],
    conflicts: 0,
    puts: 0,
    healthReads: 0,
    metricReads: [],
    tasks: [],
    sleeps: [],
    logs: [],
  };
  const config = {
    workloadId: 'demo', urlMap: 'lb', backendService: 'app', wakerBackendService: WAKER, backends: [VM_A], idleMinutes: 15, wakeTimeoutSeconds: 600, failedRetrySeconds: 60, pollSeconds: 3, ...cfg,
  };
  const store = fakeStore({ config, run, clock });
  const change = async (line, apply) => {
    world.calls.push(line);
    if ((await world.on[line]?.()) !== 'under way') apply();
  };
  const STATUS = { stop: 'TERMINATED', start: 'RUNNING', suspend: 'SUSPENDED', resume: 'RUNNING' };
  const compute = {
    getInstance: async (zone, name) => structuredClone(world.vms[name]),
    getMachineType: async (zone, name) => {
      if (!world.machineTypes[name]) throw new GoogleError('no machine type', { code: 404 });
      return structuredClone(world.machineTypes[name]);
    },
    listManagedInstances: async (group) => {
      world.groupsRead.push(group);
      return structuredClone(world.groups[group.name] ?? []);
    },
    getAutoscaler: async ({ name }) => {
      if (!world.autoscalers[name]) throw new GoogleError('no autoscaler', { code: 404 });
      return { name, autoscalingPolicy: { mode: world.autoscalers[name] } };
    },
    setAutoscalerMode: ({ name }, mode) => change(`autoscaler ${name} ${mode}`, () => { world.autoscalers[name] = mode; }),
    getBackendService: async () => ({ backends: [{ group: 'ig-url' }] }),
    getBackendServiceHealth: async () => {
      world.healthReads += 1;
      const running = Object.values(world.vms).some((vm) => vm.status === 'RUNNING')
        || Object.values(world.groups).flat().some((m) => m.instanceStatus === 'RUNNING');
      return { healthStatus: [{ healthState: running && world.healthReads > world.unhealthyPolls ? 'HEALTHY' : 'UNHEALTHY' }] };
    },
  };
  for (const [action, status] of Object.entries(STATUS)) {
    compute[`${action}Instance`] = (zone, name) => change(`${action} ${name}`, () => { world.vms[name].status = status; });
    compute[`${action}Instances`] = ({ name }, urls) => change(`${action} ${name} ${urls.map((u) => u.slice(u.lastIndexOf('/') + 1)).join(',')}`, () => {
      for (const m of world.groups[name]) if (urls.includes(m.instance)) m.instanceStatus = status;
    });
  }
  const google = {
    request: async (method, url, body) => {
      if (method === 'GET') return structuredClone(world.map);
      if (world.conflicts > 0) {
        world.conflicts -= 1;
        throw new GoogleError('Google: PUT: 412 fingerprint', { code: 412 });
      }
      await world.on.put?.();
      world.puts += 1;
      world.map = structuredClone(body);
      world.calls.push(`map ${hasPolicy(body) ? 'policy' : 'no policy'}`);
      return { status: 'DONE' };
    },
    waitCompute: async () => {},
  };
  const log = Object.fromEntries(['info', 'warn', 'error'].map((level) => [level, (event, fields = {}) => world.logs.push({ level, event, ...fields })]));
  const controller = createController({
    store,
    compute,
    urlmaps: createUrlMaps({ google, project: 'p', now: clock.now }),
    monitoring: { requestCount: async (query) => { world.metricReads.push(query); return world.requests; } },
    tasks: { enqueue: async (task) => { world.tasks.push(task); } },
    config: { project: 'p', controllerUrl: CONTROLLER },
    now: clock.now,
    sleep: async (ms) => {
      world.sleeps.push(ms);
      if (ms >= MINUTE) world.calls.push(`wait ${ms / 1000} s`);
      await clock.sleep(ms);
    },
    log,
    newId: () => 'wake-2',
  });
  return { controller, store, clock, world, run: () => store.state.run, logged: (event) => world.logs.filter((l) => l.event === event) };
}

const waking = (at, more = {}) => ({ state: STATES.WAKING, wakeId: 'w1', wakeStartedAt: at, ...more });
const START = 1_700_000_000_000;

// --- The wake ------------------------------------------------------------------------------------------------------

test('a stopped VM\'s wake: started, health polled every 2 s, AWAKE with its duration, then the policy removed', async () => {
  const t = setup({ run: waking(START - 5000), vms: { 'vm-a': { status: 'TERMINATED' } }, map: asleepMap(), unhealthyPolls: 3 });
  let stateAtRemoval;
  t.world.on.put = async () => { stateAtRemoval = t.run().state; };
  const out = await t.controller.wake('demo', 'w1');
  assert.equal(out.state, STATES.AWAKE);
  assert.deepEqual(t.world.calls, ['start vm-a', 'map no policy']);
  assert.deepEqual(t.world.sleeps, [2000, 2000, 2000]);
  assert.equal(stateAtRemoval, STATES.AWAKE);
  assert.equal(t.run().state, STATES.AWAKE);
  assert.equal(t.run().awakeSince, t.clock.now());
  assert.deepEqual(t.run().lastWake, { durationMs: 11_000 });
  assert.equal(t.logged('WakeCompleted').length, 1);
  assert.equal(t.logged('StateChanged').find((l) => l.to === STATES.AWAKE).durationMs, 11_000);
  assert.equal(hasPolicy(t.world.map), false);
  assert.equal(hasRoute(t.world.map), true);
});

test('a suspended VM is resumed, a stopped one started, a running one left', async () => {
  const t = setup({
    run: waking(START),
    cfg: { backends: [VM_A, VM_B, { kind: 'vm', location: ZONE, name: 'vm-c' }] },
    vms: { 'vm-a': { status: 'SUSPENDED' }, 'vm-b': { status: 'STOPPED' }, 'vm-c': { status: 'RUNNING' } },
  });
  await t.controller.wake('demo', 'w1');
  assert.equal(t.run().state, STATES.AWAKE);
  assert.deepEqual(t.world.calls.sort(), ['resume vm-a', 'start vm-b']);
});

test('a managed group wakes through the group, then its autoscaler gets its recorded mode back', async () => {
  const t = setup({
    run: waking(START, { autoscalers: [{ kind: 'zonal', location: ZONE, name: 'mig', mode: 'ON' }], stopped: ['mig-1'], suspended: ['mig-2'] }),
    cfg: { backends: [MIG] },
    groups: { mig: [managed('mig-1', 'TERMINATED'), managed('mig-2', 'SUSPENDED')] },
    autoscalers: { mig: 'OFF' },
  });
  await t.controller.wake('demo', 'w1');
  assert.equal(t.run().state, STATES.AWAKE);
  assert.deepEqual(t.world.calls.slice(0, 2).sort(), ['resume mig mig-2', 'start mig mig-1']);
  assert.equal(t.world.calls[2], 'autoscaler mig ON');
  assert.equal(t.world.autoscalers.mig, 'ON');
  for (const field of ['autoscalers', 'stopped', 'suspended']) assert.equal(t.run()[field], undefined, field);
});

test('a managed group\'s location says zonal or regional', async () => {
  const t = setup({
    run: waking(START),
    cfg: { backends: [{ kind: 'mig', location: 'europe-west1', name: 'mig' }, MIG] },
    groups: { mig: [managed('mig-1', 'RUNNING')] },
  });
  await t.controller.wake('demo', 'w1');
  assert.deepEqual(t.world.groupsRead.sort((a, b) => a.kind.localeCompare(b.kind)), [
    { kind: 'regional', location: 'europe-west1', name: 'mig' },
    { kind: 'zonal', location: ZONE, name: 'mig' },
  ]);
});

test('a start refused for capacity: FAILED with the kind capacity, the policy kept', async () => {
  const t = setup({ run: waking(START), vms: { 'vm-a': { status: 'TERMINATED' } }, map: asleepMap() });
  t.world.on['start vm-a'] = async () => {
    throw new GoogleError("Google: operation compute.instances.start: ZONE_RESOURCE_POOL_EXHAUSTED: The zone 'europe-west1-b' does not have enough resources", { reason: 'ZONE_RESOURCE_POOL_EXHAUSTED' });
  };
  const out = await t.controller.wake('demo', 'w1');
  assert.equal(out.state, STATES.FAILED);
  assert.equal(t.run().state, STATES.FAILED);
  assert.equal(JSON.parse(t.run().failure).kind, 'capacity');
  assert.equal(JSON.parse(t.run().failure).step, 'wake');
  assert.equal(t.run().failedAt, t.clock.now());
  assert.equal(t.run().consecutiveFailures, 1);
  assert.equal(hasPolicy(t.world.map), true);
  assert.equal(t.logged('WakeFailed')[0].kind, 'capacity');
});

test('a start refused without the permission: FAILED with the kind permission', async () => {
  const t = setup({ run: waking(START), vms: { 'vm-a': { status: 'TERMINATED' } } });
  t.world.on['start vm-a'] = async () => { throw new GoogleError("Google: POST: 403 Required 'compute.instances.start' permission", { code: 403 }); };
  await t.controller.wake('demo', 'w1');
  assert.equal(JSON.parse(t.run().failure).kind, 'permission');
});

test('at the wake timeout: unhealthy with a VM running, timeout with none, capacity with a group\'s refused start', async () => {
  const running = setup({ run: waking(START), vms: { 'vm-a': { status: 'TERMINATED' } }, unhealthyPolls: Infinity });
  await running.controller.wake('demo', 'w1');
  assert.equal(running.run().state, STATES.FAILED);
  assert.equal(JSON.parse(running.run().failure).kind, 'unhealthy');
  assert.equal(running.clock.now(), START + 600_000);

  const none = setup({ run: waking(START), vms: { 'vm-a': { status: 'TERMINATED' } } });
  none.world.on['start vm-a'] = async () => { throw notDone(); };
  await none.controller.wake('demo', 'w1');
  assert.equal(JSON.parse(none.run().failure).kind, 'timeout');

  const refused = { errors: { errors: [{ code: 'ZONE_RESOURCE_POOL_EXHAUSTED', message: 'not enough resources' }] } };
  const group = setup({
    run: waking(START),
    cfg: { backends: [MIG] },
    groups: { mig: [managed('mig-1', 'TERMINATED', 'STARTING', { lastAttempt: refused })] },
  });
  await group.controller.wake('demo', 'w1');
  assert.equal(JSON.parse(group.run().failure).kind, 'capacity');
  assert.match(JSON.parse(group.run().failure).message, /mig-1/);
});

test('a superseded wake touches nothing', async () => {
  const t = setup({ run: waking(START, { wakeId: 'other' }), vms: { 'vm-a': { status: 'TERMINATED' } }, map: asleepMap() });
  const out = await t.controller.wake('demo', 'w1');
  assert.deepEqual(out, { state: 'SUPERSEDED' });
  assert.deepEqual(t.world.calls, []);
  assert.equal(t.world.healthReads, 0);
  assert.equal(t.run().state, STATES.WAKING);
  assert.equal(t.logged('WakeSuperseded').length, 1);
});

test('a wake superseded while it waits for health does not remove the policy', async () => {
  const t = setup({ run: waking(START), vms: { 'vm-a': { status: 'TERMINATED' } }, map: asleepMap(), unhealthyPolls: 2 });
  t.clock.onSleep(() => { t.run().wakeId = 'other'; });
  const out = await t.controller.wake('demo', 'w1');
  assert.deepEqual(out, { state: 'SUPERSEDED' });
  assert.equal(hasPolicy(t.world.map), true);
});

test('the policy\'s failed removal is no failed wake: AWAKE, logged, repaired by the next check', async () => {
  const t = setup({ run: waking(START), vms: { 'vm-a': { status: 'TERMINATED' } }, map: asleepMap() });
  t.world.on.put = async () => { throw new GoogleError('Google: PUT: 500 oops', { code: 500 }); };
  const out = await t.controller.wake('demo', 'w1');
  assert.equal(out.state, STATES.AWAKE);
  assert.equal(t.run().state, STATES.AWAKE);
  assert.equal(t.run().failure, undefined);
  assert.equal(t.logged('PolicyNotRemoved').length, 1);
  assert.equal(hasPolicy(t.world.map), true);
  delete t.world.on.put;
  await t.controller.check();
  assert.equal(hasPolicy(t.world.map), false);
  assert.equal(t.logged('RouteDrift').length, 1);
});

test('a start whose operation\'s wait ran out is no failure: the health decides', async () => {
  const t = setup({ run: waking(START), vms: { 'vm-a': { status: 'TERMINATED' } } });
  t.world.on['start vm-a'] = async () => {
    t.world.vms['vm-a'].status = 'RUNNING';
    throw notDone();
  };
  await t.controller.wake('demo', 'w1');
  assert.equal(t.run().state, STATES.AWAKE);
});

test('a VM still going down is waited for, then started', async () => {
  const t = setup({ run: waking(START), vms: { 'vm-a': { status: 'STOPPING' } } });
  t.clock.onSleep((now) => { if (now >= START + 4000) t.world.vms['vm-a'].status = 'TERMINATED'; });
  await t.controller.wake('demo', 'w1');
  assert.deepEqual(t.world.calls, ['start vm-a']);
  assert.equal(t.run().state, STATES.AWAKE);
});

test('a managed group\'s VMs being started or still being stopped are not started again', async () => {
  const t = setup({
    run: waking(START),
    cfg: { backends: [MIG] },
    groups: { mig: [managed('mig-1', 'TERMINATED', 'STARTING'), managed('mig-2', 'RUNNING', 'STOPPING')] },
  });
  t.clock.onSleep(() => {
    t.world.groups.mig = [managed('mig-1', 'RUNNING'), managed('mig-2', 'TERMINATED')];
  });
  await t.controller.wake('demo', 'w1');
  assert.deepEqual(t.world.calls, ['start mig mig-2']);
});

test('a wake timeout beyond the request\'s limit fails the wake before the limit', async () => {
  const t = setup({ run: waking(START), cfg: { wakeTimeoutSeconds: 3600 }, vms: { 'vm-a': { status: 'TERMINATED' } }, unhealthyPolls: Infinity });
  const out = await t.controller.wake('demo', 'w1');
  assert.equal(out.state, STATES.FAILED);
  assert.ok(t.clock.now() - START < REQUEST_LIMIT - 30_000, `${t.clock.now() - START} ms`);
});

// --- The nap -------------------------------------------------------------------------------------------------------

test('the nap writes the policy, waits 300 s, then stops; ASLEEP with what it stopped', async () => {
  const t = setup({ vms: { 'vm-a': { status: 'RUNNING' } }, cfg: { hibernate: false } });
  const out = await t.controller.nap('demo');
  assert.equal(out.state, STATES.ASLEEP);
  assert.deepEqual(t.world.calls, ['map policy', 'wait 300 s', 'stop vm-a']);
  assert.equal(t.run().state, STATES.ASLEEP);
  assert.deepEqual(t.run().stopped, ['vm-a']);
  assert.deepEqual(t.run().suspended, []);
  assert.equal(t.run().stopping, undefined);
  assert.equal(t.logged('NapCompleted').length, 1);
  assert.deepEqual(t.world.map.pathMatchers[0].defaultCustomErrorResponsePolicy.errorService, WAKER_URL);
  assert.equal(t.logged('StateChanged').find((l) => l.to === STATES.ASLEEP).stopped[0], 'vm-a');
});

test('the nap of a workload not awake does nothing', async () => {
  const t = setup({ run: { state: STATES.ASLEEP }, vms: { 'vm-a': { status: 'TERMINATED' } } });
  assert.deepEqual(await t.controller.nap('demo'), { state: 'SKIPPED' });
  assert.deepEqual(t.world.calls, []);
});

test('hibernate on (the default) and eligible: suspended, recorded as such', async () => {
  const t = setup({ vms: { 'vm-a': { status: 'RUNNING' } } });
  await t.controller.nap('demo');
  assert.deepEqual(t.world.calls, ['map policy', 'wait 300 s', 'suspend vm-a']);
  assert.deepEqual(t.run().suspended, ['vm-a']);
  assert.deepEqual(t.run().stopped, []);
});

const NOT_SUSPENDABLE = {
  'a GPU': { guestAccelerators: [{ acceleratorType: 'nvidia-tesla-t4', acceleratorCount: 1 }] },
  'a machine type with its own GPU': { machineType: `${V1}/zones/${ZONE}/machineTypes/g2-standard-4` },
  'confidential': { confidentialInstanceConfig: { enableConfidentialCompute: true } },
  'over 208 GB of memory': { machineType: `${V1}/zones/${ZONE}/machineTypes/big` },
};
for (const [what, vm] of Object.entries(NOT_SUSPENDABLE)) {
  test(`hibernate on, ${what}: stopped`, async () => {
    const t = setup({
      vms: { 'vm-a': { status: 'RUNNING', ...vm } },
      machineTypes: { 'g2-standard-4': { memoryMb: 16_384, accelerators: [{ guestAcceleratorType: 'nvidia-l4', guestAcceleratorCount: 1 }] }, big: { memoryMb: 208 * 1024 + 1 } },
    });
    await t.controller.nap('demo');
    assert.deepEqual(t.world.calls, ['map policy', 'wait 300 s', 'stop vm-a']);
    assert.deepEqual(t.run().stopped, ['vm-a']);
  });
}

test('exactly 208 GB of memory is suspended', async () => {
  const t = setup({ vms: { 'vm-a': { status: 'RUNNING', machineType: `${V1}/zones/${ZONE}/machineTypes/limit` } }, machineTypes: { limit: { memoryMb: 208 * 1024 } } });
  await t.controller.nap('demo');
  assert.deepEqual(t.run().suspended, ['vm-a']);
});

test('a machine type that cannot be read: stopped, never a failed nap', async () => {
  const t = setup({ vms: { 'vm-a': { status: 'RUNNING', machineType: `${V1}/zones/${ZONE}/machineTypes/unknown` } } });
  await t.controller.nap('demo');
  assert.deepEqual(t.run().stopped, ['vm-a']);
  assert.equal(t.run().state, STATES.ASLEEP);
});

test('a refused suspension falls back to a stop', async () => {
  const t = setup({ vms: { 'vm-a': { status: 'RUNNING' } } });
  t.world.on['suspend vm-a'] = async () => { throw new GoogleError('Google: POST: 400 cannot suspend', { code: 400 }); };
  await t.controller.nap('demo');
  assert.deepEqual(t.world.calls, ['map policy', 'wait 300 s', 'suspend vm-a', 'stop vm-a']);
  assert.deepEqual(t.run().stopped, ['vm-a']);
  assert.deepEqual(t.run().suspended, []);
  assert.equal(t.logged('HibernationRefused').length, 1);
  assert.equal(t.run().state, STATES.ASLEEP);
});

test('a suspension whose wait ran out is no refusal: no stop, the VM ends suspended', async () => {
  const t = setup({ vms: { 'vm-a': { status: 'RUNNING' } } });
  t.world.on['suspend vm-a'] = async () => {
    t.world.vms['vm-a'].status = 'SUSPENDING';
    t.clock.advance(120_000);
    throw notDone();
  };
  t.clock.onSleep((now) => { if (now >= START + 300_000 + 120_000 + 20_000) t.world.vms['vm-a'].status = 'SUSPENDED'; });
  await t.controller.nap('demo');
  assert.deepEqual(t.world.calls, ['map policy', 'wait 300 s', 'suspend vm-a']);
  assert.equal(t.run().state, STATES.ASLEEP);
  assert.deepEqual(t.run().suspended, ['vm-a']);
});

test('a managed group: autoscaler off and its mode recorded before the VMs go, through the group, VM by VM', async () => {
  const t = setup({
    cfg: { backends: [MIG] },
    vms: { 'mig-1': { status: 'RUNNING' }, 'mig-2': { status: 'RUNNING', guestAccelerators: [{}] } },
    groups: { mig: [managed('mig-1', 'RUNNING'), managed('mig-2', 'RUNNING'), managed('mig-3', 'TERMINATED')] },
    autoscalers: { mig: 'ONLY_SCALE_OUT' },
  });
  let recordedWhenOff;
  t.world.on['autoscaler mig OFF'] = async () => { recordedWhenOff = structuredClone(t.run().autoscalers); };
  await t.controller.nap('demo');
  assert.deepEqual(t.world.calls.slice(0, 3), ['map policy', 'wait 300 s', 'autoscaler mig OFF']);
  assert.deepEqual(t.world.calls.slice(3).sort(), ['stop mig mig-2', 'suspend mig mig-1']);
  assert.deepEqual(recordedWhenOff, [{ kind: 'zonal', location: ZONE, name: 'mig', mode: 'ONLY_SCALE_OUT' }]);
  assert.deepEqual(t.run().autoscalers, recordedWhenOff);
  assert.deepEqual(t.run().stopped, ['mig-2']);
  assert.deepEqual(t.run().suspended, ['mig-1']);
  assert.equal(t.run().state, STATES.ASLEEP);
});

test('an autoscaler already off, or none: nothing recorded, nothing changed', async () => {
  const t = setup({
    cfg: { backends: [MIG, { kind: 'mig', location: ZONE, name: 'bare' }], hibernate: false },
    groups: { mig: [managed('mig-1', 'RUNNING')], bare: [managed('bare-1', 'RUNNING')] },
    autoscalers: { mig: 'OFF' },
  });
  await t.controller.nap('demo');
  assert.equal(t.run().state, STATES.ASLEEP);
  assert.deepEqual(t.run().autoscalers ?? [], []);
  assert.equal(t.world.calls.some((c) => c.startsWith('autoscaler')), false);
});

test('a managed group\'s slow stop (198 s, past the operation\'s wait) is no failure, and fits the request', async () => {
  const t = setup({ cfg: { backends: [MIG], hibernate: false }, groups: { mig: [managed('mig-1', 'RUNNING')] } });
  let stopAsked;
  t.world.on['stop mig mig-1'] = async () => {
    stopAsked = t.clock.now();
    t.world.groups.mig = [managed('mig-1', 'RUNNING', 'STOPPING')];
    t.clock.advance(120_000);
    throw notDone();
  };
  t.clock.onSleep((now) => { if (stopAsked && now >= stopAsked + 198_000) t.world.groups.mig = [managed('mig-1', 'TERMINATED')]; });
  const out = await t.controller.nap('demo');
  assert.equal(out.state, STATES.ASLEEP);
  assert.equal(t.run().failure, undefined);
  assert.deepEqual(t.run().stopped, ['mig-1']);
  assert.ok(t.clock.now() - START < REQUEST_LIMIT, `${t.clock.now() - START} ms`);
});

test('a stop whose operation is done while the group still stops its VMs: ASLEEP only once they are down', async () => {
  const t = setup({ cfg: { backends: [MIG], hibernate: false }, groups: { mig: [managed('mig-1', 'RUNNING')] } });
  t.world.on['stop mig mig-1'] = async () => {
    t.world.groups.mig = [managed('mig-1', 'RUNNING', 'STOPPING')];
    return 'under way';
  };
  let polled = 0;
  t.clock.onSleep(() => {
    if (t.world.calls.includes('stop mig mig-1')) polled += 1;
    if (polled === 5) t.world.groups.mig = [managed('mig-1', 'TERMINATED')];
  });
  await t.controller.nap('demo');
  assert.equal(t.run().state, STATES.ASLEEP);
  assert.equal(polled, 5);
});

test('a stop that never ends: FAILED with the kind timeout, within the request', async () => {
  const t = setup({ vms: { 'vm-a': { status: 'RUNNING' } }, cfg: { hibernate: false } });
  t.world.on['stop vm-a'] = async () => { t.world.vms['vm-a'].status = 'STOPPING'; throw notDone(); };
  const out = await t.controller.nap('demo');
  assert.equal(out.state, STATES.FAILED);
  assert.equal(t.run().state, STATES.FAILED);
  assert.equal(JSON.parse(t.run().failure).kind, 'timeout');
  assert.equal(JSON.parse(t.run().failure).step, 'nap');
  assert.equal(t.run().stopping, undefined);
  assert.ok(t.clock.now() - START < REQUEST_LIMIT, `${t.clock.now() - START} ms`);
  assert.equal(t.logged('NapFailed').length, 1);
});

test('a slow URL map write leaves the stop less time: the nap\'s deadline still fits the request', async () => {
  const t = setup({ vms: { 'vm-a': { status: 'RUNNING' } }, cfg: { hibernate: false } });
  t.world.on.put = async () => { t.clock.advance(400_000); };
  t.world.on['stop vm-a'] = async () => { t.world.vms['vm-a'].status = 'STOPPING'; throw notDone(); };
  const out = await t.controller.nap('demo');
  assert.equal(out.state, STATES.FAILED);
  assert.ok(t.clock.now() - START < REQUEST_LIMIT - 30_000, `${t.clock.now() - START} ms`);
});

test('a stop refused: FAILED with the kind permission', async () => {
  const t = setup({ vms: { 'vm-a': { status: 'RUNNING' } }, cfg: { hibernate: false } });
  t.world.on['stop vm-a'] = async () => { throw new GoogleError('Google: POST: 403 denied', { code: 403 }); };
  await t.controller.nap('demo');
  assert.equal(JSON.parse(t.run().failure).kind, 'permission');
});

test('a URL map changed four times over: a failure of the switch (throttled), nothing stopped', async () => {
  const t = setup({ vms: { 'vm-a': { status: 'RUNNING' } } });
  t.world.conflicts = 4;
  const out = await t.controller.nap('demo');
  assert.equal(out.state, STATES.FAILED);
  assert.equal(JSON.parse(t.run().failure).kind, 'throttled');
  assert.deepEqual(t.world.calls, []);
});

test('a URL map changed three times over is read again and written', async () => {
  const t = setup({ vms: { 'vm-a': { status: 'RUNNING' } }, cfg: { hibernate: false } });
  t.world.conflicts = 3;
  assert.equal((await t.controller.nap('demo')).state, STATES.ASLEEP);
});

test('a customer\'s own error policy: the nap is aborted, AWAKE, nothing stopped', async () => {
  const map = mapOf();
  map.pathMatchers[0].defaultCustomErrorResponsePolicy = { errorService: `${V1}/global/backendServices/theirs`, errorResponseRules: [] };
  const t = setup({ vms: { 'vm-a': { status: 'RUNNING' } }, map });
  const out = await t.controller.nap('demo');
  assert.equal(out.state, STATES.AWAKE);
  assert.equal(out.aborted, true);
  assert.equal(t.run().state, STATES.AWAKE);
  assert.equal(t.run().awakeSince, t.clock.now());
  assert.deepEqual(t.world.calls, []);
  assert.equal(t.logged('NapAborted').length, 1);
});

// Review focus 5.
test('a wake asked during the nap\'s 300 s: the nap ends awake, nothing stopped, the policy removed', async () => {
  const t = setup({ vms: { 'vm-a': { status: 'RUNNING' } } });
  t.clock.onSleep(() => t.store.setPendingWake('demo'));
  const out = await t.controller.nap('demo');
  assert.deepEqual(out, { state: STATES.AWAKE, aborted: true });
  assert.deepEqual(t.world.calls, ['map policy', 'wait 300 s', 'map no policy']);
  assert.equal(t.run().state, STATES.AWAKE);
  assert.equal(t.run().pendingWake, undefined);
  assert.equal(t.run().awakeSince, t.clock.now());
  assert.equal(hasPolicy(t.world.map), false);
  assert.equal(t.logged('NapAborted').length, 1);
});

test('a wake asked once the VMs are going: kept, and the workload wakes once the nap ends, in a new request', async () => {
  const t = setup({ vms: { 'vm-a': { status: 'RUNNING' } }, cfg: { hibernate: false } });
  t.world.on['stop vm-a'] = async () => { await t.store.setPendingWake('demo'); };
  const out = await t.controller.nap('demo');
  assert.deepEqual(out, { state: STATES.WAKING, wakeId: 'wake-2' });
  assert.equal(t.world.vms['vm-a'].status, 'TERMINATED');
  assert.equal(t.run().state, STATES.WAKING);
  assert.equal(t.run().wakeId, 'wake-2');
  assert.equal(t.run().pendingWake, undefined);
  assert.equal(t.run().stopping, undefined);
  assert.equal(t.run().wakeCount, 1);
  assert.deepEqual(t.world.tasks, [{ url: `${CONTROLLER}/v1/tasks`, body: { action: 'wake', workloadId: 'demo', wakeId: 'wake-2' } }]);
  assert.equal(t.logged('WakeRequested')[0].reason, 'pendingWake');
  const woken = await t.controller.wake('demo', 'wake-2');
  assert.equal(woken.state, STATES.AWAKE);
  assert.equal(hasPolicy(t.world.map), false);
  assert.equal(t.world.vms['vm-a'].status, 'RUNNING');
});

// --- The check -----------------------------------------------------------------------------------------------------

const AWAKE_LONG = { state: STATES.AWAKE, awakeSince: START - 60 * MINUTE };

test('idle: the check enqueues the nap and never waits for it', async () => {
  const t = setup({ run: AWAKE_LONG, vms: { 'vm-a': { status: 'RUNNING' } } });
  const out = await t.controller.check();
  assert.deepEqual(out, [{ workloadId: 'demo', state: STATES.AWAKE, nap: 'requested' }]);
  assert.deepEqual(t.world.tasks, [{ url: `${CONTROLLER}/v1/tasks`, body: { action: 'nap', workloadId: 'demo' } }]);
  assert.deepEqual(t.world.sleeps, []);
  assert.deepEqual(t.world.calls, []);
  assert.deepEqual(t.world.metricReads, [{ urlMap: 'lb', backendService: 'app', from: START - 15 * MINUTE, to: START }]);
  assert.equal(t.run().state, STATES.AWAKE);
  assert.equal(t.logged('NapRequested').length, 1);
});

test('requests in the idle window: no nap', async () => {
  const t = setup({ run: AWAKE_LONG, vms: { 'vm-a': { status: 'RUNNING' } }, requests: 3 });
  assert.deepEqual(await t.controller.check(), [{ workloadId: 'demo', state: STATES.AWAKE }]);
  assert.equal(t.world.metricReads.length, 1);
  assert.deepEqual(t.world.tasks, []);
});

test('awake for less than the idle window: no metric read', async () => {
  const t = setup({ run: { state: STATES.AWAKE, awakeSince: START - 14 * MINUTE }, vms: { 'vm-a': { status: 'RUNNING' } } });
  assert.deepEqual(await t.controller.check(), [{ workloadId: 'demo', state: STATES.AWAKE }]);
  assert.deepEqual(t.world.metricReads, []);
  assert.deepEqual(t.world.tasks, []);
});

test('asleep without the error policy: repaired, RouteDrift logged, no 300 s wait', async () => {
  const t = setup({ run: { state: STATES.ASLEEP }, vms: { 'vm-a': { status: 'TERMINATED' } } });
  assert.deepEqual(await t.controller.check(), [{ workloadId: 'demo', state: STATES.ASLEEP }]);
  assert.equal(hasPolicy(t.world.map), true);
  assert.deepEqual(t.world.sleeps, []);
  assert.deepEqual(t.logged('RouteDrift').map((l) => [l.workloadId, l.state, l.paths]), [['demo', STATES.ASLEEP, ['pathMatchers[0].defaultCustomErrorResponsePolicy']]]);
});

test('asleep without the route: repaired, RouteDrift logged', async () => {
  const map = asleepMap();
  delete map.pathMatchers[0].pathRules;
  const t = setup({ run: { state: STATES.ASLEEP }, vms: { 'vm-a': { status: 'TERMINATED' } }, map });
  await t.controller.check();
  assert.equal(hasRoute(t.world.map), true);
  assert.equal(hasPolicy(t.world.map), true);
  assert.deepEqual(t.logged('RouteDrift')[0].paths, ['pathMatchers[0].pathRules']);
});

test('asleep as it should be: nothing written, no drift', async () => {
  const t = setup({ run: { state: STATES.ASLEEP }, vms: { 'vm-a': { status: 'SUSPENDED' } }, map: asleepMap() });
  assert.deepEqual(await t.controller.check(), [{ workloadId: 'demo', state: STATES.ASLEEP }]);
  assert.equal(t.world.puts, 0);
  assert.equal(t.logged('RouteDrift').length, 0);
});

test('awake with the policy still there: removed, and the route kept', async () => {
  const t = setup({ run: { state: STATES.AWAKE, awakeSince: START }, vms: { 'vm-a': { status: 'RUNNING' } }, map: asleepMap() });
  await t.controller.check();
  assert.equal(hasPolicy(t.world.map), false);
  assert.equal(hasRoute(t.world.map), true);
  assert.equal(t.logged('RouteDrift').length, 1);
});

test('a VM started by hand: awake (external-start), the others started, autoscalers given back, the policy removed', async () => {
  const t = setup({
    run: { state: STATES.ASLEEP, stopped: ['vm-b', 'mig-1'], suspended: [], autoscalers: [{ kind: 'zonal', location: ZONE, name: 'mig', mode: 'ON' }] },
    cfg: { backends: [VM_A, VM_B, MIG] },
    vms: { 'vm-a': { status: 'RUNNING' }, 'vm-b': { status: 'TERMINATED' } },
    groups: { mig: [managed('mig-1', 'TERMINATED')] },
    autoscalers: { mig: 'OFF' },
    map: asleepMap(),
  });
  const [out] = await t.controller.check();
  assert.equal(out.state, STATES.AWAKE);
  assert.equal(t.run().state, STATES.AWAKE);
  assert.equal(t.run().awakeSince, t.clock.now());
  assert.equal(t.run().autoscalers, undefined);
  assert.equal(t.run().stopped, undefined);
  assert.deepEqual(t.world.calls.filter((c) => !c.startsWith('map')).sort(), ['autoscaler mig ON', 'start mig mig-1', 'start vm-b']);
  assert.equal(hasPolicy(t.world.map), false);
  assert.equal(t.logged('ExternalWake').length, 1);
  assert.equal(t.logged('StateChanged').find((l) => l.to === STATES.AWAKE).cause, 'external-start');
});

test('a VM started by hand while another one has no capacity: awake all the same, autoscalers given back, logged', async () => {
  const t = setup({
    run: { state: STATES.ASLEEP, autoscalers: [{ kind: 'zonal', location: ZONE, name: 'mig', mode: 'ON' }] },
    cfg: { backends: [VM_A, VM_B, MIG] },
    vms: { 'vm-a': { status: 'RUNNING' }, 'vm-b': { status: 'TERMINATED' } },
    groups: { mig: [managed('mig-1', 'RUNNING')] },
    autoscalers: { mig: 'OFF' },
    map: asleepMap(),
  });
  t.world.on['start vm-b'] = async () => { throw new GoogleError('Google: operation: ZONE_RESOURCE_POOL_EXHAUSTED: no', { reason: 'ZONE_RESOURCE_POOL_EXHAUSTED' }); };
  const [out] = await t.controller.check();
  assert.equal(out.state, STATES.AWAKE);
  assert.equal(t.world.autoscalers.mig, 'ON');
  assert.equal(t.logged('BackendsNotWoken').length, 1);
  assert.equal(hasPolicy(t.world.map), false);
});

test('asleep, a VM running but not healthy yet: still asleep', async () => {
  const t = setup({ run: { state: STATES.ASLEEP }, vms: { 'vm-a': { status: 'RUNNING' } }, map: asleepMap(), unhealthyPolls: Infinity });
  assert.deepEqual(await t.controller.check(), [{ workloadId: 'demo', state: STATES.ASLEEP }]);
  assert.equal(hasPolicy(t.world.map), true);
});

// Review focus 4.
test('VMs stopped by hand while awake: the policy written with no wait, ASLEEP with the cause external-stop', async () => {
  const t = setup({ run: AWAKE_LONG, vms: { 'vm-a': { status: 'TERMINATED' } } });
  const out = await t.controller.check();
  assert.deepEqual(out, [{ workloadId: 'demo', state: STATES.ASLEEP }]);
  assert.deepEqual(t.world.calls, ['map policy']);
  assert.deepEqual(t.world.sleeps, []);
  assert.equal(t.run().state, STATES.ASLEEP);
  assert.equal(t.logged('ExternalStop').length, 1);
  assert.equal(t.logged('StateChanged').find((l) => l.to === STATES.ASLEEP).cause, 'external-stop');
  assert.deepEqual(t.world.tasks, []);
  assert.deepEqual(t.world.metricReads, []);
});

test('the policy cannot be written: still awake, the next check tries again', async () => {
  const t = setup({ run: AWAKE_LONG, vms: { 'vm-a': { status: 'TERMINATED' } } });
  t.world.on.put = async () => { throw new GoogleError('Google: PUT: 500 oops', { code: 500 }); };
  const [out] = await t.controller.check();
  assert.match(out.error, /500/);
  assert.equal(t.run().state, STATES.AWAKE);
  assert.equal(t.logged('CheckFailed').length, 1);
});

test('awake, one VM down and one running, or one on its way up: not an external stop', async () => {
  const half = setup({ run: AWAKE_LONG, cfg: { backends: [VM_A, VM_B] }, vms: { 'vm-a': { status: 'TERMINATED' }, 'vm-b': { status: 'RUNNING' } }, unhealthyPolls: Infinity });
  assert.equal((await half.controller.check())[0].state, STATES.AWAKE);
  const booting = setup({ run: AWAKE_LONG, vms: { 'vm-a': { status: 'STAGING' } } });
  assert.equal((await booting.controller.check())[0].state, STATES.AWAKE);
  const scaledDown = setup({ run: AWAKE_LONG, cfg: { backends: [MIG] }, groups: { mig: [] }, requests: 1 });
  assert.equal((await scaledDown.controller.check())[0].state, STATES.AWAKE);
});

test('stuck waking: FAILED with the kind timeout, past the wake timeout and its grace only', async () => {
  const stuck = setup({ run: waking(START - 660_001), vms: { 'vm-a': { status: 'TERMINATED' } } });
  assert.equal((await stuck.controller.check())[0].state, STATES.FAILED);
  assert.equal(stuck.run().state, STATES.FAILED);
  assert.equal(JSON.parse(stuck.run().failure).kind, 'timeout');
  assert.equal(stuck.logged('WakeStuck').length, 1);
  const within = setup({ run: waking(START - 660_000), vms: { 'vm-a': { status: 'TERMINATED' } }, map: asleepMap() });
  assert.deepEqual(await within.controller.check(), [{ workloadId: 'demo', state: STATES.WAKING }]);
  assert.equal(within.run().state, STATES.WAKING);
  assert.equal(within.world.calls.length, 0);
});

test('stuck napping: FAILED with the kind timeout, past 15 minutes only', async () => {
  const stuck = setup({ run: { state: STATES.NAPPING, updatedAt: START - 15 * MINUTE - 1, stopping: true }, vms: { 'vm-a': { status: 'RUNNING' } } });
  await stuck.controller.check();
  assert.equal(stuck.run().state, STATES.FAILED);
  assert.equal(stuck.run().stopping, undefined);
  assert.equal(JSON.parse(stuck.run().failure).step, 'nap');
  assert.equal(stuck.logged('NapStuck').length, 1);
  const within = setup({ run: { state: STATES.NAPPING, updatedAt: START - 15 * MINUTE }, vms: { 'vm-a': { status: 'RUNNING' } } });
  assert.deepEqual(await within.controller.check(), [{ workloadId: 'demo', state: STATES.NAPPING }]);
});

const FAILED_RUN = (failedAt) => ({
  state: STATES.FAILED, failedAt, consecutiveFailures: 2, failure: JSON.stringify({ kind: 'capacity', step: 'wake', message: 'no', at: failedAt }),
});

test('failed, running for nothing, past the idle window: the check asks for the release; before it, no', async () => {
  const before = setup({ run: FAILED_RUN(START - 14 * MINUTE), vms: { 'vm-a': { status: 'RUNNING' } }, map: asleepMap(), unhealthyPolls: Infinity });
  assert.deepEqual(await before.controller.check(), [{ workloadId: 'demo', state: STATES.FAILED }]);
  assert.deepEqual(before.world.tasks, []);
  const after = setup({ run: FAILED_RUN(START - 15 * MINUTE), vms: { 'vm-a': { status: 'RUNNING' } }, map: asleepMap(), unhealthyPolls: Infinity });
  assert.deepEqual(await after.controller.check(), [{ workloadId: 'demo', state: STATES.FAILED, release: 'requested' }]);
  assert.deepEqual(after.world.tasks, [{ url: `${CONTROLLER}/v1/tasks`, body: { action: 'release', workloadId: 'demo' } }]);
  assert.equal(after.run().state, STATES.FAILED);
  assert.equal(after.logged('ReleaseRequested').length, 1);
});

test('failed, its VMs down: asleep (recovered), the failure kept for the backoff', async () => {
  const t = setup({ run: FAILED_RUN(START - MINUTE), vms: { 'vm-a': { status: 'TERMINATED' } }, map: asleepMap() });
  await t.controller.check();
  assert.equal(t.run().state, STATES.ASLEEP);
  assert.equal(t.logged('StateChanged').find((l) => l.to === STATES.ASLEEP).cause, 'recovered');
  assert.equal(JSON.parse(t.run().failure).kind, 'capacity');
  assert.equal(t.run().failedAt, START - MINUTE);
});

test('failed, its VMs now healthy: awake (recovered), the failure gone', async () => {
  const t = setup({ run: FAILED_RUN(START - MINUTE), vms: { 'vm-a': { status: 'RUNNING' } }, map: asleepMap() });
  await t.controller.check();
  assert.equal(t.run().state, STATES.AWAKE);
  assert.equal(t.run().failure, undefined);
  assert.equal(t.run().consecutiveFailures, undefined);
  assert.equal(t.logged('FailedRecovered').length, 1);
  assert.equal(hasPolicy(t.world.map), false);
});

test('the release stops the VMs behind the policy already there, ASLEEP, the failure kept', async () => {
  const t = setup({ run: FAILED_RUN(START - 15 * MINUTE), vms: { 'vm-a': { status: 'RUNNING' } }, map: asleepMap(), cfg: { hibernate: false } });
  assert.deepEqual(await t.controller.release('demo'), { state: STATES.ASLEEP });
  assert.deepEqual(t.world.calls, ['stop vm-a']);
  assert.deepEqual(t.world.sleeps, []);
  assert.equal(t.run().state, STATES.ASLEEP);
  assert.equal(JSON.parse(t.run().failure).kind, 'capacity');
  assert.deepEqual(t.run().stopped, ['vm-a']);
  assert.equal(t.logged('StateChanged').find((l) => l.to === STATES.ASLEEP).cause, 'failed-released');
  assert.equal(t.logged('FailedReleased').length, 1);
});

test('the release writes a missing policy and waits for it before stopping', async () => {
  const t = setup({ run: FAILED_RUN(START - 15 * MINUTE), vms: { 'vm-a': { status: 'RUNNING' } }, cfg: { hibernate: false } });
  await t.controller.release('demo');
  assert.deepEqual(t.world.calls, ['map policy', 'wait 300 s', 'stop vm-a']);
});

test('the release gives way to a wake asked meanwhile, and keeps a recorded autoscaler mode', async () => {
  const woken = setup({ run: FAILED_RUN(START), vms: { 'vm-a': { status: 'RUNNING' } }, cfg: { hibernate: false } });
  woken.clock.onSleep(() => { woken.run().state = STATES.WAKING; });
  assert.deepEqual(await woken.controller.release('demo'), { state: 'SUPERSEDED' });
  assert.equal(woken.world.calls.includes('stop vm-a'), false);

  const recorded = [{ kind: 'zonal', location: ZONE, name: 'mig', mode: 'ON' }];
  const kept = setup({
    run: { ...FAILED_RUN(START), autoscalers: recorded }, cfg: { backends: [MIG], hibernate: false }, groups: { mig: [managed('mig-1', 'RUNNING')] }, autoscalers: { mig: 'OFF' }, map: asleepMap(),
  });
  await kept.controller.release('demo');
  assert.deepEqual(kept.run().autoscalers, recorded);

  const running = setup({ run: { state: STATES.AWAKE }, vms: { 'vm-a': { status: 'RUNNING' } } });
  assert.deepEqual(await running.controller.release('demo'), { state: 'SKIPPED', reason: STATES.AWAKE });
  assert.deepEqual(running.world.calls, []);
});

test('a release that fails stays failed, logged, for the next check to ask again', async () => {
  const t = setup({ run: FAILED_RUN(START - 15 * MINUTE), vms: { 'vm-a': { status: 'RUNNING' } }, map: asleepMap(), cfg: { hibernate: false } });
  t.world.on['stop vm-a'] = async () => { throw new GoogleError('Google: POST: 403 denied', { code: 403 }); };
  const out = await t.controller.release('demo');
  assert.equal(out.state, STATES.FAILED);
  assert.equal(t.run().state, STATES.FAILED);
  assert.equal(t.logged('ReleaseFailed').length, 1);
});

test('the check stops at its 240 s, and one workload\'s failure does not stop the others', async () => {
  const clock = fakeClock();
  const ids = Array.from({ length: 12 }, (_, i) => `w${String(i).padStart(2, '0')}`);
  const logs = [];
  const log = { info() {}, error: (event, fields) => logs.push({ event, ...fields }), warn: (event, fields) => logs.push({ event, ...fields }) };
  const compute = {
    getInstance: async () => { clock.advance(100_000); return { status: 'RUNNING' }; },
    getBackendService: async () => ({ backends: [] }),
  };
  const store = {
    listWorkloads: async () => ({ configs: [...ids].reverse().map((workloadId) => ({ workloadId, urlMap: 'lb', backendService: 'app', wakerBackendService: WAKER, backends: [VM_A], idleMinutes: 15, wakeTimeoutSeconds: 600 })) }),
    getRun: async (id) => {
      if (id === 'w01') throw new Error('unreadable');
      return { state: STATES.AWAKE, awakeSince: clock.now() };
    },
  };
  const controller = createController({
    store,
    compute,
    urlmaps: { modify: async () => ({ paths: [] }) },
    monitoring: {},
    tasks: {},
    config: { project: 'p', controllerUrl: CONTROLLER },
    now: clock.now,
    sleep: clock.sleep,
    log,
  });
  const out = await controller.check();
  const reached = out.map((r) => r.workloadId).sort();
  assert.deepEqual(reached, ids.slice(0, 8), 'the eight first start together, none after 240 s');
  assert.match(out.find((r) => r.workloadId === 'w01').error, /unreadable/);
  assert.equal(logs.find((l) => l.event === 'CheckFailed').workloadId, 'w01');
  assert.equal(logs.find((l) => l.event === 'CheckBudgetReached').workloads, 12);
});
