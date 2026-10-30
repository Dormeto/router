import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATES } from '../../lambda/src/lib/state.mjs';
import { GoogleError } from '../src/google.mjs';
import { Refusal } from '../src/onboarding.mjs';
import { INPUT, NEG, REGION, V1, WAKER, WAKER_URL, ZONE, CONTROLLER, serviceUrl, setup, unmanagedUrl } from './world.mjs';

const refused = (status, reason, message) => (err) => {
  assert.ok(err instanceof Refusal, err.stack);
  assert.equal(err.status, status);
  assert.equal(err.reason, reason);
  if (message) assert.match(err.message, message);
  return true;
};

const mig = (extra = {}) => ({ kind: 'zonal', location: ZONE, id: '2001', members: ['mig-1'], ...extra });
const withMig = (w, extra) => {
  w.managed.mig = mig(extra);
  w.vms['mig-1'] = { id: '3001', status: 'RUNNING' };
  w.services.app.backends = [{ group: `${V1}/zones/${ZONE}/instanceGroups/mig` }];
};

// --- Section 7's refusals -----------------------------------------------------------------------------------------------

const REFUSALS = [
  ['a classic load balancer', (w) => {
    w.forwardingRules[0].loadBalancingScheme = 'EXTERNAL';
    w.services.app.loadBalancingScheme = 'EXTERNAL';
  }, [
    'forwarding rule lb-fr has the scheme EXTERNAL, a classic load balancer: only the global external Application Load Balancer (EXTERNAL_MANAGED) is supported, migrate it first',
    'backend service app has the scheme EXTERNAL: only the global external Application Load Balancer (EXTERNAL_MANAGED) is supported, migrate it first',
  ]],
  ['a URL map that does not exist', (w) => { delete w.urlMaps.lb; }, ['URL map lb not found: name a global URL map of this project']],
  ['a URL map no target proxy uses', (w) => { w.httpsProxies = []; }, ['URL map lb is used by no target proxy: attach it to a global external Application Load Balancer, then onboard again']],
  ['a URL map two target proxies use', (w) => {
    w.httpProxies = [{ name: 'lb-http', selfLink: `${V1}/global/targetHttpProxies/lb-http`, urlMap: `${V1}/global/urlMaps/lb` }];
  }, ['URL map lb is used by 2 target proxies (lb-https, lb-http): give each load balancer its own URL map']],
  ['a target proxy no forwarding rule sends to', (w) => { w.forwardingRules = []; }, ['no forwarding rule sends to the target proxy of URL map lb: add one, then onboard again']],
  ['a backend service that does not exist', (w) => { delete w.services.app; }, ['backend service app not found: name a global backend service of this project']],
  ['a service the URL map does not name', (w) => { w.urlMaps.lb.pathMatchers[0].defaultService = serviceUrl('other'); }, ['backend service app is not named in URL map lb: route to it there, or name the URL map that does']],
  ['a service in another URL map', (w) => { w.urlMaps.second = { name: 'second', defaultService: serviceUrl('app') }; }, ['backend service app is also named in URL map second: that load balancer would lose its backends during a nap; give it a backend service of its own']],
  ['a network endpoint group backend', (w) => { w.services.app.backends = [{ group: `${V1}/zones/${ZONE}/networkEndpointGroups/neg` }]; }, ['backend neg of backend service app is a network endpoint group: only instance groups are supported (unmanaged, managed zonal or regional)']],
  ['a service without a backend', (w) => { w.services.app.backends = []; }, ['backend service app has no backend: add an instance group, then onboard again']],
  ['no health check', (w) => { delete w.services.app.healthChecks; }, ['backend service app has no health check: a wake waits for a healthy instance, add one']],
  ['a GPU VM', (w) => { w.vms['vm-a'].guestAccelerators = [{ acceleratorCount: 1 }]; }, ['VM vm-a has a GPU: GPU VMs are not supported, take it out of the backend service']],
  ['a VM whose machine type brings a GPU', (w) => { w.machineTypes['e2-small'].accelerators = [{ guestAcceleratorCount: 1 }]; }, ['VM vm-a has a GPU: GPU VMs are not supported, take it out of the backend service']],
  ['a local SSD', (w) => { w.vms['vm-a'].disks = [{ type: 'PERSISTENT' }, { type: 'SCRATCH' }]; }, ['VM vm-a has a local SSD: a stop would lose its data, take it out of the backend service']],
  ['a GPU VM in a managed group', (w) => {
    withMig(w);
    w.vms['mig-1'].guestAccelerators = [{ acceleratorCount: 1 }];
  }, ['VM mig-1 has a GPU: GPU VMs are not supported, take it out of the backend service']],
  ['a managed group with stateful disks', (w) => withMig(w, { status: { stateful: { hasStatefulConfig: true } } }), ['managed group mig has a stateful configuration: a nap might not keep it, take the group out of the backend service']],
  ['an instance group without a VM', (w) => { w.unmanaged.ig = []; }, ['instance group ig has no VM: add one, then onboard again']],
  ['a policy of the customer', (w) => {
    w.urlMaps.lb.pathMatchers[0].defaultCustomErrorResponsePolicy = { errorService: serviceUrl('own') };
  }, ['the URL map has its own error response policy at pathMatchers[0].defaultCustomErrorResponsePolicy: a nap would replace it, remove it first']],
  ['a route of the customer under /_dormeto/', (w) => {
    w.urlMaps.lb.pathMatchers[0].pathRules = [{ paths: ['/_dormeto/own'], service: serviceUrl('other') }];
  }, ['the URL map has its own /_dormeto/ route at pathMatchers[0].pathRules[0]: change that, then onboard again']],
  ['a waker name taken by another backend service', (w) => { w.services[WAKER] = { name: WAKER, backends: [] }; }, [`backend service ${WAKER} exists and is not the waker of demo: rename it, or onboard under another id`]],
];

for (const [name, change, reasons] of REFUSALS) {
  test(`dry run refuses ${name}, worded`, async () => {
    const { w, onboarding } = setup(change);
    const answer = await onboarding.dryRun(INPUT);
    assert.equal(answer.eligible, false);
    assert.deepEqual(answer.reasons, reasons);
    assert.deepEqual(w.changes, []);
  });
}

test('dry run refuses a backend service or a VM another workload holds', async () => {
  const { store, onboarding } = setup();
  store.configs.set('first', { workloadId: 'first', backendService: 'app', backends: [{ kind: 'vm', location: ZONE, name: 'vm-a', id: '1001' }] });
  assert.deepEqual((await onboarding.dryRun(INPUT)).reasons, [
    'backend service app is already workload first',
    'VM vm-a belongs to workload first',
  ]);
});

test('dry run refuses a workload onboarded already', async () => {
  const { onboarding } = setup();
  await onboarding.onboard(INPUT);
  assert.deepEqual((await onboarding.dryRun(INPUT)).reasons, ['workload demo is onboarded already']);
});

test('a refused onboarding is a 400 naming every reason, with nothing changed', async () => {
  const { w, store, onboarding } = setup((world) => {
    delete world.services.app.healthChecks;
    world.vms['vm-a'].disks = [{ type: 'SCRATCH' }];
  });
  await assert.rejects(onboarding.onboard(INPUT), refused(400, 'not-eligible', /^cannot onboard demo: backend service app has no health check.*; VM vm-a has a local SSD/));
  assert.deepEqual(w.changes, []);
  assert.equal(store.configs.size, 0);
});

// --- The dry run --------------------------------------------------------------------------------------------------------

test('dry run lists the VMs and the groups, with their numeric IDs, and changes nothing', async () => {
  const { w, store, onboarding } = setup((world) => {
    world.managed.zonal = { kind: 'zonal', location: ZONE, id: '2001', members: ['z-1'] };
    world.managed.regional = { kind: 'regional', location: REGION, id: '2002', members: ['r-1'] };
    world.vms['z-1'] = { id: '3001', status: 'RUNNING' };
    world.vms['r-1'] = { id: '3002', status: 'RUNNING', zone: 'europe-west1-c' };
    world.services.app.backends.push({ group: `${V1}/zones/${ZONE}/instanceGroups/zonal` }, { group: `${V1}/regions/${REGION}/instanceGroups/regional` });
  });
  const answer = await onboarding.dryRun(INPUT);
  assert.deepEqual(answer, {
    eligible: true,
    reasons: [],
    vms: [{ zone: ZONE, name: 'vm-a', selfLink: `${V1}/zones/${ZONE}/instances/vm-a`, id: '1001' }],
    groups: [
      { kind: 'zonal', location: ZONE, name: 'zonal', selfLink: `${V1}/zones/${ZONE}/instanceGroupManagers/zonal`, id: '2001' },
      { kind: 'regional', location: REGION, name: 'regional', selfLink: `${V1}/regions/${REGION}/instanceGroupManagers/regional`, id: '2002' },
    ],
  });
  assert.deepEqual(w.changes, []);
  assert.equal(store.configs.size, 0);
  assert.equal(store.runs.size, 0);
});

test('a VM in two unmanaged groups of the service is one VM', async () => {
  const { onboarding } = setup((world) => {
    world.unmanaged.second = ['vm-a'];
    world.services.app.backends.push({ group: unmanagedUrl('second') });
  });
  assert.equal((await onboarding.dryRun(INPUT)).vms.length, 1);
});

// --- Its input ----------------------------------------------------------------------------------------------------------

test('bad input is a 400 before any read', async () => {
  const { onboarding } = setup();
  const cases = [
    [{ backendService: 'app' }, /urlMap and backendService are needed/],
    [{ urlMap: 'lb' }, /urlMap and backendService are needed/],
    [{ urlMap: '../other', backendService: 'app' }, /urlMap: "\.\.\/other" is not a Compute Engine name/],
    [{ urlMap: 'lb', backendService: 'app-' }, /backendService: "app-" is not a Compute Engine name/],
    [{ ...INPUT, id: 'Bad_ID' }, /\^\[a-z\]\(\[a-z0-9-\]\{0,38\}\[a-z0-9\]\)\?\$/],
    [{ ...INPUT, id: `a${'b'.repeat(39)}c` }, /\^\[a-z\]/],
    [{ ...INPUT, settings: { idleMinutes: 4 } }, /settings: idleMinutes must be an integer from 5 to 1440/],
    [{ ...INPUT, settings: { idleMinutes: 1441 } }, /settings: idleMinutes must be an integer from 5 to 1440/],
    [{ ...INPUT, settings: { waitSeconds: 121 } }, /settings: waitSeconds must be an integer from 5 to 120/],
    [{ ...INPUT, settings: { hibernate: 'yes' } }, /settings: hibernate must be true or false/],
    [{ ...INPUT, settings: { wakeMode: 'any' } }, /settings: unknown setting wakeMode/],
    [{ ...INPUT, settings: { constructor: 1 } }, /settings: unknown setting constructor/],
    [{ ...INPUT, settings: JSON.parse('{"__proto__": 1}') }, /settings: unknown setting __proto__/],
    [{ ...INPUT, settings: [] }, /settings: must be an object/],
  ];
  for (const [input, message] of cases) {
    for (const call of [onboarding.dryRun, onboarding.onboard]) await assert.rejects(call(input), refused(400, 'bad-request', message));
  }
});

test('an ID whose waker backend service would pass 63 characters: a 400 asking for a shorter one', async () => {
  const { onboarding } = setup((w) => { w.region = 'northamerica-northeast2'; });
  const id = `a${'b'.repeat(38)}c`;
  await assert.rejects(onboarding.dryRun({ ...INPUT, id }), refused(400, 'bad-request', /would name the waker backend service dmtr-northamerica-northeast2-a.*longer than the 63 characters/));
});

test('without an ID, the backend service\'s name, when it is one', async () => {
  const { onboarding } = setup();
  const workload = await onboarding.onboard({ urlMap: 'lb', backendService: 'app' });
  assert.equal(workload.id, 'app');
  assert.equal(workload.wakerBackendService, 'dmtr-europe-west1-app');
});

test('without an ID, a backend service\'s name that is not one is a 400 naming the pattern', async () => {
  const { onboarding } = setup();
  const backendService = `a${'b'.repeat(45)}`;
  await assert.rejects(onboarding.dryRun({ urlMap: 'lb', backendService }), refused(400, 'bad-request', /\^\[a-z\]\(/));
});

// --- The onboarding -----------------------------------------------------------------------------------------------------

test('onboard: the waker backend service dmtr-europe-west1-demo with x-dormeto-workload: demo on the NEG', async () => {
  const { w, onboarding } = setup();
  await onboarding.onboard(INPUT);
  assert.deepEqual(w.services[WAKER], {
    name: WAKER,
    loadBalancingScheme: 'EXTERNAL_MANAGED',
    protocol: 'HTTPS',
    backends: [{ group: `${V1}/regions/${REGION}/networkEndpointGroups/${NEG}` }],
    customRequestHeaders: ['x-dormeto-workload: demo'],
  });
  assert.equal(w.services[WAKER].healthChecks, undefined);
});

test('onboard: the service, then the route, then the configuration and AWAKE; no policy and no change to the VMs', async () => {
  const { w, store, clock, onboarding } = setup();
  const workload = await onboarding.onboard({ ...INPUT, settings: { idleMinutes: 30, hibernate: false, waitSeconds: 10 } });
  assert.deepEqual(w.changes, [`create ${WAKER}`, 'map lb']);
  assert.deepEqual(w.urlMaps.lb.pathMatchers[0].pathRules, [{ paths: ['/_dormeto/*'], service: WAKER_URL }]);
  assert.equal(w.urlMaps.lb.pathMatchers[0].defaultCustomErrorResponsePolicy, undefined);
  assert.equal(store.runs.get('demo').state, STATES.AWAKE);
  assert.equal(store.runs.get('demo').awakeSince, clock.now());
  const config = store.configs.get('demo');
  assert.equal(config.workloadId, 'demo');
  assert.equal(config.wakerBackendService, WAKER);
  assert.equal(config.wakeTimeoutSeconds, 600);
  assert.equal(config.failedRetrySeconds, 60);
  assert.equal(config.pollSeconds, 3);
  assert.equal(config.idleMinutes, 30);
  assert.equal(config.hibernate, false);
  assert.ok(!('admin' in config), 'cfg.admin.enabled would turn /_dormeto/wake into a 404');
  assert.deepEqual(workload, {
    id: 'demo',
    state: STATES.AWAKE,
    urlMap: 'lb',
    backendService: 'app',
    wakerBackendService: WAKER,
    hosts: ['demo.example.com'],
    settings: { idleMinutes: 30, waitSeconds: 10, wakeTimeoutSeconds: 600, hibernate: false },
    backends: [{ kind: 'vm', location: ZONE, name: 'vm-a', id: '1001' }],
    awakeSince: new Date(clock.now()).toISOString(),
  });
});

test('onboard: default settings, a managed group as a backend, the map\'s default in the hosts', async () => {
  const { store, onboarding } = setup((world) => {
    withMig(world);
    world.urlMaps.lb.defaultService = serviceUrl('app');
  });
  const workload = await onboarding.onboard(INPUT);
  assert.deepEqual(workload.backends, [{ kind: 'mig', location: ZONE, name: 'mig', id: '2001' }]);
  assert.deepEqual(workload.hosts, ['demo.example.com', '*']);
  assert.deepEqual(workload.settings, { idleMinutes: 15, wakeTimeoutSeconds: 600 });
  assert.equal('hibernate' in store.configs.get('demo'), false);
});

test('onboard twice: a 409, nothing changed', async () => {
  const { w, onboarding } = setup();
  await onboarding.onboard(INPUT);
  w.changes.length = 0;
  await assert.rejects(onboarding.onboard(INPUT), refused(409, 'exists', /workload demo is onboarded already/));
  assert.deepEqual(w.changes, []);
});

test('onboard: a waker backend service of a stopped run of the same workload is taken over', async () => {
  const { w, onboarding } = setup((world) => {
    world.services[WAKER] = { name: WAKER, customRequestHeaders: ['x-dormeto-workload: demo'], backends: [] };
  });
  assert.equal((await onboarding.dryRun(INPUT)).eligible, true);
  await onboarding.onboard(INPUT);
  assert.deepEqual(w.changes, ['map lb']);
});

test('onboard: a failure leaves nothing behind (the NEG could not be uninstalled), and the same run can go again', async () => {
  const { w, store, onboarding } = setup();
  const original = structuredClone(w.urlMaps.lb);
  const failure = new GoogleError('Google: refused', { code: 500 });
  w.fail['POST global/backendServices'] = failure;
  await assert.rejects(onboarding.onboard(INPUT), failure);
  assert.deepEqual(w.changes, []);

  delete w.fail['POST global/backendServices'];
  store.initRun = async () => { throw failure; };
  await assert.rejects(onboarding.onboard(INPUT), failure);
  assert.deepEqual(w.changes, [`create ${WAKER}`, 'map lb', 'map lb', `delete ${WAKER}`]);
  assert.deepEqual(w.urlMaps.lb, original);
  assert.equal(w.services[WAKER], undefined);
  assert.equal(store.configs.size, 0);
  assert.ok(w.logs.some((l) => l.event === 'OnboardUndone' && l.workloadId === 'demo'));
});

test('onboard: a failure whose undo fails too still answers the failure, and says so in the logs', async () => {
  const { w, store, onboarding } = setup();
  const failure = new GoogleError('Google: refused', { code: 500 });
  store.putConfig = async () => { throw failure; };
  w.fail[`DELETE global/backendServices/${WAKER}`] = new GoogleError('Google: in use', { code: 400 });
  await assert.rejects(onboarding.onboard(INPUT), failure);
  assert.ok(w.logs.some((l) => l.event === 'OnboardNotUndone' && l.workloadId === 'demo' && /in use/.test(l.error)));
});

test('onboard: a customer\'s route written between the checks and the update is a refusal, undone', async () => {
  const { w, onboarding } = setup();
  w.on['POST global/backendServices'] = () => {
    w.urlMaps.lb.pathMatchers[0].pathRules = [{ paths: ['/_dormeto/own'], service: serviceUrl('other') }];
  };
  await assert.rejects(onboarding.onboard(INPUT), refused(400, 'not-eligible', /its own \/_dormeto\/ route/));
  assert.equal(w.services[WAKER], undefined);
});

// --- The offboarding ----------------------------------------------------------------------------------------------------

test('offboard an awake workload: the route and the policy go in one update, then the service, then the documents', async () => {
  const { w, store, onboarding } = setup();
  const original = structuredClone(w.urlMaps.lb);
  await onboarding.onboard(INPUT);
  // A policy a failed removal left behind.
  w.urlMaps.lb.pathMatchers[0].defaultCustomErrorResponsePolicy = { errorService: WAKER_URL };
  w.changes.length = 0;
  await onboarding.offboard('demo');
  assert.deepEqual(w.changes, ['map lb', `delete ${WAKER}`]);
  assert.deepEqual(w.urlMaps.lb, original);
  assert.equal(store.configs.size, 0);
  assert.equal(store.runs.size, 0);
  assert.deepEqual(w.tasks, []);
});

test('offboarding an asleep workload wakes it first: VMs up and healthy before anything is removed', async () => {
  const { w, store, onboarding } = setup();
  const original = structuredClone(w.urlMaps.lb);
  await onboarding.onboard(INPUT);
  w.vms['vm-a'].status = 'TERMINATED';
  store.runs.set('demo', { ...store.runs.get('demo'), state: STATES.ASLEEP, stopped: ['vm-a'] });
  w.urlMaps.lb.pathMatchers[0].defaultCustomErrorResponsePolicy = { errorService: WAKER_URL };
  w.changes.length = 0;
  await onboarding.offboard('demo');
  assert.deepEqual(w.changes, ['start vm-a', 'map lb', 'map lb', `delete ${WAKER}`]);
  assert.equal(w.vms['vm-a'].status, 'RUNNING');
  assert.deepEqual(w.urlMaps.lb, original);
  assert.equal(store.runs.size, 0);
  assert.deepEqual(w.tasks, [], 'the wake runs in this request: the VMs are up when it answers');
});

test('offboarding a failed workload wakes it too; a wake that fails again removes nothing: a 409', async () => {
  const { w, store, onboarding, clock } = setup();
  await onboarding.onboard(INPUT);
  w.vms['vm-a'].status = 'TERMINATED';
  store.runs.set('demo', { ...store.runs.get('demo'), state: STATES.FAILED, failedAt: clock.now() });
  w.fail[`POST zones/${ZONE}/instances/vm-a/start`] = new GoogleError('Google: no capacity', { code: 503 });
  w.changes.length = 0;
  await assert.rejects(onboarding.offboard('demo'), refused(409, 'wake-failed', /cannot offboard demo: its wake failed: Google: no capacity/));
  assert.deepEqual(w.changes, []);
  assert.equal(store.configs.size, 1);
  assert.equal(store.runs.get('demo').state, STATES.FAILED);

  delete w.fail[`POST zones/${ZONE}/instances/vm-a/start`];
  await onboarding.offboard('demo');
  assert.equal(store.configs.size, 0);
});

test('offboarding while it wakes or naps is a 409', async () => {
  for (const state of [STATES.WAKING, STATES.NAPPING]) {
    const { w, store, onboarding } = setup();
    await onboarding.onboard(INPUT);
    store.runs.get('demo').state = state;
    w.changes.length = 0;
    await assert.rejects(onboarding.offboard('demo'), refused(409, 'busy', new RegExp(`cannot offboard demo: it is ${state}, try again once it is done`)));
    assert.deepEqual(w.changes, []);
    assert.equal(store.configs.size, 1);
  }
});

test('offboard: an unknown workload is a 404, a bad ID a 400', async () => {
  const { onboarding } = setup();
  await assert.rejects(onboarding.offboard('demo'), refused(404, 'not-found', /no workload demo/));
  await assert.rejects(onboarding.offboard('Bad_ID'), refused(400, 'bad-request', /\^\[a-z\]\(/));
});

test('offboard: an autoscaler\'s mode a check could not give back yet goes back before its record', async () => {
  const { w, store, onboarding } = setup((world) => { world.autoscalers.scaler = 'OFF'; });
  await onboarding.onboard(INPUT);
  store.runs.get('demo').autoscalers = [{ kind: 'zonal', location: ZONE, name: 'scaler', mode: 'ON' }];
  const failure = new GoogleError('Google: refused', { code: 500 });
  w.fail[`PATCH zones/${ZONE}/autoscalers?autoscaler=scaler`] = failure;
  await assert.rejects(onboarding.offboard('demo'), failure);
  assert.equal(store.configs.size, 1, 'the record stays until it is given back');
  delete w.fail[`PATCH zones/${ZONE}/autoscalers?autoscaler=scaler`];
  await onboarding.offboard('demo');
  assert.equal(w.autoscalers.scaler, 'ON');
  assert.equal(store.configs.size, 0);
});

test('offboard: what is gone already (a URL map, the service) is no failure, and a failed run can go again', async () => {
  const { w, store, onboarding } = setup();
  await onboarding.onboard(INPUT);
  const failure = new GoogleError('Google: in use', { code: 400 });
  w.fail[`DELETE global/backendServices/${WAKER}`] = failure;
  await assert.rejects(onboarding.offboard('demo'), failure);
  assert.equal(store.configs.size, 1, 'the documents stay: they name what is left to remove');
  delete w.fail[`DELETE global/backendServices/${WAKER}`];
  delete w.urlMaps.lb;
  delete w.services[WAKER];
  await onboarding.offboard('demo');
  assert.equal(store.configs.size, 0);
});

test('offboard: a second workload\'s dormeto-default in the same map stays', async () => {
  const { w, store, onboarding } = setup((world) => {
    // `other` in the map's default, which only a host rule `*` can hold; `app` in a matcher.
    world.services.other.backends = [{ group: unmanagedUrl('ig2') }];
    world.unmanaged.ig2 = ['vm-b'];
    world.vms['vm-b'] = { id: '1002', status: 'RUNNING' };
  });
  await onboarding.onboard(INPUT);
  await onboarding.onboard({ urlMap: 'lb', backendService: 'other', id: 'second' });
  const held = () => w.urlMaps.lb.pathMatchers.find((m) => m.name === 'dormeto-default');
  assert.ok(held(), 'the second workload is in the map\'s default');
  await onboarding.offboard('demo');
  assert.ok(held(), 'not the offboarded workload\'s');
  assert.deepEqual(w.urlMaps.lb.hostRules.at(-1), { hosts: ['*'], pathMatcher: 'dormeto-default' });
  assert.deepEqual(held().pathRules, [{ paths: ['/_dormeto/*'], service: serviceUrl('dmtr-europe-west1-second') }]);
  assert.equal(store.configs.size, 1);
});

// --- The forced offboarding: a workload that cannot wake, or whose state is stuck --------------------------------------

const VM_A = { kind: 'vm', location: ZONE, name: 'vm-a', id: '1001' };

// `demo` onboarded, then asleep behind its policy, its VM deleted by hand.
async function asleepVmDeleted() {
  const world = setup();
  const original = structuredClone(world.w.urlMaps.lb);
  await world.onboarding.onboard(INPUT);
  delete world.w.vms['vm-a'];
  Object.assign(world.store.runs.get('demo'), { state: STATES.ASLEEP, stopped: ['vm-a'] });
  world.w.urlMaps.lb.pathMatchers[0].defaultCustomErrorResponsePolicy = { errorService: WAKER_URL };
  world.w.changes.length = 0;
  return { ...world, original };
}

test('offboarding a workload that cannot wake: a 409 naming --force, nothing removed', async () => {
  const { w, store, onboarding } = await asleepVmDeleted();
  await assert.rejects(onboarding.offboard('demo'), refused(409, 'wake-failed', /cannot offboard demo: its wake failed: .*--force/));
  assert.deepEqual(w.changes, []);
  assert.ok(w.services[WAKER]);
  assert.ok(w.urlMaps.lb.pathMatchers[0].defaultCustomErrorResponsePolicy);
  assert.equal(store.configs.size, 1);
  assert.equal(store.runs.size, 1);
});

test('force: no wake; the map restored, the service and the documents gone, the backend left down named', async () => {
  const { w, store, onboarding, original } = await asleepVmDeleted();
  assert.deepEqual(await onboarding.offboard('demo', { force: true }), { id: 'demo', left: [VM_A] });
  assert.deepEqual(w.changes, ['map lb', `delete ${WAKER}`]);
  assert.deepEqual(w.urlMaps.lb, original);
  assert.equal(w.services[WAKER], undefined);
  assert.equal(store.configs.size, 0);
  assert.equal(store.runs.size, 0);
  assert.deepEqual(w.tasks, []);
  assert.ok(w.logs.some((l) => l.event === 'Offboarded' && l.force === true && l.workloadId === 'demo'));
});

test('force works once the run shows the failed wake', async () => {
  const { store, onboarding } = await asleepVmDeleted();
  await assert.rejects(onboarding.offboard('demo'), refused(409, 'wake-failed'));
  assert.equal(store.runs.get('demo').state, STATES.FAILED);
  assert.deepEqual((await onboarding.offboard('demo', { force: true })).left, [VM_A]);
  assert.equal(store.configs.size, 0);
});

test('force on a stuck WAKING or NAPPING takes the same path', async () => {
  for (const state of [STATES.WAKING, STATES.NAPPING]) {
    const { w, store, onboarding } = setup();
    await onboarding.onboard(INPUT);
    store.runs.get('demo').state = state;
    w.vms['vm-a'].status = 'TERMINATED';
    assert.deepEqual(await onboarding.offboard('demo', { force: true }), { id: 'demo', left: [VM_A] });
    assert.equal(store.configs.size, 0);
    assert.equal(w.services[WAKER], undefined);
  }
});

test('force on an awake workload leaves nothing down', async () => {
  const { store, onboarding } = setup();
  await onboarding.onboard(INPUT);
  assert.deepEqual(await onboarding.offboard('demo', { force: true }), { id: 'demo', left: [] });
  assert.equal(store.configs.size, 0);
});

test('force: a managed group with a VM down, or gone, is left; one whose VMs all run is not', async () => {
  const { w, onboarding } = setup((world) => {
    world.managed.up = mig({ id: '2001', members: ['up-1'] });
    world.managed.down = mig({ id: '2002', members: ['down-1', 'down-2'] });
    world.managed.gone = mig({ id: '2003', members: ['gone-1'] });
    Object.assign(world.vms, { 'up-1': { id: '3001', status: 'RUNNING' }, 'down-1': { id: '3002', status: 'RUNNING' }, 'down-2': { id: '3003', status: 'RUNNING' }, 'gone-1': { id: '3004', status: 'RUNNING' } });
    world.services.app.backends = ['up', 'down', 'gone'].map((name) => ({ group: `${V1}/zones/${ZONE}/instanceGroups/${name}` }));
  });
  await onboarding.onboard(INPUT);
  w.vms['down-2'].status = 'TERMINATED';
  delete w.managed.gone;
  const { left } = await onboarding.offboard('demo', { force: true });
  assert.deepEqual(left, [{ kind: 'mig', location: ZONE, name: 'down', id: '2002' }, { kind: 'mig', location: ZONE, name: 'gone', id: '2003' }]);
});

test('force: a backend that cannot be read is not known to be up: left, logged, and the offboarding goes on', async () => {
  const { w, store, onboarding } = setup();
  await onboarding.onboard(INPUT);
  w.fail[`GET zones/${ZONE}/instances/vm-a`] = new GoogleError('Google: refused', { code: 403 });
  assert.deepEqual((await onboarding.offboard('demo', { force: true })).left, [VM_A]);
  assert.ok(w.logs.some((l) => l.event === 'BackendUnread' && l.backend === 'vm-a'));
  assert.equal(store.configs.size, 0);
});

test('force: an autoscaler\'s mode goes back, and one that cannot is logged without stopping the offboarding', async () => {
  const { w, store, onboarding } = setup((world) => { Object.assign(world.autoscalers, { good: 'OFF', bad: 'OFF' }); });
  await onboarding.onboard(INPUT);
  Object.assign(store.runs.get('demo'), {
    state: STATES.FAILED,
    autoscalers: [{ kind: 'zonal', location: ZONE, name: 'good', mode: 'ON' }, { kind: 'zonal', location: ZONE, name: 'bad', mode: 'ON' }],
  });
  w.fail[`PATCH zones/${ZONE}/autoscalers?autoscaler=bad`] = new GoogleError('Google: refused', { code: 500 });
  await onboarding.offboard('demo', { force: true });
  assert.equal(w.autoscalers.good, 'ON');
  assert.equal(w.autoscalers.bad, 'OFF');
  assert.ok(w.logs.some((l) => l.event === 'AutoscalerNotGivenBack' && l.autoscaler === 'bad'));
  assert.equal(store.configs.size, 0);
});

test('force: what must go still must: a refused removal is a failure, the documents kept for the next run', async () => {
  const { w, store, onboarding } = await asleepVmDeleted();
  const failure = new GoogleError('Google: in use', { code: 400 });
  w.fail[`DELETE global/backendServices/${WAKER}`] = failure;
  await assert.rejects(onboarding.offboard('demo', { force: true }), failure);
  assert.equal(store.configs.size, 1);
});

test('force: an unknown workload is still a 404, a bad ID a 400', async () => {
  const { onboarding } = setup();
  await assert.rejects(onboarding.offboard('demo', { force: true }), refused(404, 'not-found'));
  await assert.rejects(onboarding.offboard('Bad_ID', { force: true }), refused(400, 'bad-request'));
});

// --- List, show, nap and wake now ---------------------------------------------------------------------------------------

test('show: an ISO awakeSince only while awake, the last wake, the failure as an object', async () => {
  const { store, clock, onboarding } = setup();
  await onboarding.onboard(INPUT);
  const awake = await onboarding.show('demo');
  assert.equal(awake.awakeSince, new Date(clock.now()).toISOString());
  assert.equal(awake.lastWake, undefined);
  assert.equal(awake.failure, undefined);
  Object.assign(store.runs.get('demo'), {
    state: STATES.ASLEEP,
    lastWake: { durationMs: 41000 },
    failure: JSON.stringify({ kind: 'capacity', step: 'wake', message: 'no capacity', at: 1_700_000_000_000 }),
  });
  const asleep = await onboarding.show('demo');
  assert.equal(asleep.state, STATES.ASLEEP);
  assert.equal(asleep.awakeSince, undefined);
  assert.deepEqual(asleep.lastWake, { durationMs: 41000 });
  assert.deepEqual(asleep.failure, { kind: 'capacity', step: 'wake', message: 'no capacity', at: '2023-11-14T22:13:20.000Z' });
});

test('show: an unknown workload, a bad ID', async () => {
  const { onboarding } = setup();
  await assert.rejects(onboarding.show('demo'), refused(404, 'not-found', /no workload demo/));
  await assert.rejects(onboarding.show('../x'), refused(400, 'bad-request', /\^\[a-z\]\(/));
});

test('list: every workload by ID, none as an empty list', async () => {
  const { store, onboarding } = setup((world) => {
    world.services.other.backends = [{ group: unmanagedUrl('ig2') }];
    world.unmanaged.ig2 = ['vm-b'];
    world.vms['vm-b'] = { id: '1002', status: 'RUNNING' };
  });
  assert.deepEqual(await onboarding.list(), []);
  await onboarding.onboard({ urlMap: 'lb', backendService: 'other', id: 'second' });
  await onboarding.onboard({ ...INPUT, id: 'a-first' });
  store.runs.get('second').state = STATES.ASLEEP;
  assert.deepEqual((await onboarding.list()).map((w) => [w.id, w.state]), [['a-first', STATES.AWAKE], ['second', STATES.ASLEEP]]);
});

test('nap now: asked of the queue, in a request of its own; asleep already: nothing to do; else a 409', async () => {
  const { w, store, onboarding } = setup();
  await onboarding.onboard(INPUT);
  w.changes.length = 0;
  assert.equal((await onboarding.nap('demo')).id, 'demo');
  assert.deepEqual(w.tasks, [{ url: `${CONTROLLER}/v1/tasks`, body: { action: 'nap', workloadId: 'demo' } }]);
  assert.deepEqual(w.changes, [], 'the nap takes minutes: not in the operator\'s request');
  w.tasks.length = 0;
  store.runs.get('demo').state = STATES.ASLEEP;
  assert.equal((await onboarding.nap('demo')).state, STATES.ASLEEP);
  assert.deepEqual(w.tasks, []);
  for (const state of [STATES.NAPPING, STATES.WAKING, STATES.FAILED]) {
    store.runs.get('demo').state = state;
    await assert.rejects(onboarding.nap('demo'), refused(409, 'busy', new RegExp(`workload demo is ${state}`)));
  }
  assert.deepEqual(w.tasks, []);
});

test('wake now: WAKING with its task, from asleep or failed, whatever the backoff', async () => {
  for (const state of [STATES.ASLEEP, STATES.FAILED]) {
    const { w, store, clock, onboarding } = setup();
    await onboarding.onboard(INPUT);
    Object.assign(store.runs.get('demo'), { state, failedAt: clock.now(), consecutiveFailures: 3, failure: '{"kind":"capacity"}' });
    const workload = await onboarding.wake('demo');
    assert.equal(workload.state, STATES.WAKING);
    const run = store.runs.get('demo');
    assert.equal(run.wakeId, 'wake-1');
    assert.equal(run.wakeStartedAt, clock.now());
    assert.equal(run.wakeCount, 1);
    assert.equal(run.failedAt, undefined);
    assert.deepEqual(w.tasks, [{ url: `${CONTROLLER}/v1/tasks`, body: { action: 'wake', workloadId: 'demo', wakeId: 'wake-1' } }]);
    assert.ok(w.logs.some((l) => l.event === 'WakeRequested' && l.wakeId === 'wake-1'));
  }
});

test('wake now: the task that cannot be enqueued makes it FAILED, not WAKING until the check', async () => {
  const { w, store, onboarding } = setup();
  await onboarding.onboard(INPUT);
  store.runs.get('demo').state = STATES.ASLEEP;
  w.fail.enqueue = new GoogleError('Google: queue paused', { code: 403 });
  const workload = await onboarding.wake('demo');
  assert.equal(workload.state, STATES.FAILED);
  assert.equal(workload.failure.kind, 'permission');
  assert.equal(store.runs.get('demo').consecutiveFailures, 1);
});

test('wake now: awake, nothing to do; during a nap, the pending wake; waking, a 409', async () => {
  const { w, store, onboarding } = setup();
  await onboarding.onboard(INPUT);
  assert.equal((await onboarding.wake('demo')).state, STATES.AWAKE);
  assert.deepEqual(w.tasks, []);
  store.runs.get('demo').state = STATES.NAPPING;
  assert.equal((await onboarding.wake('demo')).state, STATES.NAPPING);
  assert.equal(store.runs.get('demo').pendingWake, true);
  assert.deepEqual(w.tasks, []);
  store.runs.get('demo').state = STATES.WAKING;
  await assert.rejects(onboarding.wake('demo'), refused(409, 'busy', /workload demo is WAKING/));
});
