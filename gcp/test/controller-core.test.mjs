import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FORMAT } from '../../lambda/src/lib/ip-lists.mjs';
import { STATES } from '../../lambda/src/lib/state.mjs';
import { fakeClock, fakeStore } from '../../lambda/test/fakes.mjs';
import { createController, PauseRefused } from '../src/controller-core.mjs';
import { fromFields, toFields } from '../src/firestore.mjs';
import { GoogleError, OPERATION_NOT_DONE } from '../src/google.mjs';
import { createUrlMaps, withErrorPolicy, withSwap } from '../src/urlmaps.mjs';
import {
  CLUSTER, GKE_INPUT, GKE_NEG, NEG_READINGS, OWNER, classic, onGke, regional as regionalWorld, setup as worldOf,
} from './world.mjs';

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
    // Where the health was read from, the URLs the maps were written at, the other maps a scope's list shows (by its URL) and
    // a NEG's VMs (by its name).
    healthScopes: new Set(),
    mapWrites: new Set(),
    mapLists: {},
    negs: {},
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
  const health = () => {
    if (world.healthRefused) throw world.healthRefused;
    world.healthReads += 1;
    const running = Object.values(world.vms).some((vm) => vm.status === 'RUNNING')
      || Object.values(world.groups).flat().some((m) => m.instanceStatus === 'RUNNING');
    return { healthStatus: [{ healthState: running && world.healthReads > world.unhealthyPolls ? 'HEALTHY' : 'UNHEALTHY' }] };
  };
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
    getBackendService: async () => {
      world.healthScopes.add('global');
      return { backends: [{ group: 'ig-url' }] };
    },
    getBackendServiceHealth: async () => {
      world.healthScopes.add('global');
      return health();
    },
    getRegionBackendService: async (region) => {
      world.healthScopes.add(region);
      return { backends: [{ group: 'ig-url' }] };
    },
    getRegionBackendServiceHealth: async (region) => {
      world.healthScopes.add(region);
      return health();
    },
    listNetworkEndpoints: async (zone, name) => {
      if (!world.negs[name]) throw new GoogleError(`Google: network endpoint group ${name}: 404 not found`, { code: 404 });
      return world.negs[name].map((vm) => ({ networkEndpoint: { instance: vm } }));
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
      if (method === 'GET' && url.endsWith('/urlMaps')) return { items: structuredClone(world.mapLists[url] ?? []) };
      if (method === 'GET') return structuredClone(world.map);
      if (world.conflicts > 0) {
        world.conflicts -= 1;
        throw new GoogleError('Google: PUT: 412 fingerprint', { code: 412 });
      }
      await world.on.put?.();
      world.puts += 1;
      world.map = structuredClone(body);
      world.mapWrites.add(url);
      world.calls.push(world.mapLine?.(body) ?? `map ${hasPolicy(body) ? 'policy' : 'no policy'}`);
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
    regionalUrlmaps: createUrlMaps({ google, project: 'p', region: 'europe-west1', scope: 'regional', now: clock.now, sleep }),
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
    config: { project: 'p', region: 'europe-west1', controllerUrl: CONTROLLER },
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

// --- A regional or classic workload: the swap (the coverage design's section 7) ------------------------------------------

const SWAPS = [
  ['regional', { kind: 'regional', region: 'europe-west1' }, `${V1}/regions/europe-west1`, 100, 'europe-west1'],
  ['classic', { kind: 'classic' }, `${V1}/global`, 250, 'global'],
];

for (const [kind, lb, base, waitSeconds, healthScope] of SWAPS) {
  const service = (name) => `${base}/backendServices/${name}`;
  const WAIT = `wait ${waitSeconds} s`;
  const WAIT_MS = waitSeconds * 1000;
  const awakeMap = () => ({
    name: 'lb',
    fingerprint: 'f1',
    defaultService: service('other'),
    hostRules: [{ hosts: ['demo.example.com'], pathMatcher: 'm' }],
    pathMatchers: [{
      name: 'm',
      defaultService: service('app'),
      pathRules: [{ paths: ['/_dormeto/*'], service: service(WAKER) }, { paths: ['/_dormeto/backend/*'], service: service('app') }],
    }],
  });
  const swappedMap = () => withSwap(awakeMap(), 'app', service(WAKER)).map;
  const isSwapped = (map) => map.pathMatchers[0].defaultService === service(WAKER);
  // `calls` also says the state changes, between what changes the map and the VMs.
  const swapSetup = ({ cfg = {}, vms = { 'vm-a': { status: 'RUNNING' } }, map = awakeMap(), ...rest } = {}) => {
    const t = setup({ cfg: { lb, hibernate: false, ...cfg }, vms, map, ...rest });
    t.world.mapLine = (body) => `map ${isSwapped(body) ? 'swapped' : 'unswapped'}`;
    const { transition } = t.store;
    t.store.transition = async (id, change) => {
      const next = await transition(id, change);
      if (next && change.set?.state) t.world.calls.push(`state ${change.set.state}`);
      return next;
    };
    return t;
  };

  // --- Its nap ---

  test(`${kind} nap: the swap, SWAP_WAIT, the VMs, in that order, at the map's scope`, async () => {
    const t = swapSetup();
    const out = await t.controller.nap('demo');
    assert.equal(out.state, STATES.ASLEEP);
    assert.deepEqual(t.world.calls, [`state ${STATES.NAPPING}`, 'map swapped', WAIT, 'stop vm-a', `state ${STATES.ASLEEP}`]);
    assert.deepEqual(t.world.sleeps.filter((ms) => ms >= MINUTE), [WAIT_MS]);
    assert.deepEqual(t.world.map, { ...swappedMap(), fingerprint: 'f1' });
    assert.deepEqual([...t.world.mapWrites], [`${base}/urlMaps/lb`]);
    assert.deepEqual(t.run().stopped, ['vm-a']);
  });

  test(`${kind} nap: written again after the wait, a lost swap with a fresh wait before the VMs go`, async () => {
    const t = swapSetup();
    let lost = false;
    t.clock.onSleep(() => {
      if (!lost) t.world.map = awakeMap();
      lost = true;
    });
    assert.equal((await t.controller.nap('demo')).state, STATES.ASLEEP);
    assert.deepEqual(t.world.calls, [`state ${STATES.NAPPING}`, 'map swapped', WAIT, 'map swapped', WAIT, 'stop vm-a', `state ${STATES.ASLEEP}`]);
    assert.equal(t.logged('SwapLost').length, 1);
    assert.equal(t.logged('PolicyLost').length, 0);
  });

  test(`${kind} nap: a map of another scope naming the service is no refusal; one of its own scope is`, async () => {
    const own = `${base}/urlMaps`;
    const elsewhere = kind === 'regional' ? `${V1}/global/urlMaps` : `${V1}/regions/europe-west1/urlMaps`;
    const second = { name: 'second', defaultService: service('app') };
    const free = swapSetup();
    free.world.mapLists[elsewhere] = [second];
    assert.equal((await free.controller.nap('demo')).state, STATES.ASLEEP);
    const named = swapSetup();
    named.world.mapLists[own] = [second];
    const out = await named.controller.nap('demo');
    assert.equal(out.aborted, true);
    assert.match(out.error, /also named in URL map second/);
    assert.equal(named.world.vms['vm-a'].status, 'RUNNING');
  });

  // --- An aborted nap: review focus 2. Visitors are at the waker until the application's back has spread. ---

  const ABORTED = [`state ${STATES.NAPPING}`, 'map swapped', WAIT, 'map unswapped', WAIT, `state ${STATES.AWAKE}`];

  const assertBackAwake = (t, out) => {
    assert.equal(out.state, STATES.AWAKE);
    assert.equal(out.aborted, true);
    assert.deepEqual(t.world.calls, ABORTED);
    assert.equal(t.run().state, STATES.AWAKE);
    assert.equal(t.run().awakeSince, t.clock.now());
    assert.equal(t.run().pendingWake, undefined);
    assert.equal(t.run().stopping, undefined);
    assert.equal(t.world.vms['vm-a'].status, 'RUNNING');
    assert.deepEqual(t.world.map, { ...awakeMap(), fingerprint: 'f1' });
    assert.equal(t.logged('NapAborted').length, 1);
  };

  test(`${kind} nap aborted by a wake asked during its wait: unswapped, waited, only then AWAKE`, async () => {
    const t = swapSetup();
    t.clock.onSleep(() => t.store.setPendingWake('demo'));
    assertBackAwake(t, await t.controller.nap('demo'));
    assert.equal(t.logged('StateChanged').find((l) => l.to === STATES.AWAKE).cause, 'pending-wake');
  });

  test(`${kind} nap aborted, and a wake asked during the unswap's wait: part of it, the workload AWAKE`, async () => {
    const t = swapSetup();
    let waits = 0;
    t.clock.onSleep(async () => {
      waits += 1;
      if (waits === 1) await t.controller.pause('demo', { by: 'me', reason: 'why', keepAsleep: true });
      else assert.equal(await t.store.setPendingWake('demo'), true);
    });
    assertBackAwake(t, await t.controller.nap('demo'));
    assert.equal(waits, 2);
  });

  test(`${kind} nap aborted by a pause at the commit point: unswapped, waited, only then AWAKE`, async () => {
    const t = swapSetup();
    let paused = false;
    t.clock.onSleep(async () => {
      if (!paused) await t.controller.pause('demo', { by: 'me', reason: 'why', keepAsleep: true });
      paused = true;
    });
    assertBackAwake(t, await t.controller.nap('demo'));
    assert.equal(t.logged('StateChanged').find((l) => l.to === STATES.AWAKE).cause, 'paused');
  });

  test(`${kind} nap aborted by a map refused at the second write: unswapped, waited, only then AWAKE`, async () => {
    const t = swapSetup();
    t.clock.onSleep(() => {
      if (isSwapped(t.world.map)) t.world.map.tests = [{ host: 'demo.example.com', path: '/', service: service('app') }];
    });
    const out = await t.controller.nap('demo');
    assert.match(out.error, /has tests naming backend service app/);
    assert.equal(t.logged('StateChanged').find((l) => l.to === STATES.AWAKE).cause, 'switch-failed');
    assert.deepEqual(t.world.calls, ABORTED);
    assert.equal(t.run().state, STATES.AWAKE);
    assert.equal(t.world.vms['vm-a'].status, 'RUNNING');
  });

  test(`${kind} nap refused at its first write: nothing to unswap, so no wait, AWAKE at once`, async () => {
    const t = swapSetup({ map: { ...awakeMap(), tests: [{ host: 'demo.example.com', path: '/', service: service('app') }] } });
    const out = await t.controller.nap('demo');
    assert.equal(out.aborted, true);
    assert.deepEqual(t.world.calls, [`state ${STATES.NAPPING}`, `state ${STATES.AWAKE}`]);
    assert.deepEqual(t.world.sleeps, []);
    assert.equal(t.world.puts, 0);
  });

  test(`${kind} nap refused at its first write on a map found swapped: unswapped, waited, only then AWAKE`, async () => {
    const t = swapSetup({ map: { ...swappedMap(), tests: [{ host: 'demo.example.com', path: '/', service: service('app') }] } });
    const out = await t.controller.nap('demo');
    assert.equal(out.aborted, true);
    assert.deepEqual(t.world.calls, [`state ${STATES.NAPPING}`, 'map unswapped', WAIT, `state ${STATES.AWAKE}`]);
  });

  test(`${kind} nap whose swap is lost with no room left: unswapped, waited, AWAKE (swap-lost), within the request`, async () => {
    const t = swapSetup();
    t.clock.onSleep(() => {
      if (t.run().state === STATES.NAPPING && t.world.calls.at(-1)?.startsWith('wait') && isSwapped(t.world.map)) t.world.map = awakeMap();
    });
    let slowed = false;
    t.world.on.put = async () => {
      if (!slowed) t.clock.advance(1_100_000);
      slowed = true;
    };
    const out = await t.controller.nap('demo');
    assert.deepEqual(out, { state: STATES.AWAKE, aborted: true });
    assert.deepEqual(t.world.calls.slice(-3), ['map unswapped', WAIT, `state ${STATES.AWAKE}`]);
    assert.equal(t.logged('StateChanged').find((l) => l.to === STATES.AWAKE).cause, 'swap-lost');
    assert.equal(t.world.vms['vm-a'].status, 'RUNNING');
    assert.ok(t.clock.now() - START < REQUEST_LIMIT - 30_000, `${t.clock.now() - START} ms`);
  });

  test(`${kind} nap of a NEG changed since the onboarding: nothing written, nothing waited for, AWAKE at once`, async () => {
    const t = swapSetup({ cfg: { backends: [{ ...VM_A, neg: { zone: ZONE, name: 'neg' } }] } });
    t.world.negs.neg = ['vm-a', 'late'];
    const out = await t.controller.nap('demo');
    assert.equal(out.aborted, true);
    assert.match(out.error, /VMs added: late/);
    assert.deepEqual(t.world.calls, [`state ${STATES.NAPPING}`, `state ${STATES.AWAKE}`]);
    assert.deepEqual(t.world.sleeps, []);
    assert.equal(t.world.puts, 0);
    assert.equal(t.world.vms['vm-a'].status, 'RUNNING');
    assert.equal(t.logged('StateChanged').find((l) => l.to === STATES.AWAKE).cause, 'backends-changed');
    assert.equal(t.logged('NapAborted').length, 1);
  });

  test(`${kind} nap of a NEG deleted since the onboarding: a change, not a failure, nothing written, nothing waited for`, async () => {
    const t = swapSetup({ cfg: { backends: [{ ...VM_A, neg: { zone: ZONE, name: 'neg' } }] } });
    const out = await t.controller.nap('demo');
    assert.equal(out.state, STATES.AWAKE);
    assert.equal(out.aborted, true);
    assert.match(out.error, /network endpoint group neg no longer exists: offboard and onboard again/);
    assert.deepEqual(t.world.calls, [`state ${STATES.NAPPING}`, `state ${STATES.AWAKE}`]);
    assert.deepEqual(t.world.sleeps, []);
    assert.equal(t.logged('NapFailed').length, 0);
    assert.equal(t.run().failure, undefined);
  });

  test(`${kind} nap of a NEG changed during its wait: the later check still holds: unswapped, waited, only then AWAKE`, async () => {
    const t = swapSetup({ cfg: { backends: [{ ...VM_A, neg: { zone: ZONE, name: 'neg' } }] } });
    t.world.negs.neg = ['vm-a'];
    t.clock.onSleep(() => { t.world.negs.neg = ['vm-a', 'late']; });
    const out = await t.controller.nap('demo');
    assert.match(out.error, /VMs added: late/);
    assert.equal(t.logged('StateChanged').find((l) => l.to === STATES.AWAKE).cause, 'backends-changed');
    assertBackAwake(t, out);
  });

  test(`${kind} nap of a NEG deleted during its wait: the later check reads it as changed too`, async () => {
    const t = swapSetup({ cfg: { backends: [{ ...VM_A, neg: { zone: ZONE, name: 'neg' } }] } });
    t.world.negs.neg = ['vm-a'];
    t.clock.onSleep(() => { delete t.world.negs.neg; });
    const out = await t.controller.nap('demo');
    assert.match(out.error, /network endpoint group neg no longer exists/);
    assertBackAwake(t, out);
  });

  test(`${kind} nap whose abort cannot unswap: FAILED, nothing stopped, the map left as it is`, async () => {
    const t = swapSetup();
    t.clock.onSleep(() => t.store.setPendingWake('demo'));
    t.world.on.put = async () => { if (t.world.puts === 1) throw new GoogleError('Google: PUT: 500 oops', { code: 500 }); };
    const out = await t.controller.nap('demo');
    assert.equal(out.state, STATES.FAILED);
    assert.deepEqual(t.world.calls, [`state ${STATES.NAPPING}`, 'map swapped', WAIT, `state ${STATES.FAILED}`]);
    assert.equal(isSwapped(t.world.map), true);
    assert.equal(t.world.vms['vm-a'].status, 'RUNNING');
    assert.equal(t.logged('NapFailed').length, 1);
  });

  // --- A nap's request that dies: visitors are at the waker until a check finds it. Stuck sooner while nothing is stopped. ---

  const NAPPING_RUN = (age, more = {}) => ({ state: STATES.NAPPING, updatedAt: START - age, ...more });

  test(`${kind} nap dead while swapped: stuck past 15 minutes, not 35, and the recovering wake unswaps`, async () => {
    const at = swapSetup({ run: NAPPING_RUN(15 * MINUTE), map: swappedMap() });
    assert.deepEqual(await at.controller.check(), [{ workloadId: 'demo', state: STATES.NAPPING }]);
    assert.equal(at.logged('NapStuck').length, 0);

    const t = swapSetup({ run: NAPPING_RUN(15 * MINUTE + 1), map: swappedMap() });
    assert.equal((await t.controller.check())[0].state, STATES.FAILED);
    assert.equal(t.logged('NapStuck').length, 1);
    const failure = JSON.parse(t.run().failure);
    assert.equal(failure.kind, 'timeout');
    assert.equal(failure.step, 'nap');
    assert.match(failure.message, /within 15 minutes/);
    assert.equal(t.world.vms['vm-a'].status, 'RUNNING');

    // The next check finds it healthy behind the swap: a wake finishes the job, in a request of its own.
    assert.equal((await t.controller.check())[0].state, STATES.WAKING);
    assert.deepEqual(t.world.tasks.at(-1).body, { action: 'wake', workloadId: 'demo', wakeId: 'wake-2' });
    assert.equal((await t.controller.wake('demo', 'wake-2')).state, STATES.AWAKE);
    assert.deepEqual(t.world.map, { ...awakeMap(), fingerprint: 'f1' });
    assert.equal(t.world.vms['vm-a'].status, 'RUNNING');
  });

  test(`${kind} nap stopping: its VMs are going, 35 minutes as ever`, async () => {
    const within = swapSetup({ run: NAPPING_RUN(35 * MINUTE, { stopping: true }), map: swappedMap() });
    assert.deepEqual(await within.controller.check(), [{ workloadId: 'demo', state: STATES.NAPPING }]);
    const past = swapSetup({ run: NAPPING_RUN(35 * MINUTE + 1, { stopping: true }), map: swappedMap() });
    assert.equal((await past.controller.check())[0].state, STATES.FAILED);
    assert.match(JSON.parse(past.run().failure).message, /within 35 minutes/);
  });

  test(`${kind} slow legal nap: a lost swap and each update at its budget stay under 15 minutes, no check calls it stuck, the VMs stop`, async () => {
    // A map's update at its worst: the operation's 120 s and the pauses of a map busy with another (urlmaps.mjs).
    const update = kind === 'classic' ? 180_000 : 240_000;
    const t = swapSetup();
    t.world.on.put = async () => t.clock.advance(update);
    const seen = [];
    let lost = false;
    t.clock.onSleep(async () => {
      if (!lost) t.world.map = awakeMap();
      else if (!seen.length) seen.push(...(await t.controller.check()));
      lost = true;
    });
    assert.equal((await t.controller.nap('demo')).state, STATES.ASLEEP);
    assert.deepEqual(seen, [{ workloadId: 'demo', state: STATES.NAPPING }]);
    assert.equal(t.logged('NapStuck').length, 0);
    assert.equal(t.world.vms['vm-a'].status, 'TERMINATED');
    assert.ok(t.clock.now() - START < 15 * MINUTE, `${t.clock.now() - START} ms`);
  });

  test(`${kind} nap found stuck during its wait: it writes nothing more, whatever the recovering wake did to the map`, async () => {
    const t = swapSetup();
    t.clock.onSleep(async () => {
      if (t.run().state !== STATES.NAPPING) return;
      t.clock.advance(15 * MINUTE + 1);
      assert.equal((await t.controller.check())[0].state, STATES.FAILED);
      t.world.map = awakeMap();
    });
    const out = await t.controller.nap('demo');
    assert.deepEqual(out, { state: 'SUPERSEDED' });
    assert.deepEqual(t.world.calls, [`state ${STATES.NAPPING}`, 'map swapped', WAIT, `state ${STATES.FAILED}`]);
    assert.equal(isSwapped(t.world.map), false);
    assert.equal(t.world.vms['vm-a'].status, 'RUNNING');
    assert.equal(t.logged('NapSuperseded').length, 1);
    assert.equal(t.logged('NapAborted').length, 0);
  });

  test(`${kind} nap found stuck during its first write: no wait, nothing more`, async () => {
    const t = swapSetup();
    t.world.on.put = async () => {
      t.clock.advance(15 * MINUTE + 1);
      await t.controller.check();
    };
    assert.deepEqual(await t.controller.nap('demo'), { state: 'SUPERSEDED' });
    assert.deepEqual(t.world.sleeps, []);
    assert.equal(t.world.puts, 1);
  });

  test(`${kind} nap found stuck just before its commit: no unswap of its own, the VMs left, the wake's to do`, async () => {
    const t = swapSetup();
    const { getPauses } = t.store;
    let reads = 0;
    t.store.getPauses = async (...args) => {
      reads += 1;
      if (reads === 2) {
        t.clock.advance(15 * MINUTE + 1);
        await t.controller.check();
      }
      return getPauses(...args);
    };
    assert.deepEqual(await t.controller.nap('demo'), { state: 'SUPERSEDED' });
    assert.equal(reads, 2);
    assert.equal(t.run().state, STATES.FAILED);
    assert.equal(t.run().stopping, undefined);
    assert.equal(t.world.vms['vm-a'].status, 'RUNNING');
    assert.equal(t.world.puts, 1);
    assert.equal(isSwapped(t.world.map), true);
  });

  test(`${kind} nap found stuck during its abort's wait: not called awake, no second word on it`, async () => {
    const t = swapSetup();
    let waits = 0;
    t.clock.onSleep(async () => {
      waits += 1;
      if (waits === 1) await t.store.setPendingWake('demo');
      if (waits === 2) {
        t.clock.advance(15 * MINUTE + 1);
        await t.controller.check();
      }
    });
    assert.deepEqual(await t.controller.nap('demo'), { state: 'SUPERSEDED' });
    assert.equal(t.run().state, STATES.FAILED);
    assert.equal(t.logged('NapAborted').length, 0);
  });

  test(`${kind} a nap's task delivered late, the state changed: it writes nothing`, async () => {
    for (const state of [STATES.FAILED, STATES.WAKING, STATES.ASLEEP]) {
      const t = swapSetup({ run: { state, wakeId: 'w1', failedAt: START }, map: swappedMap() });
      assert.equal((await t.controller.nap('demo')).state, 'SKIPPED', state);
      assert.deepEqual(t.world.calls, [], state);
    }
    // Woken again since the task was asked for: it was idle then, it says nothing of now.
    const t = swapSetup({ run: { state: STATES.AWAKE, awakeSince: START - MINUTE } });
    const out = await t.controller.nap('demo', { requestedAt: START - 30 * MINUTE });
    assert.deepEqual(out, { state: 'SKIPPED', reason: 'woken since it was requested' });
    assert.deepEqual(t.world.calls, []);
    assert.equal(t.run().state, STATES.AWAKE);
  });

  // --- Its wake ---

  test(`${kind} wake: started, healthy, unswapped, SWAP_WAIT, AWAKE with it in its duration; the map as before the nap`, async () => {
    const t = swapSetup({ run: waking(START - 5000), vms: { 'vm-a': { status: 'TERMINATED' } }, map: swappedMap(), unhealthyPolls: 2 });
    let readsAtUnswap;
    t.world.on.put = async () => { readsAtUnswap = t.world.healthReads; };
    const out = await t.controller.wake('demo', 'w1');
    assert.equal(out.state, STATES.AWAKE);
    assert.deepEqual(t.world.calls, ['start vm-a', 'map unswapped', WAIT, `state ${STATES.AWAKE}`]);
    assert.deepEqual(t.world.sleeps, [2000, 2000, WAIT_MS]);
    assert.equal(readsAtUnswap, 3);
    assert.equal(out.durationMs, 9000 + WAIT_MS);
    assert.deepEqual(t.run().lastWake, { durationMs: 9000 + WAIT_MS });
    assert.equal(t.run().awakeSince, t.clock.now());
    assert.deepEqual(t.world.map, { ...awakeMap(), fingerprint: 'f1' });
    assert.deepEqual([...t.world.mapWrites], [`${base}/urlMaps/lb`]);
    assert.deepEqual([...t.world.healthScopes], [healthScope]);
    assert.equal(t.logged('WakeCompleted').length, 1);
  });

  test(`${kind} wake: an unswap that fails is a failed wake, the map left as it is; the next check finishes the job`, async () => {
    const t = swapSetup({ run: waking(START), map: swappedMap() });
    t.world.on.put = async () => { throw new GoogleError('Google: PUT: 500 oops', { code: 500 }); };
    const out = await t.controller.wake('demo', 'w1');
    assert.equal(out.state, STATES.FAILED);
    assert.equal(t.run().state, STATES.FAILED);
    assert.equal(JSON.parse(t.run().failure).step, 'wake');
    assert.equal(isSwapped(t.world.map), true);
    assert.deepEqual(t.world.sleeps, []);
    assert.equal(t.logged('WakeFailed').length, 1);
    delete t.world.on.put;
    await t.controller.check();
    assert.equal(t.run().state, STATES.WAKING);
    await t.controller.wake('demo', 'wake-2');
    assert.equal(t.run().state, STATES.AWAKE);
    assert.equal(isSwapped(t.world.map), false);
    assert.equal(t.run().failure, undefined);
  });

  // A VM that cannot start must not keep visitors at the waker while another serves: under a swap, a wake is the only way out of FAILED.
  const REFUSED_START = () => new GoogleError('Google: POST: 503 unavailable', { code: 503 });
  const oneRefused = (more = {}) => {
    const t = swapSetup({ cfg: { backends: [VM_A, VM_B] }, vms: { 'vm-a': { status: 'RUNNING' }, 'vm-b': { status: 'TERMINATED' } }, map: swappedMap(), ...more });
    t.world.on['start vm-b'] = async () => { throw REFUSED_START(); };
    return t;
  };

  test(`${kind} wake: a VM that cannot start while another is healthy: logged, unswapped, waited, AWAKE, and the checks leave it so`, async () => {
    const t = oneRefused({ run: { state: STATES.FAILED, failedAt: START, consecutiveFailures: 3, failure: JSON.stringify({ kind: 'unknown' }) } });
    assert.equal((await t.controller.check())[0].state, STATES.WAKING);
    t.world.calls.length = 0;
    const out = await t.controller.wake('demo', 'wake-2');
    assert.equal(out.state, STATES.AWAKE);
    assert.deepEqual(t.world.calls, ['start vm-b', 'map unswapped', WAIT, `state ${STATES.AWAKE}`]);
    assert.equal(t.logged('BackendsNotWoken').length, 1);
    assert.match(t.logged('BackendsNotWoken')[0].error, /503/);
    assert.equal(t.logged('WakeFailed').length, 0);
    assert.equal(t.run().failure, undefined);
    assert.equal(t.run().consecutiveFailures, undefined);
    assert.equal(t.run().wakeCount, 1);
    assert.equal(isSwapped(t.world.map), false);

    t.world.calls.length = 0;
    t.clock.advance(MINUTE);
    assert.equal((await t.controller.check())[0].state, STATES.AWAKE);
    assert.deepEqual(t.world.calls, []);
    assert.equal(t.world.tasks.length, 1);
    assert.equal(t.run().wakeCount, 1);
  });

  test(`${kind} wake: a VM that cannot start with none healthy: FAILED with its error, the map left as it is, no wait`, async () => {
    const t = swapSetup({ run: waking(START), vms: { 'vm-a': { status: 'TERMINATED' } }, map: swappedMap() });
    t.world.on['start vm-a'] = async () => { throw REFUSED_START(); };
    const out = await t.controller.wake('demo', 'w1');
    assert.equal(out.state, STATES.FAILED);
    assert.match(out.error, /503 unavailable/);
    assert.equal(t.world.puts, 0);
    assert.deepEqual(t.world.sleeps, []);
    assert.equal(t.logged('BackendsNotWoken').length, 0);
  });

  test(`${kind} wake: a VM that cannot start and a health that cannot be read: FAILED with the VM's error`, async () => {
    const t = oneRefused({ run: waking(START) });
    t.world.healthRefused = new GoogleError('Google: POST: 500 health', { code: 500 });
    const out = await t.controller.wake('demo', 'w1');
    assert.equal(out.state, STATES.FAILED);
    assert.match(out.error, /503 unavailable/);
    assert.equal(t.world.puts, 0);
  });

  test(`${kind} wake: a VM that cannot start, the autoscaler's mode given back all the same, its record gone`, async () => {
    const t = oneRefused({ run: waking(START, { autoscalers: [{ kind: 'zonal', location: ZONE, name: 'mig', mode: 'ON' }] }), autoscalers: { mig: 'OFF' } });
    assert.equal((await t.controller.wake('demo', 'w1')).state, STATES.AWAKE);
    assert.equal(t.world.autoscalers.mig, 'ON');
    assert.equal(t.run().autoscalers, undefined);
  });

  test(`${kind} wake: a mode that cannot be given back with a VM healthy: AWAKE, the record kept, a later check gives it back`, async () => {
    const t = swapSetup({ run: waking(START, { autoscalers: [{ kind: 'zonal', location: ZONE, name: 'mig', mode: 'ON' }] }), autoscalers: { mig: 'OFF' }, map: swappedMap() });
    t.world.on['autoscaler mig ON'] = async () => { throw REFUSED_START(); };
    assert.equal((await t.controller.wake('demo', 'w1')).state, STATES.AWAKE);
    assert.deepEqual(t.run().autoscalers, [{ kind: 'zonal', location: ZONE, name: 'mig', mode: 'ON' }]);
    assert.equal(t.logged('AutoscalersNotGivenBack').length, 1);
    delete t.world.on['autoscaler mig ON'];
    await t.controller.check();
    assert.equal(t.world.autoscalers.mig, 'ON');
    assert.equal(t.run().autoscalers, undefined);
  });

  test(`${kind} wake: a map that keeps changing is a failed wake, throttled`, async () => {
    const t = swapSetup({ run: waking(START), map: swappedMap() });
    t.world.conflicts = 100;
    await t.controller.wake('demo', 'w1');
    assert.equal(JSON.parse(t.run().failure).kind, 'throttled');
  });

  test(`${kind} wake: superseded while it waited for health, it does not unswap`, async () => {
    const t = swapSetup({ run: waking(START), vms: { 'vm-a': { status: 'TERMINATED' } }, map: swappedMap(), unhealthyPolls: 2 });
    t.clock.onSleep(() => { t.run().wakeId = 'other'; });
    assert.deepEqual(await t.controller.wake('demo', 'w1'), { state: 'SUPERSEDED' });
    assert.equal(t.world.puts, 0);
    assert.equal(t.logged('WakeSuperseded').length, 1);
  });

  test(`${kind} wake: superseded during its wait, it does not write AWAKE`, async () => {
    const t = swapSetup({ run: waking(START), map: swappedMap() });
    t.clock.onSleep(() => { t.run().wakeId = 'other'; });
    assert.deepEqual(await t.controller.wake('demo', 'w1'), { state: 'SUPERSEDED' });
    assert.equal(t.run().state, STATES.WAKING);
  });

  test(`${kind} wake: healthy past the deadline, nothing unswapped: FAILED with the kind timeout`, async () => {
    const t = swapSetup({ run: waking(START - 600_000), map: swappedMap() });
    await t.controller.wake('demo', 'w1');
    assert.equal(t.run().state, STATES.FAILED);
    assert.equal(JSON.parse(t.run().failure).kind, 'timeout');
    assert.equal(t.world.puts, 0);
    assert.equal(isSwapped(t.world.map), true);
  });

  test(`${kind} wake: SWAP_WAIT counts in wakeTimeoutSeconds; past it after the wait, not cut short, FAILED; the next check finishes the job`, async () => {
    const t = swapSetup({ run: waking(START - 600_000 + WAIT_MS - 1000), map: swappedMap() });
    await t.controller.wake('demo', 'w1');
    assert.equal(t.clock.now(), START + WAIT_MS);
    assert.equal(t.run().state, STATES.FAILED);
    assert.equal(JSON.parse(t.run().failure).kind, 'timeout');
    assert.equal(isSwapped(t.world.map), false);
    await t.controller.check();
    assert.equal(t.run().state, STATES.WAKING);
    await t.controller.wake('demo', 'wake-2');
    assert.equal(t.run().state, STATES.AWAKE);
  });

  test(`${kind} wake: done just within wakeTimeoutSeconds, SWAP_WAIT in it`, async () => {
    const t = swapSetup({ run: waking(START - 600_000 + WAIT_MS + 1), map: swappedMap() });
    assert.equal((await t.controller.wake('demo', 'w1')).state, STATES.AWAKE);
  });

  test(`${kind} wake: the longest timeout still fits the request, with SWAP_WAIT in it`, async () => {
    const polls = (ms) => ms / 2000;
    const slow = swapSetup({ run: waking(START), cfg: { wakeTimeoutSeconds: 1700 }, vms: { 'vm-a': { status: 'TERMINATED' } }, map: swappedMap(), unhealthyPolls: polls(1_400_000) });
    assert.equal((await slow.controller.wake('demo', 'w1')).state, STATES.AWAKE);
    assert.ok(slow.clock.now() - START < REQUEST_LIMIT - 30_000, `${slow.clock.now() - START} ms`);
    const late = swapSetup({ run: waking(START), cfg: { wakeTimeoutSeconds: 1700 }, vms: { 'vm-a': { status: 'TERMINATED' } }, map: swappedMap(), unhealthyPolls: polls(1_690_000) });
    assert.equal((await late.controller.wake('demo', 'w1')).state, STATES.FAILED);
    assert.equal(late.world.puts, 0);
    assert.equal(JSON.parse(late.run().failure).kind, 'timeout');
  });

  test(`${kind} wake: in its wait past the timeout, it is not called stuck; past the wait too, it is`, async () => {
    const age = 600_000 + 60_000 + WAIT_MS;
    const within = swapSetup({ run: waking(START - age), map: swappedMap() });
    assert.deepEqual(await within.controller.check(), [{ workloadId: 'demo', state: STATES.WAKING }]);
    const stuck = swapSetup({ run: waking(START - age - 1), map: swappedMap() });
    assert.equal((await stuck.controller.check())[0].state, STATES.FAILED);
    assert.equal(stuck.logged('WakeStuck').length, 1);
  });

  // --- The release ---

  test(`${kind} release: the swap written, SWAP_WAIT, the VMs, ASLEEP; a swap already there is not waited for`, async () => {
    const failed = { state: STATES.FAILED, failedAt: 1, failure: JSON.stringify({ kind: 'unhealthy' }) };
    const fresh = swapSetup({ run: failed });
    assert.equal((await fresh.controller.release('demo')).state, STATES.ASLEEP);
    assert.deepEqual(fresh.world.calls, ['map swapped', WAIT, 'stop vm-a', `state ${STATES.ASLEEP}`]);
    const there = swapSetup({ run: failed, map: swappedMap() });
    assert.equal((await there.controller.release('demo')).state, STATES.ASLEEP);
    assert.deepEqual(there.world.calls, ['stop vm-a', `state ${STATES.ASLEEP}`]);
  });

  // --- The check ---

  test(`${kind} check: the idle signal read by kind, an idle workload's nap asked; the map as it should be, nothing written`, async () => {
    const t = swapSetup({ run: { state: STATES.AWAKE, awakeSince: 1 } });
    assert.deepEqual(await t.controller.check(), [{ workloadId: 'demo', state: STATES.AWAKE, nap: 'requested' }]);
    assert.deepEqual(t.world.metricReads.map((read) => read.lb), [lb]);
    assert.deepEqual(t.world.calls, []);
    assert.equal(t.logged('RouteDrift').length, 0);
  });

  test(`${kind} repair, awake and swapped: unswapped, RouteDrift, no wait`, async () => {
    const t = swapSetup({ run: { state: STATES.AWAKE, awakeSince: START }, map: swappedMap() });
    await t.controller.check();
    assert.deepEqual(t.world.calls, ['map unswapped']);
    assert.deepEqual(t.world.sleeps, []);
    assert.deepEqual(t.world.map, { ...awakeMap(), fingerprint: 'f1' });
    assert.equal(t.logged('RouteDrift').length, 1);
    assert.equal(t.logged('RouteDrift')[0].state, STATES.AWAKE);
    assert.equal(t.run().state, STATES.AWAKE);
  });

  test(`${kind} repair, asleep and unswapped: swapped, RouteDrift, no wait`, async () => {
    const t = swapSetup({ run: { state: STATES.ASLEEP }, vms: { 'vm-a': { status: 'TERMINATED' } } });
    await t.controller.check();
    assert.deepEqual(t.world.calls, ['map swapped']);
    assert.deepEqual(t.world.sleeps, []);
    assert.equal(t.logged('RouteDrift')[0].state, STATES.ASLEEP);
  });

  test(`${kind} repair, failed and not healthy: swapped, as asleep`, async () => {
    const t = swapSetup({ run: { state: STATES.FAILED, failedAt: START }, unhealthyPolls: Infinity });
    await t.controller.check();
    assert.deepEqual(t.world.calls, ['map swapped']);
    assert.equal(t.run().state, STATES.FAILED);
  });

  test(`${kind} repair: the two routes lost come back in the same update, awake or swapped`, async () => {
    const bare = awakeMap();
    delete bare.pathMatchers[0].pathRules;
    const awake = swapSetup({ run: { state: STATES.AWAKE, awakeSince: START }, map: bare });
    await awake.controller.check();
    assert.equal(awake.world.puts, 1);
    const byPath = (map) => map.pathMatchers[0].pathRules.toSorted((a, b) => a.paths[0].localeCompare(b.paths[0]));
    assert.deepEqual(byPath(awake.world.map), byPath(awakeMap()));
    assert.deepEqual(awake.logged('RouteDrift')[0].paths.length, 2);

    const swapped = swappedMap();
    delete swapped.pathMatchers[0].pathRules;
    const asleep = swapSetup({ run: { state: STATES.ASLEEP }, vms: { 'vm-a': { status: 'TERMINATED' } }, map: swapped });
    await asleep.controller.check();
    assert.equal(asleep.world.puts, 1);
    assert.deepEqual(byPath(asleep.world.map), byPath(awakeMap()));
    assert.equal(isSwapped(asleep.world.map), true);
  });

  test(`${kind} repair: as the state wants it, nothing written`, async () => {
    const asleep = swapSetup({ run: { state: STATES.ASLEEP }, vms: { 'vm-a': { status: 'TERMINATED' } }, map: swappedMap() });
    await asleep.controller.check();
    assert.equal(asleep.world.puts, 0);
    assert.equal(asleep.logged('RouteDrift').length, 0);
  });

  test(`${kind} external stop: the swap with no wait, ASLEEP (external-stop)`, async () => {
    const t = swapSetup({ run: { state: STATES.AWAKE, awakeSince: START }, vms: { 'vm-a': { status: 'TERMINATED' } } });
    assert.deepEqual(await t.controller.check(), [{ workloadId: 'demo', state: STATES.ASLEEP }]);
    assert.deepEqual(t.world.calls, ['map swapped', `state ${STATES.ASLEEP}`]);
    assert.deepEqual(t.world.sleeps, []);
    assert.equal(t.logged('ExternalStop').length, 1);
    assert.equal(t.logged('StateChanged')[0].cause, 'external-stop');
  });

  for (const [from, cause, event] of [[STATES.ASLEEP, 'external-start', 'ExternalWake'], [STATES.FAILED, 'recovered', 'FailedRecovered']]) {
    test(`${kind} external start, from ${from}: WAKING with a task, no wait in the check; the task unswaps, waits, AWAKE`, async () => {
      const t = swapSetup({ run: { state: from, failedAt: START, failure: JSON.stringify({ kind: 'unhealthy' }), consecutiveFailures: 1 }, map: swappedMap() });
      assert.deepEqual(await t.controller.check(), [{ workloadId: 'demo', state: STATES.WAKING }]);
      assert.deepEqual(t.world.calls, [`state ${STATES.WAKING}`]);
      assert.deepEqual(t.world.sleeps, []);
      assert.equal(t.clock.now(), START);
      assert.equal(isSwapped(t.world.map), true);
      assert.equal(t.logged(event).length, 1);
      assert.equal(t.logged('StateChanged')[0].cause, cause);
      assert.deepEqual(t.world.tasks, [{ url: `${CONTROLLER}/v1/tasks`, body: { action: 'wake', workloadId: 'demo', wakeId: 'wake-2' } }]);

      t.world.calls.length = 0;
      assert.equal((await t.controller.wake('demo', 'wake-2')).state, STATES.AWAKE);
      assert.deepEqual(t.world.calls, ['map unswapped', WAIT, `state ${STATES.AWAKE}`]);
      assert.equal(t.run().failure, undefined);
      assert.equal(t.run().consecutiveFailures, undefined);
    });
  }

  test(`${kind} external start with its task refused: FAILED (invoke-failed), the next check asks again`, async () => {
    const t = swapSetup({ run: { state: STATES.ASLEEP }, map: swappedMap() });
    t.world.taskRefused = new GoogleError('Google: POST: 503 tasks', { code: 503 });
    assert.equal((await t.controller.check())[0].state, STATES.FAILED);
    assert.deepEqual(t.world.sleeps, []);
    assert.equal(t.logged('WakeInvokeFailed').length, 1);
    delete t.world.taskRefused;
    assert.equal((await t.controller.check())[0].state, STATES.WAKING);
  });

  test(`${kind} external start, a VM running but not healthy yet: still asleep, its swap kept`, async () => {
    const t = swapSetup({ run: { state: STATES.ASLEEP }, map: swappedMap(), unhealthyPolls: Infinity });
    assert.deepEqual(await t.controller.check(), [{ workloadId: 'demo', state: STATES.ASLEEP }]);
    assert.deepEqual(t.world.calls, []);
  });
}

test('under the policy, a VM that cannot start with another healthy stays a failed wake, as in G1', async () => {
  const t = setup({ run: waking(START), cfg: { backends: [VM_A, VM_B] }, vms: { 'vm-a': { status: 'RUNNING' }, 'vm-b': { status: 'TERMINATED' } }, map: asleepMap() });
  t.world.on['start vm-b'] = async () => { throw new GoogleError('Google: POST: 503 unavailable', { code: 503 }); };
  assert.equal((await t.controller.wake('demo', 'w1')).state, STATES.FAILED);
  assert.equal(t.world.healthReads, 0);
  assert.equal(hasPolicy(t.world.map), true);
  assert.equal(t.logged('BackendsNotWoken').length, 0);
});

test('lb: { kind: \'global\' } is the policy, as no lb is', async () => {
  const t = setup({ vms: { 'vm-a': { status: 'RUNNING' } }, cfg: { hibernate: false, lb: { kind: 'global' } } });
  assert.equal((await t.controller.nap('demo')).state, STATES.ASLEEP);
  assert.deepEqual(t.world.calls, ['map policy', 'wait 300 s', 'stop vm-a']);
  assert.deepEqual([...t.world.mapWrites], [`${V1}/global/urlMaps/lb`]);
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
  assert.deepEqual(t.world.tasks, [{ url: `${CONTROLLER}/v1/tasks`, body: { action: 'nap', workloadId: 'demo', requestedAt: t.clock.now() } }]);
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

test('a policy\'s nap keeps 35 minutes, stopping or not: nothing sends visitors elsewhere while it runs', async () => {
  const within = setup({ run: { state: STATES.NAPPING, updatedAt: START - 35 * MINUTE }, vms: { 'vm-a': { status: 'RUNNING' } }, map: asleepMap() });
  assert.deepEqual(await within.controller.check(), [{ workloadId: 'demo', state: STATES.NAPPING }]);
  assert.equal(within.logged('NapStuck').length, 0);
  const past = setup({ run: { state: STATES.NAPPING, updatedAt: START - 35 * MINUTE - 1 }, vms: { 'vm-a': { status: 'RUNNING' } }, map: asleepMap() });
  assert.equal((await past.controller.check())[0].state, STATES.FAILED);
  assert.match(JSON.parse(past.run().failure).message, /within 35 minutes/);
});

test('a policy\'s nap whose run moved on during its wait: it stops there, its policy left as the new state wants it', async () => {
  const t = setup({ vms: { 'vm-a': { status: 'RUNNING' } } });
  t.clock.onSleep(() => { t.run().state = STATES.FAILED; });
  assert.deepEqual(await t.controller.nap('demo'), { state: 'SUPERSEDED' });
  assert.equal(hasPolicy(t.world.map), true);
  assert.equal(t.world.vms['vm-a'].status, 'RUNNING');
  assert.equal(t.logged('NapAborted').length, 0);
});

test('an idle nap\'s and an operator\'s task say when they were asked for, so a late delivery can tell', async () => {
  const idle = setup({ vms: { 'vm-a': { status: 'RUNNING' } }, run: { state: STATES.AWAKE, awakeSince: START - DAY } });
  await idle.controller.check();
  assert.deepEqual(idle.world.tasks.map((task) => task.body), [{ action: 'nap', workloadId: 'demo', requestedAt: START }]);
  const operator = setup({ vms: { 'vm-a': { status: 'RUNNING' } } });
  await operator.controller.napNow('demo');
  assert.deepEqual(operator.world.tasks.map((task) => task.body), [{ action: 'nap', workloadId: 'demo', requestedAt: START }]);
  // Delivered in time, it naps.
  assert.equal((await operator.controller.nap('demo', { requestedAt: START })).state, STATES.ASLEEP);
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
  assert.deepEqual(t.world.tasks.map((task) => task.body), [{ action: 'nap', workloadId: 'demo', requestedAt: t.clock.now() }]);
});

// Twelve workloads on the same URL map, their VMs read through the world.
function crowded(schedules) {
  const world = worldOf((w) => { w.services[WAKER] = { name: WAKER, backends: [] }; });
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
  assert.deepEqual(t.world.tasks.at(-1).body, { action: 'nap', workloadId: 'demo', requestedAt: t.clock.now() });
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

const NEG_URL = `${V1}/zones/${ZONE}/networkEndpointGroups/neg`;
// An onboarded workload whose one backend is the zonal NEG `neg` of `neg-vm` (and `more`).
async function negWorkload(more = []) {
  const t = worldOf((world) => {
    world.negs.neg = { endpoints: ['neg-vm', ...more] };
    world.vms['neg-vm'] = { id: '4001', status: 'RUNNING' };
    for (const name of more) world.vms[name] = { id: '4002', status: 'RUNNING' };
    world.services.app.backends = [{ group: NEG_URL }];
  });
  await t.onboarding.onboard({ urlMap: 'lb', backendService: 'app', id: 'demo', settings: { hibernate: false } });
  return t;
}
const inMap = (t) => JSON.stringify(t.w.urlMaps.lb).includes('defaultCustomErrorResponsePolicy');

test('a zonal NEG\'s VM: a nap stops it, a wake starts it, and the health is the NEG\'s', async () => {
  const { w, core } = await negWorkload();
  assert.equal((await core.nap('demo')).state, STATES.ASLEEP);
  assert.equal(w.vms['neg-vm'].status, 'TERMINATED');
  assert.ok(w.changes.includes('stop neg-vm'), w.changes.join());
  w.healthGroups.length = 0;
  const woke = await core.wake('demo', await core.beginWake('demo', STATES.ASLEEP, 'test'));
  assert.equal(woke.state, STATES.AWAKE);
  assert.equal(w.vms['neg-vm'].status, 'RUNNING');
  assert.ok(w.changes.includes('start neg-vm'), w.changes.join());
  assert.ok(w.healthGroups.length > 0);
  assert.deepEqual([...new Set(w.healthGroups)], [NEG_URL]);
});

test('healthyCount by NEG: the NEG\'s own VMs decide, not other VMs of the project', async () => {
  const t = await negWorkload();
  t.w.vms['other-vm'] = { id: '9', status: 'RUNNING' };
  // Asleep, the other VM still running: any VM of the project would make the count 1, only the NEG's own does it after the start.
  assert.equal((await t.core.nap('demo')).state, STATES.ASLEEP);
  t.w.healthGroups.length = 0;
  const woke = await t.core.wake('demo', await t.core.beginWake('demo', STATES.ASLEEP, 'test'));
  assert.equal(woke.state, STATES.AWAKE);
  assert.equal(t.w.vms['neg-vm'].status, 'RUNNING');
});

const CHANGED = [
  ['a VM added to the NEG', (w) => { w.negs.neg.endpoints.push('late-vm'); w.vms['late-vm'] = { id: '5', status: 'RUNNING' }; }, /VMs added: late-vm/],
  ['a VM taken out of the NEG', (w) => { w.negs.neg.endpoints = ['neg-vm-2']; }, /VMs removed: neg-vm\b/],
];
for (const [name, change, reason] of CHANGED) {
  test(`a nap stops nothing after ${name}: awake again (backends-changed), NapAborted, the policy removed`, async () => {
    const t = await negWorkload(['neg-vm-2']);
    change(t.w);
    const out = await t.core.nap('demo');
    assert.equal(out.state, STATES.AWAKE);
    assert.equal(out.aborted, true);
    assert.match(out.error, reason);
    assert.match(out.error, /offboard and onboard again/);
    assert.equal(t.w.changes.some((c) => c.startsWith('stop') || c.startsWith('suspend')), false);
    assert.equal(inMap(t), false);
    assert.equal((await t.store.getRun('demo')).state, STATES.AWAKE);
    const aborted = t.w.logs.find((l) => l.event === 'NapAborted');
    assert.match(aborted.reason, reason);
  });
}

test('a nap of a NEG deleted: no stop, AWAKE with a warning, the release stays FAILED, each saying what to do', async () => {
  const t = await negWorkload();
  delete t.w.negs.neg;
  t.w.changes.length = 0;
  const out = await t.core.nap('demo');
  assert.equal(out.state, STATES.AWAKE);
  assert.equal(out.aborted, true);
  assert.match(out.error, /network endpoint group neg no longer exists: offboard and onboard again/);
  assert.equal(t.w.changes.some((c) => c.startsWith('stop') || c.startsWith('map')), false);
  assert.equal((await t.store.getRun('demo')).state, STATES.AWAKE);

  t.store.runs.get('demo').state = STATES.FAILED;
  const released = await t.core.release('demo');
  assert.equal(released.state, STATES.FAILED);
  assert.match(released.error, /no longer exists/);
  assert.equal(t.w.changes.some((c) => c.startsWith('stop')), false);
});

test('a NEG\'s endpoint with no VM: said by its address, not as an empty name among the VMs added', async () => {
  const t = await negWorkload();
  t.w.negs.neg.endpoints.push({ ipAddress: '10.0.0.9', port: 80 });
  const out = await t.core.nap('demo');
  assert.equal(out.aborted, true);
  assert.doesNotMatch(out.error, /VMs added/);
  assert.match(out.error, /network endpoint group neg changed since the onboarding \(an endpoint with no VM: 10\.0\.0\.9\): offboard and onboard again/);
});

test('the fake: listNetworkEndpoints on a NEG that is not there, or not in that zone, is a 404', async () => {
  const t = await negWorkload();
  await assert.rejects(t.compute.listNetworkEndpoints('europe-west1-c', 'neg'), (err) => err.code === 404);
  delete t.w.negs.neg;
  await assert.rejects(t.compute.listNetworkEndpoints(ZONE, 'neg'), (err) => err.code === 404);
});

test('a NEG read that fails during the nap is a nap failure, never "no change"', async () => {
  const t = await negWorkload();
  t.w.fail[`POST zones/${ZONE}/networkEndpointGroups/neg/listNetworkEndpoints`] = new GoogleError('Google: 503', { code: 503 });
  const out = await t.core.nap('demo');
  assert.equal(out.state, STATES.FAILED);
  assert.equal(t.w.changes.some((c) => c.startsWith('stop')), false);
});

test('release stops nothing of a NEG that changed: the workload stays FAILED', async () => {
  const t = await negWorkload();
  t.store.runs.get('demo').state = STATES.FAILED;
  t.w.negs.neg.endpoints.push('late-vm');
  t.w.vms['late-vm'] = { id: '5', status: 'RUNNING' };
  const out = await t.core.release('demo');
  assert.equal(out.state, STATES.FAILED);
  assert.match(out.error, /VMs added: late-vm/);
  assert.equal(t.w.changes.some((c) => c.startsWith('stop')), false);
});

test('a wake starts what is recorded, whatever the NEG holds by then', async () => {
  const t = await negWorkload();
  await t.core.nap('demo');
  t.w.negs.neg.endpoints = ['other-vm'];
  t.w.vms['other-vm'] = { id: '6', status: 'TERMINATED' };
  await t.core.wake('demo', await t.core.beginWake('demo', STATES.ASLEEP, 'test'));
  assert.equal(t.w.vms['neg-vm'].status, 'RUNNING');
  assert.equal(t.w.vms['other-vm'].status, 'TERMINATED');
});

// --- Cloud SQL companions, over the real adapter and the fake of world.mjs (task R10's assumptions, before M6) ------------------

const SQL_INPUT = { urlMap: 'lb', backendService: 'app', id: 'demo', cloudSql: ['db'] };
const lineOf = (changes, pattern) => changes.findIndex((line) => pattern.test(line));
const APP_DOWN = /^(stop|suspend) vm-a$/;
const APP_UP = /^(start|resume) vm-a$/;
const policyOf = (t, name = 'db') => t.w.sql[name].settings?.activationPolicy ?? 'ALWAYS';
const busy = () => new GoogleError('Google: PATCH: 409 another operation', { code: 409, status: 'CONFLICT', reason: 'operationInProgress' });

// A workload `demo` onboarded with the instance `db`, awake. `change(w)`: what differs from the world's defaults.
async function withCompanion(change = () => {}) {
  const t = worldOf((w) => {
    w.sql.db = {};
    change(w);
  });
  await t.onboarding.onboard(SQL_INPUT);
  t.w.changes.length = 0;
  return t;
}

// The same, asleep, with its stop's operation over.
async function asleepWithCompanion(change) {
  const t = await withCompanion(change);
  assert.equal((await t.core.nap('demo')).state, STATES.ASLEEP);
  t.clock.advance(t.w.sqlTakes.NEVER);
  t.w.changes.length = 0;
  return t;
}

const wakeNowIn = async (t) => t.core.wake('demo', await t.core.beginWake('demo', STATES.ASLEEP, 'operator'));
const failureOfRun = (t) => JSON.parse(t.store.runs.get('demo').failure);

test('a companion\'s nap: NEVER once the application is down, with no wait for it', async () => {
  const t = await withCompanion();
  let opened;
  t.w.on['PATCH sql/instances/db'] = () => { opened = t.w.changes.slice(); };
  assert.equal((await t.core.nap('demo')).state, STATES.ASLEEP);
  assert.ok(opened.some((line) => APP_DOWN.test(line)), 'the application first');
  assert.ok(lineOf(t.w.changes, APP_DOWN) < lineOf(t.w.changes, /^sql db NEVER$/));
  assert.equal(t.w.changes.at(-1), 'sql db NEVER');
  assert.equal(policyOf(t), 'NEVER');
  // The stop's operation still runs: the nap did not wait for it, or read it.
  assert.equal(t.w.used.has('cloudsql.getOperation'), false);
  assert.equal(t.w.used.has('cloudsql.listOperations'), false);
  assert.equal((await t.cloudsql.listOperations('db'))[0].status, 'RUNNING');
});

test('a companion\'s nap given up before the commit point leaves the database alone', async () => {
  const t = await withCompanion();
  t.store.pauses.set('demo', { by: 'x', at: t.clock.now(), reason: 'r', keepAsleep: false });
  assert.equal((await t.core.nap('demo')).state, 'SKIPPED');
  assert.deepEqual(t.w.changes, []);
});

test('a companion\'s wake: ALWAYS first, the application only once the database runs', async () => {
  const t = await asleepWithCompanion();
  const start = t.clock.now();
  let appAt;
  let dbAtApp;
  for (const action of ['start', 'resume']) {
    t.w.on[`POST zones/${ZONE}/instances/vm-a/${action}`] = () => {
      appAt = t.clock.now();
      dbAtApp = t.w.changes.slice();
    };
  }
  assert.equal((await wakeNowIn(t)).state, STATES.AWAKE);
  assert.equal(t.w.changes[0], 'sql db ALWAYS');
  assert.ok(dbAtApp.includes('sql db ALWAYS'));
  assert.ok(appAt - start >= t.w.sqlTakes.ALWAYS, `the application at ${appAt - start} ms, the database takes ${t.w.sqlTakes.ALWAYS}`);
  assert.equal(policyOf(t), 'ALWAYS');
});

test('a wake right after a nap: the database going down is waited for, then started', async () => {
  const t = await withCompanion();
  assert.equal((await t.core.nap('demo')).state, STATES.ASLEEP);
  t.w.changes.length = 0;
  const start = t.clock.now();
  assert.equal((await wakeNowIn(t)).state, STATES.AWAKE);
  assert.equal(t.w.changes[0], 'sql db ALWAYS');
  assert.ok(t.clock.now() - start >= t.w.sqlTakes.NEVER + t.w.sqlTakes.ALWAYS);
});

test('a failed application start leaves the database up, the workload FAILED', async () => {
  const t = await asleepWithCompanion();
  for (const action of ['start', 'resume']) t.w.fail[`POST zones/${ZONE}/instances/vm-a/${action}`] = new GoogleError('Google: refused', { code: 500 });
  assert.equal((await wakeNowIn(t)).state, STATES.FAILED);
  assert.equal(policyOf(t), 'ALWAYS');
  assert.equal(t.w.changes.includes('sql db NEVER'), false);
});

test('a database that does not come up fails the wake, the application not started; a timeout', async () => {
  const t = await asleepWithCompanion((w) => { w.sqlTakes.ALWAYS = 10 * 3_600_000; });
  const { state } = await wakeNowIn(t);
  assert.equal(state, STATES.FAILED);
  assert.equal(lineOf(t.w.changes, APP_UP), -1);
  const failure = failureOfRun(t);
  assert.equal(failure.kind, 'timeout');
  assert.match(failure.message, /Cloud SQL instance db: not running when the wake timed out/);
});

test('a database that does not come up keeps the autoscalers off, on record for the next wake', async () => {
  const t = await asleepWithCompanion((w) => { w.sqlTakes.ALWAYS = 10 * 3_600_000; });
  t.store.runs.get('demo').autoscalers = [{ kind: 'zonal', location: ZONE, name: 'scaler', mode: 'ON' }];
  await wakeNowIn(t);
  assert.equal(t.w.changes.some((line) => line.startsWith('autoscaler')), false);
  assert.equal(t.store.runs.get('demo').autoscalers.length, 1);
});

test('a wake moved on during the database\'s wait starts no application', async () => {
  const t = await asleepWithCompanion();
  t.clock.onSleep(() => {
    const run = t.store.runs.get('demo');
    if (run?.state === STATES.WAKING) run.wakeId = 'another';
  });
  assert.equal((await wakeNowIn(t)).state, 'SUPERSEDED');
  assert.equal(lineOf(t.w.changes, APP_UP), -1);
});

test('under a swap: a database that does not come up fails the wake, even with a VM healthy', async () => {
  const t = worldOf((w) => {
    regionalWorld(w);
    w.sql.db = {};
    w.sqlTakes.ALWAYS = 10 * 3_600_000;
  });
  await t.onboarding.onboard(SQL_INPUT);
  await t.core.nap('demo');
  t.clock.advance(t.w.sqlTakes.NEVER);
  t.w.vms['vm-a'].status = 'RUNNING';
  assert.equal((await wakeNowIn(t)).state, STATES.FAILED);
  assert.equal(t.w.logs.some((l) => l.event === 'BackendsNotWoken'), false);
});

test('under a swap: the nap\'s NEVER after the application, the wake\'s ALWAYS before it, then the map', async () => {
  const t = worldOf((w) => {
    regionalWorld(w);
    w.sql.db = {};
  });
  await t.onboarding.onboard(SQL_INPUT);
  t.w.changes.length = 0;
  assert.equal((await t.core.nap('demo')).state, STATES.ASLEEP);
  assert.ok(lineOf(t.w.changes, /^map lb$/) < lineOf(t.w.changes, APP_DOWN));
  assert.ok(lineOf(t.w.changes, APP_DOWN) < lineOf(t.w.changes, /^sql db NEVER$/));
  t.clock.advance(t.w.sqlTakes.NEVER);
  t.w.changes.length = 0;
  assert.equal((await wakeNowIn(t)).state, STATES.AWAKE);
  assert.deepEqual([lineOf(t.w.changes, /^sql db ALWAYS$/) < lineOf(t.w.changes, APP_UP), lineOf(t.w.changes, APP_UP) < lineOf(t.w.changes, /^map lb$/)], [true, true]);
});

test('the check, asleep: a running companion is stopped again, the state unchanged', async () => {
  const t = await asleepWithCompanion();
  t.w.sql.db.settings.activationPolicy = 'ALWAYS';
  const [result] = await t.core.check();
  assert.equal(result.state, STATES.ASLEEP);
  assert.deepEqual(t.w.changes, ['sql db NEVER']);
  assert.equal(policyOf(t), 'NEVER');
  assert.ok(t.w.logs.some((l) => l.event === 'DatabaseRestopped' && l.workloadId === 'demo' && l.instance === 'db'));
});

test('the check, asleep: a stopped companion changes nothing', async () => {
  const t = await asleepWithCompanion();
  await t.core.check();
  assert.deepEqual(t.w.changes, []);
});

test('the check, awake: a stopped companion is started, with no wait, the state unchanged', async () => {
  const t = await withCompanion();
  t.w.sql.db.settings = { activationPolicy: 'NEVER' };
  const before = t.clock.now();
  const [result] = await t.core.check();
  assert.equal(result.state, STATES.AWAKE);
  assert.deepEqual(t.w.changes, ['sql db ALWAYS']);
  assert.equal(t.clock.now(), before);
  assert.ok(t.w.logs.some((l) => l.event === 'DatabaseRestarted' && l.instance === 'db'));
});

test('the check, awake: a running companion changes nothing, and one read a single time', async () => {
  const t = await withCompanion();
  let reads = 0;
  t.w.on['GET sql/instances/db'] = () => { reads += 1; };
  await t.core.check();
  assert.deepEqual(t.w.changes, []);
  assert.equal(reads, 1);
});

test('the primaries decide the state: asleep with the database running stays asleep', async () => {
  const t = await asleepWithCompanion();
  t.w.sql.db.settings.activationPolicy = 'ALWAYS';
  assert.equal((await t.core.check())[0].state, STATES.ASLEEP);
  assert.equal(t.w.logs.some((l) => l.event === 'ExternalWake'), false);
});

test('the primaries decide the state: awake with the database stopped stays awake', async () => {
  const t = await withCompanion();
  t.w.sql.db.settings = { activationPolicy: 'NEVER' };
  assert.equal((await t.core.check())[0].state, STATES.AWAKE);
  assert.equal(t.w.logs.some((l) => l.event === 'ExternalStop'), false);
});

test('the primaries decide the state: VMs stopped by hand, the database running: asleep, and it follows', async () => {
  const t = await withCompanion();
  t.w.vms['vm-a'].status = 'TERMINATED';
  assert.equal((await t.core.check())[0].state, STATES.ASLEEP);
  assert.ok(t.w.logs.some((l) => l.event === 'ExternalStop'));
  assert.equal(policyOf(t), 'NEVER');
});

test('the primaries decide the state: a VM started by hand, the database stopped: awake, and it follows', async () => {
  const t = await asleepWithCompanion();
  t.w.vms['vm-a'].status = 'RUNNING';
  assert.equal((await t.core.check())[0].state, STATES.AWAKE);
  assert.ok(t.w.logs.some((l) => l.event === 'ExternalWake'));
  assert.equal(policyOf(t), 'ALWAYS');
});

test('the check, FAILED or napping or waking: the database is left as it is', async () => {
  for (const state of [STATES.FAILED, STATES.NAPPING, STATES.WAKING]) {
    const t = await withCompanion();
    Object.assign(t.store.runs.get('demo'), { state, failedAt: t.clock.now(), updatedAt: t.clock.now(), wakeStartedAt: t.clock.now() });
    await t.core.check();
    assert.equal(t.w.changes.some((line) => line.startsWith('sql ')), false, state);
  }
});

test('the check: a run that changed since it was read leaves the database alone', async () => {
  const t = await asleepWithCompanion();
  t.w.sql.db.settings.activationPolicy = 'ALWAYS';
  // The wake asked between the check's read of the run and its read of the instance.
  t.w.on['GET sql/instances/db'] = () => { t.store.runs.get('demo').state = STATES.WAKING; };
  await t.core.check();
  assert.deepEqual(t.w.changes, []);
});

test('the check: a companion that cannot be read or changed is logged, and the check goes on', async () => {
  const t = await withCompanion();
  t.w.fail['GET sql/instances/db'] = new GoogleError('Google: refused', { code: 500 });
  t.clock.advance(3_600_000);
  const [result] = await t.core.check();
  assert.equal(result.error, undefined);
  assert.equal(result.nap, 'requested');
  assert.ok(t.w.logs.some((l) => l.event === 'DatabaseNotFollowed' && l.instance === 'db'));
});

test('the check: operationInProgress is not waited for, the next check tries again', async () => {
  const t = await asleepWithCompanion();
  t.w.sql.db.settings.activationPolicy = 'ALWAYS';
  t.w.fail['PATCH sql/instances/db'] = busy();
  const before = t.clock.now();
  const [result] = await t.core.check();
  assert.equal(result.state, STATES.ASLEEP);
  assert.equal(t.clock.now(), before);
  assert.ok(t.w.logs.some((l) => l.event === 'DatabaseNotFollowed'));
  delete t.w.fail['PATCH sql/instances/db'];
  await t.core.check();
  assert.equal(policyOf(t), 'NEVER');
});

test('a nap\'s 409 is retried until it passes', async () => {
  const t = await withCompanion();
  let refusals = 3;
  t.w.on['PATCH sql/instances/db'] = () => {
    if (refusals > 0) {
      refusals -= 1;
      throw busy();
    }
  };
  assert.equal((await t.core.nap('demo')).state, STATES.ASLEEP);
  assert.equal(refusals, 0);
  assert.equal(policyOf(t), 'NEVER');
});

test('a nap\'s 409 is retried to the deadline: then FAILED, a timeout, within the nap\'s request', async () => {
  const t = await withCompanion();
  const start = t.clock.now();
  t.w.fail['PATCH sql/instances/db'] = busy();
  let tries = 0;
  t.google.request = ((request) => (method, url, body) => {
    if (method === 'PATCH' && url.includes('sqladmin')) tries += 1;
    return request(method, url, body);
  })(t.google.request);
  assert.equal((await t.core.nap('demo')).state, STATES.FAILED);
  assert.ok(tries > 100, `${tries} tries`);
  assert.ok(t.clock.now() - start <= REQUEST_LIMIT);
  const failure = failureOfRun(t);
  assert.equal(failure.kind, 'timeout');
  assert.match(failure.message, /Cloud SQL instance db: another operation was still running at the deadline/);
});

test('a wake\'s 409 is retried to the deadline: then FAILED, a timeout, the application not started', async () => {
  const t = await asleepWithCompanion();
  const start = t.clock.now();
  t.w.fail['PATCH sql/instances/db'] = busy();
  assert.equal((await wakeNowIn(t)).state, STATES.FAILED);
  assert.ok(t.clock.now() - start >= 1_700_000);
  assert.ok(t.clock.now() - start <= REQUEST_LIMIT);
  assert.equal(lineOf(t.w.changes, APP_UP), -1);
  assert.equal(failureOfRun(t).kind, 'timeout');
});

test('a 403 on a nap\'s PATCH: a failure of kind permission naming the tag', async () => {
  const t = await withCompanion();
  t.w.fail['PATCH sql/instances/db'] = new GoogleError('Google: PATCH: 403 not authorized', { code: 403, reason: 'notAuthorized' });
  assert.equal((await t.core.nap('demo')).state, STATES.FAILED);
  const failure = failureOfRun(t);
  assert.equal(failure.kind, 'permission');
  assert.match(failure.message, /tag dormeto=managed/);
});

test('a start refused for capacity gets AWS\'s retries, then the wake goes on', async () => {
  const t = await asleepWithCompanion();
  t.w.sqlOperationErrors.push({ errors: [{ code: 'ZONE_RESOURCE_POOL_EXHAUSTED', message: 'none left' }] });
  const start = t.clock.now();
  assert.equal((await wakeNowIn(t)).state, STATES.AWAKE);
  // A first try that fails at its operation's end, 30 s, and a second that takes its time.
  assert.ok(t.clock.now() - start >= t.w.sqlTakes.ALWAYS * 2 + 30_000);
  assert.deepEqual(t.w.changes.filter((line) => line === 'sql db ALWAYS').length, 2);
});

test('a start refused for capacity up to the deadline: a failure of kind capacity', async () => {
  const t = await asleepWithCompanion();
  t.w.fail['PATCH sql/instances/db'] = new GoogleError('Google: PATCH: 503 no', { code: 503, reason: 'ZONE_RESOURCE_POOL_EXHAUSTED' });
  assert.equal((await wakeNowIn(t)).state, STATES.FAILED);
  assert.equal(failureOfRun(t).kind, 'capacity');
});

test('a companion among the backends: the idle check, the NEG membership and the VMs\' loops read only the application', async () => {
  const t = await withCompanion((w) => {
    w.negs.neg = { endpoints: ['vm-a'] };
    w.services.app.backends = [{ group: `${V1}/zones/${ZONE}/networkEndpointGroups/neg` }];
  });
  t.clock.advance(3_600_000);
  assert.equal((await t.core.check())[0].nap, 'requested');
  assert.equal((await t.core.nap('demo')).state, STATES.ASLEEP);
  assert.equal(t.w.logs.some((l) => l.event === 'NapAborted'), false);
  t.clock.advance(t.w.sqlTakes.NEVER);
  assert.equal((await wakeNowIn(t)).state, STATES.AWAKE);
});

test('release: the application down, then the database', async () => {
  const t = await withCompanion();
  Object.assign(t.store.runs.get('demo'), { state: STATES.FAILED, failedAt: t.clock.now() });
  assert.equal((await t.core.release('demo')).state, STATES.ASLEEP);
  assert.ok(lineOf(t.w.changes, APP_DOWN) < lineOf(t.w.changes, /^sql db NEVER$/));
  assert.equal(policyOf(t), 'NEVER');
});

test('two companions: both up before the application, both asked to go after it; one that fails fails the wake once the other is settled', async () => {
  const t = worldOf((w) => {
    w.sql.db = {};
    w.sql.second = {};
  });
  await t.onboarding.onboard({ ...SQL_INPUT, cloudSql: ['db', 'second'] });
  assert.equal((await t.core.nap('demo')).state, STATES.ASLEEP);
  assert.deepEqual([policyOf(t), policyOf(t, 'second')], ['NEVER', 'NEVER']);
  t.clock.advance(t.w.sqlTakes.NEVER);
  t.w.changes.length = 0;
  assert.equal((await wakeNowIn(t)).state, STATES.AWAKE);
  assert.ok(lineOf(t.w.changes, /^sql db ALWAYS$/) < lineOf(t.w.changes, APP_UP));
  assert.ok(lineOf(t.w.changes, /^sql second ALWAYS$/) < lineOf(t.w.changes, APP_UP));

  assert.equal((await t.core.nap('demo')).state, STATES.ASLEEP);
  t.clock.advance(t.w.sqlTakes.NEVER);
  t.w.changes.length = 0;
  t.w.fail['PATCH sql/instances/second'] = new GoogleError('Google: PATCH: 403 not authorized', { code: 403 });
  const started = t.clock.now();
  assert.equal((await wakeNowIn(t)).state, STATES.FAILED);
  assert.ok(t.clock.now() - started >= t.w.sqlTakes.ALWAYS, 'the other settled first');
  assert.equal(policyOf(t), 'ALWAYS');
  assert.equal(lineOf(t.w.changes, APP_UP), -1);
  assert.equal(failureOfRun(t).kind, 'permission');
});

// --- What must hold under each reading M6 may give: the fake's choice does not decide these ------------------------------------

const READINGS = [
  ['as assumed', {}],
  ['the policy reading as asked only at the operation\'s end', { policy: 'at-end' }],
  ['the state leaving RUNNABLE during an operation', { stateDuring: 'MAINTENANCE' }],
  ['an operation in error changing the policy all the same', { failedPolicy: 'changed' }],
  ['the list showing an operation late', { listLagMs: 15_000 }],
];
const inReading = (reading) => (w) => { w.sqlReading = { ...w.sqlReading, ...reading }; };
// When the application started.
function watchApplication(t) {
  const seen = { at: null };
  for (const action of ['start', 'resume']) {
    t.w.on[`POST zones/${ZONE}/instances/vm-a/${action}`] = () => {
      seen.at ??= t.clock.now();
    };
  }
  return seen;
}

for (const [title, reading] of READINGS) {
  test(`a wake right after a nap, ${title}: the stop waited for, the start waited for, then the application`, async () => {
    const t = await withCompanion(inReading(reading));
    assert.equal((await t.core.nap('demo')).state, STATES.ASLEEP);
    const seen = watchApplication(t);
    const start = t.clock.now();
    t.w.changes.length = 0;
    assert.equal((await wakeNowIn(t)).state, STATES.AWAKE);
    assert.equal(t.w.changes[0], 'sql db ALWAYS');
    assert.ok(seen.at - start >= t.w.sqlTakes.NEVER + t.w.sqlTakes.ALWAYS, `the application after ${seen.at - start} ms`);
  });

  test(`a task delivered again mid-start, ${title}: the start under way waited for, not asked again`, async () => {
    const t = await asleepWithCompanion(inReading(reading));
    const wakeId = await t.core.beginWake('demo', STATES.ASLEEP, 'operator');
    // The first attempt asked, and its request died.
    await t.cloudsql.setActivation('db', 'ALWAYS');
    t.clock.advance(reading.listLagMs ?? 0);
    const seen = watchApplication(t);
    const start = t.clock.now();
    assert.equal((await t.core.wake('demo', wakeId)).state, STATES.AWAKE);
    assert.ok(seen.at - start >= t.w.sqlTakes.ALWAYS - (reading.listLagMs ?? 0), `the application after ${seen.at - start} ms`);
    assert.equal(t.w.changes.filter((line) => line === 'sql db ALWAYS').length, 1);
  });

  test(`a start failed for capacity, ${title}: asked again, the application only after one that succeeded`, async () => {
    const t = await asleepWithCompanion(inReading(reading));
    t.w.sqlOperationErrors.push({ errors: [{ code: 'ZONE_RESOURCE_POOL_EXHAUSTED', message: 'none left' }] });
    const seen = watchApplication(t);
    const start = t.clock.now();
    assert.equal((await wakeNowIn(t)).state, STATES.AWAKE);
    assert.equal(t.w.changes.filter((line) => line === 'sql db ALWAYS').length, 2);
    assert.ok(seen.at - start >= t.w.sqlTakes.ALWAYS * 2 + 30_000, `the application after ${seen.at - start} ms`);
  });

  test(`the wake after one that timed out, the start still under way, ${title}: waited for`, async () => {
    const t = await asleepWithCompanion(inReading(reading));
    t.store.configs.get('demo').wakeTimeoutSeconds = 60;
    assert.equal((await wakeNowIn(t)).state, STATES.FAILED);
    t.store.configs.get('demo').wakeTimeoutSeconds = 1700;
    t.clock.advance(reading.listLagMs ?? 0);
    const seen = watchApplication(t);
    const start = t.clock.now();
    const wakeId = await t.core.beginWake('demo', STATES.FAILED, 'request');
    assert.equal((await t.core.wake('demo', wakeId)).state, STATES.AWAKE);
    assert.ok(seen.at > start, 'not at once');
    assert.ok(seen.at - start >= t.w.sqlTakes.ALWAYS - 60_000 - 10_000 - (reading.listLagMs ?? 0), `the application after ${seen.at - start} ms`);
    assert.equal(t.w.changes.filter((line) => line === 'sql db ALWAYS').length, 1);
  });
}

test('the operations refused with a 403: the wake goes on by the state and the policy, said once, whatever the polls and the companions', async () => {
  const t = worldOf((w) => {
    w.sql.db = {};
    w.sql.second = {};
    // The state tells, here: the wake polls.
    w.sqlReading.stateDuring = 'MAINTENANCE';
  });
  await t.onboarding.onboard({ ...SQL_INPUT, cloudSql: ['db', 'second'] });
  await t.core.nap('demo');
  t.clock.advance(t.w.sqlTakes.NEVER);
  const refusal = new GoogleError('Google: GET: 403 not authorized', { code: 403, reason: 'notAuthorized' });
  t.google.request = ((request) => async (method, url, body) => {
    if (url.includes('/operations')) throw refusal;
    return request(method, url, body);
  })(t.google.request);
  assert.equal((await wakeNowIn(t)).state, STATES.AWAKE);
  const said = t.w.logs.filter((l) => l.event === 'DatabaseOperationsUnread');
  assert.equal(said.length, 1);
  assert.equal(said[0].workloadId, 'demo');
  assert.equal(said[0].wakeId, 'wake-1');
});

test('another operation running as a wake reads the database up: waited for, whatever it is', async () => {
  const t = await asleepWithCompanion();
  await t.cloudsql.setActivation('db', 'ALWAYS');
  t.clock.advance(t.w.sqlTakes.ALWAYS);
  // As a backup, for this reading.
  t.w.sqlTakes.ALWAYS = 40_000;
  await t.cloudsql.setActivation('db', 'ALWAYS');
  t.w.changes.length = 0;
  const seen = watchApplication(t);
  const start = t.clock.now();
  assert.equal((await wakeNowIn(t)).state, STATES.AWAKE);
  assert.ok(seen.at - start >= 40_000);
  assert.deepEqual(t.w.changes.filter((line) => line.startsWith('sql ')), []);
});

// --- Nothing asked of a database once the nap or the release no longer holds the run -------------------------------------------

test('a wake asked during a nap\'s stop: the database is left alone, and the wake follows', async () => {
  const t = await withCompanion();
  for (const action of ['stop', 'suspend']) {
    t.w.on[`POST zones/${ZONE}/instances/vm-a/${action}`] = () => { t.store.setPendingWake('demo'); };
  }
  const answer = await t.core.nap('demo');
  assert.equal(answer.state, STATES.WAKING);
  assert.equal(t.w.changes.includes('sql db NEVER'), false);
  assert.equal(policyOf(t), 'ALWAYS');
  assert.equal(t.w.tasks.at(-1).body.action, 'wake');
});

test('a wake asked while a nap reads the database: nothing sent', async () => {
  const t = await withCompanion();
  t.w.on['GET sql/instances/db'] = () => { t.store.setPendingWake('demo'); };
  assert.equal((await t.core.nap('demo')).state, STATES.WAKING);
  assert.equal(t.w.changes.includes('sql db NEVER'), false);
});

test('a wake asked during a nap\'s 409s: no other try, the wake in about one poll, not at the nap\'s budget', async () => {
  const t = await withCompanion();
  t.w.fail['PATCH sql/instances/db'] = busy();
  let tries = 0;
  t.google.request = ((request) => (method, url, body) => {
    if (method === 'PATCH' && url.includes('sqladmin')) {
      tries += 1;
      if (tries === 3) t.store.setPendingWake('demo');
    }
    return request(method, url, body);
  })(t.google.request);
  let refused;
  t.w.on['GET sql/instances/db'] = () => { refused ??= t.clock.now(); };
  const answer = await t.core.nap('demo');
  assert.equal(answer.state, STATES.WAKING);
  assert.equal(tries, 3);
  assert.ok(t.clock.now() - refused <= 3 * 10_000, `${t.clock.now() - refused} ms`);
  assert.equal(t.w.tasks.at(-1).body.action, 'wake');
  assert.equal(t.store.runs.get('demo').state, STATES.WAKING);
});

test('a forced offboarding during a nap\'s 409s: nothing more is sent', async () => {
  const t = await withCompanion();
  t.w.fail['PATCH sql/instances/db'] = busy();
  let tries = 0;
  t.google.request = ((request) => (method, url, body) => {
    if (method === 'PATCH' && url.includes('sqladmin')) {
      tries += 1;
      if (tries === 2) {
        t.store.runs.delete('demo');
        t.store.configs.delete('demo');
      }
    }
    return request(method, url, body);
  })(t.google.request);
  await t.core.nap('demo');
  assert.equal(tries, 2);
});

test('a wake begun during a release\'s stop: the database is left alone, the release gives way', async () => {
  const t = await withCompanion();
  Object.assign(t.store.runs.get('demo'), { state: STATES.FAILED, failedAt: t.clock.now() });
  for (const action of ['stop', 'suspend']) {
    t.w.on[`POST zones/${ZONE}/instances/vm-a/${action}`] = () => { Object.assign(t.store.runs.get('demo'), { state: STATES.WAKING, wakeId: 'visitor' }); };
  }
  assert.equal((await t.core.release('demo')).state, 'SUPERSEDED');
  assert.equal(t.w.changes.includes('sql db NEVER'), false);
  assert.equal(policyOf(t), 'ALWAYS');
});

test('a wake begun during a release\'s 409s: no other try', async () => {
  const t = await withCompanion();
  Object.assign(t.store.runs.get('demo'), { state: STATES.FAILED, failedAt: t.clock.now() });
  t.w.fail['PATCH sql/instances/db'] = busy();
  let tries = 0;
  t.google.request = ((request) => (method, url, body) => {
    if (method === 'PATCH' && url.includes('sqladmin')) {
      tries += 1;
      if (tries === 2) Object.assign(t.store.runs.get('demo'), { state: STATES.WAKING, wakeId: 'visitor' });
    }
    return request(method, url, body);
  })(t.google.request);
  assert.equal((await t.core.release('demo')).state, 'SUPERSEDED');
  assert.equal(tries, 2);
});

// --- GKE pods behind standalone NEGs, over the real adapters and the fake of world.mjs (task R11's assumptions, before M9 to M12) ----------------------------------------

const KEDA_PAUSE = 'autoscaling.keda.sh/paused-replicas';
const scaler = (annotations = {}) => ({ metadata: { namespace: 'shop', name: 'web-scaler', annotations }, spec: { scaleTargetRef: { name: 'web' } } });
const withScaler = (annotations) => (w) => { w.kube.scaledObjects.push(scaler(annotations)); };
const scalerAnnotations = (t) => t.w.kube.scaledObjects[0].metadata.annotations;
const replicasOf = (t) => t.w.kube.owners[OWNER]?.replicas;
const SCALE_0 = 'scale shop/web 0';
const runOf = (t) => t.store.runs.get('demo');
const logged = (t, event) => t.w.logs.filter((l) => l.event === event);
const event = (t, reason, message, pod = 'web-0') => ({ type: 'Warning', reason, message, involvedObject: { kind: 'Pod', name: pod }, lastTimestamp: new Date(t).toISOString() });

// A workload `demo`, its Deployment shop/web at 2 replicas behind a standalone NEG, onboarded and awake.
async function withPods(change = () => {}, input = GKE_INPUT) {
  const t = worldOf((w) => {
    onGke(w);
    change(w);
  });
  await t.onboarding.onboard(input);
  t.w.changes.length = 0;
  t.w.kube.calls.length = 0;
  return t;
}
const asleepPods = async (change, input) => {
  const t = await withPods(change, input);
  assert.equal((await t.core.nap('demo')).state, STATES.ASLEEP);
  t.w.changes.length = 0;
  return t;
};
const wakePods = async (t, from = STATES.ASLEEP) => t.core.wake('demo', await t.core.beginWake('demo', from, 'operator'));
// As each reading M9 and M12 may give: where a NEG names its Service, what a NEG at 0 replicas answers, and whether an endpoint names its node.
const POD_READINGS = [
  { reading: 'description', healthAtZero: 'none', endpointNames: 'node' },
  { reading: 'annotations', healthAtZero: 'unhealthy', endpointNames: 'none' },
  { reading: 'description', healthAtZero: 'unhealthy', endpointNames: 'node' },
  { reading: 'annotations', healthAtZero: 'none', endpointNames: 'none' },
];
const inPodReading = ({ reading, healthAtZero, endpointNames }) => (w) => {
  onGke(w, { reading });
  Object.assign(w.gkeReading, { healthAtZero, endpointNames });
};

for (const reading of POD_READINGS) {
  test(`a nap at 0 with the replicas recorded, a wake back to them (${JSON.stringify(reading)})`, async () => {
    const t = await withPods(inPodReading(reading));
    assert.equal((await t.core.nap('demo')).state, STATES.ASLEEP);
    assert.equal(replicasOf(t), 0);
    assert.deepEqual(t.w.changes, ['map lb', SCALE_0]);
    assert.equal(runOf(t).owners[0].replicas, 2);
    assert.equal(runOf(t).owners[0].keda, null);
    assert.deepEqual(runOf(t).stopped, ['Deployment shop/web']);
    t.w.changes.length = 0;
    assert.equal((await wakePods(t)).state, STATES.AWAKE);
    assert.equal(replicasOf(t), 2);
    assert.deepEqual(t.w.changes, ['scale shop/web 2', 'map lb']);
    assert.equal(runOf(t).owners, undefined);
    assert.equal(runOf(t).stopped, undefined);
  });
}

test('a nap reads the replicas at each nap, not those of the onboarding, nor of the nap before', async () => {
  const t = await withPods();
  t.w.kube.owners[OWNER].replicas = 5;
  await t.core.nap('demo');
  assert.equal(runOf(t).owners[0].replicas, 5);
  await wakePods(t);
  assert.equal(replicasOf(t), 5);
  t.w.kube.owners[OWNER].replicas = 3;
  await t.core.nap('demo');
  await wakePods(t);
  assert.equal(replicasOf(t), 3);
});

test('a nap of an owner already at 0: no endpoint is normal, its wake brings 1', async () => {
  const t = await withPods((w) => { w.kube.owners[OWNER].replicas = 0; });
  assert.equal((await t.core.nap('demo')).state, STATES.ASLEEP);
  assert.equal(runOf(t).owners[0].replicas, 0);
  assert.equal((await wakePods(t)).state, STATES.AWAKE);
  assert.equal(replicasOf(t), 1);
});

test('a nap waits for the pods to go, within its stop timeout', async () => {
  const t = await withPods((w) => { w.kube.leaving = 3; });
  assert.equal((await t.core.nap('demo')).state, STATES.ASLEEP);
  assert.equal(t.w.kube.owners[OWNER].leavingFrom, undefined);
  const stuck = await withPods((w) => { w.kube.leaving = 1_000_000; });
  const out = await stuck.core.nap('demo');
  assert.equal(out.state, STATES.FAILED);
  assert.equal(failureOfRun(stuck).kind, 'timeout');
  assert.match(failureOfRun(stuck).message, /timeout waiting for the pods of Deployment shop\/web to stop/);
  assert.equal(runOf(stuck).owners[0].replicas, 2);
});

test('KEDA is paused at 0 before the scale, and given back after the wake\'s: none there before, none after', async () => {
  const t = await withPods(withScaler());
  await t.core.nap('demo');
  assert.deepEqual(t.w.changes, ['map lb', `keda web-scaler {"${KEDA_PAUSE}":"0"}`, SCALE_0]);
  assert.equal(scalerAnnotations(t)[KEDA_PAUSE], '0');
  assert.deepEqual(runOf(t).owners[0].keda, { name: 'web-scaler', paused: null });
  t.w.changes.length = 0;
  assert.equal((await wakePods(t)).state, STATES.AWAKE);
  assert.deepEqual(t.w.changes.slice(0, 2), ['scale shop/web 2', `keda web-scaler {"${KEDA_PAUSE}":null}`]);
  assert.deepEqual(scalerAnnotations(t), {});
});

test('the customer\'s own KEDA pause is given back as it was', async () => {
  const t = await withPods(withScaler({ [KEDA_PAUSE]: '4' }));
  await t.core.nap('demo');
  assert.equal(scalerAnnotations(t)[KEDA_PAUSE], '0');
  assert.equal(runOf(t).owners[0].keda.paused, '4');
  await wakePods(t);
  assert.equal(scalerAnnotations(t)[KEDA_PAUSE], '4');
});

test('a cluster without KEDA\'s API: none, nothing asked of it', async () => {
  const t = await withPods((w) => { w.kube.keda = false; });
  assert.equal((await t.core.nap('demo')).state, STATES.ASLEEP);
  assert.equal(runOf(t).owners[0].keda, null);
  assert.equal(t.w.changes.some((line) => line.startsWith('keda')), false);
});

test('a ScaledObject deleted while asleep is nothing to give back, and fails no wake', async () => {
  const t = await asleepPods(withScaler());
  t.w.kube.scaledObjects.length = 0;
  assert.equal((await wakePods(t)).state, STATES.AWAKE);
});

test('a nap that failed after its scale keeps its record: its release and its wake give back what the first nap read', async () => {
  const t = await withPods((w) => {
    w.kube.scaledObjects.push(scaler({ [KEDA_PAUSE]: '4' }));
    w.kube.leaving = 1_000_000;
  });
  assert.equal((await t.core.nap('demo')).state, STATES.FAILED);
  assert.equal(replicasOf(t), 0);
  t.w.kube.leaving = 0;
  delete t.w.kube.owners[OWNER].leavingFrom;
  assert.equal((await t.core.release('demo')).state, STATES.ASLEEP);
  assert.equal(runOf(t).owners[0].replicas, 2);
  assert.equal(runOf(t).owners[0].keda.paused, '4');
  assert.equal((await wakePods(t)).state, STATES.AWAKE);
  assert.equal(replicasOf(t), 2);
  assert.equal(scalerAnnotations(t)[KEDA_PAUSE], '4');
});

// --- An owner gone, an endpoint not its own ---------------------------------------------------------------------------------------------------------------------------------

test('a nap of an owner gone: failed, worded, before anything is written', async () => {
  const t = await withPods();
  delete t.w.kube.owners[OWNER];
  const out = await t.core.nap('demo');
  assert.equal(out.state, STATES.FAILED);
  assert.match(out.error, /Deployment shop\/web not found in GKE cluster europe-west1-b\/shop/);
  assert.equal(failureOfRun(t).kind, 'configuration');
  assert.deepEqual(t.w.changes, []);
});

test('a wake of an owner gone: failed, worded, the switch kept', async () => {
  const t = await asleepPods();
  delete t.w.kube.owners[OWNER];
  const out = await wakePods(t);
  assert.equal(out.state, STATES.FAILED);
  assert.match(out.error, /Deployment shop\/web not found in GKE cluster europe-west1-b\/shop/);
  assert.equal(failureOfRun(t).step, 'wake');
  assert.deepEqual(t.w.changes, []);
});

test('an owner gone during the nap\'s wait: failed, worded, nothing scaled', async () => {
  const t = await withPods();
  t.w.on['PUT global/urlMaps/lb'] = () => { delete t.w.kube.owners[OWNER]; };
  const out = await t.core.nap('demo');
  assert.equal(out.state, STATES.FAILED);
  assert.match(out.error, /not found in GKE cluster/);
  assert.equal(t.w.changes.includes(SCALE_0), false);
});

test('a NEG\'s endpoints belonging to another owner: no scale, no switch, a worded failure, and it keeps serving', async () => {
  const t = await withPods();
  t.w.negs[GKE_NEG].foreign = ['10.9.9.9'];
  const out = await t.core.nap('demo');
  assert.equal(out.state, STATES.AWAKE);
  assert.equal(out.aborted, true);
  assert.match(out.error, new RegExp(`network endpoint group ${GKE_NEG} holds 1 endpoint \\(10\\.9\\.9\\.9\\) that are not pods of Deployment shop/web: nothing is scaled`));
  assert.deepEqual(t.w.changes, []);
  assert.equal(replicasOf(t), 2);
  assert.equal(runOf(t).owners, undefined);
  assert.equal(logged(t, 'NapAborted')[0].reason, out.error);
  assert.equal(t.w.logs.find((l) => l.event === 'StateChanged' && l.to === STATES.AWAKE).cause, 'backends-changed');
});

test('another owner\'s pods behind the NEG, of the same selector: no scale', async () => {
  const t = await withPods();
  t.w.kube.pods.push({
    metadata: { name: 'canary-0', namespace: 'shop', labels: { app: 'web' }, ownerReferences: [{ kind: 'ReplicaSet', name: 'canary-1', controller: true }] },
    status: { phase: 'Running', podIP: '10.8.0.77', conditions: [{ type: 'Ready', status: 'True' }] },
  });
  t.w.negs[GKE_NEG].foreign = ['10.8.0.77'];
  const out = await t.core.nap('demo');
  assert.equal(out.aborted, true);
  assert.equal(replicasOf(t), 2);
});

test('an endpoint with no address cannot be shown to be a pod: no scale', async () => {
  const t = await withPods();
  t.w.negs[GKE_NEG].foreign = [undefined];
  const out = await t.core.nap('demo');
  assert.equal(out.aborted, true);
  assert.match(out.error, /with no address/);
  assert.equal(replicasOf(t), 2);
});

test('an endpoint appearing during the nap\'s wait: back awake, the policy removed, nothing scaled', async () => {
  const t = await withPods();
  t.w.on['PUT global/urlMaps/lb'] = () => { t.w.negs[GKE_NEG].foreign = ['10.9.9.9']; };
  const out = await t.core.nap('demo');
  assert.equal(out.aborted, true);
  assert.equal(replicasOf(t), 2);
  assert.equal(runOf(t).state, STATES.AWAKE);
  assert.equal(t.w.urlMaps.lb.pathMatchers[0].defaultCustomErrorResponsePolicy, undefined);
});

test('an owner\'s endpoints legitimately change: new pods, scaled up since the onboarding, are no change', async () => {
  const t = await withPods();
  t.w.kube.owners[OWNER].replicas = 7;
  assert.equal((await t.core.nap('demo')).state, STATES.ASLEEP);
});

for (const [name, change, words] of [
  ['a NEG deleted', (w) => { delete w.negs[GKE_NEG]; }, /not found: it was deleted/],
  ['a NEG now of another Service', (w) => { Object.assign(w.negs[GKE_NEG], NEG_READINGS.description('shop', 'admin')); }, /belongs to Service shop\/admin, not shop\/web/],
  ['a NEG whose Service no longer reads', (w) => { w.negs[GKE_NEG].description = 'by hand'; }, /cannot read which namespace and Service/],
  ['a VM group put next to the NEG', (w) => { w.services.app.backends.push({ group: `${V1}/zones/${ZONE}/instanceGroups/ig` }); }, /is an instance group/],
  ['every NEG taken out', (w) => { w.services.app.backends = []; }, /no longer has a network endpoint group/],
  ['the backend service deleted', (w) => { delete w.services.app; }, /its backend service no longer exists/],
]) {
  test(`${name} aborts a nap, before anything is written: it acts only on what still is the workload`, async () => {
    const t = await withPods();
    change(t.w);
    const out = await t.core.nap('demo');
    assert.equal(out.aborted, true);
    assert.match(out.error, words);
    assert.match(out.error, /offboard and onboard again/);
    assert.deepEqual(t.w.changes, []);
    assert.equal(replicasOf(t), 2);
  });
}

test('a release with an endpoint not the owner\'s: nothing scaled, still failed', async () => {
  const t = await withPods();
  runOf(t).state = STATES.FAILED;
  t.w.negs[GKE_NEG].foreign = ['10.9.9.9'];
  const out = await t.core.release('demo');
  assert.equal(out.state, STATES.FAILED);
  assert.match(out.error, /not pods of Deployment shop\/web/);
  assert.equal(replicasOf(t), 2);
});

// --- The wake's health --------------------------------------------------------------------------------------------------------------------------------------------------------

test('a wake waits for a healthy endpoint: scaled, not ready for a while, then AWAKE, its policy removed last', async () => {
  const t = await asleepPods();
  t.w.kube.unschedulable = true;
  let polls = 0;
  t.w.on['GET global/backendServices/app'] = () => {
    polls += 1;
    if (polls > 5) t.w.kube.unschedulable = false;
  };
  assert.equal((await wakePods(t)).state, STATES.AWAKE);
  assert.ok(polls > 5);
  assert.equal(t.w.urlMaps.lb.pathMatchers[0].defaultCustomErrorResponsePolicy, undefined);
});

test('a pod that stays unschedulable: unhealthy at the deadline, with the Kubernetes events, at 300 s', async () => {
  const t = await asleepPods();
  t.w.kube.unschedulable = true;
  t.w.kube.events.push(event(t.clock.now() + 1000, 'FailedScheduling', '0/3 nodes are available: 3 Insufficient cpu.'));
  const started = t.clock.now();
  const out = await wakePods(t);
  assert.equal(out.state, STATES.FAILED);
  assert.equal(failureOfRun(t).kind, 'unhealthy');
  assert.match(failureOfRun(t).message, /^no pod of Deployment shop\/web healthy when the wake timed out: pod web-0: FailedScheduling: 0\/3 nodes are available/);
  assert.ok(t.clock.now() - started >= 300_000);
  assert.ok(t.clock.now() - started < 310_000);
  assert.equal(replicasOf(t), 2);
});

test('no event read, unhealthy all the same at the deadline', async () => {
  const t = await asleepPods();
  t.w.kube.unschedulable = true;
  assert.equal((await wakePods(t)).state, STATES.FAILED);
  assert.equal(failureOfRun(t).kind, 'unhealthy');
  assert.match(failureOfRun(t).message, /^no pod of Deployment shop\/web healthy when the wake timed out$/);
});

test('an image that cannot be pulled ends the wake when its event says so, not at the deadline', async () => {
  const t = await asleepPods();
  t.w.kube.unschedulable = true;
  t.w.kube.events.push(event(t.clock.now() + 1000, 'Failed', 'ErrImagePull: not found'));
  const started = t.clock.now();
  const out = await wakePods(t);
  assert.equal(out.state, STATES.FAILED);
  assert.equal(failureOfRun(t).kind, 'configuration');
  assert.match(failureOfRun(t).message, /ErrImagePull/);
  assert.ok(t.clock.now() - started < 60_000);
});

// --- Failures -----------------------------------------------------------------------------------------------------------------------------------------------------------------

test('a Kubernetes 403 reads permission, an unreachable API timeout, at a nap and at a wake', async () => {
  const forbidden = await withPods();
  forbidden.w.kube.denied = ['get deployments'];
  assert.equal((await forbidden.core.nap('demo')).state, STATES.FAILED);
  assert.equal(failureOfRun(forbidden).kind, 'permission');
  assert.deepEqual(forbidden.w.changes, []);

  const unreachable = await withPods();
  unreachable.w.kube.down = true;
  assert.equal((await unreachable.core.nap('demo')).state, STATES.FAILED);
  assert.equal(failureOfRun(unreachable).kind, 'timeout');
  assert.deepEqual(unreachable.w.changes, []);

  const scale = await asleepPods();
  scale.w.kube.denied = ['patch deployments/scale'];
  assert.equal((await wakePods(scale)).state, STATES.FAILED);
  assert.equal(failureOfRun(scale).kind, 'permission');

  const down = await asleepPods();
  down.w.kube.down = true;
  assert.equal((await wakePods(down)).state, STATES.FAILED);
  assert.equal(failureOfRun(down).kind, 'timeout');
});

test('a 403 on the scale at a nap\'s commit: failed, permission, the record on the run for the wake', async () => {
  const t = await withPods(withScaler());
  t.w.kube.denied = ['patch deployments/scale'];
  assert.equal((await t.core.nap('demo')).state, STATES.FAILED);
  assert.equal(failureOfRun(t).kind, 'permission');
  assert.equal(runOf(t).owners[0].replicas, 2);
  assert.equal(scalerAnnotations(t)[KEDA_PAUSE], '0');
  t.w.kube.denied = [];
  // Its pods never left: at the check it is what it is, awake, and KEDA is given back.
  await t.core.check();
  assert.equal(runOf(t).state, STATES.AWAKE);
  assert.deepEqual(scalerAnnotations(t), {});
  assert.equal(runOf(t).owners, undefined);
});

// --- The check ----------------------------------------------------------------------------------------------------------------------------------------------------------------

for (const [name, world] of [['a policy', () => {}], ['a swap', classic]]) {
  test(`the check, under ${name}: asleep with replicas up is as a VM started by hand: AWAKE, the replicas kept, KEDA given back`, async () => {
    const t = await asleepPods((w) => {
      world(w);
      w.kube.scaledObjects.push(scaler());
    });
    t.w.kube.owners[OWNER].replicas = 3;
    await t.core.check();
    assert.equal(logged(t, 'ExternalWake').length, 1);
    if (name === 'a swap') {
      // As a VM's: a wake finishes the job, in a request of its own.
      assert.equal(runOf(t).state, STATES.WAKING);
      assert.equal(t.w.tasks.at(-1).body.action, 'wake');
      assert.equal((await t.core.wake('demo', runOf(t).wakeId)).state, STATES.AWAKE);
    }
    assert.equal(runOf(t).state, STATES.AWAKE);
    assert.equal(replicasOf(t), 3);
    assert.deepEqual(scalerAnnotations(t), {});
    assert.equal(runOf(t).owners, undefined);
  });
}

test('the check: asleep with replicas up, none healthy yet: left asleep, as a VM starting', async () => {
  const t = await asleepPods();
  t.w.kube.unschedulable = true;
  t.w.kube.owners[OWNER].replicas = 2;
  await t.core.check();
  assert.equal(runOf(t).state, STATES.ASLEEP);
  assert.equal(logged(t, 'ExternalWake').length, 0);
});

test('the check: KEDA that could not be given back stays recorded, and the next check tries again', async () => {
  const t = await asleepPods(withScaler());
  t.w.kube.owners[OWNER].replicas = 2;
  t.w.kube.denied = ['patch scaledobjects'];
  await t.core.check();
  assert.equal(runOf(t).state, STATES.AWAKE);
  assert.equal(runOf(t).owners.length, 1);
  assert.equal(logged(t, 'AutoscalersNotGivenBack').length, 1);
  t.w.kube.denied = [];
  await t.core.check();
  assert.equal(runOf(t).owners, undefined);
  assert.deepEqual(scalerAnnotations(t), {});
});

for (const healthAtZero of ['none', 'unhealthy']) {
  test(`the check: awake at 0 is as a VM stopped by hand: the switch, then ASLEEP (a NEG at 0 reads ${healthAtZero})`, async () => {
    const t = await withPods((w) => { w.gkeReading.healthAtZero = healthAtZero; });
    t.w.kube.owners[OWNER].replicas = 0;
    await t.core.check();
    assert.equal(logged(t, 'ExternalStop').length, 1);
    assert.equal(runOf(t).state, STATES.ASLEEP);
    assert.ok(t.w.urlMaps.lb.pathMatchers[0].defaultCustomErrorResponsePolicy, 'the switch');
    assert.equal(t.w.logs.find((l) => l.event === 'StateChanged' && l.to === STATES.ASLEEP).cause, 'external-stop');
    // Nothing recorded: its wake brings 1.
    assert.equal((await wakePods(t)).state, STATES.AWAKE);
    assert.equal(replicasOf(t), 1);
  });
}

test('the check: an owner gone or rolling is left as it is; the state unchanged, nothing scaled', async () => {
  const t = await withPods();
  delete t.w.kube.owners[OWNER];
  await t.core.check();
  assert.equal(runOf(t).state, STATES.AWAKE);
  assert.deepEqual(t.w.changes, []);
  const asleep = await asleepPods();
  delete asleep.w.kube.owners[OWNER];
  await asleep.core.check();
  assert.equal(runOf(asleep).state, STATES.ASLEEP);
});

test('the check: a cluster out of reach stops only that workload\'s check, and changes nothing', async () => {
  const t = await withPods();
  t.w.kube.down = true;
  const [result] = await t.core.check();
  assert.match(result.error, /did not answer/);
  assert.equal(runOf(t).state, STATES.AWAKE);
  assert.deepEqual(t.w.changes, []);
});

test('the check: an idle owner is napped, as a VM: the backend service\'s requests decide', async () => {
  const t = await withPods();
  t.clock.advance(3_600_000);
  const [result] = await t.core.check();
  assert.equal(result.nap, 'requested');
  assert.equal(t.w.tasks.at(-1).body.action, 'nap');
});

// --- With the rest ------------------------------------------------------------------------------------------------------------------------------------------------------------

test('a companion with an owner as its primary: down after the pods, up before them', async () => {
  const t = await withPods((w) => { w.sql.db = {}; }, { ...GKE_INPUT, cloudSql: ['db'] });
  assert.equal(t.store.configs.get('demo').wakeTimeoutSeconds, 1700);
  assert.equal((await t.core.nap('demo')).state, STATES.ASLEEP);
  assert.deepEqual(t.w.changes, ['map lb', SCALE_0, 'sql db NEVER']);
  t.clock.advance(t.w.sqlTakes.NEVER);
  t.w.changes.length = 0;
  assert.equal((await wakePods(t)).state, STATES.AWAKE);
  assert.deepEqual(t.w.changes, ['sql db ALWAYS', 'scale shop/web 2', 'map lb']);
});

test('the companion follows the owner\'s state at the check', async () => {
  const t = await asleepPods((w) => { w.sql.db = {}; }, { ...GKE_INPUT, cloudSql: ['db'] });
  t.clock.advance(t.w.sqlTakes.NEVER);
  t.w.sql.db.settings = { activationPolicy: 'ALWAYS' };
  await t.core.check();
  assert.equal(runOf(t).state, STATES.ASLEEP);
  assert.ok(t.w.changes.includes('sql db NEVER'));
});

for (const [name, world, waits] of [
  ['regional', (w) => {
    const { backends } = w.services.app;
    regionalWorld(w);
    w.regions['europe-west1'].services.app.backends = backends;
  }, 100_000],
  ['classic', classic, 250_000],
]) {
  test(`pods under a ${name} load balancer's swap: swapped, waited, scaled; scaled, healthy, unswapped, waited`, async () => {
    const t = await withPods(world);
    assert.equal((await t.core.nap('demo')).state, STATES.ASLEEP);
    assert.deepEqual(t.w.changes, ['map lb', SCALE_0]);
    assert.equal(runOf(t).owners[0].replicas, 2);
    t.w.changes.length = 0;
    const before = t.clock.now();
    assert.equal((await wakePods(t)).state, STATES.AWAKE);
    assert.deepEqual(t.w.changes, ['scale shop/web 2', 'map lb']);
    assert.ok(t.clock.now() - before >= waits);
  });
}

test('a nap, a wake and a check call nothing outside the namespace, and no node', async () => {
  const t = await asleepPods(withScaler());
  await wakePods(t);
  t.clock.advance(3_600_000);
  await t.core.check();
  assert.ok(t.w.kube.calls.length > 0);
  for (const call of t.w.kube.calls) assert.match(call, /^(GET|PATCH) \/(api\/v1|apis\/[^/]+\/[^/]+)\/namespaces\/shop\//, call);
});

test('the fake refuses what the Role does not hold: a node\'s read is a 403, so that passing above says something', async () => {
  const t = await withPods();
  await assert.rejects((await t.gke.kubernetesOf(CLUSTER)).get('/api/v1/nodes/gke-shop-node-1'), (err) => err.status === 403);
  await assert.rejects((await t.gke.kubernetesOf(CLUSTER)).list('/apis/apps/v1/deployments'), (err) => err.status === 403);
});

test('a VM workload reads no cluster, whatever is done to it', async () => {
  const t = worldOf();
  await t.onboarding.onboard({ urlMap: 'lb', backendService: 'app', id: 'demo' });
  await t.core.nap('demo');
  await t.core.check();
  await wakePods(t);
  assert.deepEqual(t.w.kube.calls, []);
  assert.equal(runOf(t).owners, undefined);
  assert.equal([...t.w.used].some((name) => name.startsWith('gke.')), false);
});

test('a StatefulSet naps and wakes as a Deployment: its pods are its own, with no ReplicaSet', async () => {
  const STATEFUL = 'StatefulSet shop/db';
  const t = await withPods((w) => {
    delete w.kube.owners[OWNER];
    w.kube.owners[STATEFUL] = { replicas: 3 };
    w.negs[GKE_NEG].gkeOwner = STATEFUL;
  }, { ...GKE_INPUT, gke: { ...GKE_INPUT.gke, owner: { kind: 'StatefulSet', name: 'db' } } });
  assert.equal((await t.core.nap('demo')).state, STATES.ASLEEP);
  assert.equal(t.w.kube.owners[STATEFUL].replicas, 0);
  assert.equal(t.w.kube.calls.some((call) => call.includes('replicasets')), false);
  assert.equal((await wakePods(t)).state, STATES.AWAKE);
  assert.equal(t.w.kube.owners[STATEFUL].replicas, 3);
});

test('what a nap records of an owner goes through Firestore\'s fields unchanged', async () => {
  const t = await asleepPods(withScaler({ [KEDA_PAUSE]: '4' }));
  const [record] = runOf(t).owners;
  assert.deepEqual(record, {
    kind: 'k8s',
    id: 'europe-west1-b/shop/shop/Deployment/web',
    cluster: CLUSTER,
    namespace: 'shop',
    owner: { kind: 'Deployment', name: 'web' },
    replicas: 2,
    keda: { name: 'web-scaler', paused: '4' },
  });
  assert.deepEqual(fromFields(toFields(record)), record);
  const none = await asleepPods();
  assert.deepEqual(fromFields(toFields(runOf(none).owners[0])), runOf(none).owners[0]);
});

// --- Ready pods with no endpoint: an empty NEG proves nothing of the owner -----------------------------------------------------------------------------------------------------

const NOT_BEHIND = /its network endpoint groups hold no endpoint, and Deployment shop\/web has ready pods, not shown to be behind this load balancer: nothing is scaled/;

test('ready pods behind an empty NEG: no scale, no switch, back awake, worded: they may serve some other way', async () => {
  const t = await withPods();
  t.w.negs[GKE_NEG].empty = true;
  const out = await t.core.nap('demo');
  assert.equal(out.state, STATES.AWAKE);
  assert.equal(out.aborted, true);
  assert.match(out.error, NOT_BEHIND);
  assert.deepEqual(t.w.changes, []);
  assert.equal(replicasOf(t), 2);
  assert.equal(t.w.logs.find((l) => l.event === 'StateChanged' && l.to === STATES.AWAKE).cause, 'backends-changed');
});

test('a NEG emptied during the nap\'s wait, its pods still ready: back awake, nothing scaled', async () => {
  const t = await withPods();
  t.w.on['PUT global/urlMaps/lb'] = () => { t.w.negs[GKE_NEG].empty = true; };
  const out = await t.core.nap('demo');
  assert.equal(out.aborted, true);
  assert.match(out.error, NOT_BEHIND);
  assert.equal(replicasOf(t), 2);
});

test('a release of ready pods behind an empty NEG: nothing scaled, still failed', async () => {
  const t = await withPods();
  runOf(t).state = STATES.FAILED;
  t.w.negs[GKE_NEG].empty = true;
  const out = await t.core.release('demo');
  assert.equal(out.state, STATES.FAILED);
  assert.match(out.error, NOT_BEHIND);
  assert.equal(replicasOf(t), 2);
});

test('one NEG empty, another holding the owner\'s pods: it is behind the load balancer, and naps', async () => {
  const t = await withPods((w) => {
    w.negs.other = { gkeOwner: OWNER, zone: 'europe-west1-c', empty: true, ...NEG_READINGS.description('shop', 'web') };
    w.services.app.backends.push({ group: `${V1}/zones/europe-west1-c/networkEndpointGroups/other` });
  });
  assert.equal((await t.core.nap('demo')).state, STATES.ASLEEP);
});

for (const [name, change] of [
  ['an owner at 0', (w) => { w.kube.owners[OWNER].replicas = 0; }],
  ['pods not ready yet', (w) => { w.kube.unschedulable = true; }],
  ['pods only leaving, after an earlier scale to 0', (w) => { Object.assign(w.kube.owners[OWNER], { replicas: 0, leavingFrom: 2, leavingReads: 5 }); }],
]) {
  test(`an empty NEG with ${name}: nothing ready to lose, and it naps`, async () => {
    const t = await withPods();
    t.w.negs[GKE_NEG].empty = true;
    change(t.w);
    assert.equal((await t.core.nap('demo')).state, STATES.ASLEEP);
  });
}

// --- What a regression would lose unseen -------------------------------------------------------------------------------------------------------------------------------------

// `at` the nap's commit point, when the record is written and nothing is scaled yet: what happens between the checks and the scale.
const atCommit = (t, happen) => {
  const { transition } = t.store;
  t.store.transition = async (id, change) => {
    if (change.set?.stopping) happen();
    return transition(id, change);
  };
};

test('a nap that failed with KEDA paused and the pods up: its release keeps the customer\'s own pause, read now as Dormeto\'s 0', async () => {
  const t = await withPods(withScaler({ [KEDA_PAUSE]: '4' }));
  t.w.kube.denied = ['patch deployments/scale'];
  assert.equal((await t.core.nap('demo')).state, STATES.FAILED);
  assert.equal(scalerAnnotations(t)[KEDA_PAUSE], '0');
  assert.equal(replicasOf(t), 2);
  t.w.kube.denied = [];
  assert.equal((await t.core.release('demo')).state, STATES.ASLEEP);
  assert.equal(runOf(t).owners[0].keda.paused, '4');
  assert.equal((await wakePods(t)).state, STATES.AWAKE);
  assert.equal(scalerAnnotations(t)[KEDA_PAUSE], '4');
});

test('a release with no record yet (its nap failed before the commit) records the replicas: its wake brings them back', async () => {
  const t = await withPods((w) => { w.kube.owners[OWNER].replicas = 4; });
  runOf(t).state = STATES.FAILED;
  assert.equal(runOf(t).owners, undefined);
  assert.equal((await t.core.release('demo')).state, STATES.ASLEEP);
  assert.equal(replicasOf(t), 0);
  assert.equal(runOf(t).owners[0].replicas, 4);
  assert.equal((await wakePods(t)).state, STATES.AWAKE);
  assert.equal(replicasOf(t), 4);
});

test('an offboarding of an awake workload gives back the KEDA pause a check could not', async () => {
  const t = await asleepPods(withScaler({ [KEDA_PAUSE]: '4' }));
  t.w.kube.owners[OWNER].replicas = 2;
  t.w.kube.denied = ['patch scaledobjects'];
  await t.core.check();
  assert.equal(runOf(t).state, STATES.AWAKE);
  assert.equal(scalerAnnotations(t)[KEDA_PAUSE], '0');
  t.w.kube.denied = [];
  await t.onboarding.offboard('demo');
  assert.equal(scalerAnnotations(t)[KEDA_PAUSE], '4');
  assert.equal(t.store.configs.size, 0);
});

test('an owner deleted between the checks and the scale: failed, worded', async () => {
  const t = await withPods();
  atCommit(t, () => { delete t.w.kube.owners[OWNER]; });
  const out = await t.core.nap('demo');
  assert.equal(out.state, STATES.FAILED);
  assert.match(out.error, /Deployment shop\/web not found in GKE cluster europe-west1-b\/shop/);
  assert.equal(failureOfRun(t).kind, 'configuration');
});

test('a ScaledObject deleted between the read and the pause is not said to be the owner: it is there, and left at its replicas', async () => {
  const t = await withPods(withScaler());
  atCommit(t, () => { t.w.kube.scaledObjects.length = 0; });
  const out = await t.core.nap('demo');
  assert.equal(out.state, STATES.FAILED);
  assert.match(out.error, /scaledobjects\.keda\.sh "web-scaler" not found/);
  assert.doesNotMatch(out.error, /Deployment shop\/web not found/);
  assert.equal(replicasOf(t), 2);
});

test('a terminating pod is still the owner\'s: its endpoint, not gone yet, is no foreign one', async () => {
  const t = await withPods();
  Object.assign(t.w.kube.owners[OWNER], { leavingFrom: 3, leavingReads: 4 });
  t.w.negs[GKE_NEG].foreign = ['10.8.0.3'];
  assert.equal((await t.core.nap('demo')).state, STATES.ASLEEP);
});

test('pods ready, the load balancer\'s health check failing: unhealthy at the wake\'s deadline, and a check leaves it asleep', async () => {
  const t = await asleepPods();
  t.w.kube.unhealthy = true;
  t.w.kube.owners[OWNER].replicas = 2;
  await t.core.check();
  assert.equal(runOf(t).state, STATES.ASLEEP);
  const started = t.clock.now();
  assert.equal((await wakePods(t)).state, STATES.FAILED);
  assert.equal(failureOfRun(t).kind, 'unhealthy');
  assert.ok(t.clock.now() - started >= 300_000);
});
