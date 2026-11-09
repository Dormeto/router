import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FORMAT } from '../../lambda/src/lib/ip-lists.mjs';
import { STATES } from '../../lambda/src/lib/state.mjs';
import { fakeClock, fakeStore } from '../../lambda/test/fakes.mjs';
import { createController, PauseRefused } from '../src/controller-core.mjs';
import { fromFields, toFields } from '../src/firestore.mjs';
import { eventOf } from '../src/rows.mjs';
import { GoogleError, OPERATION_NOT_DONE } from '../src/google.mjs';
import { createLogs } from '../src/logs.mjs';
import { createUrlMaps, withErrorPolicy, withSwap } from '../src/urlmaps.mjs';
import {
  CLUSTER, GKE_INPUT, GKE_NEG, NEG_READINGS, OWNER, REGION, classic, clockTimers, heartbeatStore, idleReadsStore, onGke, sweepStore, regional as regionalWorld, regionalUrl, setup as worldOf,
  unmanagedUrl, virtualClock,
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
// `nodeTimers`: the heartbeat on the controller's own timer, Node's, not on the fake clock. `logs`: the router's log view (DMT_LOG_VIEW),
// what it answers (requests, null, or a function of the query); none, no view. `logConfig`: the backend service's.
// `network.fetch`: the favicon's network at a nap, none unless a test sets it, so that no test reaches one. `customPages`: the install's
// switch (DMT_CUSTOM_PAGES).
function setup({
  run = { state: STATES.AWAKE, awakeSince: 1 }, cfg = {}, vms = {}, groups = {}, autoscalers = {}, machineTypes = {}, map = mapOf(), requests = 0, unhealthyPolls = 0, lists, download,
  nodeTimers = false, logs, logConfig, customPages = false,
} = {}) {
  const network = { fetch: async () => { throw new Error('no network in tests'); }, calls: [] };
  const clock = fakeClock();
  const world = {
    vms: Object.fromEntries(Object.entries(vms).map(([name, vm]) => [name, { machineType: `${V1}/zones/${ZONE}/machineTypes/e2-small`, ...vm }])),
    groups,
    autoscalers,
    machineTypes: { 'e2-small': { memoryMb: 2048 }, ...machineTypes },
    map,
    requests,
    logEntries: logs,
    logConfig,
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
    logReads: [],
    serviceReads: [],
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
  const { every, timers } = clockTimers(clock);
  Object.assign(store, heartbeatStore(() => store.state.run, clock.now), sweepStore(clock.now), idleReadsStore(() => store.state.run));
  // The Firestore store's names, and what its fields do to a value: an `undefined` comes back null.
  // The Firestore store's router documents: router/check and router/manager (state.managerSettings, as the store reads it).
  store.putCheck = async (summary) => {
    store.state.check = fromFields(toFields(summary));
  };
  store.getManagerSettings = async () => structuredClone(store.state.managerSettings ?? null);
  store.getRouterPause = async () => structuredClone(store.state.pauses.find((p) => p.workloadId === null) ?? null);
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
    setMachineType: (zone, name, type) => change(`setMachineType ${name} ${type}`, () => { world.vms[name].machineType = `${V1}/zones/${ZONE}/machineTypes/${type}`; }),
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
    getBackendService: async (name) => {
      world.healthScopes.add('global');
      world.serviceReads.push(`global ${name}`);
      if (world.serviceRefused) throw world.serviceRefused;
      return { backends: [{ group: 'ig-url' }], ...(world.logConfig ? { logConfig: structuredClone(world.logConfig) } : {}) };
    },
    getBackendServiceHealth: async () => {
      world.healthScopes.add('global');
      return health();
    },
    getRegionBackendService: async (region, name) => {
      world.healthScopes.add(region);
      world.serviceReads.push(`${region} ${name}`);
      return { backends: [{ group: 'ig-url' }], ...(world.logConfig ? { logConfig: structuredClone(world.logConfig) } : {}) };
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
    // A wait is a sleep of a minute or more, or the swap's own where it is shorter (regional internal's 30 s, which a swap test sets).
    if (ms >= MINUTE || ms === world.swapWaitMs) world.calls.push(`wait ${ms / 1000} s`);
    await clock.sleep(ms);
  };
  const urlmaps = createUrlMaps({ google, project: 'p', now: clock.now, sleep });
  const regionalUrlmaps = createUrlMaps({ google, project: 'p', region: 'europe-west1', scope: 'regional', now: clock.now, sleep });
  const controller = createController({
    store,
    compute,
    urlmaps,
    regionalUrlmaps,
    monitoring: {
      requestCount: async (query) => {
        world.metricReads.push(query);
        return typeof world.requests === 'function' ? world.requests(query) : world.requests;
      },
    },
    ...(logs === undefined ? {} : {
      logs: {
        requests: async (query) => {
          world.logReads.push(query);
          return structuredClone(await (typeof world.logEntries === 'function' ? world.logEntries(query) : world.logEntries));
        },
      },
    }),
    tasks: {
      enqueue: async (task) => {
        if (world.taskRefused) throw world.taskRefused;
        world.tasks.push(task);
        world.onTask?.(task);
      },
    },
    config: { project: 'p', region: 'europe-west1', controllerUrl: CONTROLLER, version: '0.40.0', build: 'abc123' },
    lists,
    download,
    now: clock.now,
    sleep,
    ...(nodeTimers ? {} : { every }),
    log,
    newId: () => 'wake-2',
    fetch: (...args) => {
      network.calls.push(args[0]);
      return network.fetch(...args);
    },
    customPages,
  });
  return { controller, store, clock, world, timers, urlmaps, regionalUrlmaps, network, run: () => store.state.run, logged: (event) => world.logs.filter((l) => l.event === event) };
}

// When each beat was asked, written or not.
function beatsOf(t) {
  const asked = [];
  const { beat } = t.store;
  t.store.beat = (...args) => {
    asked.push(t.clock.now());
    return beat(...args);
  };
  return asked;
}

const waking = (at, more = {}) => ({ state: STATES.WAKING, wakeId: 'w1', wakeStartedAt: at, ...more });
const START = 1_700_000_000_000;

// The request logs (L): what the log view answers (logs.mjs), scanners, a bot and a HEAD, and a backend service logging every request.
const BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
// A request as the log view answers it (logs.mjs).
const entry = (path, { method = 'GET', userAgent = BROWSER, remoteIp = '203.0.113.7' } = {}) => ({
  method, url: `https://demo.example.com${path}`, path, userAgent, remoteIp,
});
const SCANNERS = [
  entry('/.env'), entry('/wp-login.php'), entry('/', { userAgent: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' }), entry('/', { method: 'HEAD' }),
];
const EVERY_REQUEST = { enable: true, sampleRate: 1 };

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

// Capacity (vision docs/specs/2026-11-08-google-cloud-router-features-design.md, section 6): AWS's retries within the wake, and a VM's
// fallback machine types, given back after the next stop.
const stockout = () => new GoogleError("Google: operation compute.instances.start: ZONE_RESOURCE_POOL_EXHAUSTED: The zone 'europe-west1-b' does not have enough resources", { reason: 'ZONE_RESOURCE_POOL_EXHAUSTED' });
const forbidden = () => new GoogleError("Google: POST setMachineType: 403 Required 'compute.instances.setMachineType' permission for 'projects/p/zones/europe-west1-b/instances/vm-a'", { code: 403 });
const SET_TYPE_REFUSED = 'the router\'s role lacks compute.instances.setMachineType: run dormeto gcp install again';
// The next `times` asks of `line` refused, for capacity unless said.
const refusedFor = (t, line, times, error = stockout) => {
  let left = times;
  t.world.on[line] = async () => {
    if (left <= 0) return;
    left -= 1;
    throw error();
  };
};
const typeUrl = (type) => `${V1}/zones/${ZONE}/machineTypes/${type}`;
const typeOf = (t, name) => t.world.vms[name].machineType.slice(t.world.vms[name].machineType.lastIndexOf('/') + 1);
const FALLBACK = { fallbackInstanceTypes: ['e2-medium'] };
const ON_FALLBACK = { 'vm-a': { from: 'e2-small', to: 'e2-medium' } };
const fieldsOf = (lines) => lines.map(({ level, event, ...fields }) => [level, fields]);

test('a start refused for capacity until the wake\'s deadline: tried again after 30 s, 60 s, then every 120 s, then FAILED with the kind capacity, the policy kept', async () => {
  const t = setup({ run: waking(START), vms: { 'vm-a': { status: 'TERMINATED' } }, map: asleepMap() });
  t.world.on['start vm-a'] = async () => { throw stockout(); };
  const out = await t.controller.wake('demo', 'w1');
  assert.equal(out.state, STATES.FAILED);
  // At 570 s, the next wait would pass the 600 s of the wake.
  assert.deepEqual(t.world.sleeps, [30_000, 60_000, 120_000, 120_000, 120_000, 120_000]);
  assert.equal(t.world.calls.filter((call) => call === 'start vm-a').length, 7);
  assert.equal(t.run().state, STATES.FAILED);
  assert.equal(JSON.parse(t.run().failure).kind, 'capacity');
  assert.equal(JSON.parse(t.run().failure).step, 'wake');
  assert.equal(t.run().failedAt, t.clock.now());
  assert.equal(t.run().consecutiveFailures, 1);
  assert.equal(hasPolicy(t.world.map), true);
  assert.equal(t.logged('WakeFailed')[0].kind, 'capacity');
});

test('a start refused for capacity falls back to the list\'s next type: e2-medium set on the stopped VM, started on it, on the run and in the AWAKE event', async () => {
  const t = setup({ run: waking(START), cfg: FALLBACK, vms: { 'vm-a': { status: 'TERMINATED' } } });
  refusedFor(t, 'start vm-a', 2);
  assert.equal((await t.controller.wake('demo', 'w1')).state, STATES.AWAKE);
  // Refused on its own type, then on e2-medium, the list's last: started on it 30 s later.
  assert.deepEqual(t.world.calls, ['start vm-a', 'setMachineType vm-a e2-medium', 'start vm-a', 'start vm-a']);
  assert.deepEqual(t.world.sleeps, [30_000]);
  assert.equal(typeOf(t, 'vm-a'), 'e2-medium');
  assert.deepEqual(t.run().instanceTypes, ON_FALLBACK);
  assert.deepEqual(t.logged('StateChanged').find((l) => l.to === STATES.AWAKE).fallbacks, ON_FALLBACK);
  assert.deepEqual(fieldsOf(t.logged('InstanceTypeFallback')), [['warn', { workloadId: 'demo', wakeId: 'w1', instance: 'vm-a', from: 'e2-small', to: 'e2-medium' }]]);
});

test('the record is on the run before the machine type changes, so that a request that dies leaves the next stop what to give back; two VMs falling back at once both stay on it', async () => {
  const t = setup({ run: waking(START), cfg: { ...FALLBACK, backends: [VM_A, VM_B] }, vms: { 'vm-a': { status: 'TERMINATED' }, 'vm-b': { status: 'TERMINATED' } } });
  refusedFor(t, 'start vm-a', 1);
  refusedFor(t, 'start vm-b', 1);
  let atChange;
  t.world.on['setMachineType vm-a e2-medium'] = async () => { atChange = t.run().instanceTypes; };
  assert.equal((await t.controller.wake('demo', 'w1')).state, STATES.AWAKE);
  assert.deepEqual(atChange?.['vm-a'], { from: 'e2-small', to: 'e2-medium' });
  const both = { 'vm-a': { from: 'e2-small', to: 'e2-medium' }, 'vm-b': { from: 'e2-small', to: 'e2-medium' } };
  assert.deepEqual(t.run().instanceTypes, both);
  assert.deepEqual(t.logged('StateChanged').find((l) => l.to === STATES.AWAKE).fallbacks, both);
});

test('the list in its order, each type once: from stays the VM\'s own type', async () => {
  const t = setup({ run: waking(START), cfg: { fallbackInstanceTypes: ['e2-medium', 'e2-standard-2'] }, vms: { 'vm-a': { status: 'TERMINATED' } } });
  refusedFor(t, 'start vm-a', 2);
  await t.controller.wake('demo', 'w1');
  assert.deepEqual(t.world.calls, ['start vm-a', 'setMachineType vm-a e2-medium', 'start vm-a', 'setMachineType vm-a e2-standard-2', 'start vm-a']);
  assert.deepEqual(t.world.sleeps, []);
  assert.deepEqual(t.run().instanceTypes, { 'vm-a': { from: 'e2-small', to: 'e2-standard-2' } });
  assert.deepEqual(t.logged('InstanceTypeFallback').map((l) => l.to), ['e2-medium', 'e2-standard-2']);
});

test('the list exhausted: the VM stays on its last type, tried again after 30 s, then 60 s', async () => {
  const t = setup({ run: waking(START), cfg: FALLBACK, vms: { 'vm-a': { status: 'TERMINATED' } } });
  refusedFor(t, 'start vm-a', 3);
  assert.equal((await t.controller.wake('demo', 'w1')).state, STATES.AWAKE);
  assert.deepEqual(t.world.calls, ['start vm-a', 'setMachineType vm-a e2-medium', 'start vm-a', 'start vm-a', 'wait 60 s', 'start vm-a']);
  assert.deepEqual(t.world.sleeps, [30_000, 60_000]);
  assert.equal(typeOf(t, 'vm-a'), 'e2-medium');
  assert.deepEqual(t.run().instanceTypes, ON_FALLBACK);
});

test('a suspended VM only resumes, on its own type: a resume refused for capacity is tried again, no machine type changed', async () => {
  const t = setup({ run: waking(START), cfg: FALLBACK, vms: { 'vm-a': { status: 'SUSPENDED' } } });
  refusedFor(t, 'resume vm-a', 1);
  assert.equal((await t.controller.wake('demo', 'w1')).state, STATES.AWAKE);
  assert.deepEqual(t.world.calls, ['resume vm-a', 'resume vm-a']);
  assert.deepEqual(t.world.sleeps, [30_000]);
  assert.equal(typeOf(t, 'vm-a'), 'e2-small');
  assert.equal(t.run().instanceTypes, undefined);
});

test('a managed group\'s start refused for capacity: tried again after 30 s, no machine type changed', async () => {
  const t = setup({ run: waking(START), cfg: { backends: [MIG], ...FALLBACK }, groups: { mig: [managed('mig-1', 'TERMINATED')] } });
  refusedFor(t, 'start mig mig-1', 1);
  assert.equal((await t.controller.wake('demo', 'w1')).state, STATES.AWAKE);
  assert.deepEqual(t.world.calls, ['start mig mig-1', 'start mig mig-1']);
  assert.deepEqual(t.world.sleeps, [30_000]);
  assert.equal(t.run().instanceTypes, undefined);
});

test('a start refused for quota (QUOTA_EXCEEDED): no retry, no fallback, FAILED with the kind quota', async () => {
  const t = setup({ run: waking(START), cfg: FALLBACK, vms: { 'vm-a': { status: 'TERMINATED' } } });
  t.world.on['start vm-a'] = async () => {
    throw new GoogleError("Google: operation compute.instances.start: QUOTA_EXCEEDED: Quota 'CPUS' exceeded. Limit: 8.0 in region europe-west1.", { reason: 'QUOTA_EXCEEDED' });
  };
  assert.equal((await t.controller.wake('demo', 'w1')).state, STATES.FAILED);
  assert.equal(JSON.parse(t.run().failure).kind, 'quota');
  assert.deepEqual(t.world.calls, ['start vm-a']);
  assert.deepEqual(t.world.sleeps, []);
});

test('a fallback refused for the permission (403): FAILED with the kind permission, in words that say what to do; the VM on its own type, nothing on the run', async () => {
  const t = setup({ run: waking(START), cfg: FALLBACK, vms: { 'vm-a': { status: 'TERMINATED' } } });
  refusedFor(t, 'start vm-a', 1);
  refusedFor(t, 'setMachineType vm-a e2-medium', 1, forbidden);
  assert.equal((await t.controller.wake('demo', 'w1')).state, STATES.FAILED);
  assert.deepEqual(JSON.parse(t.run().failure), { kind: 'permission', step: 'wake', message: SET_TYPE_REFUSED, at: t.clock.now() });
  assert.equal(typeOf(t, 'vm-a'), 'e2-small');
  assert.equal(t.run().instanceTypes, undefined);
  assert.deepEqual(t.logged('InstanceTypeFallback'), []);
});

test('a VM a nap could not give its own type back: the next wake sets it first and starts it on it, and the run forgets it', async () => {
  const t = setup({ run: waking(START, { instanceTypes: ON_FALLBACK }), cfg: FALLBACK, vms: { 'vm-a': { status: 'TERMINATED', machineType: typeUrl('e2-medium') } } });
  assert.equal((await t.controller.wake('demo', 'w1')).state, STATES.AWAKE);
  assert.deepEqual(t.world.calls, ['setMachineType vm-a e2-small', 'start vm-a']);
  assert.equal(typeOf(t, 'vm-a'), 'e2-small');
  assert.equal(t.run().instanceTypes, undefined);
  assert.equal(t.logged('StateChanged').find((l) => l.to === STATES.AWAKE).fallbacks, undefined);
});

// The live acceptance (2026-11-09): the start's operation failed on the global quota, its status 403.
const GLOBAL_QUOTA = "Google: operation start https://www.googleapis.com/compute/v1/projects/dormeto-dev/zones/europe-west1-b/instances/dmt-demo: QUOTA_EXCEEDED: Quota 'CPUS_ALL_REGIONS' exceeded.  Limit: 32.0 globally.";
for (const [name, error, kind] of [
  ['the live message, its operation\'s status 403', () => new GoogleError(GLOBAL_QUOTA, { code: 403, reason: 'QUOTA_EXCEEDED' }), 'quota'],
  ['a call\'s reason quotaExceeded on a 403', () => new GoogleError('Google: POST: 403 Quota exceeded', { code: 403, reason: 'quotaExceeded' }), 'quota'],
  ['a call\'s reason rateLimitExceeded on a 403', () => new GoogleError('Google: POST: 403 Rate limit exceeded', { code: 403, reason: 'rateLimitExceeded' }), 'throttled'],
  ['a stockout on a 403 stays capacity', () => new GoogleError('Google: operation start: ZONE_RESOURCE_POOL_EXHAUSTED: no capacity', { code: 403, reason: 'ZONE_RESOURCE_POOL_EXHAUSTED' }), 'capacity'],
  ['a real refusal stays permission', () => new GoogleError("Google: POST: 403 Required 'compute.instances.start' permission", { code: 403, reason: 'forbidden' }), 'permission'],
]) {
  test(`a start's failure, ${name}: the kind ${kind}`, async () => {
    const t = setup({ run: waking(START), vms: { 'vm-a': { status: 'TERMINATED' } } });
    t.world.on['start vm-a'] = async () => { throw error(); };
    await t.controller.wake('demo', 'w1');
    assert.equal(JSON.parse(t.run().failure).kind, kind);
  });
}

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

// --- The heartbeat (F5): a running wake or nap says so on its run, and a lost one is acted on in minutes ---------------------

const NAPPING_BEATING = (more = {}) => ({ state: STATES.NAPPING, napId: 'n1', stateAt: START - 10 * MINUTE, updatedAt: START - 10 * MINUTE, ...more });
const oops = () => new GoogleError('Google: POST: 500 oops', { code: 500 });

test('a wake beats on its run at its start, then every 60 s, and stops at its end: no timer left', async () => {
  const t = setup({ run: waking(START), vms: { 'vm-a': { status: 'TERMINATED' } }, unhealthyPolls: 100 });
  const beats = beatsOf(t);
  assert.equal((await t.controller.wake('demo', 'w1')).state, STATES.AWAKE);
  assert.deepEqual(beats.map((at) => at - START), [0, 60_000, 120_000, 180_000]);
  assert.equal(t.run().beatAt, START + 180_000);
  assert.equal(t.timers.size, 0);
});

test('the heartbeat\'s own timer is Node\'s interval: a beat a minute during the wake, none once it ended', async (context) => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  const t = setup({ run: waking(START), vms: { 'vm-a': { status: 'TERMINATED' } }, nodeTimers: true });
  const beats = beatsOf(t);
  t.world.on['start vm-a'] = async () => {
    context.mock.timers.tick(60_000);
  };
  assert.equal((await t.controller.wake('demo', 'w1')).state, STATES.AWAKE);
  assert.equal(beats.length, 2);
  context.mock.timers.tick(10 * 60_000);
  await new Promise(setImmediate);
  assert.equal(beats.length, 2);
});

test('a wake\'s heartbeat stops whatever ends it: failed, superseded, or a failure it cannot even write', async () => {
  const failed = setup({ run: waking(START), vms: { 'vm-a': { status: 'TERMINATED' } } });
  failed.world.on['start vm-a'] = async () => { throw oops(); };
  assert.equal((await failed.controller.wake('demo', 'w1')).state, STATES.FAILED);
  assert.equal(failed.timers.size, 0);

  const superseded = setup({ run: waking(START, { wakeId: 'w2' }) });
  assert.equal((await superseded.controller.wake('demo', 'w1')).state, 'SUPERSEDED');
  assert.equal(superseded.timers.size, 0);
  assert.equal(superseded.run().beatAt, undefined);

  const unwritten = setup({ run: waking(START), vms: { 'vm-a': { status: 'TERMINATED' } } });
  unwritten.world.on['start vm-a'] = async () => { throw oops(); };
  unwritten.store.transition = async () => { throw new GoogleError('Google: POST: 503 firestore', { code: 503 }); };
  await assert.rejects(unwritten.controller.wake('demo', 'w1'), /503 firestore/);
  assert.equal(unwritten.timers.size, 0);
});

test('a nap beats with its napId from NAPPING to its end, and stops whatever ends it: asleep, given up, failed; skipped, none', async () => {
  const t = setup({ vms: { 'vm-a': { status: 'RUNNING' } } });
  const beats = beatsOf(t);
  assert.equal((await t.controller.nap('demo')).state, STATES.ASLEEP);
  assert.equal(t.run().napId, 'wake-2');
  // The policy's wait is one sleep of 300 s: its ticks make one beat.
  assert.deepEqual(beats.map((at) => at - START), [0, 300_000]);
  assert.equal(t.run().beatAt, START + 300_000);
  assert.equal(t.timers.size, 0);

  const givenUp = setup({ cfg: { backends: [{ ...VM_A, neg: { zone: ZONE, name: 'neg' } }] }, vms: { 'vm-a': { status: 'RUNNING' } } });
  assert.equal((await givenUp.controller.nap('demo')).aborted, true);
  assert.equal(givenUp.timers.size, 0);

  const failed = setup({ cfg: { hibernate: false }, vms: { 'vm-a': { status: 'RUNNING' } } });
  failed.world.on['stop vm-a'] = async () => { throw oops(); };
  assert.equal((await failed.controller.nap('demo')).state, STATES.FAILED);
  assert.equal(failed.timers.size, 0);

  const skipped = setup({ run: { state: STATES.ASLEEP } });
  const none = beatsOf(skipped);
  assert.equal((await skipped.controller.nap('demo')).state, 'SKIPPED');
  assert.deepEqual(none, []);
  assert.equal(skipped.timers.size, 0);
});

test('a beat whose write throws: said each time, and the wake goes on to AWAKE; a nap to ASLEEP', async () => {
  const t = setup({ run: waking(START), vms: { 'vm-a': { status: 'TERMINATED' } }, unhealthyPolls: 40 });
  t.store.beat = async () => { throw new GoogleError('Google: POST: 503 firestore', { code: 503 }); };
  assert.equal((await t.controller.wake('demo', 'w1')).state, STATES.AWAKE);
  // The beats at 0 and 60 s, each tried again 10 s later.
  assert.deepEqual(t.logged('BeatFailed').map(({ level, workloadId, wakeId, error }) => [level, workloadId, wakeId, error]), Array(4).fill(
    ['warn', 'demo', 'w1', 'Google: POST: 503 firestore'],
  ));
  assert.equal(t.timers.size, 0);

  const nap = setup({ vms: { 'vm-a': { status: 'RUNNING' } } });
  nap.store.beat = () => { throw new TypeError('no beat here'); };
  assert.equal((await nap.controller.nap('demo')).state, STATES.ASLEEP);
  // The first beat, its retry, and the beat of the policy's one 300 s sleep (whose retry the nap's end stops).
  assert.deepEqual(nap.logged('BeatFailed').map((l) => [l.napId, l.error]), Array(3).fill(['wake-2', 'no beat here']));
  assert.equal(nap.timers.size, 0);
});

// A late task's first beat matters most: one that fails would leave the run without a beat for a minute, past the 90 s, and a
// visitor's poll would send a healthy wake again.
test('a beat that fails is tried again once, 10 s later, without holding the wake: the run beats within seconds', async () => {
  const t = setup({ run: waking(START - 40_000), vms: { 'vm-a': { status: 'TERMINATED' } }, unhealthyPolls: 40 });
  const { beat } = t.store;
  let failures = 1;
  t.store.beat = async (...args) => {
    if (failures-- > 0) throw oops();
    return beat(...args);
  };
  const beats = beatsOf(t);
  let startedAt;
  t.world.on['start vm-a'] = async () => { startedAt = t.clock.now(); };
  assert.equal((await t.controller.wake('demo', 'w1')).state, STATES.AWAKE);
  assert.equal(startedAt, START);
  assert.deepEqual(beats.map((at) => at - START), [0, 10_000, 60_000]);
  assert.equal(t.logged('BeatFailed').length, 1);
  assert.equal(t.timers.size, 0);
});

test('the retry on Node\'s interval ticks once: 10 s after the failed beat, and never again', async (context) => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  const t = setup({ run: waking(START), vms: { 'vm-a': { status: 'TERMINATED' } }, nodeTimers: true });
  const { beat } = t.store;
  let failures = 1;
  t.store.beat = async (...args) => {
    if (failures-- > 0) throw oops();
    return beat(...args);
  };
  const beats = beatsOf(t);
  t.world.on['start vm-a'] = async () => {
    for (let s = 0; s < 50; s += 1) {
      context.mock.timers.tick(1000);
      await new Promise(setImmediate);
    }
  };
  assert.equal((await t.controller.wake('demo', 'w1')).state, STATES.AWAKE);
  assert.equal(beats.length, 2);
  assert.equal(t.run().beatAt, START);
  context.mock.timers.tick(10 * 60_000);
  await new Promise(setImmediate);
  assert.equal(beats.length, 2);
});

test('a beat tried again that fails too waits for the next minute\'s: once per failed beat, none pending once the wake ends', async () => {
  const t = setup({ run: waking(START), vms: { 'vm-a': { status: 'TERMINATED' } }, unhealthyPolls: 40 });
  t.store.beat = async () => { throw oops(); };
  const beats = beatsOf(t);
  assert.equal((await t.controller.wake('demo', 'w1')).state, STATES.AWAKE);
  assert.deepEqual(beats.map((at) => at - START), [0, 10_000, 60_000, 70_000]);
  assert.equal(t.timers.size, 0);
  const ended = setup({ run: waking(START), vms: { 'vm-a': { status: 'TERMINATED' } }, unhealthyPolls: 2 });
  ended.store.beat = async () => { throw oops(); };
  assert.equal((await ended.controller.wake('demo', 'w1')).state, STATES.AWAKE);
  assert.equal(ended.timers.size, 0);
});

test('the check sweeps the counters older than 35 days once a UTC day, logging StatsSwept with the count', async () => {
  const t = setup({ vms: { 'vm-a': { status: 'RUNNING' } } });
  await t.controller.check();
  assert.deepEqual(t.store.swept, [START - 35 * 86_400_000]);
  assert.deepEqual(t.logged('StatsSwept'), [{ level: 'info', event: 'StatsSwept', swept: 3 }]);
  t.clock.advance(60_000);
  await t.controller.check();
  assert.equal(t.store.swept.length, 1);
  t.clock.advance(25 * 3_600_000);
  await t.controller.check();
  assert.equal(t.store.swept.length, 2);
});

test('the day\'s sweep also removes the events older than 7 days, once', async () => {
  const t = setup({ vms: { 'vm-a': { status: 'RUNNING' } } });
  await t.controller.check();
  assert.deepEqual(t.store.sweptEvents, [t.clock.now() - 7 * 86_400_000]);
  assert.deepEqual(t.logged('EventsSwept'), [{ level: 'info', event: 'EventsSwept', swept: 2 }]);
  t.clock.advance(60_000);
  await t.controller.check();
  assert.equal(t.store.sweptEvents.length, 1);
});

test('an events sweep that fails is logged EventsSweepFailed and the check goes on', async () => {
  const t = setup({ vms: { 'vm-a': { status: 'RUNNING' } } });
  t.store.sweepEvents = async () => { throw new Error('firestore down'); };
  assert.equal((await t.controller.check()).length, 1);
  assert.deepEqual(t.logged('EventsSweepFailed').map((l) => l.error), ['firestore down']);
});

test('a sweep that fails is logged StatsSweepFailed and the check goes on', async () => {
  const t = setup({ vms: { 'vm-a': { status: 'RUNNING' } } });
  t.store.sweepStats = async () => { throw new Error('firestore down'); };
  assert.equal((await t.controller.check()).length, 1);
  assert.deepEqual(t.logged('StatsSweepFailed').map((l) => l.error), ['firestore down']);
});

test('WAKING 3 minutes with no beat: the check sends that wakeId again; 30 s later nothing, a minute later again', async () => {
  const t = setup({ run: waking(START - 3 * MINUTE), vms: { 'vm-a': { status: 'TERMINATED' } }, map: asleepMap() });
  assert.deepEqual(await t.controller.check(), [{ workloadId: 'demo', state: STATES.WAKING, wake: 'resent' }]);
  assert.deepEqual(t.world.tasks, [{ url: `${CONTROLLER}/v1/tasks`, body: { action: 'wake', workloadId: 'demo', wakeId: 'w1' } }]);
  assert.equal(t.run().resentAt, START);
  assert.equal(t.run().wakeId, 'w1');
  assert.deepEqual(t.logged('WakeResent'), [{ level: 'warn', event: 'WakeResent', workloadId: 'demo', wakeId: 'w1', by: 'check', reason: 'no heartbeat 90 s after it started' }]);
  t.clock.advance(30_000);
  assert.deepEqual(await t.controller.check(), [{ workloadId: 'demo', state: STATES.WAKING }]);
  assert.equal(t.world.tasks.length, 1);
  t.clock.advance(30_001);
  assert.equal((await t.controller.check())[0].wake, 'resent');
  assert.equal(t.world.tasks.length, 2);
  assert.deepEqual(t.world.calls, []);
});

// A duplicate wake holds a controller request for the whole wake: under a saturated queue, the cause of a stale wake, resends
// without end would deepen it. Twice per wakeId, then the deadline alone.
test('a stale wake is sent again twice at most: then nothing more, and its deadline calls it stuck', async () => {
  const t = setup({ run: waking(START - 3 * MINUTE), vms: { 'vm-a': { status: 'TERMINATED' } }, map: asleepMap() });
  assert.equal((await t.controller.check())[0].wake, 'resent');
  t.clock.advance(MINUTE + 1);
  assert.equal((await t.controller.check())[0].wake, 'resent');
  t.clock.advance(MINUTE + 1);
  assert.deepEqual(await t.controller.check(), [{ workloadId: 'demo', state: STATES.WAKING }]);
  t.clock.advance(4 * MINUTE);
  assert.deepEqual(await t.controller.check(), [{ workloadId: 'demo', state: STATES.WAKING }]);
  assert.deepEqual(t.world.tasks.map((task) => task.body), Array(2).fill({ action: 'wake', workloadId: 'demo', wakeId: 'w1' }));
  assert.equal(t.logged('WakeResent').length, 2);
  // Past the wake's 600 s and the grace: stuck.
  t.clock.advance(2 * MINUTE);
  assert.equal((await t.controller.check())[0].state, STATES.FAILED);
  assert.equal(t.logged('WakeStuck').length, 1);
  assert.equal(t.world.tasks.length, 2);
});

test('a wake that beats is left alone, whatever its age within its deadline; one not yet 90 s old too', async () => {
  for (const run of [waking(START - 9 * MINUTE, { beatAt: START - 30_000 }), waking(START - 90_000), waking(START - 3 * MINUTE, { beatAt: START - 3 * MINUTE })]) {
    const t = setup({ run });
    assert.deepEqual(await t.controller.check(), [{ workloadId: 'demo', state: STATES.WAKING }]);
    assert.deepEqual(t.world.tasks, []);
    assert.equal(t.logged('WakeResent').length, 0);
  }
});

test('a resend the queue refuses: said, the run still WAKING, and the check goes on', async () => {
  const t = setup({ run: waking(START - 3 * MINUTE) });
  t.world.taskRefused = new GoogleError('Google: POST: 503 tasks', { code: 503 });
  assert.deepEqual(await t.controller.check(), [{ workloadId: 'demo', state: STATES.WAKING }]);
  assert.equal(t.logged('WakeResendFailed')[0].error, 'Google: POST: 503 tasks');
  assert.equal(t.logged('CheckFailed').length, 0);
  assert.equal(t.run().state, STATES.WAKING);
});

test('two wake tasks, one wakeId (the lost one delivered after all): one start, one AWAKE, the other superseded', async () => {
  const t = setup({ run: waking(START - 3 * MINUTE), vms: { 'vm-a': { status: 'TERMINATED' } }, map: asleepMap() });
  await t.controller.check();
  const [{ body: resent }] = t.world.tasks;
  assert.equal((await t.controller.wake(resent.workloadId, resent.wakeId)).state, STATES.AWAKE);
  assert.deepEqual(await t.controller.wake('demo', 'w1'), { state: 'SUPERSEDED' });
  assert.deepEqual(t.world.calls, ['start vm-a', 'map no policy']);
  assert.equal(t.logged('WakeCompleted').length, 1);
  assert.equal(t.logged('WakeSuperseded').length, 1);
  assert.equal(t.timers.size, 0);
});

test('a nap whose beat is 4 minutes old: the stuck nap\'s path at once, not at 35 minutes; the next check wakes it, its policy removed', async () => {
  const t = setup({ run: NAPPING_BEATING({ beatAt: START - 4 * MINUTE }), vms: { 'vm-a': { status: 'RUNNING' } }, map: asleepMap() });
  assert.equal((await t.controller.check())[0].state, STATES.FAILED);
  assert.deepEqual(t.logged('NapStuck'), [{ level: 'warn', event: 'NapStuck', workloadId: 'demo', reason: 'no heartbeat for more than 3 minutes' }]);
  assert.equal(t.logged('StateChanged').at(-1).cause, 'nap-stuck');
  const failure = JSON.parse(t.run().failure);
  assert.equal(failure.kind, 'timeout');
  assert.equal(failure.step, 'nap');
  assert.equal(failure.message, 'the nap\'s request stopped: no heartbeat for more than 3 minutes');
  assert.equal(t.world.vms['vm-a'].status, 'RUNNING');
  // Healthy behind its policy: the next check wakes it, the policy removed.
  assert.equal((await t.controller.check())[0].state, STATES.AWAKE);
  assert.equal(t.logged('FailedRecovered').length, 1);
  assert.equal(hasPolicy(t.world.map), false);
});

test('a nap\'s heartbeat: a beat 2 minutes old holds; none 90 s after its NAPPING is stale; a nap from before the heartbeat keeps its 35 minutes', async () => {
  const alive = setup({ run: NAPPING_BEATING({ beatAt: START - 2 * MINUTE }), vms: { 'vm-a': { status: 'RUNNING' } }, map: asleepMap() });
  assert.deepEqual(await alive.controller.check(), [{ workloadId: 'demo', state: STATES.NAPPING }]);
  const silent = setup({ run: NAPPING_BEATING({ stateAt: START - 90_001, updatedAt: START - 90_001 }), vms: { 'vm-a': { status: 'RUNNING' } }, map: asleepMap() });
  assert.equal((await silent.controller.check())[0].state, STATES.FAILED);
  assert.equal(silent.logged('NapStuck')[0].reason, 'no heartbeat 90 s after it started');
  const before = setup({ run: { state: STATES.NAPPING, stateAt: START - 30 * MINUTE, updatedAt: START - 30 * MINUTE }, vms: { 'vm-a': { status: 'RUNNING' } }, map: asleepMap() });
  assert.deepEqual(await before.controller.check(), [{ workloadId: 'demo', state: STATES.NAPPING }]);
  assert.equal(before.logged('NapStuck').length, 0);
});

// --- A regional, classic or internal workload: the swap (the coverage design's section 7; G5's design, section 7) --------------

// A regional waker's headers are in the map (M4), as an internal one's, regional or cross-region (Google's page), the cross-region
// one's map global; a classic one's on its backend service. The internal kinds wait as M3 measured them (30 s, 150 s).
const SWAP_HEADERS = [['x-dormeto-workload', 'demo'], ['x-dormeto-switch', 'swap']];
const SWAPS = [
  ['regional', { kind: 'regional', region: 'europe-west1' }, `${V1}/regions/europe-west1`, 100, 'europe-west1', SWAP_HEADERS],
  ['classic', { kind: 'classic' }, `${V1}/global`, 250, 'global', undefined],
  ['internal', { kind: 'internal', region: 'europe-west1' }, `${V1}/regions/europe-west1`, 30, 'europe-west1', SWAP_HEADERS],
  ['cross-region-internal', { kind: 'cross-region-internal' }, `${V1}/global`, 150, 'global', SWAP_HEADERS],
];

for (const [kind, lb, base, waitSeconds, healthScope, headers] of SWAPS) {
  // Its map, backend services and waker in the router's region, or global.
  const regionalScope = healthScope !== 'global';
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
      pathRules: [headers
        ? { paths: ['/_dormeto/*'], routeAction: { weightedBackendServices: [{ backendService: service(WAKER), weight: 100, headerAction: {
          requestHeadersToAdd: headers.map(([headerName, headerValue]) => ({ headerName, headerValue, replace: true })) } }] } }
        : { paths: ['/_dormeto/*'], service: service(WAKER) }, { paths: ['/_dormeto/backend/*'], service: service('app') }],
    }],
  });
  const swappedMap = () => withSwap(awakeMap(), 'app', service(WAKER), { headers }).map;
  const defaultOf = (matcher) => matcher.defaultService ?? matcher.defaultRouteAction?.weightedBackendServices?.[0]?.backendService;
  const isSwapped = (map) => defaultOf(map.pathMatchers[0]) === service(WAKER);
  // `calls` also says the state changes, between what changes the map and the VMs.
  const swapSetup = ({ cfg = {}, vms = { 'vm-a': { status: 'RUNNING' } }, map = awakeMap(), ...rest } = {}) => {
    const t = setup({ cfg: { lb, hibernate: false, ...cfg }, vms, map, ...rest });
    t.world.swapWaitMs = WAIT_MS;
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
    assert.deepEqual(t.world.sleeps.filter((ms) => ms >= MINUTE || ms === WAIT_MS), [WAIT_MS]);
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
    const elsewhere = regionalScope ? `${V1}/global/urlMaps` : `${V1}/regions/europe-west1/urlMaps`;
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

  test(`${kind} nap whose map stays busy with other updates past its pauses: nothing swapped, no wait, AWAKE (map-busy), no failure`, async () => {
    const t = swapSetup();
    t.world.conflicts = 100;
    const out = await t.controller.nap('demo');
    assert.equal(out.aborted, true);
    // The busy map's pauses are 30 s each, as regional internal's wait is: only the map's writes, and no wait where it differs, tell.
    assert.deepEqual(t.world.calls.filter((call) => WAIT_MS === 30_000 ? !call.startsWith('wait') : true), [`state ${STATES.NAPPING}`, `state ${STATES.AWAKE}`]);
    if (WAIT_MS !== 30_000) assert.equal(t.world.sleeps.includes(WAIT_MS), false);
    assert.equal(t.world.puts, 0);
    assert.equal(t.run().napAborted.reason, 'map-busy');
    assert.equal(t.run().failure, undefined);
    assert.equal(t.world.vms['vm-a'].status, 'RUNNING');
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

  test(`${kind} idle nap with requests since its check: read through its load balancer, unswapped, waited, only then AWAKE (traffic)`, async () => {
    const t = swapSetup({ requests: 3 });
    assertBackAwake(t, await t.controller.nap('demo', { requestedAt: START }));
    assert.deepEqual(t.world.metricReads.map(({ lb: read, from }) => [read, from]), [[lb, START - 210_000]]);
    assert.equal(t.logged('StateChanged').find((l) => l.to === STATES.AWAKE).cause, 'traffic');
    assert.equal(t.run().napAborted.reason, 'traffic');
  });

  test(`${kind} idle nap whose traffic cannot be read: unswapped, waited, only then AWAKE (traffic-unread), no failure`, async () => {
    const t = swapSetup({ requests: () => { throw new GoogleError('Google: GET: 503 unavailable', { code: 503 }); } });
    const out = await t.controller.nap('demo', { requestedAt: START });
    assertBackAwake(t, out);
    assert.match(out.error, /503 unavailable/);
    assert.equal(t.logged('StateChanged').find((l) => l.to === STATES.AWAKE).cause, 'traffic-unread');
    assert.equal(t.run().napAborted.reason, 'traffic-unread');
    assert.equal(t.run().failure, undefined);
    assert.equal(t.logged('NapFailed').length, 0);
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

  test(`${kind} nap dead while swapped: stuck past 22 minutes, not 35, and the recovering wake unswaps`, async () => {
    const at = swapSetup({ run: NAPPING_RUN(22 * MINUTE), map: swappedMap() });
    assert.deepEqual(await at.controller.check(), [{ workloadId: 'demo', state: STATES.NAPPING }]);
    assert.equal(at.logged('NapStuck').length, 0);

    const t = swapSetup({ run: NAPPING_RUN(22 * MINUTE + 1), map: swappedMap() });
    assert.equal((await t.controller.check())[0].state, STATES.FAILED);
    assert.equal(t.logged('NapStuck').length, 1);
    const failure = JSON.parse(t.run().failure);
    assert.equal(failure.kind, 'timeout');
    assert.equal(failure.step, 'nap');
    assert.match(failure.message, /within 22 minutes/);
    assert.equal(t.world.vms['vm-a'].status, 'RUNNING');

    // The next check finds it healthy behind the swap: a wake finishes the job, in a request of its own.
    assert.equal((await t.controller.check())[0].state, STATES.WAKING);
    assert.deepEqual(t.world.tasks.at(-1).body, { action: 'wake', workloadId: 'demo', wakeId: 'wake-2' });
    assert.equal((await t.controller.wake('demo', 'wake-2')).state, STATES.AWAKE);
    assert.deepEqual(t.world.map, { ...awakeMap(), fingerprint: 'f1' });
    assert.equal(t.world.vms['vm-a'].status, 'RUNNING');
  });

  test(`${kind} nap whose beat is 4 minutes old: stuck at once, not at 22 minutes, and the recovering wake unswaps`, async () => {
    const t = swapSetup({ run: NAPPING_RUN(5 * MINUTE, { napId: 'n1', stateAt: START - 5 * MINUTE, beatAt: START - 4 * MINUTE }), map: swappedMap() });
    assert.equal((await t.controller.check())[0].state, STATES.FAILED);
    assert.equal(t.logged('NapStuck').length, 1);
    assert.equal(t.logged('StateChanged').at(-1).cause, 'nap-stuck');
    assert.equal(t.world.vms['vm-a'].status, 'RUNNING');
    assert.equal(isSwapped(t.world.map), true);
    assert.equal((await t.controller.check())[0].state, STATES.WAKING);
    assert.deepEqual(t.world.tasks.at(-1).body, { action: 'wake', workloadId: 'demo', wakeId: 'wake-2' });
    assert.equal((await t.controller.wake('demo', 'wake-2')).state, STATES.AWAKE);
    assert.deepEqual(t.world.map, { ...awakeMap(), fingerprint: 'f1' });
    assert.equal(t.world.vms['vm-a'].status, 'RUNNING');
    assert.equal(t.timers.size, 0);
  });

  test(`${kind} nap stopping: its VMs are going, 35 minutes as ever`, async () => {
    const within = swapSetup({ run: NAPPING_RUN(35 * MINUTE, { stopping: true }), map: swappedMap() });
    assert.deepEqual(await within.controller.check(), [{ workloadId: 'demo', state: STATES.NAPPING }]);
    const past = swapSetup({ run: NAPPING_RUN(35 * MINUTE + 1, { stopping: true }), map: swappedMap() });
    assert.equal((await past.controller.check())[0].state, STATES.FAILED);
    assert.match(JSON.parse(past.run().failure).message, /within 35 minutes/);
  });

  test(`${kind} slow legal nap: a lost swap, each write behind another update of its map under way here, each update at its worst: under 22 minutes, no check calls it stuck`, async () => {
    // A map's update at its worst: the operation's 120 s and the pauses of a map busy with another (urlmaps.mjs), by its scope.
    const update = regionalScope ? 240_000 : 180_000;
    const t = swapSetup();
    t.world.swapWaitMs = WAIT_MS;
    t.world.mapLine = (body) => `map ${isSwapped(body) ? 'swapped' : 'unswapped'}${body.description ? ` on ${body.description}` : ''}`;
    // Another workload's change of the map, its update held until the nap's write waits for it.
    const maps = regionalScope ? t.regionalUrlmaps : t.urlmaps;
    let others = 0;
    let holding = false;
    const another = () => {
      holding = true;
      others += 1;
      return maps.modify('lb', (map) => ({ map: { ...structuredClone(map), description: `another ${others}` }, paths: ['description'] }));
    };
    const turns = async (n) => {
      for (let i = 0; i < n; i += 1) await new Promise((resolve) => { setImmediate(resolve); });
    };
    t.world.on.put = async () => {
      t.clock.advance(update);
      if (!holding) return;
      holding = false;
      await turns(5);
    };
    const seen = [];
    let lost = false;
    t.clock.onSleep(async () => {
      if (!lost) {
        t.world.map = awakeMap();
        another();
      } else if (!seen.length) seen.push(...(await t.controller.check()));
      lost = true;
    });
    another();
    assert.equal((await t.controller.nap('demo')).state, STATES.ASLEEP);
    // Each of the nap's writes on the map as the other update left it: it waited for that one.
    assert.deepEqual(t.world.calls.filter((c) => c.startsWith('map')), ['map unswapped on another 1', 'map swapped on another 1', 'map unswapped on another 2', 'map swapped on another 2']);
    assert.deepEqual(seen, [{ workloadId: 'demo', state: STATES.NAPPING }]);
    assert.equal(t.logged('NapStuck').length, 0);
    assert.equal(t.world.vms['vm-a'].status, 'TERMINATED');
    // Regional and internal 2 x 100 s + 2 x (240 s + 240 s) = 1160 s, classic 2 x 250 s + 2 x (180 s + 180 s) = 1220 s, cross-region
    // internal 2 x 100 s + 2 x (180 s + 180 s) = 920 s: past 15 minutes.
    const took = t.clock.now() - START;
    assert.ok(took > 15 * MINUTE && took < 22 * MINUTE, `${took} ms`);
  });

  test(`${kind} nap found stuck during its wait: it writes nothing more, whatever the recovering wake did to the map`, async () => {
    const t = swapSetup();
    t.clock.onSleep(async () => {
      if (t.run().state !== STATES.NAPPING) return;
      t.clock.advance(22 * MINUTE + 1);
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
      t.clock.advance(22 * MINUTE + 1);
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
        t.clock.advance(22 * MINUTE + 1);
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
        t.clock.advance(22 * MINUTE + 1);
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

  // The map's change must still fit the wake once the retries end: a start past that could not unswap in time.
  test(`${kind} wake: a VM refused for capacity while another is healthy: tried again only while the map's change still fits the wake, then unswapped, AWAKE`, async () => {
    const t = swapSetup({ run: waking(START), cfg: { backends: [VM_A, VM_B] }, vms: { 'vm-a': { status: 'RUNNING' }, 'vm-b': { status: 'TERMINATED' } }, map: swappedMap() });
    t.world.on['start vm-b'] = async () => { throw stockout(); };
    assert.equal((await t.controller.wake('demo', 'w1')).state, STATES.AWAKE);
    const retries = t.world.sleeps.slice(0, -1);
    assert.deepEqual(retries.slice(0, 3), [30_000, 60_000, 120_000]);
    // Up to the deadline less the swap's wait and the room of the wake's floor (60 s), and no wait left out that would fit.
    assert.ok(START + retries.reduce((sum, ms) => sum + ms, 0) + 120_000 >= START + 600_000 - WAIT_MS - 60_000, 'no wait left out that the map\'s change would fit');
    assert.equal(t.world.sleeps.at(-1), WAIT_MS);
    assert.ok(t.clock.now() <= START + 600_000);
    assert.equal(t.logged('BackendsNotWoken').length, 1);
    assert.match(t.logged('BackendsNotWoken')[0].error, /ZONE_RESOURCE_POOL_EXHAUSTED/);
    assert.equal(isSwapped(t.world.map), false);
  });

  // A start takes time, and so does the map's write (5 s here): the retries end early enough for the last start, the write and the swap's
  // wait, the room of section 3's floor (60 s beyond the wait). A bound at the wait alone timed out, regional for d of 8, 9 and 33 to 42 s,
  // classic for 3, 4 and 34 to 46 s.
  const SLOW_STARTS = [0, 3, 4, 8, 9, ...Array.from({ length: 14 }, (_, i) => 33 + i)];
  const slowly = (t, line, d, refusals = Infinity) => {
    let starts = 0;
    t.world.on.put = async () => { t.clock.advance(5000); };
    t.world.on[line] = async () => {
      starts += 1;
      t.clock.advance(d * 1000);
      if (starts <= refusals) throw stockout();
    };
    return () => starts;
  };

  test(`${kind} wake: a VM refused for capacity, each start taking d seconds, while another serves: its retries end in time, AWAKE, never a timeout`, async () => {
    for (const d of SLOW_STARTS) {
      const t = swapSetup({ run: waking(START), cfg: { backends: [VM_A, VM_B] }, vms: { 'vm-a': { status: 'RUNNING' }, 'vm-b': { status: 'TERMINATED' } }, map: swappedMap() });
      slowly(t, 'start vm-b', d);
      const out = await t.controller.wake('demo', 'w1');
      assert.equal(out.state, STATES.AWAKE, `d = ${d} s: ${out.error}`);
      assert.equal(t.logged('BackendsNotWoken').length, 1, `d = ${d} s`);
      assert.ok(t.clock.now() < START + 600_000, `d = ${d} s`);
    }
  });

  test(`${kind} wake: a VM refused for capacity, each start taking d seconds: FAILED for capacity, never a timeout; started at the last try the retries allow, AWAKE`, async () => {
    for (const d of SLOW_STARTS) {
      const refused = swapSetup({ run: waking(START), map: swappedMap(), vms: { 'vm-a': { status: 'TERMINATED' } } });
      const tries = slowly(refused, 'start vm-a', d);
      assert.equal((await refused.controller.wake('demo', 'w1')).state, STATES.FAILED, `d = ${d} s`);
      assert.equal(JSON.parse(refused.run().failure).kind, 'capacity', `d = ${d} s`);

      const last = swapSetup({ run: waking(START), map: swappedMap(), vms: { 'vm-a': { status: 'TERMINATED' } } });
      slowly(last, 'start vm-a', d, tries() - 1);
      const out = await last.controller.wake('demo', 'w1');
      assert.equal(out.state, STATES.AWAKE, `d = ${d} s, started at try ${tries()}: ${out.error}`);
    }
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
    // The request's budget (1,740 s) less the wait binds before the timeout (1,700 s) only where the wait is over 40 s: the 30 s one
    // never leaves a healthy VM past it.
    if (WAIT_MS > 40_000) {
      const late = swapSetup({ run: waking(START), cfg: { wakeTimeoutSeconds: 1700 }, vms: { 'vm-a': { status: 'TERMINATED' } }, map: swappedMap(), unhealthyPolls: polls(1_690_000) });
      assert.equal((await late.controller.wake('demo', 'w1')).state, STATES.FAILED);
      assert.equal(late.world.puts, 0);
      assert.equal(JSON.parse(late.run().failure).kind, 'timeout');
    }
  });

  test(`${kind} wake: in its wait past the timeout, it is not called stuck; past the wait too, it is`, async () => {
    const age = 600_000 + 60_000 + WAIT_MS;
    // A wake in its wait still beats.
    const within = swapSetup({ run: waking(START - age, { beatAt: START - 30_000 }), map: swappedMap() });
    assert.deepEqual(await within.controller.check(), [{ workloadId: 'demo', state: STATES.WAKING }]);
    const stuck = swapSetup({ run: waking(START - age - 1, { beatAt: START - 30_000 }), map: swappedMap() });
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

  test(`${kind} check: the logConfig read at the service's scope, the request logs through its load balancer`, async () => {
    const t = swapSetup({ run: { state: STATES.AWAKE, awakeSince: 1 }, requests: 4, logConfig: EVERY_REQUEST, logs: SCANNERS });
    assert.deepEqual(await t.controller.check(), [{ workloadId: 'demo', state: STATES.AWAKE, nap: 'requested' }]);
    assert.deepEqual(t.world.serviceReads, [`${healthScope} app`]);
    assert.deepEqual(t.world.logReads.map((read) => read.lb), [lb]);
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

// F8: a nap does not fail on its map's contention. Nothing it wrote kept visitors from the application: its idle time goes on, and
// the next check asks again.
test('a URL map changed five times over: the nap given up (map-busy), nothing stopped, no failure, and the next check asks again', async () => {
  const t = setup({ vms: { 'vm-a': { status: 'RUNNING' } } });
  t.world.conflicts = 5;
  const out = await t.controller.nap('demo');
  assert.equal(out.state, STATES.AWAKE);
  assert.equal(out.aborted, true);
  assert.equal(out.error, 'URL map lb stayed busy with other updates: Google: PUT: 412 fingerprint');
  assert.deepEqual(t.world.calls, []);
  assert.equal(t.run().state, STATES.AWAKE);
  assert.equal(t.run().failure, undefined);
  assert.equal(t.run().napAborted.reason, 'map-busy');
  assert.equal(t.run().awakeSince, 1, 'its idle time goes on');
  assert.deepEqual(t.logged('NapAborted').map((l) => [l.level, l.reason]), [['warn', out.error]]);
  assert.equal(t.logged('StateChanged').find((l) => l.to === STATES.AWAKE).cause, 'map-busy');
  assert.equal((await check(t)).nap, 'requested');
});

test('a URL map changed four times over is read again and written, with its pauses', async () => {
  const t = setup({ vms: { 'vm-a': { status: 'RUNNING' } }, cfg: { hibernate: false } });
  t.world.conflicts = 4;
  assert.equal((await t.controller.nap('demo')).state, STATES.ASLEEP);
});

test('a URL map kept busy while a wake is asked during the nap: given up (map-busy), the idle window starts again, no nap at the next check', async () => {
  const t = setup({ vms: { 'vm-a': { status: 'RUNNING' } } });
  t.world.conflicts = 5;
  let asked = false;
  t.clock.onSleep(async () => {
    if (asked) return;
    asked = true;
    await t.controller.wakeNow('demo');
  });
  const out = await t.controller.nap('demo');
  assert.equal(out.state, STATES.AWAKE);
  assert.equal(t.logged('PendingWake').length, 1);
  assert.equal(t.run().napAborted.reason, 'map-busy');
  assert.equal(t.run().pendingWake, undefined);
  assert.equal(t.run().awakeSince, t.run().napAborted.at, 'the wake asked restarts it');
  assert.equal((await check(t)).nap, undefined);
  assert.deepEqual(t.world.metricReads, []);
  assert.deepEqual(t.world.tasks, []);
});

test('another update of the URL map under way (resourceNotReady): the nap waits for it; for ever, given up (map-busy), nothing stopped', async () => {
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
  assert.equal((await never.controller.nap('demo')).state, STATES.AWAKE);
  assert.equal(never.run().napAborted.reason, 'map-busy');
  assert.equal(never.run().failure, undefined);
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
  assert.deepEqual(t.world.metricReads, [{ backendService: 'app', from: START - 15 * MINUTE - 210_000, to: START }]);
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
  const within = setup({ run: { state: STATES.AWAKE, awakeSince: START - 15 * MINUTE - 209_999 }, vms: { 'vm-a': { status: 'RUNNING' } } });
  assert.deepEqual(await within.controller.check(), [{ workloadId: 'demo', state: STATES.AWAKE }]);
  assert.deepEqual(within.world.metricReads, []);
  assert.deepEqual(within.world.tasks, []);
  const at = setup({ run: { state: STATES.AWAKE, awakeSince: START - 15 * MINUTE - 210_000 }, vms: { 'vm-a': { status: 'RUNNING' } } });
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

// F4: what the check could not see yet, and what came during the wait.
test('an idle nap reads the traffic again before its commit: 0 at the check, then 3: AWAKE (traffic), nothing stopped, napAborted on the run', async () => {
  let reads = 0;
  const t = setup({ run: AWAKE_LONG, cfg: { hibernate: false }, vms: { 'vm-a': { status: 'RUNNING' } }, requests: () => (reads++ ? 3 : 0) });
  await t.controller.check();
  const [{ body }] = t.world.tasks;
  const out = await t.controller.nap('demo', body);
  assert.deepEqual(out, { state: STATES.AWAKE, aborted: true });
  assert.deepEqual(t.world.calls, ['map policy', 'wait 300 s', 'map no policy']);
  assert.equal(t.world.vms['vm-a'].status, 'RUNNING');
  assert.deepEqual(t.world.metricReads[1], { backendService: 'app', from: START - 210_000, to: t.clock.now() });
  assert.ok(t.clock.now() >= START + 300_000);
  assert.deepEqual(t.logged('NapAborted').map((l) => l.reason), ['traffic']);
  assert.equal(t.logged('StateChanged').find((l) => l.to === STATES.AWAKE).cause, 'traffic');
  assert.equal(t.run().state, STATES.AWAKE);
  assert.deepEqual(t.run().napAborted, { reason: 'traffic', at: t.clock.now() });
  assert.equal(hasPolicy(t.world.map), false);

  // A later nap that commits: the record gone from then on.
  t.world.requests = 0;
  t.clock.advance(MINUTE);
  let atTheStop;
  t.world.on['stop vm-a'] = async () => { atTheStop = structuredClone(t.run()); };
  assert.equal((await t.controller.nap('demo', { requestedAt: t.clock.now() })).state, STATES.ASLEEP);
  assert.equal(atTheStop.napAborted, undefined);
  assert.equal(t.run().napAborted, undefined);
});

test('an idle nap whose traffic cannot be read again: given up, AWAKE (traffic-unread), nothing stopped, no failure, no release at the next check', async () => {
  let reads = 0;
  const t = setup({
    run: AWAKE_LONG,
    vms: { 'vm-a': { status: 'RUNNING' } },
    requests: () => {
      reads += 1;
      if (reads === 2) throw new GoogleError('Google: GET: 503 unavailable', { code: 503 });
      return 0;
    },
  });
  await t.controller.check();
  const out = await t.controller.nap('demo', t.world.tasks[0].body);
  assert.equal(out.state, STATES.AWAKE);
  assert.equal(out.aborted, true);
  assert.match(out.error, /503 unavailable/);
  assert.deepEqual(t.world.calls, ['map policy', 'wait 300 s', 'map no policy']);
  assert.equal(t.world.vms['vm-a'].status, 'RUNNING');
  assert.equal(hasPolicy(t.world.map), false);
  assert.equal(t.run().state, STATES.AWAKE);
  assert.equal(t.run().failure, undefined);
  assert.equal(t.run().consecutiveFailures, undefined);
  assert.deepEqual(t.run().napAborted, { reason: 'traffic-unread', at: t.clock.now() });
  assert.equal(t.logged('NapFailed').length, 0);
  assert.match(t.logged('NapAborted')[0].reason, /503 unavailable/);
  assert.equal(t.logged('StateChanged').find((l) => l.to === STATES.AWAKE).cause, 'traffic-unread');

  // Past the idle window: an idle nap asked again, no release.
  t.clock.advance(20 * MINUTE);
  await t.controller.check();
  assert.deepEqual(t.world.tasks.map((task) => task.body.action), ['nap', 'nap']);
  assert.equal(t.run().state, STATES.AWAKE);
});

test('a scheduled nap and an operator\'s do not read the traffic again: asleep whatever the requests', async () => {
  const scheduledNap = setup({ vms: { 'vm-a': { status: 'RUNNING' } }, requests: 5 });
  assert.equal((await scheduledNap.controller.nap('demo', { cause: 'schedule', requestedAt: START, until: START + 60 * MINUTE })).state, STATES.ASLEEP);
  assert.deepEqual(scheduledNap.world.metricReads, []);
  const operator = setup({ vms: { 'vm-a': { status: 'RUNNING' } }, requests: 5 });
  await operator.controller.napNow('demo');
  assert.equal((await operator.controller.nap('demo', operator.world.tasks[0].body)).state, STATES.ASLEEP);
  assert.deepEqual(operator.world.metricReads, []);
  assert.equal(operator.logged('StateChanged').find((l) => l.to === STATES.NAPPING).cause, 'operator');
});

// F12: why a workload does not nap, for whoever reads it.
test('every nap given up is recorded on the run, its cause and time: a wake asked, a changed NEG, a map refused', async () => {
  const wake = setup({ vms: { 'vm-a': { status: 'RUNNING' } } });
  wake.clock.onSleep(() => wake.store.setPendingWake('demo'));
  assert.equal((await wake.controller.nap('demo')).aborted, true);
  assert.deepEqual(wake.run().napAborted, { reason: 'pending-wake', at: wake.clock.now() });

  const neg = setup({ cfg: { backends: [{ ...VM_A, neg: { zone: ZONE, name: 'neg' } }] }, vms: { 'vm-a': { status: 'RUNNING' } } });
  neg.world.negs.neg = ['vm-a', 'late'];
  assert.equal((await neg.controller.nap('demo')).aborted, true);
  assert.deepEqual(neg.run().napAborted, { reason: 'backends-changed', at: neg.clock.now() });

  const map = mapOf();
  map.pathMatchers[0].defaultCustomErrorResponsePolicy = { errorService: `${V1}/global/backendServices/theirs`, errorResponseRules: [] };
  const refused = setup({ vms: { 'vm-a': { status: 'RUNNING' } }, map });
  assert.equal((await refused.controller.nap('demo')).aborted, true);
  assert.deepEqual(refused.run().napAborted, { reason: 'switch-failed', at: refused.clock.now() });
});

test('asleep without the error policy: repaired, RouteDrift logged, no 300 s wait', async () => {
  const t = setup({ run: { state: STATES.ASLEEP }, vms: { 'vm-a': { status: 'TERMINATED' } } });
  assert.deepEqual(await t.controller.check(), [{ workloadId: 'demo', state: STATES.ASLEEP }]);
  assert.equal(hasPolicy(t.world.map), true);
  assert.deepEqual(t.world.sleeps, []);
  assert.deepEqual(t.logged('RouteDrift').map((l) => [l.workloadId, l.state, l.paths]), [['demo', STATES.ASLEEP, ['pathMatchers[0].defaultCustomErrorResponsePolicy']]]);
});

test('a check that races an offboarding: the map write finds the workload deleted, CheckSkipped, no CheckFailed, no error in the results', async () => {
  const t = setup({ run: { state: STATES.ASLEEP }, vms: { 'vm-a': { status: 'TERMINATED' } } });
  t.world.on.put = async () => {
    t.store.getConfig = async () => null;
    throw new GoogleError('Google: PUT: 404 not found', { code: 404, status: 'NOT_FOUND', reason: 'notFound' });
  };
  assert.deepEqual(await t.controller.check(), [{ workloadId: 'demo', skipped: 'offboarded' }]);
  assert.deepEqual(t.logged('CheckSkipped').map((l) => [l.workloadId, l.reason]), [['demo', 'offboarded']]);
  assert.equal(t.logged('CheckFailed').length, 0);
});

test('a check that fails while the workload is still there stays a CheckFailed', async () => {
  const t = setup({ run: { state: STATES.ASLEEP }, vms: { 'vm-a': { status: 'TERMINATED' } } });
  t.world.on.put = async () => { throw new GoogleError('Google: PUT: 500 oops', { code: 500 }); };
  const [out] = await t.controller.check();
  assert.match(out.error, /500 oops/);
  assert.equal(t.logged('CheckFailed').length, 1);
  assert.equal(t.logged('CheckSkipped').length, 0);
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
  // The last resort: no beat for 11 minutes, and not sent again past the deadline.
  const stuck = setup({ run: waking(START - 660_001), vms: { 'vm-a': { status: 'TERMINATED' } } });
  assert.equal((await stuck.controller.check())[0].state, STATES.FAILED);
  assert.equal(stuck.run().state, STATES.FAILED);
  assert.equal(JSON.parse(stuck.run().failure).kind, 'timeout');
  assert.equal(stuck.logged('WakeStuck').length, 1);
  assert.deepEqual(stuck.world.tasks, []);
  assert.equal(stuck.logged('WakeResent').length, 0);
  const within = setup({ run: waking(START - 660_000, { beatAt: START - 30_000 }), vms: { 'vm-a': { status: 'TERMINATED' } }, map: asleepMap() });
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
  assert.deepEqual(operator.world.tasks.map((task) => task.body), [{ action: 'nap', workloadId: 'demo', cause: 'operator', requestedAt: START }]);
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

// A fallback machine type is for one wake only (section 6 of the router features' design): stopped, a VM gets its own type back.
test('the next nap gives a VM its own type back once it is stopped, and the run forgets it', async () => {
  const t = setup({ run: waking(START), cfg: FALLBACK, vms: { 'vm-a': { status: 'TERMINATED' } } });
  refusedFor(t, 'start vm-a', 1);
  await t.controller.wake('demo', 'w1');
  assert.deepEqual(t.run().instanceTypes, ON_FALLBACK);
  t.world.calls.length = 0;
  assert.equal((await t.controller.nap('demo')).state, STATES.ASLEEP);
  assert.deepEqual(t.world.calls, ['map policy', 'wait 300 s', 'stop vm-a', 'setMachineType vm-a e2-small']);
  assert.equal(typeOf(t, 'vm-a'), 'e2-small');
  assert.equal(t.run().instanceTypes, undefined);
  assert.deepEqual(t.logged('InstanceTypeNotReverted'), []);
});

test('a revert refused (403): said, the nap ASLEEP all the same, the VM kept on the run; refused again at the wake, it starts on its fallback type; the next nap gives it back', async () => {
  const t = setup({ run: { state: STATES.AWAKE, awakeSince: 1, instanceTypes: ON_FALLBACK }, cfg: FALLBACK, vms: { 'vm-a': { status: 'RUNNING', machineType: typeUrl('e2-medium') } } });
  refusedFor(t, 'setMachineType vm-a e2-small', 2, forbidden);
  assert.equal((await t.controller.nap('demo')).state, STATES.ASLEEP);
  assert.equal(t.run().state, STATES.ASLEEP);
  assert.deepEqual(t.run().instanceTypes, ON_FALLBACK);
  assert.deepEqual(fieldsOf(t.logged('InstanceTypeNotReverted')), [['warn', { workloadId: 'demo', instance: 'vm-a', error: SET_TYPE_REFUSED }]]);

  await t.controller.wakeNow('demo');
  assert.equal((await t.controller.wake('demo', 'wake-2')).state, STATES.AWAKE);
  assert.equal(typeOf(t, 'vm-a'), 'e2-medium');
  assert.deepEqual(t.run().instanceTypes, ON_FALLBACK);
  assert.equal(t.logged('InstanceTypeNotReverted').length, 2);

  t.world.calls.length = 0;
  assert.equal((await t.controller.nap('demo')).state, STATES.ASLEEP);
  assert.deepEqual(t.world.calls, ['map policy', 'wait 300 s', 'stop vm-a', 'setMachineType vm-a e2-small']);
  assert.equal(t.run().instanceTypes, undefined);
});

test('hibernate true, a VM on a fallback type: stopped, not suspended, so that it gets its own type back; the others suspended', async () => {
  const t = setup({
    run: { state: STATES.AWAKE, awakeSince: 1, instanceTypes: ON_FALLBACK },
    cfg: { ...FALLBACK, hibernate: true, backends: [VM_A, VM_B] },
    vms: { 'vm-a': { status: 'RUNNING', machineType: typeUrl('e2-medium') }, 'vm-b': { status: 'RUNNING' } },
    machineTypes: { 'e2-medium': { memoryMb: 4096 } },
  });
  await t.controller.nap('demo');
  assert.deepEqual(t.run().stopped, ['vm-a']);
  assert.deepEqual(t.run().suspended, ['vm-b']);
  assert.equal(t.world.calls.at(-1), 'setMachineType vm-a e2-small');
  assert.equal(t.run().instanceTypes, undefined);
});

test('the release gives the VMs their own types back once stopped, and the run forgets them', async () => {
  const t = setup({
    run: { ...FAILED_RUN(START - 15 * MINUTE), instanceTypes: ON_FALLBACK }, cfg: FALLBACK, map: asleepMap(),
    vms: { 'vm-a': { status: 'RUNNING', machineType: typeUrl('e2-medium') } },
  });
  assert.deepEqual(await t.controller.release('demo'), { state: STATES.ASLEEP });
  assert.deepEqual(t.world.calls, ['stop vm-a', 'setMachineType vm-a e2-small']);
  assert.equal(t.run().instanceTypes, undefined);
});

test('a wake that fails on a fallback type leaves it on the run, for the release to give back', async () => {
  const t = setup({ run: waking(START), cfg: FALLBACK, vms: { 'vm-a': { status: 'TERMINATED' } }, unhealthyPolls: Infinity });
  refusedFor(t, 'start vm-a', 1);
  assert.equal((await t.controller.wake('demo', 'w1')).state, STATES.FAILED);
  assert.deepEqual(t.run().instanceTypes, ON_FALLBACK);
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
    getConfig: async (workloadId) => ({ workloadId }),
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

// --- The waiting page (G5, design §5.2): the wakes' durations, the favicon read at the nap ----------------------------------------

test('three wakes leave three recentWakes, beside lastWake; a failed wake adds none', async () => {
  const t = setup({ vms: { 'vm-a': { status: 'RUNNING' } } });
  for (const durationMs of [20_000, 30_000, 40_000]) {
    t.store.state.run = { ...t.run(), ...waking(t.clock.now() - durationMs) };
    assert.equal((await t.controller.wake('demo', 'w1')).state, STATES.AWAKE);
  }
  assert.equal(t.run().recentWakes, '[20000,30000,40000]');
  assert.deepEqual(t.run().lastWake, { durationMs: 40_000 });
  t.store.state.run = { ...t.run(), ...waking(t.clock.now() - 5000) };
  t.world.on['start vm-a'] = async () => { throw new GoogleError('Google: POST: 403 denied', { code: 403 }); };
  t.world.vms['vm-a'].status = 'TERMINATED';
  assert.equal((await t.controller.wake('demo', 'w1')).state, STATES.FAILED);
  assert.equal(t.run().recentWakes, '[20000,30000,40000]');
});

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PNG_URI = `data:image/png;base64,${PNG_BYTES.toString('base64')}`;
// The application at demo.example.com, its home page linking /f.png. What each request found: the run's state and whether the map
// held the nap's policy.
function site(t) {
  const seen = [];
  t.network.fetch = async (url) => {
    seen.push([url, t.run().state, hasPolicy(t.world.map) ? 'policy' : 'no policy']);
    if (url === 'https://demo.example.com/') return new Response('<link rel="icon" href="/f.png">', { status: 200 });
    if (url === 'https://demo.example.com/f.png') return new Response(PNG_BYTES, { status: 200 });
    return new Response('', { status: 404 });
  };
  return seen;
}
test('a nap reads the favicon before its NAPPING, the route still the application\'s, from the host the URL map sends / to the workload', async () => {
  const t = setup({ vms: RUNNING, cfg: { hibernate: false } });
  const seen = site(t);
  const at = t.clock.now();
  assert.equal((await t.controller.nap('demo')).state, STATES.ASLEEP);
  assert.deepEqual(seen, [['https://demo.example.com/', STATES.AWAKE, 'no policy'], ['https://demo.example.com/f.png', STATES.AWAKE, 'no policy']]);
  assert.deepEqual(t.store.state.favicons.demo, { icon: PNG_URI, fetchedAt: at, error: null });
  assert.deepEqual(t.world.calls, ['map policy', 'wait 300 s', 'stop vm-a']);
});

test('a nap reads the favicon at most once a day, successful or not; the levels only when it is due', async () => {
  const t = setup({ vms: RUNNING });
  site(t);
  const levels = [];
  const { getWaitingPage } = t.store;
  t.store.getWaitingPage = async (level, ...rest) => {
    levels.push(level);
    return getWaitingPage(level, ...rest);
  };
  t.store.state.favicons.demo = { icon: null, fetchedAt: t.clock.now() - DAY + 60_000, error: 'the page answered 401' };
  assert.equal((await t.controller.nap('demo')).state, STATES.ASLEEP);
  assert.deepEqual([t.network.calls, levels], [[], []]);
  const again = setup({ vms: RUNNING });
  site(again);
  again.store.state.favicons.demo = { icon: PNG_URI, fetchedAt: again.clock.now() - DAY - 1, error: null };
  await again.controller.nap('demo');
  assert.equal(again.network.calls.length, 2);
  assert.equal(again.store.state.favicons.demo.fetchedAt, again.clock.now() - 300_000);
});

test('the favicon is read for a template with icon auto only; a custom page the switch keeps off is none, and its template shows', async () => {
  const CUSTOM = { mode: 'custom', html: '<p data-dormeto="status"></p>' };
  for (const [name, pages, customPages, reads] of [
    ['an icon of its own at the router', { router: { mode: 'template', icon: PNG_URI } }, false, 0],
    ['none at the workload', { 'WL#demo': { mode: 'template', icon: 'none' } }, false, 0],
    ['a custom page, the switch on', { 'WL#demo': CUSTOM }, true, 0],
    ['a custom page, the switch off', { 'WL#demo': CUSTOM }, false, 2],
    ['a custom router page over a template, the switch off', { router: CUSTOM, 'WL#demo': { mode: 'template', title: 'Shop' } }, false, 2],
  ]) {
    const t = setup({ vms: RUNNING, customPages });
    site(t);
    for (const [level, page] of Object.entries(pages)) t.store.state.pages[level] = { page, by: 'ops', at: 1 };
    assert.equal((await t.controller.nap('demo')).state, STATES.ASLEEP, name);
    assert.equal(t.network.calls.length, reads, name);
  }
});

test('the favicon: no host rule sending / to the workload is said and waits a day; a skipped nap reads none; a map that cannot be read changes nothing', async () => {
  const none = setup({ vms: RUNNING, map: { ...mapOf(), hostRules: [{ hosts: ['*'], pathMatcher: 'm' }] } });
  site(none);
  const at = none.clock.now();
  assert.equal((await none.controller.nap('demo')).state, STATES.ASLEEP);
  assert.deepEqual([none.network.calls, none.store.state.favicons.demo], [[], { icon: null, fetchedAt: at, error: 'no rule for the whole of a host name' }]);

  const paused = setup({ vms: RUNNING });
  site(paused);
  await paused.store.putPause('demo', { by: 'ops', at: 1, reason: 'x', keepAsleep: false });
  assert.equal((await paused.controller.nap('demo')).state, 'SKIPPED');
  assert.deepEqual([paused.network.calls, paused.store.state.favicons], [[], {}]);

  const unread = setup({ vms: RUNNING });
  site(unread);
  unread.urlmaps.get = async () => { throw new GoogleError('Google: GET: 503 unavailable', { code: 503 }); };
  assert.equal((await unread.controller.nap('demo')).state, STATES.ASLEEP);
  assert.deepEqual([unread.network.calls, unread.store.state.favicons], [[], {}]);
  assert.equal(unread.logged('FaviconSkipped').length, 1);
});

// An internal load balancer's visitors are in the customer's network: no icon is read for them (as on AWS), the map not even read.
test('the favicon of an internal or a cross-region internal workload: none read, nothing stored, its nap as any swap\'s', async () => {
  for (const lb of [{ kind: 'internal', region: 'europe-west1' }, { kind: 'cross-region-internal' }]) {
    const t = setup({ vms: RUNNING, cfg: { lb, hibernate: false } });
    site(t);
    const read = [];
    for (const maps of [t.urlmaps, t.regionalUrlmaps]) {
      const { get } = maps;
      maps.get = async (name) => {
        read.push(name);
        return get(name);
      };
    }
    assert.equal((await t.controller.nap('demo')).state, STATES.ASLEEP, lb.kind);
    assert.deepEqual([t.network.calls, t.store.state.favicons, read], [[], {}, []], lb.kind);
    assert.equal(t.logged('FaviconSkipped').length, 0, lb.kind);
  }
});

test('the favicon of a regional workload: its host from the regional URL map', async () => {
  const lb = { kind: 'regional', region: 'europe-west1' };
  const t = setup({ vms: RUNNING, cfg: { lb, hibernate: false } });
  site(t);
  const read = [];
  t.urlmaps.get = async () => assert.fail('the global scope');
  const { get } = t.regionalUrlmaps;
  t.regionalUrlmaps.get = async (name) => {
    read.push(name);
    return get(name);
  };
  t.world.map = { ...mapOf(), pathMatchers: [{ name: 'm', defaultService: `${V1}/regions/europe-west1/backendServices/app` }] };
  assert.equal((await t.controller.nap('demo')).state, STATES.ASLEEP);
  assert.deepEqual(read, ['lb']);
  assert.equal(t.store.state.favicons.demo.icon, PNG_URI);
});

// --- The levels (G5, design §4.5): what the check, the wake, the nap and the release act on is resolved ---------------------

const RUNNING_VM = { 'vm-a': { status: 'RUNNING' } };
const unreadable = () => new GoogleError('Google: GET: 503 unavailable', { code: 503 });
// The setup with the router's record (router/settings).
const leveled = (router, options) => {
  const t = setup(options);
  t.store.state.routerSettings = router;
  return t;
};
// How many times the router level was read.
function routerReads(t) {
  const reads = { count: 0 };
  const { getRouterSettings } = t.store;
  t.store.getRouterSettings = (...args) => {
    reads.count += 1;
    return getRouterSettings(...args);
  };
  return reads;
}

test('the router\'s idleMinutes 5 on a workload that inherits it: the check reads [t − 5 min − 210 s, t], and asks the nap', async () => {
  const t = leveled({ defaults: { idleMinutes: 5 } }, { run: { state: STATES.AWAKE, awakeSince: START - 5 * MINUTE - 210_000 }, cfg: { inherits: ['idleMinutes'] }, vms: RUNNING_VM });
  assert.deepEqual(await t.controller.check(), [{ workloadId: 'demo', state: STATES.AWAKE, nap: 'requested' }]);
  assert.deepEqual(t.world.metricReads, [{ backendService: 'app', from: START - 5 * MINUTE - 210_000, to: START }]);
  // A configuration from before G5 (no `inherits`) holding G1's 15 inherits it too; its own 20 wins.
  const legacy = leveled({ defaults: { idleMinutes: 5 } }, { run: AWAKE_LONG, vms: RUNNING_VM });
  await legacy.controller.check();
  assert.deepEqual(legacy.world.metricReads.map((q) => q.from), [START - 5 * MINUTE - 210_000]);
  const own = leveled({ defaults: { idleMinutes: 5 } }, { run: AWAKE_LONG, cfg: { idleMinutes: 20 }, vms: RUNNING_VM });
  await own.controller.check();
  assert.deepEqual(own.world.metricReads.map((q) => q.from), [START - 20 * MINUTE - 210_000]);
});

test('a failed workload is released once the resolved idle window has passed: the router\'s 5 minutes', async () => {
  const t = leveled({ defaults: { idleMinutes: 5 } }, { run: FAILED_RUN(START - 5 * MINUTE), cfg: { inherits: ['idleMinutes'] }, vms: RUNNING_VM, map: asleepMap(), unhealthyPolls: Infinity });
  assert.deepEqual(await t.controller.check(), [{ workloadId: 'demo', state: STATES.FAILED, release: 'requested' }]);
  assert.deepEqual(t.world.tasks.map((task) => task.body), [{ action: 'release', workloadId: 'demo' }]);
});

test('the router\'s hibernate false, the workload setting none: the nap and the release stop, never suspend; the workload\'s own true wins', async () => {
  const nap = leveled({ hibernate: false }, { vms: RUNNING_VM });
  assert.equal((await nap.controller.nap('demo')).state, STATES.ASLEEP);
  assert.deepEqual(nap.world.calls, ['map policy', 'wait 300 s', 'stop vm-a']);
  assert.deepEqual(nap.run().stopped, ['vm-a']);
  const release = leveled({ hibernate: false }, { run: FAILED_RUN(START - 15 * MINUTE), vms: RUNNING_VM, map: asleepMap() });
  assert.deepEqual(await release.controller.release('demo'), { state: STATES.ASLEEP });
  assert.deepEqual(release.world.calls, ['stop vm-a']);
  const own = leveled({ hibernate: false }, { cfg: { hibernate: true }, vms: RUNNING_VM });
  await own.controller.nap('demo');
  assert.deepEqual(own.world.calls, ['map policy', 'wait 300 s', 'suspend vm-a']);
});

test('a workload with fallback machine types: the nap stops, whatever the router says, unless its own hibernate is true', async () => {
  const fallback = leveled({ hibernate: true }, { cfg: { fallbackInstanceTypes: ['e2-medium'] }, vms: RUNNING_VM });
  await fallback.controller.nap('demo');
  assert.deepEqual(fallback.world.calls, ['map policy', 'wait 300 s', 'stop vm-a']);
  const own = setup({ cfg: { fallbackInstanceTypes: ['e2-medium'], hibernate: true }, vms: RUNNING_VM });
  await own.controller.nap('demo');
  assert.deepEqual(own.world.calls, ['map policy', 'wait 300 s', 'suspend vm-a']);
});

// The organization's level (G2 §5.5): the manager's settings.json in router/manager.
const organized = (settings, router, options) => {
  const t = leveled(router ?? null, options);
  t.store.state.managerSettings = { settings, etag: 'e', at: START - MINUTE };
  return t;
};

test('the organization\'s idleMinutes 5 under no router value: the check reads [t - 5 min - 210 s, t]; the router\'s 20 wins over it', async () => {
  const t = organized({ workloads: { defaults: { idleMinutes: 5 } } }, null, { run: { state: STATES.AWAKE, awakeSince: START - 5 * MINUTE - 210_000 }, cfg: { inherits: ['idleMinutes'] }, vms: RUNNING_VM });
  assert.deepEqual(await t.controller.check(), [{ workloadId: 'demo', state: STATES.AWAKE, nap: 'requested' }]);
  assert.deepEqual(t.world.metricReads.map((q) => q.from), [START - 5 * MINUTE - 210_000]);
  const router = organized({ workloads: { defaults: { idleMinutes: 5 } } }, { defaults: { idleMinutes: 20 } }, { run: AWAKE_LONG, cfg: { inherits: ['idleMinutes'] }, vms: RUNNING_VM });
  await router.controller.check();
  assert.deepEqual(router.world.metricReads.map((q) => q.from), [START - 20 * MINUTE - 210_000]);
});

test('the organization\'s hibernate false, no workload or router setting: the nap stops; the router\'s true wins over it', async () => {
  const nap = organized({ workloads: { hibernate: false } }, null, { vms: RUNNING_VM });
  await nap.controller.nap('demo');
  assert.deepEqual(nap.world.calls, ['map policy', 'wait 300 s', 'stop vm-a']);
  const router = organized({ workloads: { hibernate: false } }, { hibernate: true }, { vms: RUNNING_VM });
  await router.controller.nap('demo');
  assert.deepEqual(router.world.calls, ['map policy', 'wait 300 s', 'suspend vm-a']);
});

test('router/manager a document that is not an object, or unreadable: the organization is unset, the nap is the built-in suspend', async () => {
  const bad = organized('oops', null, { vms: RUNNING_VM });
  await bad.controller.nap('demo');
  assert.deepEqual(bad.world.calls, ['map policy', 'wait 300 s', 'suspend vm-a']);
  const unread = setup({ vms: RUNNING_VM });
  unread.store.getManagerSettings = async () => { throw unreadable(); };
  await unread.controller.nap('demo');
  assert.equal(unread.run().state, STATES.ASLEEP);
});

test('routerInfo reads router/manager once for the settings and the health', async () => {
  const t = organized({ workloads: { hibernate: false } }, null, {});
  t.store.state.check = { lastScheduledCheckAt: START };
  let reads = 0;
  const { getManagerSettings } = t.store;
  t.store.getManagerSettings = (...args) => {
    reads += 1;
    return getManagerSettings(...args);
  };
  await t.controller.routerInfo();
  assert.equal(reads, 1);
});

// A router level this instance never read (AWS's rule): nothing falls back to the built-in values, which could act against the
// router's (an idle window shorter than its own, a suspend against its "off", a wake failed before its timeout).
const neverRead = (options) => {
  const t = setup(options);
  t.store.getRouterSettings = async () => { throw unreadable(); };
  return t;
};

test('a router level never read on this instance: the check asks no idle nap and no release, says so, and no CheckFailed; the reconcile still runs', async () => {
  const idle = neverRead({ run: AWAKE_LONG, vms: RUNNING_VM });
  assert.deepEqual(await idle.controller.check(), [{ workloadId: 'demo', state: STATES.AWAKE, settings: 'unreadable' }]);
  assert.deepEqual(idle.world.tasks, []);
  assert.deepEqual(idle.world.metricReads, []);
  assert.deepEqual(idle.logged('CheckFailed'), []);
  assert.deepEqual(idle.logged('SettingsLevelUnreadable').map(({ level, error }) => ({ level, error })), [{ level: 'router', error: 'Google: GET: 503 unavailable' }]);
  const failed = neverRead({ run: FAILED_RUN(START - 60 * MINUTE), vms: RUNNING_VM, map: asleepMap(), unhealthyPolls: Infinity });
  assert.deepEqual(await failed.controller.check(), [{ workloadId: 'demo', state: STATES.FAILED, settings: 'unreadable' }]);
  assert.deepEqual(failed.world.tasks, []);
  assert.deepEqual(failed.logged('CheckFailed'), []);
  const stopped = neverRead({ run: AWAKE_LONG, vms: { 'vm-a': { status: 'TERMINATED' } } });
  assert.deepEqual(await stopped.controller.check(), [{ workloadId: 'demo', state: STATES.ASLEEP, settings: 'unreadable' }]);
  assert.equal(stopped.logged('ExternalStop').length, 1);
});

test('a router level never read on this instance: a wake waits the longest timeout Google Cloud allows, 1700 s, and the check calls it stuck only past it', async () => {
  const wake = neverRead({ run: waking(START), vms: { 'vm-a': { status: 'TERMINATED' } }, unhealthyPolls: Infinity });
  assert.equal((await wake.controller.wake('demo', 'w1')).state, STATES.FAILED);
  assert.equal(wake.clock.now() - START, 1_700_000);
  const within = neverRead({ run: waking(START - 1_760_000, { beatAt: START - 30_000 }), vms: { 'vm-a': { status: 'TERMINATED' } }, map: asleepMap() });
  assert.deepEqual(await within.controller.check(), [{ workloadId: 'demo', state: STATES.WAKING }]);
  const stuck = neverRead({ run: waking(START - 1_760_001, { beatAt: START - 30_000 }), vms: { 'vm-a': { status: 'TERMINATED' } }, map: asleepMap() });
  assert.equal((await stuck.controller.check())[0].state, STATES.FAILED);
  assert.equal(JSON.parse(stuck.run().failure).message, 'the wake did not finish within 1700 s (its request stopped)');
});

test('a router level never read on this instance: the nap and the release stop the VMs plainly, never suspend', async () => {
  const nap = neverRead({ vms: RUNNING_VM });
  assert.equal((await nap.controller.nap('demo')).state, STATES.ASLEEP);
  assert.deepEqual(nap.world.calls, ['map policy', 'wait 300 s', 'stop vm-a']);
  assert.deepEqual(nap.run().suspended, []);
  const release = neverRead({ run: FAILED_RUN(START - 15 * MINUTE), vms: RUNNING_VM, map: asleepMap() });
  assert.deepEqual(await release.controller.release('demo'), { state: STATES.ASLEEP });
  assert.deepEqual(release.world.calls, ['stop vm-a']);
});

test('a router level that cannot be read keeps the last one this instance read: for the next check, a wake and a nap', async () => {
  const t = leveled({ hibernate: false, defaults: { idleMinutes: 5, wakeTimeoutSeconds: 120 } }, { run: AWAKE_LONG, cfg: { inherits: ['idleMinutes', 'wakeTimeoutSeconds'] }, vms: RUNNING_VM, requests: 1 });
  await t.controller.check();
  t.store.getRouterSettings = async () => { throw unreadable(); };
  await t.controller.check();
  assert.deepEqual(t.world.metricReads.map((q) => q.from), [START - 5 * MINUTE - 210_000, START - 5 * MINUTE - 210_000]);
  assert.deepEqual(t.logged('CheckFailed'), []);
  t.world.requests = 0;
  await t.controller.nap('demo');
  assert.deepEqual(t.world.calls, ['map policy', 'wait 300 s', 'stop vm-a']);
  t.store.state.run = waking(t.clock.now());
  t.world.unhealthyPolls = Infinity;
  const started = t.clock.now();
  assert.equal((await t.controller.wake('demo', 'w1')).state, STATES.FAILED);
  assert.equal(t.clock.now() - started, 120_000);
  assert.equal(t.logged('SettingsLevelUnreadable').length, 3);
});

test('the wake\'s deadline is the resolved wake timeout: the router\'s 120 s on a workload that inherits it', async () => {
  const t = leveled({ defaults: { wakeTimeoutSeconds: 120 } }, { run: waking(START), cfg: { inherits: ['wakeTimeoutSeconds'] }, vms: { 'vm-a': { status: 'TERMINATED' } }, unhealthyPolls: Infinity });
  assert.equal((await t.controller.wake('demo', 'w1')).state, STATES.FAILED);
  assert.equal(t.clock.now() - START, 120_000);
  assert.equal(t.logged('WakeFailed').length, 1);
});

test('the stuck wake\'s deadline is the resolved wake timeout: the router\'s 300 s and the grace, not the stored 600 s', async () => {
  const router = { defaults: { wakeTimeoutSeconds: 300 } };
  const within = leveled(router, { run: waking(START - 360_000, { beatAt: START - 30_000 }), cfg: { inherits: ['wakeTimeoutSeconds'] }, vms: { 'vm-a': { status: 'TERMINATED' } }, map: asleepMap() });
  assert.deepEqual(await within.controller.check(), [{ workloadId: 'demo', state: STATES.WAKING }]);
  const stuck = leveled(router, { run: waking(START - 360_001, { beatAt: START - 30_000 }), cfg: { inherits: ['wakeTimeoutSeconds'] }, vms: { 'vm-a': { status: 'TERMINATED' } }, map: asleepMap() });
  assert.equal((await stuck.controller.check())[0].state, STATES.FAILED);
  assert.equal(stuck.logged('WakeStuck').length, 1);
  assert.equal(JSON.parse(stuck.run().failure).message, 'the wake did not finish within 300 s (its request stopped)');
});

test('the stuck wake\'s deadline is bounded as Google Cloud fixes it: the router\'s 3600 s is 1700 s', async () => {
  const stuck = leveled({ defaults: { wakeTimeoutSeconds: 3600 } }, { run: waking(START - 1_760_001, { beatAt: START - 30_000 }), cfg: { inherits: ['wakeTimeoutSeconds'] }, vms: { 'vm-a': { status: 'TERMINATED' } }, map: asleepMap() });
  assert.equal((await stuck.controller.check())[0].state, STATES.FAILED);
  assert.equal(JSON.parse(stuck.run().failure).message, 'the wake did not finish within 1700 s (its request stopped)');
});

test('the router level is read once by a check, once by a wake, once by a nap, once by a release', async () => {
  const t = setup({ run: AWAKE_LONG, vms: RUNNING_VM });
  const reads = routerReads(t);
  await t.controller.check();
  assert.equal(reads.count, 1);
  await t.controller.nap('demo', t.world.tasks[0].body);
  assert.equal(reads.count, 2);
  await t.controller.wakeNow('demo');
  await t.controller.wake('demo', 'wake-2');
  assert.equal(t.run().state, STATES.AWAKE);
  assert.equal(reads.count, 3);
  const failed = setup({ run: FAILED_RUN(START - 15 * MINUTE), vms: RUNNING_VM, map: asleepMap() });
  const released = routerReads(failed);
  await failed.controller.release('demo');
  assert.equal(released.count, 1);
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

test('a router level never read on this instance: a nap window still asks its nap, as on AWS (the window is no setting of the levels)', async () => {
  const t = scheduled(scheduleOf(NAP));
  t.store.getRouterSettings = async () => { throw unreadable(); };
  assert.equal((await check(t)).schedule, 'nap');
  assert.deepEqual(t.world.tasks, [napTask]);
  assert.deepEqual(t.logged('CheckFailed'), []);
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
  // Its wake's request runs, and beats.
  t.run().beatAt = t.clock.now() - 30_000;
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

// The router level's joinMinutes (router/settings), as AWS's check reads it: the schedule's own value, then the router's, then 15.
test('the router\'s joinMinutes 0 on a schedule with none of its own: two nap windows 10 minutes apart stay apart, the nap ends with the first; the schedule\'s own wins', async () => {
  const windows = scheduleOf(NAP, { ...NAP, start: '23:10', end: '23:50' });
  const JOINED_END = Date.parse('2023-11-14T23:50:00Z');
  const untilOf = async (t) => {
    await check(t);
    return t.world.tasks.map((task) => task.body.until);
  };
  assert.deepEqual(await untilOf(scheduled(windows)), [JOINED_END]);
  const router = scheduled(windows);
  router.store.state.routerSettings = { joinMinutes: 0 };
  assert.deepEqual(await untilOf(router), [NAP_END]);
  const own = scheduled({ ...windows, joinMinutes: 15 });
  own.store.state.routerSettings = { joinMinutes: 0 };
  assert.deepEqual(await untilOf(own), [JOINED_END]);
});

test('the router\'s joinMinutes 60 joins two awake windows 45 minutes apart: in their gap, the idle nap kept off by the awake window', async () => {
  // 22:13 on the fake clock: 32 minutes before the second starts, past the 30 that keep a workload awake before a start.
  const windows = scheduleOf({ ...AWAKE_WINDOW, start: '21:00', end: '22:00' }, { ...AWAKE_WINDOW, start: '22:45', end: '23:30' });
  const apart = scheduled(windows, { run: AWAKE_LONG, requests: 0 });
  assert.equal((await check(apart)).nap, 'requested');
  const joined = scheduled(windows, { run: AWAKE_LONG, requests: 0 });
  joined.store.state.routerSettings = { joinMinutes: 60 };
  const out = await check(joined);
  assert.equal(out.kept, 'awake window');
  assert.deepEqual(joined.world.tasks, []);
});

test('a schedule the router cannot read: logged, the workload as with none', async () => {
  const t = scheduled({ timeZone: 'Nowhere/Land', windows: [NAP], at: START }, { requests: 0 });
  const out = await check(t);
  assert.equal(t.logged('ScheduleSkipped').length, 1);
  assert.equal(out.nap, 'requested');
  assert.deepEqual(t.world.tasks.map((task) => task.body), [{ action: 'nap', workloadId: 'demo', requestedAt: t.clock.now() }]);
});

// Workloads on the same URL map, their VMs read through the world, awake for a day: by ID, each one's schedule (null: none).
function crowded(schedules) {
  const world = worldOf((w) => { w.services[WAKER] = { name: WAKER, backends: [] }; });
  for (const [workloadId, schedule] of Object.entries(schedules)) {
    world.store.configs.set(workloadId, { workloadId, urlMap: 'lb', backendService: 'app', wakerBackendService: WAKER, backends: [{ kind: 'vm', location: ZONE, name: 'vm-a' }], idleMinutes: 15, wakeTimeoutSeconds: 600 });
    world.store.runs.set(workloadId, { state: STATES.AWAKE, awakeSince: world.clock.now() - DAY });
    if (schedule) world.store.schedules.set(workloadId, schedule);
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

// --- The naps in flight: at most 20 per router (F8) ---------------------------------------------------------------------

const thirty = Array.from({ length: 30 }, (_, i) => `w${String(i).padStart(2, '0')}`);
const napTasksOf = (world) => world.w.tasks.filter((task) => task.body.action === 'nap').map((task) => task.body.workloadId);
const deferredOf = (world) => world.w.logs.filter((l) => l.event === 'NapDeferred').map(({ reason, count }) => ({ reason, count }));
// Their naps' requests running, each beating.
const napping = (world, ids) => {
  const t = world.clock.now();
  for (const id of ids) Object.assign(world.store.runs.get(id), { state: STATES.NAPPING, napId: `nap-${id}`, stateAt: t, updatedAt: t, beatAt: t });
};
const nextCheck = (world) => {
  world.w.tasks.length = 0;
  world.w.logs.length = 0;
  world.clock.advance(FIVE_MINUTES);
};

// Which workloads the 8 checked at once reach first is theirs to say: the counts and the sets are what holds.
test('30 idle workloads: 20 nap tasks and NapDeferred once for the 10 others; while the 20 nap, none more but a wake; then the 10 others', async () => {
  const world = crowded(Object.fromEntries(thirty.map((id) => [id, null])));
  const { store, core, clock } = world;
  const out = await core.check();
  const asked = napTasksOf(world);
  assert.equal(new Set(asked).size, 20);
  const others = thirty.filter((id) => !asked.includes(id));
  for (const id of others) assert.equal(out.find((r) => r.workloadId === id).nap, 'deferred', id);
  assert.deepEqual(deferredOf(world), [{ reason: 'cap', count: 10 }]);

  // The 20 still napping: no nap more. A wake is never held back: an asleep workload's awake window.
  nextCheck(world);
  napping(world, asked);
  store.configs.set('zz', { ...store.configs.get('w00'), workloadId: 'zz' });
  store.runs.set('zz', { state: STATES.ASLEEP, stateAt: clock.now() - DAY });
  store.schedules.set('zz', scheduleOf(AWAKE_WINDOW));
  await core.check();
  assert.deepEqual(napTasksOf(world), []);
  assert.deepEqual(world.w.tasks.map((task) => [task.body.action, task.body.workloadId]), [['wake', 'zz']]);
  assert.deepEqual(deferredOf(world), [{ reason: 'cap', count: 10 }]);

  // Their naps over (asleep, then woken by visitors): the 10 others.
  nextCheck(world);
  store.configs.delete('zz');
  for (const id of asked) store.runs.set(id, { state: STATES.AWAKE, awakeSince: clock.now() });
  await core.check();
  assert.deepEqual(napTasksOf(world).sort(), others);
  assert.deepEqual(deferredOf(world), []);
});

test('25 idle workloads and 5 in a nap window: the 5 scheduled naps first, then 15 idle ones, the 10 others deferred', async () => {
  // The scheduled ones last by name: they go first all the same.
  const world = crowded(Object.fromEntries(thirty.map((id, i) => [id, i >= 25 ? scheduleOf(NAP) : null])));
  const out = await world.core.check();
  const tasks = world.w.tasks.map((task) => task.body);
  assert.deepEqual(tasks.slice(0, 5).map((body) => [body.workloadId, body.cause]), thirty.slice(25).map((id) => [id, 'schedule']));
  const idle = tasks.slice(5).map((body) => body.workloadId);
  assert.equal(new Set(idle).size, 15);
  assert.equal(tasks.slice(5).every((body) => body.cause === undefined && thirty.slice(0, 25).includes(body.workloadId)), true);
  for (const id of thirty.slice(0, 25).filter((id) => !idle.includes(id))) assert.equal(out.find((r) => r.workloadId === id).nap, 'deferred', id);
  assert.deepEqual(deferredOf(world), [{ reason: 'cap', count: 10 }]);
});

test('the naps in flight count the scheduled ones too: 18 napping, 5 in a nap window → 2 asked, 3 put off to the next check, no idle nap', async () => {
  const busy = thirty.slice(0, 18);
  const windowed = thirty.slice(18, 23);
  const idle = thirty.slice(23, 25);
  const world = crowded(Object.fromEntries([...busy.map((id) => [id, null]), ...windowed.map((id) => [id, scheduleOf(NAP)]), ...idle.map((id) => [id, null])]));
  napping(world, busy);
  const out = await world.core.check();
  assert.deepEqual(napTasksOf(world), windowed.slice(0, 2));
  for (const id of windowed.slice(2)) {
    assert.equal(out.find((r) => r.workloadId === id).schedule, 'nap deferred', id);
    assert.equal(world.store.runs.get(id).scheduleApplied, undefined, id);
  }
  assert.deepEqual(world.w.logs.find((l) => l.event === 'ScheduledNapsDeferred').workloads, windowed.slice(2));
  assert.deepEqual(deferredOf(world), [{ reason: 'cap', count: 2 }]);
});

// Ten workloads on the one regional URL map `lb`, onboarded: each its host, matcher, backend service `app-<id>` of the unmanaged group
// `ig-<id>` of `vm-<id>`, and waker. The store dates its changes as Firestore does: what the check's stuck naps read.
async function tenOnOneRegionalMap(clock) {
  const ten = thirty.slice(0, 10);
  const t = worldOf((w) => {
    regionalWorld(w);
    const region = w.regions[REGION];
    Object.assign(region.urlMaps.lb, {
      hostRules: ten.map((id) => ({ hosts: [`${id}.example.com`], pathMatcher: id })),
      pathMatchers: ten.map((id) => ({ name: id, defaultService: regionalUrl(`app-${id}`) })),
    });
    for (const [i, id] of ten.entries()) {
      region.services[`app-${id}`] = { ...region.services.app, name: `app-${id}`, backends: [{ group: unmanagedUrl(`ig-${id}`) }] };
      w.unmanaged[`ig-${id}`] = [`vm-${id}`];
      w.vms[`vm-${id}`] = { id: String(3000 + i), status: 'RUNNING' };
    }
  }, { clock });
  for (const id of ten) await t.onboarding.onboard({ urlMap: 'lb', backendService: `app-${id}`, id, settings: { hibernate: false } });
  const { transition } = t.store;
  t.store.transition = (id, change) => {
    const run = t.store.runs.get(id);
    const dated = change.set?.state !== undefined && change.set.state !== run?.state ? { stateAt: clock.now() } : {};
    return transition(id, { ...change, set: { ...change.set, ...dated, updatedAt: clock.now() } });
  };
  return { ...t, ten };
}

// The regional map's update as M3 measured it, 85 s. During it another one is refused (resourceNotReady), and one made on the map
// read before it is a 412, its fingerprint stale. `updates`: when each began.
function slowRegionalMap(t, clock) {
  const updates = [];
  let busyUntil = 0;
  const { request } = t.google;
  t.google.request = async (method, url, body) => {
    if (method !== 'PUT' || !url.endsWith(`/regions/${REGION}/urlMaps/lb`)) return request(method, url, body);
    const current = body.fingerprint === t.w.regions[REGION].urlMaps.lb.fingerprint;
    if (current && clock.now() < busyUntil) throw new GoogleError('Google: URL map lb: 400 The resource is not ready', { code: 400, reason: 'resourceNotReady' });
    const answer = await request(method, url, body);
    busyUntil = clock.now() + 85_000;
    updates.push(clock.now());
    return { ...answer, doneAt: busyUntil };
  };
  t.google.waitCompute = async (op) => {
    if (op?.doneAt) await clock.sleep(op.doneAt - clock.now());
  };
  return updates;
}

// What the controller's API does of a task, as Cloud Tasks dispatches it.
const dispatch = (core) => ({ body: { action, workloadId, ...rest } }) => {
  if (action === 'nap') return core.nap(workloadId, rest);
  if (action === 'wake') return core.wake(workloadId, rest.wakeId);
  return core.release(workloadId);
};

test('ten idle workloads on one regional map, an update taking 85 s and a stale fingerprint a 412: all asleep by the third check, none failed', async () => {
  const clock = virtualClock();
  const t = await tenOnOneRegionalMap(clock);
  clock.advance(60 * MINUTE);
  const updates = slowRegionalMap(t, clock);
  const started = clock.now();
  const requests = [];
  let asleep;
  await clock.until((async () => {
    for (const [i, at] of [0, FIVE_MINUTES, 2 * FIVE_MINUTES].entries()) {
      if (i) await clock.sleep(started + at - clock.now());
      await t.core.check();
      requests.push(...t.w.tasks.splice(0).map(dispatch(t.core)));
    }
    asleep = t.ten.filter((id) => t.store.runs.get(id).state === STATES.ASLEEP);
    await Promise.all(requests);
  })());
  assert.deepEqual(asleep, t.ten, 'all asleep by the third check');
  assert.deepEqual(t.w.logs.filter((l) => l.event === 'NapFailed' || l.event === 'NapAborted'), []);
  assert.equal(t.w.logs.filter((l) => l.event === 'NapCompleted').length, 10);
  for (const id of t.ten) assert.equal(t.w.vms[`vm-${id}`].status, 'TERMINATED', id);
  // The first nap's swap alone, then the nine asked during it, together.
  assert.deepEqual(updates.map((at) => (at - started) / 1000), [0, 85]);
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
  assert.deepEqual(t.run().napAborted, { reason: 'paused', at: t.clock.now() });
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

// --- The router-wide pause (G2 §5.6) ---------------------------------------------------------------------------------

const routerPauseFor = (t, pause = {}) => pauseFor(t, { workloadId: null, ...pause });

test('a router pause keeps every workload from its idle nap and shows in its pauses', async () => {
  const t = setup({ vms: { 'vm-a': { status: 'RUNNING' } } });
  routerPauseFor(t);
  assert.deepEqual(await check(t), { workloadId: 'demo', state: STATES.AWAKE, paused: true });
  assert.deepEqual(t.world.tasks, []);
  assert.deepEqual(t.world.metricReads, []);
  assert.deepEqual(await t.controller.pausesFor('demo'), [
    { scope: 'router', by: 'ops', at: new Date(START - 1000).toISOString(), reason: 'load test', until: null, keepAsleep: false },
  ]);
});

test('a router pause past its until no longer holds, and the check deletes it', async () => {
  const t = scheduled(scheduleOf(NAP));
  routerPauseFor(t, { until: START });
  assert.equal((await check(t)).schedule, 'nap');
  assert.deepEqual(t.store.state.pauses, []);
  assert.deepEqual(t.logged('PauseExpired').map((l) => [l.workloadId, l.by, l.reason]), [[null, 'ops', 'load test']]);
});

test('a router pause with keepAsleep holds the wakes of an asleep workload; a plain one holds the window\'s nap', async () => {
  const kept = scheduled(scheduleOf(AWAKE_WINDOW), { run: { state: STATES.ASLEEP, stateAt: START - DAY }, vms: { 'vm-a': { status: 'TERMINATED' } }, map: asleepMap() });
  routerPauseFor(kept, { keepAsleep: true });
  assert.equal((await check(kept)).schedule, 'held by a keepAsleep pause');
  assert.equal(kept.run().state, STATES.ASLEEP);
  const plain = scheduled(scheduleOf(NAP));
  routerPauseFor(plain);
  assert.equal((await check(plain)).schedule, 'held by a pause');
});

test('pausing the router writes its pause without a workload and wakes a sleeper; keepAsleep leaves it asleep', async () => {
  const t = setup({ run: { state: STATES.ASLEEP }, vms: { 'vm-a': { status: 'TERMINATED' } }, map: asleepMap() });
  const done = await t.controller.pause(null, { reason: ' maintenance ', by: 'ops' });
  assert.deepEqual(t.store.state.pauses, [{ workloadId: null, by: 'ops', at: START, reason: 'maintenance', keepAsleep: false }]);
  assert.equal(t.run().state, STATES.WAKING);
  assert.deepEqual(done, { pause: { scope: 'router', by: 'ops', at: new Date(START).toISOString(), reason: 'maintenance', until: null, keepAsleep: false }, woken: ['demo'] });
  assert.equal(t.store.state.stats['wake:pause'], 1);

  const asleep = setup({ run: { state: STATES.ASLEEP }, vms: { 'vm-a': { status: 'TERMINATED' } }, map: asleepMap() });
  const kept = await asleep.controller.pause(null, { reason: 'freeze', keepAsleep: true });
  assert.equal(asleep.run().state, STATES.ASLEEP);
  assert.deepEqual(kept.woken, []);
  assert.deepEqual(asleep.world.tasks, []);
  await assert.rejects(() => asleep.controller.pause(null, {}), /reason required/);
});

test('a router pause is refused as a workload\'s is: no reason, an until in the past', async () => {
  const t = setup();
  await assert.rejects(() => t.controller.pause(null, { reason: 'r', until: START }), /until must be/);
  assert.deepEqual(t.store.state.pauses, []);
});

test('resuming the router removes its pause only, once; the workload\'s own stays', async () => {
  const t = setup();
  await t.controller.pause('demo', { reason: 'mine', by: 'ops' });
  await t.controller.pause(null, { reason: 'all', by: 'ops' });
  assert.deepEqual(await t.controller.resume(null, 'ops'), { resumed: true });
  assert.deepEqual(t.store.state.pauses.map((p) => p.workloadId), ['demo']);
  assert.deepEqual(t.logged('Resumed').map((l) => [l.workloadId ?? null, l.by]), [[null, 'ops']]);
  assert.deepEqual(await t.controller.resume(null, 'ops'), { resumed: false });
  assert.equal(t.logged('Resumed').length, 1);
});

test('routerInfo and the check\'s summary show the router pause as AWS\'s answer does, and count every workload as paused', async () => {
  const t = setup({ vms: { 'vm-a': { status: 'RUNNING' } } });
  routerPauseFor(t, { until: START + MINUTE, keepAsleep: true });
  const shown = { scope: 'router', by: 'ops', at: new Date(START - 1000).toISOString(), reason: 'load test', until: new Date(START + MINUTE).toISOString(), keepAsleep: true };
  const info = await t.controller.routerInfo();
  assert.deepEqual(info.pauses, [shown]);
  assert.equal(info.workloads.paused, 1);
  await t.controller.check();
  assert.deepEqual(t.store.state.check.pauses, [shown]);
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

// --- The request logs (L) ------------------------------------------------------------------------------------------------

const IDLE_WINDOW = { from: START - 15 * MINUTE - 210_000, to: START };
const RUNNING = { 'vm-a': { status: 'RUNNING' } };

// What the check reads in the logs of a backend service logging every request: from a minute before Monitoring's window to its end.
const LOGS_WINDOW = { backendService: 'app', from: IDLE_WINDOW.from - MINUTE, to: IDLE_WINDOW.to, limit: 1000 };
// The real reader (logs.mjs) behind the fake's log view, on Cloud Logging's `entries` as `answer` gives them, logging in the world.
function realLogs(t, answer) {
  const log = Object.fromEntries(['info', 'warn', 'error'].map((level) => [level, (event, fields = {}) => t.world.logs.push({ level, event, ...fields })]));
  const reader = createLogs({ google: { request: async () => answer() }, view: 'projects/p/locations/global/buckets/_Default/views/dmtr-europe-west1-lb', log });
  t.world.logEntries = (query) => reader.requests(query);
}
// A request of `entry` as Cloud Logging holds it.
const logEntryOf = ({ method, url, userAgent, remoteIp }) => ({ httpRequest: { requestMethod: method, requestUrl: url, userAgent, remoteIp } });

test('request logs: scanners and bots only, on a backend service logging every request: the nap asked, the run says request logs', async () => {
  const t = setup({ run: AWAKE_LONG, vms: RUNNING, requests: 4, logConfig: EVERY_REQUEST, logs: SCANNERS });
  assert.deepEqual(await t.controller.check(), [{ workloadId: 'demo', state: STATES.AWAKE, nap: 'requested' }]);
  assert.deepEqual(t.world.serviceReads, ['global app']);
  // The logs decide alone: Monitoring's count, sampled (M2), is neither read nor compared with them.
  assert.deepEqual(t.world.metricReads, []);
  assert.deepEqual(t.world.logReads, [LOGS_WINDOW]);
  assert.equal(t.world.tasks[0].body.action, 'nap');
  assert.equal(t.run().idleReads, 'request logs');
});

test('request logs: a browser\'s GET among the scanners keeps the workload awake', async () => {
  const t = setup({ run: AWAKE_LONG, vms: RUNNING, requests: 5, logConfig: EVERY_REQUEST, logs: [...SCANNERS, entry('/')] });
  assert.deepEqual(await t.controller.check(), [{ workloadId: 'demo', state: STATES.AWAKE }]);
  assert.deepEqual(t.world.tasks, []);
  assert.equal(t.run().idleReads, 'request logs');
});

// M2: Monitoring's request_count is sampled and batched, its points late and in lumps, with gaps of six minutes: a count of 0 is no
// window without requests.
test('request logs decide alone: Monitoring counts 0, but the logs hold a browser\'s GET /: the workload stays awake, the run says request logs', async () => {
  const t = setup({ run: AWAKE_LONG, vms: RUNNING, requests: 0, logConfig: EVERY_REQUEST, logs: [entry('/')] });
  assert.deepEqual(await t.controller.check(), [{ workloadId: 'demo', state: STATES.AWAKE }]);
  assert.deepEqual(t.world.logReads, [LOGS_WINDOW]);
  assert.deepEqual(t.world.tasks, []);
  assert.equal(t.run().idleReads, 'request logs');
});

// M2: Monitoring counted 48 requests where the logs held 30 (and 32 where they held 24), all scanners': read through logs.mjs, the
// entries are not compared with the count.
test('request logs decide alone: Monitoring counts 48, the logs hold 30 scanners\' entries: the nap asked, no LogsUnread', async () => {
  const t = setup({ run: AWAKE_LONG, vms: RUNNING, requests: 48, logConfig: EVERY_REQUEST, logs: [] });
  realLogs(t, () => ({ entries: Array.from({ length: 30 }, (_, i) => logEntryOf(SCANNERS[i % SCANNERS.length])) }));
  assert.deepEqual(await t.controller.check(), [{ workloadId: 'demo', state: STATES.AWAKE, nap: 'requested' }]);
  assert.deepEqual(t.logged('LogsUnread'), []);
  assert.equal(t.run().idleReads, 'request logs');
});

test('request logs: three scanners\' entries while Monitoring counts 48: idle, Monitoring not read', async () => {
  const t = setup({ run: AWAKE_LONG, vms: RUNNING, requests: 48, logConfig: EVERY_REQUEST, logs: SCANNERS.slice(0, 3) });
  assert.deepEqual(await t.controller.check(), [{ workloadId: 'demo', state: STATES.AWAKE, nap: 'requested' }]);
  assert.deepEqual(t.world.metricReads, []);
  assert.deepEqual(t.logged('LogsEmpty'), []);
  assert.equal(t.run().idleReads, 'request logs');
});

// Logs that are empty while requests came are lost upstream (a _Default sink's exclusion of the load balancers' logs, the first
// minutes of regional logging): Monitoring's count over the same window says so.
test('request logs empty, Monitoring counts 0: idle, the count read over the same window, the run left as it says', async () => {
  const t = setup({ run: AWAKE_LONG, vms: RUNNING, requests: 0, logConfig: EVERY_REQUEST, logs: [] });
  assert.deepEqual(await t.controller.check(), [{ workloadId: 'demo', state: STATES.AWAKE, nap: 'requested' }]);
  assert.deepEqual(t.world.logReads, [LOGS_WINDOW]);
  assert.deepEqual(t.world.metricReads, [{ backendService: 'app', ...IDLE_WINDOW }]);
  assert.deepEqual(t.logged('LogsEmpty'), []);
  assert.equal(t.run().idleReads, undefined);
});

test('request logs empty, Monitoring counts 5: the count decides, awake, request count, LogsEmpty said once an hour per workload', async () => {
  const t = setup({ run: AWAKE_LONG, vms: RUNNING, requests: 5, logConfig: EVERY_REQUEST, logs: [] });
  assert.deepEqual(await t.controller.check(), [{ workloadId: 'demo', state: STATES.AWAKE }]);
  assert.deepEqual(t.world.tasks, []);
  assert.equal(t.run().idleReads, 'request count');
  assert.deepEqual(t.logged('LogsEmpty').map(({ level, workloadId, backendService, count }) => ({ level, workloadId, backendService, count })), [
    { level: 'warn', workloadId: 'demo', backendService: 'app', count: 5 },
  ]);
  t.clock.advance(59 * MINUTE);
  assert.deepEqual(await t.controller.check(), [{ workloadId: 'demo', state: STATES.AWAKE }]);
  assert.equal(t.logged('LogsEmpty').length, 1);
  t.clock.advance(MINUTE);
  await t.controller.check();
  assert.equal(t.logged('LogsEmpty').length, 2);
});

test('a failed read of the logs (null): the count decides, 0 idle and the run left as it says, more awake and request count', async () => {
  const idle = setup({ run: { ...AWAKE_LONG, idleReads: 'request logs' }, vms: RUNNING, requests: 0, logConfig: EVERY_REQUEST, logs: null });
  assert.equal((await idle.controller.check())[0].nap, 'requested');
  assert.deepEqual(idle.world.logReads, [LOGS_WINDOW]);
  assert.deepEqual(idle.world.metricReads, [{ backendService: 'app', ...IDLE_WINDOW }]);
  assert.equal(idle.run().idleReads, 'request logs');
  const busy = setup({ run: AWAKE_LONG, vms: RUNNING, requests: 4, logConfig: EVERY_REQUEST, logs: null });
  assert.deepEqual(await busy.controller.check(), [{ workloadId: 'demo', state: STATES.AWAKE }]);
  assert.equal(busy.world.logReads.length, 1);
  assert.deepEqual(busy.world.tasks, []);
  assert.equal(busy.run().idleReads, 'request count');
  // A read that failed is no empty log.
  assert.deepEqual(busy.logged('LogsEmpty'), []);
});

test('a failed read of the logs through logs.mjs (a 403): said in LogsUnread, and the count decides', async () => {
  const t = setup({ run: AWAKE_LONG, vms: RUNNING, requests: 3, logConfig: EVERY_REQUEST, logs: [] });
  realLogs(t, () => {
    throw new GoogleError('Google: POST https://logging.googleapis.com/v2/entries:list: 403 Permission \'logging.views.access\' denied', { code: 403 });
  });
  assert.deepEqual(await t.controller.check(), [{ workloadId: 'demo', state: STATES.AWAKE }]);
  assert.deepEqual(t.logged('LogsUnread').map((l) => l.level), ['warn']);
  assert.equal(t.run().idleReads, 'request count');
});

test('without request logs, as before them: the count decides, 0 idle and the run left as it says, more awake and request count', async () => {
  for (const [name, more] of [['no log view', {}], ['logging off', { logConfig: { enable: false }, logs: SCANNERS }]]) {
    const idle = setup({ run: AWAKE_LONG, vms: RUNNING, requests: 0, ...more });
    assert.equal((await idle.controller.check())[0].nap, 'requested', name);
    assert.deepEqual(idle.world.metricReads, [{ backendService: 'app', ...IDLE_WINDOW }], name);
    assert.deepEqual(idle.world.logReads, [], name);
    assert.equal(idle.run().idleReads, undefined, name);
    const busy = setup({ run: AWAKE_LONG, vms: RUNNING, requests: 4, ...more });
    assert.deepEqual(await busy.controller.check(), [{ workloadId: 'demo', state: STATES.AWAKE }], name);
    assert.equal(busy.run().idleReads, 'request count', name);
  }
});

test('logging off, or sampled below 1.0, or no logConfig: no read of the logs, the count decides', async () => {
  for (const logConfig of [{ enable: false }, { enable: false, sampleRate: 1 }, { enable: true, sampleRate: 0.5 }, undefined]) {
    const t = setup({ run: AWAKE_LONG, vms: RUNNING, requests: 4, logConfig, logs: SCANNERS });
    assert.deepEqual(await t.controller.check(), [{ workloadId: 'demo', state: STATES.AWAKE }], JSON.stringify(logConfig));
    assert.deepEqual(t.world.serviceReads, ['global app']);
    assert.deepEqual(t.world.logReads, [], JSON.stringify(logConfig));
    assert.equal(t.run().idleReads, 'request count');
  }
});

test('logging on with no sampleRate logs every request (Google\'s default, 1.0): the logs are read', async () => {
  const t = setup({ run: AWAKE_LONG, vms: RUNNING, requests: 4, logConfig: { enable: true }, logs: SCANNERS });
  assert.equal((await t.controller.check())[0].nap, 'requested');
  assert.equal(t.world.logReads.length, 1);
});

test('no log view (DMT_LOG_VIEW unset): neither the backend service nor the logs are read, the count decides', async () => {
  const t = setup({ run: AWAKE_LONG, vms: RUNNING, requests: 4, logConfig: EVERY_REQUEST });
  assert.deepEqual(await t.controller.check(), [{ workloadId: 'demo', state: STATES.AWAKE }]);
  assert.deepEqual(t.world.serviceReads, []);
  assert.equal(t.run().idleReads, 'request count');
});

test('a logConfig that cannot be read: the count decides, said in LogsUnread, and the check goes on', async () => {
  const t = setup({ run: AWAKE_LONG, vms: RUNNING, requests: 4, logConfig: EVERY_REQUEST, logs: SCANNERS });
  t.world.serviceRefused = new GoogleError('Google: GET: 503 unavailable', { code: 503 });
  assert.deepEqual(await t.controller.check(), [{ workloadId: 'demo', state: STATES.AWAKE }]);
  assert.deepEqual(t.world.logReads, []);
  assert.match(t.logged('LogsUnread')[0].reason, /logConfig.*503 unavailable/);
  assert.equal(t.logged('CheckFailed').length, 0);
});

// Past 1,000 entries, the read is null and the count decides: logs.test.mjs, "more entries than the limit is null".
test('the logs are read whatever Monitoring counts, past 1,000 too, and 1,000 entries decide', async () => {
  const busy = setup({ run: AWAKE_LONG, vms: RUNNING, requests: 1001, logConfig: EVERY_REQUEST, logs: SCANNERS });
  assert.equal((await busy.controller.check())[0].nap, 'requested');
  assert.deepEqual(busy.world.logReads, [LOGS_WINDOW]);
  assert.equal(busy.run().idleReads, 'request logs');
  const cap = setup({ run: AWAKE_LONG, vms: RUNNING, requests: 0, logConfig: EVERY_REQUEST, logs: Array(1000).fill(SCANNERS[0]) });
  assert.equal((await cap.controller.check())[0].nap, 'requested');
  assert.equal(cap.run().idleReads, 'request logs');
});

test('what the idle check read is written when it changes only', async () => {
  const t = setup({ run: AWAKE_LONG, vms: RUNNING, requests: 5, logConfig: EVERY_REQUEST, logs: [...SCANNERS, entry('/')] });
  const written = [];
  const { setIdleReads } = t.store;
  t.store.setIdleReads = (...args) => {
    written.push(args);
    return setIdleReads(...args);
  };
  await t.controller.check();
  t.clock.advance(MINUTE);
  await t.controller.check();
  t.world.logEntries = null;
  t.clock.advance(MINUTE);
  await t.controller.check();
  assert.deepEqual(written, [['demo', 'request logs'], ['demo', 'request count']]);
});

test('what the idle check read that cannot be written: logged, and the nap asked all the same', async () => {
  const t = setup({ run: AWAKE_LONG, vms: RUNNING, requests: 4, logConfig: EVERY_REQUEST, logs: SCANNERS });
  t.store.setIdleReads = async () => { throw new Error('Firestore down'); };
  assert.equal((await t.controller.check())[0].nap, 'requested');
  assert.match(t.logged('IdleReadsNotRecorded')[0].error, /Firestore down/);
});

test('request logs: an address of a list the waker ignores is no activity, the lists read as the waker holds them', async () => {
  const t = setup({
    run: AWAKE_LONG, vms: RUNNING, requests: 2, logConfig: EVERY_REQUEST, lists: LISTS, download: async () => '1.2.3.4\n',
    logs: [entry('/', { remoteIp: '1.2.3.4' }), entry('/shop', { remoteIp: '1.2.3.4' })],
  });
  await t.controller.refreshLists(['scanners']);
  assert.equal((await t.controller.check())[0].nap, 'requested');
  t.world.logEntries = [entry('/', { remoteIp: '1.2.3.4' }), entry('/', { remoteIp: '198.51.100.9' })];
  t.world.tasks = [];
  t.store.state.run = structuredClone(AWAKE_LONG);
  t.clock.advance(MINUTE);
  assert.deepEqual(await t.controller.check(), [{ workloadId: 'demo', state: STATES.AWAKE }]);
});

// G4's design left the no-wake rules to G5 (vision docs/specs/2026-11-07-google-cloud-fixes-design.md, section 5): a request a rule of
// any level ignores is no activity, as the waker ignores it.
const PARTNER = 'AcmeSync/2.1 (+https://acme.example/sync)';
const PARTNER_RULE = { name: 'partner', userAgentPattern: '^AcmeSync/' };
const PARTNER_LOGS = [entry('/', { userAgent: PARTNER }), entry('/api/orders', { userAgent: PARTNER }), entry('/api/orders', { method: 'POST', userAgent: PARTNER })];

test('request logs: entries all from a user agent a no-wake rule names, the workload\'s or the router\'s, are no activity: the nap asked; without the rule, awake', async () => {
  const logged = { run: AWAKE_LONG, vms: RUNNING, requests: 3, logConfig: EVERY_REQUEST, logs: PARTNER_LOGS };
  const workload = setup({ ...logged, cfg: { noWakeRules: [PARTNER_RULE] } });
  assert.deepEqual(await workload.controller.check(), [{ workloadId: 'demo', state: STATES.AWAKE, nap: 'requested' }]);
  assert.equal(workload.run().idleReads, 'request logs');
  const router = leveled({ defaults: { noWakeRules: [PARTNER_RULE] } }, logged);
  assert.deepEqual(await router.controller.check(), [{ workloadId: 'demo', state: STATES.AWAKE, nap: 'requested' }]);
  assert.equal(router.run().idleReads, 'request logs');
  const none = setup(logged);
  assert.deepEqual(await none.controller.check(), [{ workloadId: 'demo', state: STATES.AWAKE }]);
  assert.deepEqual(none.world.tasks, []);
  assert.equal(none.run().idleReads, 'request logs');
});

test('an idle nap\'s last read applies the no-wake rules too: the partner\'s requests during the wait, it naps', async () => {
  const t = setup({
    run: AWAKE_LONG, cfg: { hibernate: false, noWakeRules: [PARTNER_RULE] }, vms: RUNNING, logConfig: EVERY_REQUEST,
    logs: logView(PARTNER_LOGS.map((request) => [START + 1000, request])),
  });
  assert.equal((await t.controller.check())[0].nap, 'requested');
  assert.equal((await t.controller.nap('demo', t.world.tasks[0].body)).state, STATES.ASLEEP);
  assert.equal(t.world.logReads.length, 2);
});

// As the waker compiles them (lambda/src/lib/waker-core.mjs): an invalid rule is skipped, so its requests are activity (more wakes,
// never fewer), and said once, not at each check.
test('request logs: an invalid no-wake rule is skipped, its requests activity, and said once in NoWakeRuleInvalid', async () => {
  const logged = { run: AWAKE_LONG, vms: RUNNING, requests: 3, logConfig: EVERY_REQUEST, logs: PARTNER_LOGS };
  const BROKEN = { name: 'broken', userAgentPattern: '(' };
  const beside = setup({ ...logged, cfg: { noWakeRules: [BROKEN, PARTNER_RULE] } });
  assert.equal((await beside.controller.check())[0].nap, 'requested');
  const alone = setup({ ...logged, cfg: { noWakeRules: [BROKEN] } });
  assert.deepEqual(await alone.controller.check(), [{ workloadId: 'demo', state: STATES.AWAKE }]);
  alone.clock.advance(MINUTE);
  await alone.controller.check();
  assert.deepEqual(alone.logged('NoWakeRuleInvalid').map(({ level, rule }) => ({ level, rule })), [{ level: 'workload', rule: 'broken' }]);
});

// `timed`: `[at (ms), request]`, what the log view holds; read as logs.mjs reads it, over [from, to).
const logView = (timed) => ({ from, to }) => timed.filter(([at]) => at >= from && at < to).map(([, request]) => request);

test('an idle nap\'s last read goes by the request logs too: scanners during the wait, it naps; a browser, AWAKE (traffic)', async () => {
  for (const [during, state] of [[SCANNERS, STATES.ASLEEP], [[entry('/')], STATES.AWAKE]]) {
    // After the check's window, during the nap's wait.
    const t = setup({ run: AWAKE_LONG, cfg: { hibernate: false }, vms: RUNNING, logConfig: EVERY_REQUEST, logs: logView(during.map((request) => [START + 1000, request])) });
    assert.equal((await t.controller.check())[0].nap, 'requested');
    const out = await t.controller.nap('demo', t.world.tasks[0].body);
    assert.equal(out.state, state);
    assert.equal(t.world.logReads.length, 2);
    const { to, ...read } = t.world.logReads[1];
    assert.deepEqual(read, { backendService: 'app', from: START - 210_000 - MINUTE, limit: 1000 });
    assert.ok(to > START + 1000);
    if (state === STATES.AWAKE) assert.deepEqual(t.run().napAborted, { reason: 'traffic', at: t.clock.now() });
  }
});

// Entries reach the logs 0.6 to 1.5 s after the request on a classic load balancer, about 10 s on a regional one (M2): a request
// just before the check is read by the nap's last read, before anything stops.
test('an idle nap\'s last read: a browser\'s request the logs showed only after the check is traffic, AWAKE, nothing stopped', async () => {
  // A request 5 s before the check, in the logs 10 s after it.
  const t = setup({ run: AWAKE_LONG, cfg: { hibernate: false }, vms: RUNNING, logConfig: EVERY_REQUEST, logs: ({ to }) => (to > START + 5000 ? [entry('/')] : []) });
  assert.equal((await t.controller.check())[0].nap, 'requested');
  const out = await t.controller.nap('demo', t.world.tasks[0].body);
  assert.equal(out.state, STATES.AWAKE);
  assert.deepEqual(t.run().napAborted, { reason: 'traffic', at: t.clock.now() });
  assert.ok(!t.world.calls.some((call) => /^(stop|suspend)/.test(call)), t.world.calls.join(', '));
});

// The log lost upstream, at the nap's last read: the count over its window decides.
test('an idle nap\'s last read on an empty log while Monitoring counts 3: traffic, AWAKE, said in LogsEmpty, nothing stopped', async () => {
  let reads = 0;
  const t = setup({ run: AWAKE_LONG, cfg: { hibernate: false }, vms: RUNNING, requests: () => (reads++ ? 3 : 0), logConfig: EVERY_REQUEST, logs: [] });
  assert.equal((await t.controller.check())[0].nap, 'requested');
  const out = await t.controller.nap('demo', t.world.tasks[0].body);
  assert.equal(out.state, STATES.AWAKE);
  assert.deepEqual(t.run().napAborted, { reason: 'traffic', at: t.clock.now() });
  assert.deepEqual(t.logged('LogsEmpty').map(({ count }) => count), [3]);
  assert.ok(!t.world.calls.some((call) => /^(stop|suspend)/.test(call)), t.world.calls.join(', '));
});

test('request logs are read from a minute before the window: a scanner\'s request there is read too, no activity, the nap asked', async () => {
  const t = setup({
    run: AWAKE_LONG, vms: RUNNING, requests: 2, logConfig: EVERY_REQUEST,
    logs: logView([[IDLE_WINDOW.from - 30_000, entry('/.env')], [IDLE_WINDOW.from + MINUTE, entry('/wp-login.php')]]),
  });
  assert.deepEqual(await t.controller.check(), [{ workloadId: 'demo', state: STATES.AWAKE, nap: 'requested' }]);
  assert.deepEqual(t.world.logReads, [LOGS_WINDOW]);
  assert.equal(t.run().idleReads, 'request logs');
});

test('an idle nap\'s last read: a scanners\' burst in the minute before it starts, which the check read as noise, is no traffic: it naps', async () => {
  // The burst 240 s before the check: in the check's window, and in the minute before the nap's read's start.
  const burst = [entry('/.env'), entry('/wp-login.php'), entry('/', { method: 'HEAD' })].map((request) => [START - 240_000, request]);
  const t = setup({ run: AWAKE_LONG, cfg: { hibernate: false }, vms: RUNNING, requests: burst.length, logConfig: EVERY_REQUEST, logs: logView(burst) });
  assert.equal((await t.controller.check())[0].nap, 'requested');
  const out = await t.controller.nap('demo', t.world.tasks[0].body);
  assert.equal(out.state, STATES.ASLEEP);
  assert.equal(t.world.logReads[1].from, START - 210_000 - MINUTE);
  assert.equal(t.run().napAborted, undefined);
  assert.deepEqual(t.logged('LogsUnread'), []);
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

// The unmanaged group and the backend service as the onboarding read them: a nap acts on them only while they still are so.
async function groupWorkload() {
  const t = worldOf();
  await t.onboarding.onboard({ urlMap: 'lb', backendService: 'app', id: 'demo', settings: { hibernate: false } });
  return t;
}

test('the onboarding records the groups of the unmanaged VMs and the backends of the service', async () => {
  const t = await groupWorkload();
  const cfg = await t.store.getConfig('demo');
  assert.deepEqual(cfg.groups, { 'vm-a': unmanagedUrl('ig') });
  assert.deepEqual(cfg.serviceBackends, [unmanagedUrl('ig')]);
});

test('a nap of an unmanaged group that gained a VM since the onboarding stops nothing: awake again (backends-changed)', async () => {
  const t = await groupWorkload();
  t.w.unmanaged.ig.push('vm-new');
  t.w.vms['vm-new'] = { id: '1002', status: 'RUNNING' };
  const out = await t.core.nap('demo');
  assert.equal(out.state, STATES.AWAKE);
  assert.equal(out.aborted, true);
  assert.match(out.error, /instance group ig changed since the onboarding \(VMs added: vm-new\): offboard and onboard again/);
  assert.equal(t.w.vms['vm-a'].status, 'RUNNING');
  assert.equal(t.w.changes.some((c) => c.startsWith('stop') || c.startsWith('suspend')), false);
  assert.equal(t.w.logs.find((l) => l.event === 'NapAborted').reason, out.error);
  assert.equal(t.w.logs.find((l) => l.event === 'StateChanged' && l.to === STATES.AWAKE).cause, 'backends-changed');
});

test('a nap of an unmanaged group that lost a VM since the onboarding stops nothing', async () => {
  const t = await groupWorkload();
  t.w.unmanaged.ig = [];
  const out = await t.core.nap('demo');
  assert.equal(out.aborted, true);
  assert.match(out.error, /VMs removed: vm-a/);
  assert.equal(t.w.vms['vm-a'].status, 'RUNNING');
});

test('a nap reads each unmanaged group once, whatever its VMs', async () => {
  const t = worldOf((world) => {
    world.unmanaged.ig = ['vm-a', 'vm-b'];
    world.vms['vm-b'] = { id: '1002', status: 'RUNNING' };
  });
  await t.onboarding.onboard({ urlMap: 'lb', backendService: 'app', id: 'demo', settings: { hibernate: false } });
  const reads = [];
  const listed = t.w.unmanaged;
  t.w.unmanaged = new Proxy(listed, { get: (target, name) => { if (name === 'ig') reads.push(name); return target[name]; } });
  assert.equal((await t.core.nap('demo')).state, STATES.ASLEEP);
  // The nap checks the backends twice (before the policy and before the stop): one read of the group each time, not one per VM.
  assert.ok(reads.length > 0 && reads.length <= 2, `${reads.length} reads`);
});

test('a nap of a backend service that gained a backend since the onboarding stops nothing: awake again (backends-changed)', async () => {
  const t = await groupWorkload();
  t.w.services.app.backends.push({ group: unmanagedUrl('late') });
  const out = await t.core.nap('demo');
  assert.equal(out.state, STATES.AWAKE);
  assert.equal(out.aborted, true);
  assert.match(out.error, /backend service app changed since the onboarding \(backends added: .*late\): offboard and onboard again/);
  assert.equal(t.w.vms['vm-a'].status, 'RUNNING');
  assert.equal(t.w.logs.find((l) => l.event === 'StateChanged' && l.to === STATES.AWAKE).cause, 'backends-changed');
});

test('a nap of a backend service that lost a backend since the onboarding stops nothing', async () => {
  const t = await groupWorkload();
  t.w.services.app.backends = [];
  const out = await t.core.nap('demo');
  assert.equal(out.aborted, true);
  assert.match(out.error, /backends removed: .*\/ig\b/);
  assert.equal(t.w.vms['vm-a'].status, 'RUNNING');
});

test('a config written before groups and serviceBackends: the nap compares nothing and naps as before', async () => {
  const t = await groupWorkload();
  const cfg = await t.store.getConfig('demo');
  delete cfg.groups;
  delete cfg.serviceBackends;
  await t.store.putConfig('demo', cfg);
  t.w.unmanaged.ig.push('vm-new');
  t.w.vms['vm-new'] = { id: '1002', status: 'RUNNING' };
  t.w.services.app.backends.push({ group: unmanagedUrl('late') });
  assert.equal((await t.core.nap('demo')).state, STATES.ASLEEP);
  assert.equal(t.w.vms['vm-a'].status, 'TERMINATED');
});

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

test('a Cloud SQL wake of 28 minutes, near its 1700 s, beating every 60 s: no check sends it again or calls it stuck; AWAKE', async () => {
  const t = await asleepWithCompanion((w) => { w.sqlTakes.ALWAYS = 28 * MINUTE; });
  const start = t.clock.now();
  const beats = [];
  const { beat } = t.store;
  t.store.beat = (...args) => {
    beats.push(t.clock.now() - start);
    return beat(...args);
  };
  const seen = [];
  let next = start + 5 * MINUTE;
  t.clock.onSleep(async (now) => {
    if (now < next) return;
    next += 5 * MINUTE;
    seen.push(...(await t.core.check()));
  });
  assert.equal((await wakeNowIn(t)).state, STATES.AWAKE);
  assert.ok(t.clock.now() - start >= 28 * MINUTE, `${t.clock.now() - start} ms`);
  assert.deepEqual(seen, Array.from({ length: 5 }, () => ({ workloadId: 'demo', state: STATES.WAKING })));
  assert.deepEqual(t.w.tasks, []);
  for (const event of ['WakeResent', 'WakeStuck', 'WakeFailed', 'BeatFailed']) assert.equal(t.w.logs.filter((l) => l.event === event).length, 0, event);
  assert.ok(beats.length >= 28, `${beats.length} beats`);
  assert.ok(beats.every((at, i) => i === 0 || at - beats[i - 1] <= 60_000), `${beats}`);
  assert.equal(t.timers.size, 0);
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
    await t.onboarding.setSettings('demo', { wakeTimeoutSeconds: 60 });
    assert.equal((await wakeNowIn(t)).state, STATES.FAILED);
    await t.onboarding.setSettings('demo', { wakeTimeoutSeconds: 1700 });
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

// --- A companion deleted while it is the workload's: no nap goes down for it, and no wake stays down for it -----------------------

const goneReason = /^Cloud SQL instance db no longer exists: offboard and onboard again$/;
// `then(reads)` at each read of the instance, before it is answered.
const atEachRead = (t, then) => {
  let reads = 0;
  t.w.on['GET sql/instances/db'] = () => {
    reads += 1;
    then(reads);
  };
};
const logsOf = (t, event) => t.w.logs.filter((l) => l.event === event);

test('a companion gone, a nap: back to AWAKE in words, nothing stopped, nothing written', async () => {
  const t = await withCompanion();
  delete t.w.sql.db;
  const answer = await t.core.nap('demo');
  assert.equal(answer.state, STATES.AWAKE);
  assert.equal(answer.aborted, true);
  assert.match(answer.error, goneReason);
  assert.equal(t.store.runs.get('demo').state, STATES.AWAKE);
  assert.deepEqual(t.w.changes, []);
  assert.equal(t.w.vms['vm-a'].status, 'RUNNING');
  assert.ok(logsOf(t, 'NapAborted').some((l) => goneReason.test(l.reason)));
  assert.ok(logsOf(t, 'StateChanged').some((l) => l.to === STATES.AWAKE && l.cause === 'backends-changed'));
});

test('a companion gone during the nap\'s wait: the policy taken back, nothing stopped', async () => {
  const t = await withCompanion();
  atEachRead(t, (reads) => { if (reads === 2) delete t.w.sql.db; });
  const answer = await t.core.nap('demo');
  assert.equal(answer.state, STATES.AWAKE);
  assert.match(answer.error, goneReason);
  assert.equal(t.w.vms['vm-a'].status, 'RUNNING');
  assert.equal(t.w.changes.some((line) => APP_DOWN.test(line)), false);
  assert.equal(JSON.stringify(t.w.urlMaps.lb).includes('defaultCustomErrorResponsePolicy'), false);
});

test('a companion the router cannot read any more, a nap: back to AWAKE, nothing stopped', async () => {
  const t = await withCompanion();
  t.w.fail['GET sql/instances/db'] = new GoogleError('Google: GET: 403 not authorized', { code: 403, status: 'PERMISSION_DENIED' });
  const answer = await t.core.nap('demo');
  assert.equal(answer.state, STATES.AWAKE);
  assert.match(answer.error, /^the router cannot read Cloud SQL instance db/);
  assert.deepEqual(t.w.changes, []);
});

// A failure here would hold visitors at the waker, and each wake would refuse them: the visitors come back first.
test('under a swap, a companion gone or refused at the read after the wait: unswapped and waited for, AWAKE, nothing stopped', async () => {
  const refused = new GoogleError('Google: GET: 403 not authorized', { code: 403, status: 'PERMISSION_DENIED' });
  // A read answers what w.fail holds before it runs w.on: the second read is the one to refuse, from the first.
  for (const [at, lost] of [[2, (t) => { delete t.w.sql.db; }], [1, (t) => { t.w.fail['GET sql/instances/db'] = refused; }]]) {
    const t = await withCompanion(regionalWorld);
    atEachRead(t, (reads) => { if (reads === at) lost(t); });
    const answer = await t.core.nap('demo');
    assert.equal(answer.state, STATES.AWAKE);
    assert.equal(answer.aborted, true);
    assert.equal(t.store.runs.get('demo').state, STATES.AWAKE);
    assert.equal(t.w.vms['vm-a'].status, 'RUNNING');
    assert.equal(t.w.changes.some((line) => APP_DOWN.test(line)), false);
  }
});

test('a companion deleted after a nap\'s last read: the nap ends, said; the application is down as asked, and a wake finds it', async () => {
  const t = await withCompanion();
  atEachRead(t, (reads) => { if (reads === 3) delete t.w.sql.db; });
  assert.equal((await t.core.nap('demo')).state, STATES.ASLEEP);
  assert.ok(logsOf(t, 'CompanionGone').some((l) => l.workloadId === 'demo' && l.instance === 'db'));
  t.clock.advance(600_000);
  assert.equal((await wakeNowIn(t)).state, STATES.AWAKE);
});

test('a companion gone, a wake: the application starts all the same, said in the log and on the run, and no failure', async () => {
  const t = await asleepWithCompanion();
  delete t.w.sql.db;
  const answer = await wakeNowIn(t);
  assert.equal(answer.state, STATES.AWAKE);
  assert.ok(t.w.changes.some((line) => APP_UP.test(line)));
  assert.equal(t.w.vms['vm-a'].status, 'RUNNING');
  assert.ok(logsOf(t, 'CompanionGone').some((l) => l.workloadId === 'demo' && l.instance === 'db'));
  const run = t.store.runs.get('demo');
  assert.deepEqual(run.companionsGone, ['db']);
  assert.equal(run.failure, undefined);
});

test('two companions, one gone, a wake: the other still comes first, the application next', async () => {
  const t = worldOf((w) => { Object.assign(w.sql, { db: {}, second: {} }); });
  await t.onboarding.onboard({ ...SQL_INPUT, cloudSql: ['db', 'second'] });
  assert.equal((await t.core.nap('demo')).state, STATES.ASLEEP);
  t.clock.advance(t.w.sqlTakes.NEVER);
  t.w.changes.length = 0;
  delete t.w.sql.db;
  assert.equal((await wakeNowIn(t)).state, STATES.AWAKE);
  assert.ok(lineOf(t.w.changes, /^sql second ALWAYS$/) < lineOf(t.w.changes, APP_UP));
  assert.deepEqual(t.store.runs.get('demo').companionsGone, ['db']);
});

test('the story of a review: a companion deleted while awake: the check asks its nap, the nap aborts, the application serves on', async () => {
  const t = await withCompanion();
  delete t.w.sql.db;
  t.clock.advance(3_600_000);
  const [result] = await t.core.check();
  assert.equal(result.nap, 'requested');
  assert.equal(result.error, undefined);
  assert.equal((await t.core.nap('demo', { requestedAt: t.clock.now() })).state, STATES.AWAKE);
  const [next] = await t.core.check();
  assert.equal(next.state, STATES.AWAKE);
  assert.equal(t.w.vms['vm-a'].status, 'RUNNING');
});

for (const [state, arrange] of [[STATES.AWAKE, withCompanion], [STATES.ASLEEP, asleepWithCompanion]]) {
  test(`the check, ${state}: a companion gone is said and kept on the run, with no failure and no change; back, it is no longer`, async () => {
    const t = await arrange();
    delete t.w.sql.db;
    const [result] = await t.core.check();
    assert.equal(result.error, undefined);
    assert.equal(result.state, state);
    assert.deepEqual(t.store.runs.get('demo').companionsGone, ['db']);
    assert.ok(logsOf(t, 'CompanionGone').some((l) => l.instance === 'db'));
    assert.deepEqual(logsOf(t, 'DatabaseNotFollowed'), []);
    assert.deepEqual(t.w.changes.filter((line) => line.startsWith('sql ')), []);
    // Said at each check, written once.
    const { version } = t.store.runs.get('demo');
    await t.core.check();
    assert.equal(logsOf(t, 'CompanionGone').length, 2);
    assert.equal(t.store.runs.get('demo').version, version);
    t.w.sql.db = { settings: { activationPolicy: state === STATES.AWAKE ? 'ALWAYS' : 'NEVER' } };
    await t.core.check();
    assert.equal(t.store.runs.get('demo').companionsGone, undefined);
  });
}

test('the check: another failure on a companion is no gone one', async () => {
  const t = await withCompanion();
  t.w.fail['GET sql/instances/db'] = new GoogleError('Google: refused', { code: 500 });
  await t.core.check();
  assert.deepEqual(logsOf(t, 'CompanionGone'), []);
  assert.equal(t.store.runs.get('demo').companionsGone, undefined);
});

test('a wake with a companion back since: the run no longer says it is gone', async () => {
  const t = await asleepWithCompanion();
  const { settings } = t.w.sql.db;
  delete t.w.sql.db;
  await t.core.check();
  assert.deepEqual(t.store.runs.get('demo').companionsGone, ['db']);
  t.w.sql.db = { settings };
  assert.equal((await wakeNowIn(t)).state, STATES.AWAKE);
  assert.equal(t.store.runs.get('demo').companionsGone, undefined);
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
  // Its third: the two before the commit point are read for the nap's own sake.
  atEachRead(t, (reads) => { if (reads === 3) t.store.setPendingWake('demo'); });
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
  // The last read before the tries is the stop's: those before it are the nap's own, before its commit point.
  let refused;
  t.w.on['GET sql/instances/db'] = () => { refused = t.clock.now(); };
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
const scaler = (annotations = {}) => ({ metadata: { namespace: 'shop', name: 'web-scaler', annotations }, spec: { scaleTargetRef: { name: 'web' }, minReplicaCount: 1 } });
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

test('a pod that stays unschedulable: unhealthy at the deadline, with the Kubernetes events, at the built-in 600 s', async () => {
  const t = await asleepPods();
  t.w.kube.unschedulable = true;
  t.w.kube.events.push(event(t.clock.now() + 1000, 'FailedScheduling', '0/3 nodes are available: 3 Insufficient cpu.'));
  const started = t.clock.now();
  const out = await wakePods(t);
  assert.equal(out.state, STATES.FAILED);
  assert.equal(failureOfRun(t).kind, 'unhealthy');
  assert.match(failureOfRun(t).message, /^no pod of Deployment shop\/web healthy when the wake timed out: pod web-0: FailedScheduling: 0\/3 nodes are available/);
  assert.ok(t.clock.now() - started >= 600_000);
  assert.ok(t.clock.now() - started < 610_000);
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

// --- The journal (G2 §5.3): what a transition hands the store for its event, and the line it logs ----------------------------

// The state changes the controller asked of the store, as { to, cause, event }.
function changesOf(t) {
  const asked = [];
  const { transition } = t.store;
  t.store.transition = (id, change) => {
    if (change.set?.state) asked.push({ to: change.set.state, cause: change.cause, event: change.event });
    return transition.call(t.store, id, change);
  };
  return asked;
}

test('a wake to AWAKE hands the store its wakeId and duration for the event; the log says when, and which router', async () => {
  const t = setup({ run: waking(START - 5000), vms: { 'vm-a': { status: 'TERMINATED' } }, map: asleepMap() });
  const asked = changesOf(t);
  await t.controller.wake('demo', 'w1');
  assert.deepEqual(asked.find((c) => c.to === STATES.AWAKE).event, { wakeId: 'w1', durationMs: 5000, tags: {} });
  const line = t.logged('StateChanged').find((l) => l.to === STATES.AWAKE);
  assert.deepEqual([line.router, line.region, line.project], ['dmtr-europe-west1', 'europe-west1', 'p']);
  assert.equal(line.at, new Date(t.run().stateAt ?? t.clock.now()).toISOString());
});

test('a wake to FAILED hands the store its failure with an ISO `at`, and the log carries it', async () => {
  const t = setup({ run: waking(START), vms: { 'vm-a': { status: 'TERMINATED' } }, map: asleepMap() });
  t.world.on['start vm-a'] = async () => { throw stockout(); };
  const asked = changesOf(t);
  await t.controller.wake('demo', 'w1');
  const { event } = asked.find((c) => c.to === STATES.FAILED);
  assert.equal(event.wakeId, 'w1');
  assert.equal(event.failure.kind, 'capacity');
  assert.equal(event.failure.at, new Date(t.clock.now()).toISOString());
  assert.equal(t.logged('StateChanged').find((l) => l.to === STATES.FAILED).failure.at, event.failure.at);
});

test('a nap to ASLEEP hands the store the VMs it suspended, which the event lists as hibernated', async () => {
  const t = setup({ vms: { 'vm-a': { status: 'RUNNING' } } });
  const asked = changesOf(t);
  await t.controller.nap('demo');
  const change = asked.find((c) => c.to === STATES.ASLEEP);
  assert.deepEqual(change.event.suspended, ['vm-a']);
  assert.deepEqual(eventOf({ workloadId: 'demo', from: 'NAPPING', to: 'ASLEEP', stateAt: START, event: change.event, router: { name: 'dmtr-europe-west1', region: 'europe-west1', project: 'p' } }).hibernated, ['vm-a']);
});

test('a state change reads no configuration of its own: its event carries the tags the wake read', async () => {
  const t = setup({ run: waking(START - 5000), vms: { 'vm-a': { status: 'TERMINATED' } }, map: asleepMap(), cfg: { tags: { team: 'a' } } });
  const asked = changesOf(t);
  let reads = 0;
  const { getConfig } = t.store;
  t.store.getConfig = (...args) => {
    reads += 1;
    return getConfig.apply(t.store, args);
  };
  await t.controller.wake('demo', 'w1');
  assert.equal(reads, 1);
  assert.deepEqual(asked.find((c) => c.to === STATES.AWAKE).event.tags, { team: 'a' });
});

// --- The check's summary and the router's health (G2 plan 1, R3; design §5.4) -------------------------------------------------

const SCHEDULE = '*/5 * * * *';
const AWS_ROUTER_KEYS = {
  router: ['name', 'version', 'build'],
  settings: ['hibernate', 'joinMinutes', 'by', 'at'],
  managerSettings: ['url', 'hibernate', 'joinMinutes', 'readAt', 'error'],
  configuration: ['checkSchedule', 'ipLists', 'noWakeRules', 'metrics'],
  pauses: [],
  workloads: ['total', 'byState', 'paused', 'lastActivityAt'],
  health: ['status', 'problems', 'checkSchedule', 'lastScheduledCheckAt', 'lambda', 'queues', 'ipLists', 'concurrency', 'drift24h'],
};

test('a check writes router/check: when, how long, the schedule, the counts by state, and the health', async () => {
  const t = setup({ run: AWAKE_LONG, vms: RUNNING_VM });
  await t.controller.check({ scheduled: true });
  assert.deepEqual(t.store.state.check, {
    checkedAt: START, durationMs: 0, checkSchedule: SCHEDULE, lastScheduledCheckAt: START,
    health: { status: 'ok', problems: [] }, pauses: [], counts: { AWAKE: 1 },
  });
});

test('a check an operator asked keeps the last scheduled check\'s date; none ever ran: check-late is in its health', async () => {
  const t = setup({ run: AWAKE_LONG, vms: RUNNING_VM });
  await t.controller.check();
  assert.equal(t.store.state.check.lastScheduledCheckAt, null);
  assert.deepEqual(t.store.state.check.health.problems.map((p) => p.code), ['check-late']);
  await t.controller.check({ scheduled: true });
  t.clock.advance(MINUTE);
  await t.controller.check();
  assert.equal(t.store.state.check.lastScheduledCheckAt, START);
  assert.equal(t.store.state.check.checkedAt, START + MINUTE);
  assert.equal(t.store.state.check.health.status, 'ok');
});

test('a check whose summary cannot be written is not failed: it says so', async () => {
  const t = setup({ run: AWAKE_LONG, vms: RUNNING_VM });
  t.store.putCheck = async () => { throw unreadable(); };
  assert.deepEqual(await t.controller.check({ scheduled: true }), [{ workloadId: 'demo', state: STATES.AWAKE, nap: 'requested' }]);
  assert.equal(t.logged('CheckNotRecorded').length, 1);
});

test('a check whose pauses cannot be read says so in its summary with the read\'s error, as routerInfo and AWS\'s health say it', async () => {
  const t = setup({ run: AWAKE_LONG, vms: RUNNING_VM });
  t.store.listPauses = async () => { throw unreadable(); };
  await t.controller.check({ scheduled: true });
  const problem = { level: 'warning', code: 'pauses-unreadable', text: `pauses unreadable: ${unreadable().message}` };
  assert.deepEqual(t.store.state.check.health, { status: 'warning', problems: [problem] });
  assert.deepEqual((await t.controller.routerInfo()).health.problems, [problem]);
});

test('a check whose IP lists\' records cannot be read writes its summary all the same, each list\'s problem in its health; routerInfo answers too', async () => {
  const t = setup({ run: AWAKE_LONG, vms: RUNNING_VM, lists: LISTS });
  t.store.getListMeta = () => { throw unreadable(); };
  await t.controller.check({ scheduled: true });
  assert.equal(t.logged('CheckNotRecorded').length, 0);
  const problem = { level: 'warning', code: 'ip-list:scanners', text: `IP list scanners: ${unreadable().message}` };
  assert.deepEqual(t.store.state.check.health, { status: 'warning', problems: [problem] });
  const info = await t.controller.routerInfo();
  assert.deepEqual(info.health.problems, [problem]);
  assert.deepEqual(info.health.ipLists.map((l) => [l.name, l.error, l.source]), [['scanners', unreadable().message, 'cli']]);
});

test('the counts of router/check are the workloads\' states, a workload with no run counting UNKNOWN', async () => {
  const t = setup({ run: FAILED_RUN(START - MINUTE), vms: RUNNING_VM, map: asleepMap(), unhealthyPolls: Infinity });
  await t.controller.check({ scheduled: true });
  assert.deepEqual(t.store.state.check.counts, { FAILED: 1 });
  assert.equal(t.store.state.check.health.problems.find((p) => p.code === 'failed-workloads').level, 'warning');
});

test('routerInfo answers the AWS router action\'s keys, with the Google Cloud router\'s values', async () => {
  const t = setup({ run: AWAKE_LONG, vms: RUNNING_VM });
  await t.controller.check({ scheduled: true });
  const info = await t.controller.routerInfo();
  assert.deepEqual(Object.keys(info), Object.keys(AWS_ROUTER_KEYS));
  for (const [key, names] of Object.entries(AWS_ROUTER_KEYS)) for (const name of names) assert.ok(name in info[key], `${key}.${name}`);
  assert.deepEqual(info.router, { name: 'dmtr-europe-west1', version: '0.40.0', build: 'abc123' });
  assert.equal(info.configuration.checkSchedule.value, SCHEDULE);
  assert.deepEqual(info.pauses, []);
  assert.deepEqual(info.workloads, { total: 1, byState: { AWAKE: 1 }, paused: 0, lastActivityAt: null });
  assert.deepEqual(info.health, {
    status: 'ok', problems: [], checkSchedule: SCHEDULE, lastScheduledCheckAt: new Date(START).toISOString(),
    lambda: {}, queues: {}, ipLists: [], concurrency: null, drift24h: 0,
  });
  assert.deepEqual(info.managerSettings, { url: null, hibernate: null, joinMinutes: null, readAt: null, error: null });
});

test('routerInfo: a router whose last scheduled check is 16 minutes old is check-late, an error; 14 minutes is fine', async () => {
  const late = setup({ run: AWAKE_LONG, vms: RUNNING_VM });
  late.store.state.check = { lastScheduledCheckAt: START - 16 * MINUTE };
  const health = (await late.controller.routerInfo()).health;
  assert.equal(health.status, 'error');
  assert.deepEqual(health.problems.map((p) => [p.level, p.code]), [['error', 'check-late']]);
  const fine = setup({ run: AWAKE_LONG, vms: RUNNING_VM });
  fine.store.state.check = { lastScheduledCheckAt: START - 14 * MINUTE };
  assert.equal((await fine.controller.routerInfo()).health.status, 'ok');
  assert.equal((await setup().controller.routerInfo()).health.problems[0].code, 'check-late', 'none ever recorded');
});

test('routerInfo: a failed workload is the warning failed-workloads', async () => {
  const t = setup({ run: FAILED_RUN(START - MINUTE) });
  t.store.state.check = { lastScheduledCheckAt: START };
  const info = await t.controller.routerInfo();
  assert.deepEqual(info.health.problems.map((p) => [p.level, p.code]), [['warning', 'failed-workloads']]);
  assert.deepEqual(info.workloads.byState, { FAILED: 1 });
});

test('routerInfo: the organization\'s settings that are not a JSON object are manager-settings-unreadable; absent, no problem', async () => {
  for (const settings of ['oops', null, ['a'], 3]) {
    const t = setup();
    t.store.state.check = { lastScheduledCheckAt: START };
    t.store.state.managerSettings = { settings, etag: 'e', at: START - MINUTE };
    const info = await t.controller.routerInfo();
    assert.deepEqual(info.health.problems.map((p) => p.code), ['manager-settings-unreadable'], JSON.stringify(settings));
    assert.equal(info.managerSettings.error, 'settings.json is invalid: settings.json must be an object');
  }
  const absent = setup();
  absent.store.state.check = { lastScheduledCheckAt: START };
  assert.deepEqual((await absent.controller.routerInfo()).health.problems, []);
  const unread = setup();
  unread.store.state.check = { lastScheduledCheckAt: START };
  unread.store.getManagerSettings = async () => { throw unreadable(); };
  assert.deepEqual((await unread.controller.routerInfo()).health.problems.map((p) => p.code), ['manager-settings-unreadable']);
});

test('routerInfo: the organization\'s settings are shown as the router holds them', async () => {
  const t = setup();
  t.store.state.check = { lastScheduledCheckAt: START };
  t.store.state.managerSettings = { settings: { workloads: { hibernate: false, joinMinutes: 10, defaults: { idleMinutes: 30 } } }, etag: 'e', at: START - MINUTE };
  const shown = (await t.controller.routerInfo()).managerSettings;
  assert.equal(shown.hibernate, false);
  assert.equal(shown.joinMinutes, 10);
  assert.deepEqual(shown.defaults, { idleMinutes: 30 });
  assert.equal('types' in shown, false);
  assert.equal(shown.error, null);
  assert.equal(shown.readAt, new Date(START - MINUTE).toISOString());
});

test('routerInfo: the router level\'s record and the active router pauses are shown; a router whose pauses cannot be read says so', async () => {
  const t = leveled({ hibernate: true, joinMinutes: 3, by: 'ops', at: START - MINUTE }, {});
  t.store.state.check = { lastScheduledCheckAt: START };
  const info = await t.controller.routerInfo();
  assert.deepEqual(info.settings, { hibernate: true, joinMinutes: 3, by: 'ops', at: new Date(START - MINUTE).toISOString() });
  t.store.listPauses = async () => { throw unreadable(); };
  assert.deepEqual((await t.controller.routerInfo()).health.problems.map((p) => p.code), ['pauses-unreadable']);
});

// --- Windows that ended long ago leave the schedule: the organization's endedWindowDays, a year by default (AWS's rule) ---------------

const OFFICE = { kind: 'awake', days: ['sat'], start: '10:00', end: '11:00' };
const endedOn = (day, until) => ({ kind: 'awake', days: [day], start: '10:00', end: '11:00', until });
const withEnded = (windows, settings) => {
  const t = scheduled(scheduleOf(...windows), { run: { state: STATES.ASLEEP } });
  if (settings !== undefined) t.store.state.managerSettings = { settings, etag: 'e', at: START - MINUTE };
  return t;
};
const kept = (t) => t.store.state.schedules.demo.windows;

test('a window that ended 400 days ago and no organization value: removed, the other kept, logged with the year', async () => {
  const t = withEnded([OFFICE, endedOn('sat', '2022-10-08')]);
  await t.controller.check();
  assert.deepEqual(kept(t), [OFFICE]);
  assert.deepEqual(t.logged('EndedWindowsRemoved').map(({ workloadId, windows, dates, days }) => ({ workloadId, windows, dates, days })), [{ workloadId: 'demo', windows: 1, dates: 0, days: 365 }]);
  assert.equal(t.store.state.schedules.demo.by, 'ops', 'who set the schedule is kept');
});

test('the organization\'s endedWindowDays 0 keeps them; 30 removes one ended 31 days ago and keeps one ended 29 days ago', async () => {
  const old = endedOn('sat', '2022-10-08');
  const keep = withEnded([OFFICE, old], { workloads: { endedWindowDays: 0 } });
  await keep.controller.check();
  assert.equal(kept(keep).length, 2);
  const month = withEnded([OFFICE, endedOn('sat', '2023-10-14'), endedOn('mon', '2023-10-16')], { workloads: { endedWindowDays: 30 } });
  await month.controller.check();
  assert.deepEqual(kept(month), [OFFICE, endedOn('mon', '2023-10-16')]);
  assert.deepEqual(month.logged('EndedWindowsRemoved').map((l) => l.days), [30]);
});

test('the organization\'s value unreadable, or its document not an object: nothing leaves; a document without the key uses the year', async () => {
  const bad = withEnded([OFFICE, endedOn('sat', '2022-10-08')], 'oops');
  await bad.controller.check();
  assert.equal(kept(bad).length, 2);
  const unread = withEnded([OFFICE, endedOn('sat', '2022-10-08')]);
  unread.store.getManagerSettings = async () => { throw unreadable(); };
  await unread.controller.check();
  assert.equal(kept(unread).length, 2);
  const unset = withEnded([OFFICE, endedOn('sat', '2022-10-08')], { workloads: { hibernate: true } });
  await unset.controller.check();
  assert.deepEqual(kept(unset), [OFFICE]);
});

test('not while a window is active, and a workload with no schedule never touches the schedules', async () => {
  const active = withEnded([NAP, endedOn('sat', '2022-10-08')]);
  await active.controller.check();
  assert.equal(kept(active).length, 2, 'an occurrence\'s id holds its window\'s index');
  const none = setup({ vms: { 'vm-a': { status: 'RUNNING' } } });
  none.store.replaceSchedule = async () => assert.fail('no schedule, nothing to replace');
  await none.controller.check();
});
