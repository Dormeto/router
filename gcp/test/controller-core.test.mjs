import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FORMAT } from '../../lambda/src/lib/ip-lists.mjs';
import { STATES } from '../../lambda/src/lib/state.mjs';
import { fakeClock, fakeStore } from '../../lambda/test/fakes.mjs';
import { createController, PauseRefused } from '../src/controller-core.mjs';
import { fromFields, toFields } from '../src/firestore.mjs';
import { GoogleError, OPERATION_NOT_DONE } from '../src/google.mjs';
import { createUrlMaps, withErrorPolicy } from '../src/urlmaps.mjs';
import { setup as worldOf } from './world.mjs';

const V1 = 'https://compute.googleapis.com/compute/v1/projects/p';
const ZONE = 'europe-west1-b';
const CONTROLLER = 'https://dmtr-europe-west1-controller-123.europe-west1.run.app';
const WAKER = 'dmtr-europe-west1-demo';
const WAKER_URL = `${V1}/global/backendServices/${WAKER}`;
const APP_URL = `${V1}/global/backendServices/app`;
const MINUTE = 60_000;
const REQUEST_LIMIT = 1_800_000;
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
  run = { state: STATES.AWAKE, awakeSince: 1 }, cfg = {}, vms = {}, groups = {}, autoscalers = {}, machineTypes = {}, map = mapOf(), requests = 0, unhealthyPolls = 0, lists, download,
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
    autoscalerOf: {},
    autoscalerReads: [],
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
  // The Firestore store's names, and what its fields do to a value: an `undefined` comes back null.
  store.addPause = (id, pause) => store.putPause(id, fromFields(toFields(pause)));
  store.removePauses = async (id, { at } = {}) => {
    const found = store.state.pauses.find((p) => p.workloadId === id && (at === undefined || p.at === at));
    store.state.pauses = store.state.pauses.filter((p) => p !== found);
    return Boolean(found);
  };
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
    getManagedGroup: async ({ name }) => {
      const scaler = world.autoscalerOf[name] ?? (world.autoscalers[name] ? name : null);
      return { name, status: scaler ? { autoscaler: `${V1}/zones/${ZONE}/autoscalers/${scaler}` } : {} };
    },
    getAutoscaler: async ({ name }) => {
      world.autoscalerReads.push(name);
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
  const sleep = async (ms) => {
    world.sleeps.push(ms);
    if (ms >= MINUTE) world.calls.push(`wait ${ms / 1000} s`);
    await clock.sleep(ms);
  };
  const controller = createController({
    store,
    compute,
    urlmaps: createUrlMaps({ google, project: 'p', now: clock.now, sleep }),
    monitoring: {
      requestCount: async (query) => {
        world.metricReads.push(query);
        return typeof world.requests === 'function' ? world.requests(query) : world.requests;
      },
    },
    tasks: {
      enqueue: async (task) => {
        if (world.taskRefused) throw world.taskRefused;
        world.tasks.push(task);
        world.onTask?.(task);
      },
    },
    config: { project: 'p', controllerUrl: CONTROLLER },
    lists,
    download,
    now: clock.now,
    sleep,
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
  assert.deepEqual(t.world.autoscalerReads, ['mig'], 'a group naming no autoscaler has none');
});

test('an autoscaler not named like its group: found through the group, off for the nap, its name recorded, given back', async () => {
  const t = setup({
    cfg: { backends: [MIG], hibernate: false },
    groups: { mig: [managed('mig-1', 'RUNNING')] },
    autoscalers: { 'mig-scaler': 'ON' },
  });
  t.world.autoscalerOf.mig = 'mig-scaler';
  await t.controller.nap('demo');
  assert.equal(t.world.autoscalers['mig-scaler'], 'OFF');
  assert.ok(t.world.calls.includes('autoscaler mig-scaler OFF'));
  assert.deepEqual(t.run().autoscalers, [{ kind: 'zonal', location: ZONE, name: 'mig-scaler', mode: 'ON' }]);
  t.run().state = STATES.WAKING;
  t.run().wakeId = 'w1';
  await t.controller.wake('demo', 'w1');
  assert.equal(t.world.autoscalers['mig-scaler'], 'ON');
  assert.equal(t.run().autoscalers, undefined);
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

test('the nap asks to stop only what runs: a VM being created or started would have the whole request refused', async () => {
  const t = setup({
    cfg: { backends: [MIG], hibernate: false },
    groups: {
      mig: [
        managed('mig-1', 'RUNNING'),
        managed('mig-2', 'PROVISIONING', 'CREATING'),
        managed('mig-3', 'STAGING'),
        managed('mig-4', 'RUNNING', 'STARTING'),
        managed('mig-5', 'TERMINATED'),
      ],
    },
  });
  t.world.on['stop mig mig-1'] = async () => { t.world.groups.mig = t.world.groups.mig.map((m) => ({ ...m, instanceStatus: 'TERMINATED', currentAction: 'NONE' })); return 'under way'; };
  assert.equal((await t.controller.nap('demo')).state, STATES.ASLEEP);
  assert.deepEqual(t.world.calls.filter((c) => c.startsWith('stop')), ['stop mig mig-1']);
  assert.deepEqual(t.run().stopped, ['mig-1']);
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
  assert.ok(t.clock.now() - START <= REQUEST_LIMIT - 30_000, `${t.clock.now() - START} ms`);
});

test('a stop refused: FAILED with the kind permission', async () => {
  const t = setup({ vms: { 'vm-a': { status: 'RUNNING' } }, cfg: { hibernate: false } });
  t.world.on['stop vm-a'] = async () => { throw new GoogleError('Google: POST: 403 denied', { code: 403 }); };
  await t.controller.nap('demo');
  assert.equal(JSON.parse(t.run().failure).kind, 'permission');
});

test('a URL map changed five times over: a failure of the switch (throttled), nothing stopped', async () => {
  const t = setup({ vms: { 'vm-a': { status: 'RUNNING' } } });
  t.world.conflicts = 5;
  const out = await t.controller.nap('demo');
  assert.equal(out.state, STATES.FAILED);
  assert.equal(JSON.parse(t.run().failure).kind, 'throttled');
  assert.deepEqual(t.world.calls, []);
});

test('a URL map changed four times over is read again and written, with its pauses', async () => {
  const t = setup({ vms: { 'vm-a': { status: 'RUNNING' } }, cfg: { hibernate: false } });
  t.world.conflicts = 4;
  assert.equal((await t.controller.nap('demo')).state, STATES.ASLEEP);
});

test('another update of the URL map under way (resourceNotReady): the nap waits for it; for ever, a failure of the switch', async () => {
  const notReady = () => new GoogleError('Google: PUT: 400 The resource is not ready', { code: 400, reason: 'resourceNotReady' });
  const waits = setup({ vms: { 'vm-a': { status: 'RUNNING' } }, cfg: { hibernate: false } });
  let refusals = 2;
  waits.world.on.put = async () => {
    if (refusals-- > 0) throw notReady();
  };
  assert.equal((await waits.controller.nap('demo')).state, STATES.ASLEEP);
  assert.deepEqual(waits.world.sleeps.slice(0, 2), [5000, 10_000]);

  const never = setup({ vms: { 'vm-a': { status: 'RUNNING' } } });
  never.world.on.put = async () => { throw notReady(); };
  assert.equal((await never.controller.nap('demo')).state, STATES.FAILED);
  assert.equal(JSON.parse(never.run().failure).kind, 'throttled');
  assert.deepEqual(never.world.calls, []);
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

test('the policy lost during the 300 s: written again and a fresh wait before the VMs go, a group\'s 198 s stop still fitting', async () => {
  const t = setup({ cfg: { backends: [MIG], hibernate: false }, groups: { mig: [managed('mig-1', 'RUNNING')] } });
  t.world.on.put = async () => { t.clock.advance(25_000); };
  let lost = false;
  let stopAsked;
  t.clock.onSleep((now) => {
    if (!lost) {
      lost = true;
      delete t.world.map.pathMatchers[0].defaultCustomErrorResponsePolicy;
    }
    if (stopAsked && now >= stopAsked + 198_000) t.world.groups.mig = [managed('mig-1', 'TERMINATED')];
  });
  t.world.on['stop mig mig-1'] = async () => {
    stopAsked = t.clock.now();
    t.world.groups.mig = [managed('mig-1', 'RUNNING', 'STOPPING')];
    return 'under way';
  };
  const out = await t.controller.nap('demo');
  assert.deepEqual(t.world.calls, ['map policy', 'wait 300 s', 'map policy', 'wait 300 s', 'stop mig mig-1']);
  assert.equal(out.state, STATES.ASLEEP);
  assert.equal(t.run().failure, undefined);
  assert.equal(t.logged('PolicyLost').length, 1);
  assert.ok(t.clock.now() - START < REQUEST_LIMIT - 30_000, `${t.clock.now() - START} ms`);
});

test('the policy lost with no room for a fresh wait: AWAKE, the policy removed, nothing stopped', async () => {
  const t = setup({ vms: { 'vm-a': { status: 'RUNNING' } } });
  let slowed = false;
  t.world.on.put = async () => {
    if (!slowed) t.clock.advance(1_300_000);
    slowed = true;
  };
  t.clock.onSleep(() => { delete t.world.map.pathMatchers[0].defaultCustomErrorResponsePolicy; });
  const out = await t.controller.nap('demo');
  assert.deepEqual(out, { state: STATES.AWAKE, aborted: true });
  assert.deepEqual(t.world.calls, ['map policy', 'wait 300 s', 'map policy', 'map no policy']);
  assert.equal(t.run().state, STATES.AWAKE);
  assert.equal(t.run().awakeSince, t.clock.now());
  assert.equal(hasPolicy(t.world.map), false);
  assert.equal(t.world.vms['vm-a'].status, 'RUNNING');
  assert.equal(t.logged('NapAborted').length, 1);
});

test('a customer\'s own policy written during the 300 s: AWAKE, theirs kept, nothing stopped', async () => {
  const t = setup({ vms: { 'vm-a': { status: 'RUNNING' } } });
  t.clock.onSleep(() => {
    t.world.map.pathMatchers[0].defaultCustomErrorResponsePolicy = { errorService: `${V1}/global/backendServices/theirs`, errorResponseRules: [] };
  });
  const out = await t.controller.nap('demo');
  assert.equal(out.state, STATES.AWAKE);
  assert.equal(out.aborted, true);
  assert.equal(t.world.vms['vm-a'].status, 'RUNNING');
  assert.equal(t.world.calls.some((c) => c.startsWith('stop') || c.startsWith('suspend')), false);
  assert.equal(t.world.map.pathMatchers[0].defaultCustomErrorResponsePolicy.errorService, `${V1}/global/backendServices/theirs`);
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
  assert.deepEqual(t.world.metricReads, [{ backendService: 'app', from: START - 15 * MINUTE - 180_000, to: START }]);
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

test('awake for less than the idle window and the metric\'s margin: no metric read; at that distance, read', async () => {
  const within = setup({ run: { state: STATES.AWAKE, awakeSince: START - 15 * MINUTE - 179_999 }, vms: { 'vm-a': { status: 'RUNNING' } } });
  assert.deepEqual(await within.controller.check(), [{ workloadId: 'demo', state: STATES.AWAKE }]);
  assert.deepEqual(within.world.metricReads, []);
  assert.deepEqual(within.world.tasks, []);
  const at = setup({ run: { state: STATES.AWAKE, awakeSince: START - 15 * MINUTE - 180_000 }, vms: { 'vm-a': { status: 'RUNNING' } } });
  await at.controller.check();
  assert.equal(at.world.metricReads.length, 1);
});

// What Cloud Monitoring answers at `now`: the requests' points in the query's interval, once published (125 s at worst).
const publishedPoints = (ages, now = START) => ({ from, to }) => ages.map((age) => now - age).filter((at) => at >= from && at <= to && at + 125_000 <= now).length;

test('a request 200 s ago, its point the only one, with a 5-minute window: stays awake', async () => {
  const t = setup({ run: AWAKE_LONG, cfg: { idleMinutes: 5 }, vms: { 'vm-a': { status: 'RUNNING' } }, requests: publishedPoints([200_000]) });
  assert.deepEqual(await t.controller.check(), [{ workloadId: 'demo', state: STATES.AWAKE }]);
  assert.deepEqual(t.world.tasks, []);
});

test('with a 5-minute window, a request 30 s ago not published yet and the one before 320 s ago: stays awake on the older point', async () => {
  const t = setup({ run: AWAKE_LONG, cfg: { idleMinutes: 5 }, vms: { 'vm-a': { status: 'RUNNING' } }, requests: publishedPoints([30_000, 320_000]) });
  assert.deepEqual(await t.controller.check(), [{ workloadId: 'demo', state: STATES.AWAKE }]);
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

test('a failed give-back at an external wake: awake, the record kept; a later check gives the mode back and clears it', async () => {
  const recorded = [{ kind: 'zonal', location: ZONE, name: 'mig', mode: 'ON' }];
  const t = setup({
    run: { state: STATES.ASLEEP, autoscalers: recorded },
    cfg: { backends: [VM_A, MIG] },
    vms: { 'vm-a': { status: 'RUNNING' } },
    groups: { mig: [managed('mig-1', 'RUNNING')] },
    autoscalers: { mig: 'OFF' },
    map: asleepMap(),
  });
  t.world.on['autoscaler mig ON'] = async () => { throw new GoogleError('Google: PATCH: 503 unavailable', { code: 503 }); };
  const [first] = await t.controller.check();
  assert.equal(first.state, STATES.AWAKE);
  assert.deepEqual(t.run().autoscalers, recorded);
  assert.equal(t.world.autoscalers.mig, 'OFF');
  assert.equal(t.logged('AutoscalersNotGivenBack').length, 1);
  assert.equal(t.world.calls.filter((c) => c === 'autoscaler mig ON').length, 1, 'once per check');

  const [still] = await t.controller.check();
  assert.equal(still.state, STATES.AWAKE);
  assert.deepEqual(t.run().autoscalers, recorded);

  delete t.world.on['autoscaler mig ON'];
  await t.controller.check();
  assert.equal(t.world.autoscalers.mig, 'ON');
  assert.equal(t.run().autoscalers, undefined);
});

test('a record kept on an awake run survives its next nap: the mode read OFF does not replace it', async () => {
  const recorded = [{ kind: 'zonal', location: ZONE, name: 'mig', mode: 'ON' }];
  const t = setup({
    run: { state: STATES.AWAKE, awakeSince: START, autoscalers: recorded },
    cfg: { backends: [MIG], hibernate: false },
    groups: { mig: [managed('mig-1', 'RUNNING')] },
    autoscalers: { mig: 'OFF' },
  });
  await t.controller.nap('demo');
  assert.equal(t.run().state, STATES.ASLEEP);
  assert.deepEqual(t.run().autoscalers, recorded);
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

test('stuck napping: FAILED with the kind timeout, past 35 minutes only', async () => {
  const stuck = setup({ run: { state: STATES.NAPPING, updatedAt: START - 35 * MINUTE - 1, stopping: true }, vms: { 'vm-a': { status: 'RUNNING' } } });
  await stuck.controller.check();
  assert.equal(stuck.run().state, STATES.FAILED);
  assert.equal(stuck.run().stopping, undefined);
  assert.equal(JSON.parse(stuck.run().failure).step, 'nap');
  assert.equal(stuck.logged('NapStuck').length, 1);
  const within = setup({ run: { state: STATES.NAPPING, updatedAt: START - 34 * MINUTE }, vms: { 'vm-a': { status: 'RUNNING' } } });
  assert.deepEqual(await within.controller.check(), [{ workloadId: 'demo', state: STATES.NAPPING }]);
  const at = setup({ run: { state: STATES.NAPPING, updatedAt: START - 35 * MINUTE }, vms: { 'vm-a': { status: 'RUNNING' } } });
  assert.deepEqual(await at.controller.check(), [{ workloadId: 'demo', state: STATES.NAPPING }]);
  const late = setup({ run: { state: STATES.NAPPING, updatedAt: START - 36 * MINUTE, stopping: true }, vms: { 'vm-a': { status: 'RUNNING' } } });
  await late.controller.check();
  assert.equal(late.run().state, STATES.FAILED);
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

test('the release reads the run again after its wait: a mode recorded meanwhile survives, with the autoscaler now off', async () => {
  const recorded = [{ kind: 'zonal', location: ZONE, name: 'mig', mode: 'ON' }];
  const t = setup({
    run: FAILED_RUN(START), cfg: { backends: [MIG], hibernate: false }, groups: { mig: [managed('mig-1', 'RUNNING')] }, autoscalers: { mig: 'ON' },
  });
  t.clock.onSleep(() => {
    t.run().autoscalers = recorded;
    t.world.autoscalers.mig = 'OFF';
  });
  assert.equal((await t.controller.release('demo')).state, STATES.ASLEEP);
  assert.deepEqual(t.run().autoscalers, recorded);
});

test('the release whose run left FAILED, or is gone, during its wait reads nothing more and stops nothing', async () => {
  const gone = setup({ run: FAILED_RUN(START), vms: { 'vm-a': { status: 'RUNNING' } }, cfg: { backends: [MIG], hibernate: false }, groups: { mig: [managed('mig-1', 'RUNNING')] } });
  gone.clock.onSleep(() => { gone.store.state.run = null; });
  assert.deepEqual(await gone.controller.release('demo'), { state: 'SUPERSEDED' });
  assert.equal(gone.world.calls.some((c) => c.startsWith('stop')), false);
  assert.deepEqual(gone.world.autoscalerReads, []);
  assert.deepEqual(gone.logged('ReleaseFailed'), []);
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
    listWorkloads: async () => ({ configs: [...ids].reverse().map((workloadId) => ({ workloadId, urlMap: 'lb', backendService: 'app', wakerBackendService: WAKER, backends: [VM_A], idleMinutes: 15, wakeTimeoutSeconds: 600 })), schedules: new Map() }),
    listPauses: async () => [],
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

// --- Schedules ---------------------------------------------------------------------------------------------------------

// The fake clock starts on Tuesday 2023-11-14 at 22:13 UTC.
const scheduleOf = (...windows) => ({ timeZone: 'UTC', windows, by: 'ops', at: START - 1000 });
const NAP = { kind: 'nap', days: ['tue'], start: '22:00', end: '23:00' };
const AWAKE_WINDOW = { kind: 'awake', days: ['tue'], start: '22:00', end: '23:00' };
const NAP_ID = '0@2023-11-14T22:00:00.000Z';
const NAP_END = Date.parse('2023-11-14T23:00:00Z');
const DAY = 86_400_000;
const FIVE_MINUTES = 5 * MINUTE;
const scheduled = (schedule, options) => {
  const t = setup({ vms: { 'vm-a': { status: 'RUNNING' } }, ...options });
  t.store.state.schedules.demo = schedule;
  return t;
};
const pauseFor = (t, pause = {}) => t.store.state.pauses.push({ workloadId: 'demo', by: 'ops', at: START - 1000, reason: 'load test', keepAsleep: false, ...pause });
const check = async (t) => (await t.controller.check()).find((r) => r.workloadId === 'demo');
const napTask = { url: `${CONTROLLER}/v1/tasks`, body: { action: 'nap', workloadId: 'demo', cause: 'schedule', requestedAt: START, until: NAP_END } };

test('a nap window naps once, whatever the traffic: its task says its cause and its end, a second check asks nothing', async () => {
  const t = scheduled(scheduleOf(NAP), { requests: 5 });
  assert.equal((await check(t)).schedule, 'nap');
  assert.deepEqual(t.world.tasks, [napTask]);
  assert.equal(t.run().scheduleApplied, NAP_ID);
  assert.equal(t.run().state, STATES.AWAKE, 'only asked: a nap holds a request for minutes');
  assert.deepEqual(t.logged('ScheduleApplied').map((l) => [l.occurrence, l.kind, l.action]), [[NAP_ID, 'nap', 'nap']]);
  assert.equal(t.logged('NapRequested')[0].cause, 'schedule');
  t.clock.advance(FIVE_MINUTES);
  assert.equal((await check(t)).schedule, undefined);
  assert.equal(t.world.tasks.length, 1);
});

test('an idle workload in its nap window gets the scheduled nap only, not an idle one too', async () => {
  const t = scheduled(scheduleOf(NAP));
  await check(t);
  assert.deepEqual(t.world.tasks, [napTask]);
});

test('the scheduled nap\'s task runs with its cause: the state change says schedule', async () => {
  const t = scheduled(scheduleOf(NAP), { map: mapOf() });
  await t.controller.nap('demo', { cause: 'schedule', requestedAt: START, until: NAP_END });
  assert.equal(t.logged('StateChanged').find((l) => l.to === STATES.NAPPING).cause, 'schedule');
});

test('a nap window\'s task delivered late or twice stops nothing: its window ended, or the workload woke since', async () => {
  const ended = scheduled(scheduleOf(NAP));
  ended.clock.advance(NAP_END - START);
  assert.deepEqual(await ended.controller.nap('demo', { cause: 'schedule', requestedAt: START, until: NAP_END }), { state: 'SKIPPED', reason: 'the nap window ended' });
  const woken = scheduled(scheduleOf(NAP), { run: { state: STATES.AWAKE, awakeSince: START + 1000 } });
  assert.deepEqual(await woken.controller.nap('demo', { cause: 'schedule', requestedAt: START, until: NAP_END }), { state: 'SKIPPED', reason: 'woken since it was requested' });
  for (const t of [ended, woken]) {
    assert.equal(t.run().state, STATES.AWAKE);
    assert.deepEqual(t.world.calls, []);
    assert.equal(t.logged('NapSkipped').length, 1);
  }
});

test('an awake window wakes a sleeper in a request of its own, once', async () => {
  const t = scheduled(scheduleOf(AWAKE_WINDOW), { run: { state: STATES.ASLEEP, stateAt: START - DAY }, vms: { 'vm-a': { status: 'TERMINATED' } }, map: asleepMap() });
  assert.equal((await check(t)).schedule, 'wake');
  assert.equal(t.run().state, STATES.WAKING);
  assert.equal(t.run().scheduleApplied, NAP_ID);
  assert.deepEqual(t.world.tasks.map((task) => task.body), [{ action: 'wake', workloadId: 'demo', wakeId: 'wake-2' }]);
  assert.equal(t.logged('StateChanged').find((l) => l.to === STATES.WAKING).cause, 'schedule');
  assert.equal(t.store.state.stats['wake:schedule'], 1);
  t.clock.advance(FIVE_MINUTES);
  assert.equal((await check(t)).schedule, undefined);
  assert.equal(t.world.tasks.length, 1);
});

test('an awake window gives a napping workload its pending wake, and the occurrence is recorded once the nap settled', async () => {
  const t = scheduled(scheduleOf(AWAKE_WINDOW), { run: { state: STATES.NAPPING, updatedAt: START } });
  assert.equal((await check(t)).schedule, 'pending wake');
  assert.equal(t.run().pendingWake, true);
  assert.equal(t.run().scheduleApplied, undefined);
  assert.equal(t.world.tasks.length, 0);
  Object.assign(t.store.state.run, { state: STATES.AWAKE, awakeSince: START, pendingWake: false });
  await check(t);
  assert.equal(t.run().scheduleApplied, NAP_ID);
});

test('an awake window while awake: recorded with nothing to do, and the idle nap kept off', async () => {
  const t = scheduled(scheduleOf(AWAKE_WINDOW));
  const out = await check(t);
  assert.equal(out.kept, 'awake window');
  assert.equal(t.run().scheduleApplied, NAP_ID);
  assert.deepEqual(t.world.tasks, []);
  assert.deepEqual(t.logged('ScheduleApplied').map((l) => l.action), ['none']);
});

test('within 30 minutes of an awake start, the nap is skipped and recorded, and the idle nap kept off', async () => {
  const t = scheduled(scheduleOf({ ...NAP, start: '21:00', end: '22:30' }, { ...AWAKE_WINDOW, start: '22:30', end: '23:30' }));
  const out = await check(t);
  assert.equal(out.kept, 'awake window within 30 minutes');
  assert.deepEqual(t.world.tasks, []);
  assert.equal(t.run().scheduleApplied, '0@2023-11-14T21:00:00.000Z');
  assert.deepEqual(t.logged('ScheduleApplied').map((l) => l.action), ['skipped: an awake window starts within 30 minutes']);
});

test('napping or waking at a nap window: left for the next check, which naps it once awake', async () => {
  const t = scheduled(scheduleOf(NAP), { run: waking(START) });
  await check(t);
  assert.equal(t.run().scheduleApplied, undefined);
  Object.assign(t.store.state.run, { state: STATES.AWAKE, awakeSince: START });
  await check(t);
  assert.equal(t.world.tasks.length, 1);
  assert.equal(t.run().scheduleApplied, NAP_ID);
});

test('a schedule the router cannot read: logged, the workload as with none', async () => {
  const t = scheduled({ timeZone: 'Nowhere/Land', windows: [NAP], at: START }, { requests: 0 });
  const out = await check(t);
  assert.equal(t.logged('ScheduleSkipped').length, 1);
  assert.equal(out.nap, 'requested');
  assert.deepEqual(t.world.tasks.map((task) => task.body), [{ action: 'nap', workloadId: 'demo' }]);
});

// Twelve workloads on the same URL map, their VMs read through the world.
function crowded(schedules) {
  const world = worldOf();
  for (const [workloadId, schedule] of Object.entries(schedules)) {
    world.store.configs.set(workloadId, { workloadId, urlMap: 'lb', backendService: 'app', wakerBackendService: WAKER, backends: [{ kind: 'vm', location: ZONE, name: 'vm-a' }], idleMinutes: 15, wakeTimeoutSeconds: 600 });
    world.store.runs.set(workloadId, { state: STATES.AWAKE, awakeSince: world.clock.now() - DAY });
    world.store.schedules.set(workloadId, schedule);
  }
  return world;
}
const napsOf = (world) => world.w.tasks.map((task) => task.body.workloadId);
const twelve = Array.from({ length: 12 }, (_, i) => `w${String(i).padStart(2, '0')}`);

test('12 workloads in one window → 10 tasks, the 2 others at the next check, their occurrences unrecorded until then', async () => {
  const world = crowded(Object.fromEntries(twelve.map((id) => [id, scheduleOf(NAP)])));
  const { store, core, clock, w } = world;
  const out = await core.check();
  assert.deepEqual(napsOf(world), twelve.slice(0, 10), 'and no idle nap for the two others');
  assert.equal(w.tasks.every((task) => task.body.cause === 'schedule'), true);
  for (const id of twelve.slice(0, 10)) assert.equal(store.runs.get(id).scheduleApplied, NAP_ID, id);
  for (const id of twelve.slice(10)) {
    assert.equal(store.runs.get(id).scheduleApplied, undefined, id);
    assert.equal(out.find((r) => r.workloadId === id).schedule, 'nap deferred', id);
  }
  assert.deepEqual(w.logs.find((l) => l.event === 'ScheduledNapsDeferred').workloads, twelve.slice(10));

  // The first ten's tasks are running: only the two others are left to ask for.
  for (const id of twelve.slice(0, 10)) store.runs.get(id).state = STATES.NAPPING;
  for (const id of twelve.slice(0, 10)) store.runs.get(id).updatedAt = clock.now();
  w.tasks.length = 0;
  clock.advance(FIVE_MINUTES);
  await core.check();
  assert.deepEqual(napsOf(world), twelve.slice(10));
  for (const id of twelve.slice(10)) assert.equal(store.runs.get(id).scheduleApplied, NAP_ID, id);
  w.tasks.length = 0;
  for (const id of twelve.slice(10)) store.runs.get(id).awakeSince = clock.now();
  clock.advance(FIVE_MINUTES);
  await core.check();
  assert.deepEqual(w.tasks, []);
});

test('the oldest occurrence goes first, whatever the workload\'s name', async () => {
  const world = crowded({ ...Object.fromEntries(twelve.slice(0, 10).map((id) => [id, scheduleOf(NAP)])), zz: scheduleOf({ ...NAP, start: '21:00' }) });
  await world.core.check();
  assert.deepEqual(napsOf(world), ['zz', ...twelve.slice(0, 9)]);
  assert.equal(world.store.runs.get('w09').scheduleApplied, undefined);
});

test('a scheduled nap\'s task refused: the occurrence unrecorded, another workload\'s goes on, the next check asks again', async () => {
  const world = crowded({ a: scheduleOf(NAP), b: scheduleOf(NAP) });
  world.w.fail.enqueue = new GoogleError('Google: 403 denied', { code: 403 });
  const out = await world.core.check();
  assert.deepEqual(world.w.tasks, []);
  for (const id of ['a', 'b']) {
    assert.equal(world.store.runs.get(id).scheduleApplied, undefined);
    assert.equal(out.find((r) => r.workloadId === id).schedule, 'nap refused');
  }
  assert.equal(world.w.logs.filter((l) => l.event === 'ScheduleFailed').length, 2);
  delete world.w.fail.enqueue;
  world.store.runs.get('a').awakeSince = world.store.runs.get('b').awakeSince = world.clock.now();
  await world.core.check();
  assert.deepEqual(napsOf(world), ['a', 'b']);
  assert.equal(world.store.runs.get('a').scheduleApplied, NAP_ID);
});

test('a task accepted while its nap already started: the occurrence recorded all the same', async () => {
  const t = scheduled(scheduleOf(NAP), { requests: 1 });
  t.world.onTask = () => { Object.assign(t.store.state.run, { state: STATES.NAPPING, updatedAt: START }); };
  await check(t);
  assert.equal(t.run().scheduleApplied, NAP_ID);
  assert.equal(t.run().state, STATES.NAPPING);
});

test('the same check\'s reconcile leaves the policy of the nap it just asked for, whatever a stale read of the run says', async () => {
  const t = scheduled(scheduleOf(NAP), { requests: 1 });
  // The task starts at once: the run NAPPING, the policy written. The check's read of the run went out before that.
  t.world.onTask = () => {
    Object.assign(t.store.state.run, { state: STATES.NAPPING, updatedAt: START });
    t.world.map = asleepMap();
  };
  const { getRun } = t.store;
  t.store.getRun = async (id) => ({ ...(await getRun(id)), state: STATES.AWAKE, awakeSince: 1 });
  const out = await check(t);
  assert.equal(out.schedule, 'nap');
  assert.equal(hasPolicy(t.world.map), true, 'the check\'s repair would have removed it');
  assert.deepEqual(t.world.calls, []);
  assert.equal(t.world.tasks.length, 1, 'no idle nap on top');
});

// Deliberate: an occurrence is recorded once its task is accepted, and the task may have started by then.
test('a pause after the task was accepted: the task refused and the occurrence consumed, so only an idle nap comes after the pause', async () => {
  const t = scheduled(scheduleOf(NAP), { requests: 5 });
  assert.equal((await check(t)).schedule, 'nap');
  assert.equal(t.run().scheduleApplied, NAP_ID);
  pauseFor(t);
  assert.deepEqual(await t.controller.nap('demo', { cause: 'schedule', requestedAt: START, until: NAP_END }), { state: 'SKIPPED', reason: 'paused' });
  assert.equal(t.run().state, STATES.AWAKE);
  assert.equal(t.world.vms['vm-a'].status, 'RUNNING');

  await t.controller.resume('demo');
  t.clock.advance(FIVE_MINUTES);
  assert.equal((await check(t)).schedule, undefined);
  assert.equal(t.world.tasks.length, 1, 'the window\'s nap is not asked again');
  assert.equal(t.run().scheduleApplied, NAP_ID);

  t.world.requests = 0;
  assert.equal((await check(t)).nap, 'requested');
  assert.deepEqual(t.world.tasks.at(-1).body, { action: 'nap', workloadId: 'demo' });
});

test('an awake window\'s wake with its task refused: failed, the occurrence unrecorded, the next check wakes it', async () => {
  const t = scheduled(scheduleOf(AWAKE_WINDOW), { run: { state: STATES.ASLEEP, stateAt: START - DAY }, vms: { 'vm-a': { status: 'TERMINATED' } }, map: asleepMap() });
  t.world.taskRefused = new GoogleError('Google: 403 denied', { code: 403 });
  await check(t);
  assert.equal(t.logged('StateChanged').find((l) => l.to === STATES.FAILED).cause, 'invoke-failed');
  assert.equal(t.logged('WakeInvokeFailed').length, 1);
  assert.equal(t.run().scheduleApplied, undefined);
  // Its VMs down, the same check's reconcile leaves it asleep, the failure kept.
  assert.equal(t.run().state, STATES.ASLEEP);
  assert.match(t.run().failure, /denied/);
  t.world.taskRefused = null;
  assert.equal((await check(t)).schedule, 'wake');
  assert.equal(t.run().state, STATES.WAKING);
  assert.equal(t.run().scheduleApplied, NAP_ID);
});

test('maxNapDays fires from stateAt, once past; a wake for maintenance, as a request of its own', async () => {
  const schedule = { maxNapDays: 7, by: 'ops', at: START };
  const early = scheduled(schedule, { run: { state: STATES.ASLEEP, stateAt: START - 7 * DAY + 1000 }, vms: { 'vm-a': { status: 'TERMINATED' } }, map: asleepMap() });
  assert.equal((await check(early)).schedule, undefined);
  assert.equal(early.run().state, STATES.ASLEEP);

  const due = scheduled(schedule, { run: { state: STATES.ASLEEP, stateAt: START - 7 * DAY }, vms: { 'vm-a': { status: 'TERMINATED' } }, map: asleepMap() });
  assert.equal((await check(due)).schedule, 'maintenance');
  assert.equal(due.run().state, STATES.WAKING);
  assert.deepEqual(due.world.tasks.map((task) => task.body.action), ['wake']);
  assert.equal(due.logged('StateChanged').find((l) => l.to === STATES.WAKING).cause, 'maintenance');
  assert.equal(due.store.state.stats['wake:maintenance'], 1);
});

test('the budget gone before the loop: no task asked, the nap put off, and said for a workload the loop did not reach', async () => {
  const world = crowded({ a: scheduleOf(NAP) });
  const { getRun } = world.store;
  // The schedules read the run first: that read takes the whole budget.
  world.store.getRun = async (id) => {
    world.clock.advance(300_000);
    return getRun(id);
  };
  assert.deepEqual(await world.core.check(), [{ workloadId: 'a', schedule: 'nap deferred' }]);
  assert.deepEqual(world.w.tasks, []);
  assert.equal(world.store.runs.get('a').scheduleApplied, undefined);
});

// --- Pauses ------------------------------------------------------------------------------------------------------------

test('a nap asked before a pause is refused at its start: nothing written', async () => {
  const t = setup({ vms: { 'vm-a': { status: 'RUNNING' } } });
  pauseFor(t);
  assert.deepEqual(await t.controller.nap('demo'), { state: 'SKIPPED', reason: 'paused' });
  assert.equal(t.run().state, STATES.AWAKE);
  assert.deepEqual(t.world.calls, []);
  assert.deepEqual(t.logged('NapSkipped').map((l) => l.reason), ['paused']);
});

test('a pause written during the nap\'s wait → back to awake at the commit point, no VM stopped, the policy removed', async () => {
  const t = setup({ vms: { 'vm-a': { status: 'RUNNING' } } });
  t.clock.onSleep(() => pauseFor(t));
  const out = await t.controller.nap('demo');
  assert.deepEqual(out, { state: STATES.AWAKE, aborted: true });
  assert.equal(t.run().state, STATES.AWAKE);
  assert.equal(t.run().awakeSince, t.clock.now());
  assert.equal(t.run().stopping, undefined);
  assert.deepEqual(t.world.calls, ['map policy', 'wait 300 s', 'map no policy']);
  assert.equal(t.logged('StateChanged').find((l) => l.to === STATES.AWAKE).cause, 'paused');
  assert.deepEqual(t.logged('NapAborted').map((l) => l.reason), ['paused']);
  assert.equal(hasPolicy(t.world.map), false);
});

test('unreadable pauses count as a pause, at a nap\'s start and at its commit point', async () => {
  const unreadable = async () => { throw new Error('Google: 503 firestore'); };
  const start = setup({ vms: { 'vm-a': { status: 'RUNNING' } } });
  start.store.getPauses = unreadable;
  assert.deepEqual(await start.controller.nap('demo'), { state: 'SKIPPED', reason: 'paused' });
  assert.equal(start.logged('PausesUnreadable').length, 1);

  const commit = setup({ vms: { 'vm-a': { status: 'RUNNING' } } });
  commit.clock.onSleep(() => { commit.store.getPauses = unreadable; });
  assert.deepEqual(await commit.controller.nap('demo'), { state: STATES.AWAKE, aborted: true });
  assert.equal(commit.world.vms['vm-a'].status, 'RUNNING');
});

test('pauses the check cannot read hold every nap and wake of the check, logged; the reconcile still runs', async () => {
  const napper = scheduled(scheduleOf(NAP), { map: { ...mapOf(), pathMatchers: [{ name: 'm', defaultService: APP_URL }] } });
  napper.store.listPauses = async () => { throw new Error('Google: 503 firestore'); };
  const held = await check(napper);
  assert.equal(held.schedule, 'held by a pause');
  assert.equal(held.paused, true);
  assert.deepEqual(napper.world.tasks, []);
  assert.equal(napper.logged('PausesUnreadable').length, 1);
  assert.equal(hasRoute(napper.world.map), true, 'the route repaired');

  const sleeper = scheduled(scheduleOf(AWAKE_WINDOW), { run: { state: STATES.ASLEEP, stateAt: START - DAY }, vms: { 'vm-a': { status: 'TERMINATED' } }, map: asleepMap() });
  sleeper.store.listPauses = napper.store.listPauses;
  assert.equal((await check(sleeper)).schedule, 'held by a keepAsleep pause');
  assert.equal(sleeper.run().state, STATES.ASLEEP);
});

test('a pause holds the window\'s nap, unrecorded: it applies once the pause is gone', async () => {
  const t = scheduled(scheduleOf(NAP));
  pauseFor(t);
  const out = await check(t);
  assert.equal(out.schedule, 'held by a pause');
  assert.equal(out.paused, true);
  assert.deepEqual(t.world.tasks, []);
  assert.equal(t.run().scheduleApplied, undefined);
  await t.controller.resume('demo');
  assert.equal((await check(t)).schedule, 'nap');
  assert.equal(t.run().scheduleApplied, NAP_ID);
});

test('a pause keeps a workload from its idle nap', async () => {
  const t = setup({ vms: { 'vm-a': { status: 'RUNNING' } } });
  pauseFor(t);
  assert.deepEqual(await check(t), { workloadId: 'demo', state: STATES.AWAKE, paused: true });
  assert.deepEqual(t.world.tasks, []);
  assert.deepEqual(t.world.metricReads, []);
});

test('a paused failed workload is left for its team: no release asked, and a release refused', async () => {
  const t = setup({ run: { state: STATES.FAILED, failedAt: START - DAY }, vms: { 'vm-a': { status: 'RUNNING' } }, unhealthyPolls: 99 });
  pauseFor(t);
  await check(t);
  assert.deepEqual(t.world.tasks, []);
  assert.deepEqual(await t.controller.release('demo'), { state: 'SKIPPED', reason: 'paused' });
  assert.equal(t.world.vms['vm-a'].status, 'RUNNING');
});

test('keepAsleep holds an awake window, unrecorded, until the pause is gone', async () => {
  const t = scheduled(scheduleOf(AWAKE_WINDOW), { run: { state: STATES.ASLEEP, stateAt: START - DAY }, vms: { 'vm-a': { status: 'TERMINATED' } }, map: asleepMap() });
  pauseFor(t, { keepAsleep: true });
  assert.equal((await check(t)).schedule, 'held by a keepAsleep pause');
  assert.equal(t.run().state, STATES.ASLEEP);
  assert.equal(t.run().scheduleApplied, undefined);
  assert.deepEqual(t.world.tasks, []);
  await t.controller.resume('demo');
  assert.equal((await check(t)).schedule, 'wake');
});

test('keepAsleep holds the maintenance wake; a plain pause does not', async () => {
  const asleep = { run: { state: STATES.ASLEEP, stateAt: START - 8 * DAY }, vms: { 'vm-a': { status: 'TERMINATED' } }, map: asleepMap() };
  const kept = scheduled({ maxNapDays: 7, at: START }, asleep);
  pauseFor(kept, { keepAsleep: true });
  assert.equal((await check(kept)).schedule, 'held by a keepAsleep pause');
  assert.equal(kept.run().state, STATES.ASLEEP);
  const plain = scheduled({ maxNapDays: 7, at: START }, asleep);
  pauseFor(plain);
  assert.equal((await check(plain)).schedule, 'maintenance');
});

test('a pause past its until no longer holds, and the check deletes it, unless a newer one replaced it', async () => {
  const t = scheduled(scheduleOf(NAP));
  pauseFor(t, { until: START });
  assert.equal((await check(t)).schedule, 'nap');
  assert.deepEqual(t.store.state.pauses, []);
  assert.deepEqual(t.logged('PauseExpired').map((l) => [l.workloadId, l.by, l.reason]), [['demo', 'ops', 'load test']]);
  assert.deepEqual(await t.controller.pausesFor('demo'), []);

  const kept = setup({ vms: { 'vm-a': { status: 'RUNNING' } } });
  pauseFor(kept, { until: START });
  kept.store.removePauses = async () => false;
  await check(kept);
  assert.deepEqual(kept.logged('PauseExpired'), []);

  const broken = setup({ vms: { 'vm-a': { status: 'RUNNING' } } });
  pauseFor(broken, { until: START });
  broken.store.removePauses = async () => { throw new Error('Google: 503 firestore'); };
  await check(broken);
  assert.equal(broken.logged('PauseDeleteFailed').length, 1);
});

test('a pause with no until goes through the store without one, and never expires', async () => {
  for (const input of [{}, { until: undefined }, { until: null }]) {
    const t = setup({ vms: { 'vm-a': { status: 'RUNNING' } } });
    const { addPause } = t.store;
    const written = [];
    t.store.addPause = (id, pause) => {
      written.push(pause);
      return addPause(id, pause);
    };
    await t.controller.pause('demo', { reason: 'load test', by: 'ops', ...input });
    assert.equal(Object.hasOwn(written[0], 'until'), false, JSON.stringify(input));
    assert.equal(Object.hasOwn(t.store.state.pauses[0], 'until'), false, JSON.stringify(input));
    t.clock.advance(400 * DAY);
    assert.equal((await t.controller.pausesFor('demo')).length, 1, JSON.stringify(input));
    assert.deepEqual(await t.controller.nap('demo'), { state: 'SKIPPED', reason: 'paused' });
  }
});

test('the pause as written and shown: its author, its reason trimmed, keepAsleep only when true, until to its limit', async () => {
  const t = setup({ vms: { 'vm-a': { status: 'RUNNING' } } });
  const until = new Date(START + 366 * DAY).toISOString();
  await t.controller.pause('demo', { reason: '  load test ', by: 'ops', until, keepAsleep: true });
  assert.deepEqual(t.store.state.pauses, [{ workloadId: 'demo', by: 'ops', at: START, reason: 'load test', until: START + 366 * DAY, keepAsleep: true }]);
  assert.deepEqual(await t.controller.pausesFor('demo'), [{ by: 'ops', at: new Date(START).toISOString(), reason: 'load test', until, keepAsleep: true }]);
  assert.deepEqual(t.logged('Paused').map((l) => [l.workloadId, l.by]), [['demo', 'ops']]);
  await t.controller.pause('demo', { reason: 'again' });
  assert.deepEqual(await t.controller.pausesFor('demo'), [{ by: 'unknown', at: new Date(START).toISOString(), reason: 'again', until: null, keepAsleep: false }]);
});

test('a pause refused: no reason, one too long, an until in the past or too far, a keepAsleep that is not a boolean', async () => {
  const t = setup({ vms: { 'vm-a': { status: 'RUNNING' } } });
  for (const [input, message] of [
    [{}, /reason required/],
    [{ reason: '   ' }, /reason required/],
    [{ reason: 7 }, /reason required/],
    [{ reason: 'x'.repeat(257) }, /reason required/],
    [{ reason: 'r', until: new Date(START).toISOString() }, /until must be in the future, within 366 days/],
    [{ reason: 'r', until: START + 366 * DAY + 1 }, /until must be/],
    [{ reason: 'r', until: 'soon' }, /until must be/],
    [{ reason: 'r', keepAsleep: 'true' }, /keepAsleep must be true or false/],
  ]) {
    await assert.rejects(t.controller.pause('demo', input), (err) => err instanceof PauseRefused && message.test(err.message), JSON.stringify(input));
  }
  assert.deepEqual(t.store.state.pauses, []);
});

test('a pause without keepAsleep wakes a sleeper, or a failed one, in a request of its own', async () => {
  for (const state of [STATES.ASLEEP, STATES.FAILED]) {
    const t = setup({ run: { state }, vms: { 'vm-a': { status: 'TERMINATED' } }, map: asleepMap() });
    await t.controller.pause('demo', { reason: 'load test', by: 'ops' });
    assert.equal(t.run().state, STATES.WAKING, state);
    assert.deepEqual(t.world.tasks.map((task) => task.body), [{ action: 'wake', workloadId: 'demo', wakeId: 'wake-2' }]);
    assert.equal(t.logged('StateChanged').find((l) => l.to === STATES.WAKING).cause, 'pause');
    assert.equal(t.store.state.stats['wake:pause'], 1);
  }
});

test('a pause without keepAsleep gives a napping workload its pending wake; awake: nothing to wake', async () => {
  const napping = setup({ run: { state: STATES.NAPPING } });
  await napping.controller.pause('demo', { reason: 'load test' });
  assert.equal(napping.run().pendingWake, true);
  assert.deepEqual(napping.logged('PendingWake').map((l) => l.reason), ['pause']);
  assert.equal(napping.store.state.stats['wake:pause'], 1);
  const awake = setup();
  await awake.controller.pause('demo', { reason: 'load test' });
  assert.equal(awake.run().state, STATES.AWAKE);
  assert.deepEqual(awake.world.tasks, []);
});

test('a pause with keepAsleep leaves a sleeper asleep', async () => {
  const t = setup({ run: { state: STATES.ASLEEP }, vms: { 'vm-a': { status: 'TERMINATED' } }, map: asleepMap() });
  await t.controller.pause('demo', { reason: 'load test', keepAsleep: true });
  assert.equal(t.run().state, STATES.ASLEEP);
  assert.deepEqual(t.world.tasks, []);
});

test('the pause stays when its wake cannot start: logged', async () => {
  const t = setup({ run: { state: STATES.ASLEEP }, vms: { 'vm-a': { status: 'TERMINATED' } }, map: asleepMap() });
  t.store.transition = async () => { throw new Error('Google: 503 firestore'); };
  await t.controller.pause('demo', { reason: 'load test' });
  assert.equal(t.store.state.pauses.length, 1);
  assert.equal(t.logged('PauseWakeFailed').length, 1);
});

test('resume removes the pause, once; the wake it made stays', async () => {
  const t = setup({ run: { state: STATES.ASLEEP }, vms: { 'vm-a': { status: 'TERMINATED' } }, map: asleepMap() });
  await t.controller.pause('demo', { reason: 'load test' });
  await t.controller.resume('demo', 'ops');
  assert.deepEqual(t.store.state.pauses, []);
  assert.equal(t.run().state, STATES.WAKING);
  assert.deepEqual(t.logged('Resumed').map((l) => l.by), ['ops']);
  await t.controller.resume('demo', 'ops');
  assert.equal(t.logged('Resumed').length, 1);
});

// --- IP lists --------------------------------------------------------------------------------------------------------

const LISTS = [{ name: 'scanners', url: 'https://lists.example/scanners.txt', action: 'ignore', refreshHours: 24 }];

test('a check with no list enqueues no refresh', async () => {
  const t = setup({ run: { state: STATES.ASLEEP } });
  await t.controller.check();
  assert.deepEqual(t.world.tasks, []);
});

test('a check enqueues one refreshLists with the due lists, no workload; none due: nothing', async () => {
  const t = setup({ run: { state: STATES.ASLEEP }, lists: LISTS });
  await t.controller.check();
  assert.deepEqual(t.world.tasks, [{ url: `${CONTROLLER}/v1/tasks`, body: { action: 'refreshLists', names: ['scanners'] } }]);
  assert.deepEqual(t.logged('ListRefreshRequested').map((l) => l.names), [['scanners']]);
  const fresh = setup({ run: { state: STATES.ASLEEP }, lists: LISTS });
  await fresh.store.setListMeta('scanners', { url: LISTS[0].url, format: FORMAT, fetchedAt: fresh.clock.now() });
  await fresh.controller.check();
  assert.deepEqual(fresh.world.tasks, []);
});

test('a refused refresh task is logged and the check goes on', async () => {
  const t = setup({ run: AWAKE_LONG, vms: { 'vm-a': { status: 'RUNNING' } }, lists: LISTS });
  t.world.onTask = undefined;
  t.world.taskRefused = new Error('queue down');
  const out = await t.controller.check();
  assert.equal(out[0].workloadId, 'demo');
  assert.equal(t.logged('ListRefreshCheckFailed').length, 1);
});

test('refreshLists downloads the named lists into the store and logs AWS\'s events', async () => {
  const t = setup({ lists: LISTS, download: async () => '1.2.3.4\n10.0.0.1\n' });
  const { results } = await t.controller.refreshLists(['scanners']);
  assert.deepEqual(results, [{ name: 'scanners', entries: 1, dropped: 1 }]);
  assert.equal((await t.store.getListMeta('scanners')).entries, 1);
  assert.equal(t.logged('ListRefreshed').length, 1);
});

test('a list that fails, an s3:// one included, is a list error: logged, stored, no throw', async () => {
  const s3 = [{ name: 'private', url: 's3://bucket/key.txt', action: 'ignore', refreshHours: 24 }];
  const t = setup({ lists: s3 });
  const { results } = await t.controller.refreshLists(['private']);
  assert.match(results[0].error, /S3/);
  assert.equal(t.logged('ListRefreshFailed').length, 1);
  assert.match((await t.store.getListMeta('private')).error, /S3/);
});

test('refreshLists with no list configured does nothing', async () => {
  const t = setup();
  assert.deepEqual(await t.controller.refreshLists(['scanners']), { results: [] });
});

test('a second refreshLists task for a list the first just refreshed downloads nothing', async () => {
  let downloads = 0;
  const t = setup({ lists: LISTS, download: async () => { downloads += 1; return '1.2.3.4\n'; } });
  await t.controller.refreshLists(['scanners']);
  assert.deepEqual(await t.controller.refreshLists(['scanners']), { results: [] });
  assert.equal(downloads, 1);
});

// --- A zonal NEG's VM -----------------------------------------------------------------------------------------------------

test('a zonal NEG\'s VM: healthyCount asks about the NEG, a nap stops the VM, a wake starts it', async () => {
  const neg = `${V1}/zones/${ZONE}/networkEndpointGroups/neg`;
  const { w, core, onboarding } = worldOf((world) => {
    world.negs.neg = { endpoints: ['neg-vm'] };
    world.vms['neg-vm'] = { id: '4001', status: 'RUNNING' };
    world.services.app.backends = [{ group: neg }];
  });
  await onboarding.onboard({ urlMap: 'lb', backendService: 'app', id: 'demo', settings: {} });
  const napped = await core.nap('demo');
  assert.equal(napped.state, STATES.ASLEEP);
  assert.equal(w.vms['neg-vm'].status, 'SUSPENDED');
  assert.ok(w.changes.includes('suspend neg-vm') || w.changes.includes('stop neg-vm'), w.changes.join());
  const wakeId = await core.beginWake('demo', STATES.ASLEEP, 'test');
  const woke = await core.wake('demo', wakeId);
  assert.equal(woke.state, STATES.AWAKE);
  assert.equal(w.vms['neg-vm'].status, 'RUNNING');
  assert.ok(w.healthGroups.length > 0);
  assert.deepEqual([...new Set(w.healthGroups)], [neg]);
});
