import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATES } from '../../lambda/src/lib/state.mjs';
import { GoogleError } from '../src/google.mjs';
import { Refusal } from '../src/onboarding.mjs';
import {
  CLUSTER, CONTROLLER, GKE_DRY, GKE_INPUT, GKE_NEG, INPUT, K8S_BACKEND, NEG, NEG_READINGS, OWNER, REGION, V1, WAKER, WAKER_URL, ZONE, classic, onGke, regionOf, regional, regionalUrl, serviceUrl, setup, unmanagedUrl,
} from './world.mjs';

const refused = (status, reason, message) => (err) => {
  assert.ok(err instanceof Refusal, err.stack);
  assert.equal(err.status, status);
  assert.equal(err.reason, reason);
  if (message) assert.match(err.message, message);
  return true;
};

// A map as it was, but for its fingerprint: Google changes it at each write.
const assertSameMap = (actual, expected) => assert.deepEqual({ ...actual, fingerprint: null }, { ...expected, fingerprint: null });

const mig = (extra = {}) => ({ kind: 'zonal', location: ZONE, id: '2001', members: ['mig-1'], ...extra });
const withMig = (w, extra) => {
  w.managed.mig = mig(extra);
  w.vms['mig-1'] = { id: '3001', status: 'RUNNING' };
  w.services.app.backends = [{ group: `${V1}/zones/${ZONE}/instanceGroups/mig` }];
};

// The service's one backend is the zonal NEG `neg` (or `name`) of the VM `neg-vm`; `vm`: fields of that VM.
const withNeg = (w, { name = 'neg', vm = {}, endpoints = ['neg-vm'], ...fields } = {}) => {
  w.negs[name] = { endpoints, ...fields };
  w.vms['neg-vm'] = { id: '4001', status: 'RUNNING', ...vm };
  w.services.app.backends = [{ group: `${V1}/zones/${ZONE}/networkEndpointGroups/${name}` }];
};

// --- Section 7's refusals -----------------------------------------------------------------------------------------------

const REFUSALS = [
  ['a URL map that does not exist', (w) => { delete w.urlMaps.lb; }, ['URL map lb not found: name a global URL map of this project, or a regional one of europe-west1: regional load balancers are onboarded on the router of their region']],
  ['a URL map no target proxy uses', (w) => { w.httpsProxies = []; }, ['URL map lb is used by no target proxy: attach it to an external Application Load Balancer, then onboard again']],
  ['a URL map two target proxies use', (w) => {
    w.httpProxies = [{ name: 'lb-http', selfLink: `${V1}/global/targetHttpProxies/lb-http`, urlMap: `${V1}/global/urlMaps/lb` }];
  }, ['URL map lb is used by 2 target proxies (lb-https, lb-http): give each load balancer its own URL map']],
  ['a target proxy no forwarding rule sends to', (w) => { w.forwardingRules = []; }, ['no forwarding rule sends to the target proxy of URL map lb: add one, then onboard again']],
  ['a backend service that does not exist', (w) => { delete w.services.app; }, ['backend service app not found: name a global backend service of this project']],
  ['a service the URL map does not name', (w) => { w.urlMaps.lb.pathMatchers[0].defaultService = serviceUrl('other'); }, ['backend service app is not named in URL map lb: route to it there, or name the URL map that does']],
  ['a service only in a default no host reaches', (w) => {
    w.urlMaps.lb.defaultService = serviceUrl('app');
    w.urlMaps.lb.pathMatchers[0].defaultService = serviceUrl('other');
    w.urlMaps.lb.hostRules.push({ hosts: ['*'], pathMatcher: 'm' });
  }, ['backend service app is named in URL map lb only by its default, which a host rule * hides: route to it in a path matcher, then onboard again']],
  ['a service in another URL map', (w) => { w.urlMaps.second = { name: 'second', defaultService: serviceUrl('app') }; }, ['backend service app is also named in URL map second: that load balancer would lose its backends during a nap; give it a backend service of its own']],
  ['a regional network endpoint group backend', (w) => { w.services.app.backends = [{ group: `${V1}/regions/${REGION}/networkEndpointGroups/neg` }]; }, ['backend neg of backend service app is a regional network endpoint group (serverless, private service connect): only zonal network endpoint groups of VMs and instance groups are supported']],
  ['a global network endpoint group backend', (w) => { w.services.app.backends = [{ group: `${V1}/global/networkEndpointGroups/neg` }]; }, ['backend neg of backend service app is a global network endpoint group (internet): only zonal network endpoint groups of VMs and instance groups are supported']],
  ['a zonal NEG that is not of VMs', (w) => withNeg(w, { type: 'NON_GCP_PRIVATE_IP_PORT', endpoints: [{ ipAddress: '10.0.0.9', port: 80 }] }), ['network endpoint group neg of backend service app has the type NON_GCP_PRIVATE_IP_PORT: only GCE_VM_IP_PORT is supported, take it out of the backend service']],
  ['a NEG without an endpoint', (w) => withNeg(w, { endpoints: [] }), ['network endpoint group neg has no endpoint: add a VM to it, then onboard again']],
  ['a NEG endpoint that is a bare address', (w) => withNeg(w, { endpoints: ['neg-vm', { ipAddress: '10.0.0.9', port: 80 }] }), ['network endpoint group neg has an endpoint with no VM (10.0.0.9): only endpoints naming a VM are supported, replace it with one']],
  ['a NEG whose VM a managed group made', (w) => withNeg(w, { vm: { metadata: { items: [{ key: 'created-by', value: `projects/1/zones/${ZONE}/instanceGroupManagers/mig` }] } } }), ['VM neg-vm is a member of managed group mig, which would repair it once stopped: put the managed group in the backend service instead of its VM in a network endpoint group']],
  ['a NEG that GKE made, by its annotations', (w) => withNeg(w, { annotations: { 'cluster-name': 'c1' } }), ['network endpoint group neg of backend service app was made by GKE, its endpoints are pods: it needs --gke-cluster']],
  ['a NEG that GKE made, by its description', (w) => withNeg(w, { description: '{"cluster-uid":"u1","namespace":"default","service-name":"s","port":"80"}' }), ['network endpoint group neg of backend service app was made by GKE, its endpoints are pods: it needs --gke-cluster']],
  ['a NEG that GKE made, by its name', (w) => withNeg(w, { name: 'k8s1-1234-default-web-80-abcd' }), ['network endpoint group k8s1-1234-default-web-80-abcd of backend service app was made by GKE, its endpoints are pods: it needs --gke-cluster']],
  ['a NEG that is not there', (w) => { w.services.app.backends = [{ group: `${V1}/zones/${ZONE}/networkEndpointGroups/gone` }]; }, ['network endpoint group gone of backend service app not found: it was deleted, take it out of the backend service']],
  ['a GPU VM behind a NEG', (w) => withNeg(w, { vm: { guestAccelerators: [{ acceleratorCount: 1 }] } }), ['VM neg-vm has a GPU: GPU VMs are not supported, take it out of the backend service']],
  ['a service without a backend', (w) => { w.services.app.backends = []; }, ['backend service app has no backend: add an instance group, then onboard again']],
  ['no health check', (w) => { delete w.services.app.healthChecks; }, ['backend service app has no health check: a wake waits for a healthy instance, add one']],
  ['a GPU VM', (w) => { w.vms['vm-a'].guestAccelerators = [{ acceleratorCount: 1 }]; }, ['VM vm-a has a GPU: GPU VMs are not supported, take it out of the backend service']],
  ['a VM whose machine type brings a GPU', (w) => { w.machineTypes['e2-small'].accelerators = [{ guestAcceleratorCount: 1 }]; }, ['VM vm-a has a GPU: GPU VMs are not supported, take it out of the backend service']],
  ['a local SSD', (w) => { w.vms['vm-a'].disks = [{ type: 'PERSISTENT' }, { type: 'SCRATCH' }]; }, ['VM vm-a has a local SSD: a stop would lose its data, take it out of the backend service']],
  ['a regional managed group with an even target shape and instance redistribution on', (w) => {
    w.managed.mig = mig({ kind: 'regional', location: REGION, distributionPolicy: { targetShape: 'EVEN' }, updatePolicy: { instanceRedistributionType: 'PROACTIVE' } });
    w.vms['mig-1'] = { id: '3001', status: 'RUNNING' };
    w.services.app.backends = [{ group: `${V1}/regions/${REGION}/instanceGroups/mig` }];
  }, ['regional managed group mig has the target shape EVEN with instance redistribution on: Google cannot stop or suspend its VMs one by one, set its instance redistribution type to NONE or change its target shape, then onboard again']],
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

const REGIONAL_GROUPS = [
  ['instance redistribution off', { distributionPolicy: { targetShape: 'EVEN' }, updatePolicy: { instanceRedistributionType: 'NONE' } }],
  ['another target shape', { distributionPolicy: { targetShape: 'BALANCED' }, updatePolicy: { instanceRedistributionType: 'PROACTIVE' } }],
];
for (const [name, fields] of REGIONAL_GROUPS) {
  test(`dry run accepts a regional managed group with ${name}`, async () => {
    const { onboarding } = setup((w) => {
      w.managed.mig = mig({ kind: 'regional', location: REGION, ...fields });
      w.vms['mig-1'] = { id: '3001', status: 'RUNNING' };
      w.services.app.backends = [{ group: `${V1}/regions/${REGION}/instanceGroups/mig` }];
    });
    assert.deepEqual((await onboarding.dryRun(INPUT)).reasons, []);
  });
}

test('dry run: Google\'s defaults hold when it says nothing: a regional group is even and redistributes; a zonal one has neither', async () => {
  const silent = setup((w) => {
    w.managed.mig = mig({ kind: 'regional', location: REGION });
    w.vms['mig-1'] = { id: '3001', status: 'RUNNING' };
    w.services.app.backends = [{ group: `${V1}/regions/${REGION}/instanceGroups/mig` }];
  });
  assert.match((await silent.onboarding.dryRun(INPUT)).reasons.join(), /regional managed group mig has the target shape EVEN/);
  const zonal = setup((w) => withMig(w));
  assert.deepEqual((await zonal.onboarding.dryRun(INPUT)).reasons, []);
});

test('dry run lists the VMs and the groups, with their numeric IDs, and changes nothing', async () => {
  const { w, store, onboarding } = setup((world) => {
    world.managed.zonal = { kind: 'zonal', location: ZONE, id: '2001', members: ['z-1'] };
    world.managed.regional = { kind: 'regional', location: REGION, id: '2002', members: ['r-1'], updatePolicy: { instanceRedistributionType: 'NONE' } };
    world.vms['z-1'] = { id: '3001', status: 'RUNNING' };
    world.vms['r-1'] = { id: '3002', status: 'RUNNING', zone: 'europe-west1-c' };
    world.services.app.backends.push({ group: `${V1}/zones/${ZONE}/instanceGroups/zonal` }, { group: `${V1}/regions/${REGION}/instanceGroups/regional` });
  });
  const answer = await onboarding.dryRun(INPUT);
  assert.deepEqual(answer, {
    eligible: true,
    reasons: [],
    vms: [{ zone: ZONE, name: 'vm-a', selfLink: `${V1}/zones/${ZONE}/instances/vm-a`, id: '1001' }],
    lb: { kind: 'global' },
    databases: [],
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

test('dry run: the VMs of a zonal NEG are unmanaged VMs, as an unmanaged group\'s, read across the NEG\'s pages', async () => {
  const { w, store, onboarding } = setup((world) => {
    withNeg(world, { endpoints: ['neg-vm', 'neg-vm-2'] });
    world.vms['neg-vm-2'] = { id: '4002', status: 'TERMINATED' };
  });
  const answer = await onboarding.dryRun(INPUT);
  assert.deepEqual(answer, {
    eligible: true,
    reasons: [],
    vms: [
      { zone: ZONE, name: 'neg-vm', selfLink: `${V1}/zones/${ZONE}/instances/neg-vm`, id: '4001' },
      { zone: ZONE, name: 'neg-vm-2', selfLink: `${V1}/zones/${ZONE}/instances/neg-vm-2`, id: '4002' },
    ],
    groups: [],
    databases: [],
    lb: { kind: 'global' },
  });
  assert.deepEqual(w.changes, []);
  assert.equal(store.configs.size, 0);
  assert.ok(w.used.has('compute.listNetworkEndpoints'));
});

// Google refuses a backend service with both an instance group and a NEG; the mix only shows that one VM is one entry.
test('dry run: a VM named by a NEG and by an unmanaged group, or by two endpoints, is one VM', async () => {
  const { onboarding } = setup((world) => {
    withNeg(world, { endpoints: ['vm-a', 'vm-a'] });
    world.services.app.backends.push({ group: unmanagedUrl('ig') });
  });
  const answer = await onboarding.dryRun(INPUT);
  assert.deepEqual(answer.reasons, []);
  assert.deepEqual(answer.vms.map((vm) => vm.name), ['vm-a']);
});

test('dry run: a NEG\'s VM is held by another workload, or a GPU, as an unmanaged group\'s', async () => {
  const { store, onboarding } = setup((world) => withNeg(world, { vm: { disks: [{ type: 'SCRATCH' }] } }));
  store.configs.set('first', { workloadId: 'first', backendService: 'other', backends: [{ kind: 'vm', location: ZONE, name: 'neg-vm', id: '4001' }] });
  assert.deepEqual((await onboarding.dryRun(INPUT)).reasons, [
    'VM neg-vm has a local SSD: a stop would lose its data, take it out of the backend service',
    'VM neg-vm belongs to workload first',
  ]);
});

test('onboard: a NEG\'s VMs are the workload\'s vm backends, beside a group\'s', async () => {
  const { store, onboarding } = setup((world) => {
    withNeg(world);
    world.services.app.backends.push({ group: unmanagedUrl('ig') });
  });
  await onboarding.onboard(INPUT);
  assert.deepEqual((await store.getConfig('demo')).backends, [
    { kind: 'vm', location: ZONE, name: 'neg-vm', id: '4001', neg: { zone: ZONE, name: 'neg' } },
    { kind: 'vm', location: ZONE, name: 'vm-a', id: '1001' },
  ]);
});

test('onboard: a VM in two NEGs records the first and the other', async () => {
  const { store, onboarding } = setup((world) => {
    withNeg(world);
    world.negs.second = { endpoints: ['neg-vm'] };
    world.services.app.backends.push({ group: `${V1}/zones/${ZONE}/networkEndpointGroups/second` });
  });
  await onboarding.onboard(INPUT);
  assert.deepEqual((await store.getConfig('demo')).backends, [
    { kind: 'vm', location: ZONE, name: 'neg-vm', id: '4001', neg: { zone: ZONE, name: 'neg' }, moreNegs: [{ zone: ZONE, name: 'second' }] },
  ]);
});

test('dry run: a NEG whose endpoint names a VM that is gone is refused, naming it', async () => {
  const { onboarding } = setup((world) => withNeg(world, { endpoints: ['gone-vm'] }));
  assert.deepEqual((await onboarding.dryRun(INPUT)).reasons.filter((r) => r.includes('gone-vm')), ['network endpoint group neg names the VM gone-vm, which does not exist: remove the endpoint, then onboard again']);
});

for (const [what, key] of [['the NEG\'s read', `GET zones/${ZONE}/networkEndpointGroups/neg`], ['its endpoints\' read', `POST zones/${ZONE}/networkEndpointGroups/neg/listNetworkEndpoints`]]) {
  test(`dry run: a 5xx on ${what} is an error, not "not found" or "no endpoint"`, async () => {
    const { onboarding } = setup((world) => {
      withNeg(world);
      world.fail[key] = new GoogleError('Google: 503', { code: 503 });
    });
    await assert.rejects(onboarding.dryRun(INPUT), /503/);
  });
}

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
    [{ ...INPUT, settings: { wakeTimeoutSeconds: 59 } }, /settings: wakeTimeoutSeconds must be an integer from 60 to 1700/],
    [{ ...INPUT, settings: { wakeTimeoutSeconds: 1701 } }, /settings: wakeTimeoutSeconds must be an integer from 60 to 1700/],
    [{ ...INPUT, loadBalancer: 'internal' }, /loadBalancer: "internal" is not global, regional or classic/],
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
    lb: { kind: 'global' },
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
  assertSameMap(w.urlMaps.lb, original);
  assert.equal(w.services[WAKER], undefined);
  assert.equal(store.configs.size, 0);
  assert.ok(w.logs.some((l) => l.event === 'OnboardUndone' && l.workloadId === 'demo'));
});

// M4's likeliest failure: Google refuses a waker on the serverless NEG for this kind of load balancer, or the router lacks a permission.
for (const [kind, world, path] of [['global', () => {}, 'global/backendServices'], ['classic', classic, 'global/backendServices'], ['regional', regional, `regions/${REGION}/backendServices`]]) {
  for (const code of [400, 403]) {
    test(`onboard ${kind}: Google's ${code} on the waker's insert is a refusal in Google's words, undone`, async () => {
      const { w, store, onboarding } = setup(world);
      const words = `Google: POST ${path}: ${code} Invalid value for field 'resource.backends[0].group'`;
      w.fail[`POST ${path}`] = new GoogleError(words, { code });
      await assert.rejects(onboarding.onboard(INPUT), refused(400, 'not-eligible', new RegExp(`^cannot onboard demo: Google refused its waker backend service ${WAKER}: .*${code} Invalid value`)));
      assert.deepEqual(w.changes, []);
      assert.equal(store.configs.size, 0);
      assert.equal(store.runs.size, 0);
      assert.ok(w.logs.some((l) => l.event === 'OnboardUndone' && l.workloadId === 'demo'));
    });
  }

  test(`onboard ${kind}: anything else on the waker's insert stays a failure`, async () => {
    const { w, onboarding } = setup(world);
    const failure = new GoogleError('Google: 503 unavailable', { code: 503 });
    w.fail[`POST ${path}`] = failure;
    await assert.rejects(onboarding.onboard(INPUT), failure);
  });
}

test('onboard: a refused waker\'s insert reaches the operator as the refusal, not an internal error', async () => {
  const { w, onboarding } = setup();
  w.fail['POST global/backendServices'] = new GoogleError('Google: 403 Required compute.regionNetworkEndpointGroups.use', { code: 403 });
  const err = await onboarding.onboard(INPUT).catch((e) => e);
  assert.equal(err.status, 400);
  assert.equal(err.reason, 'not-eligible');
  assert.match(err.message, /Required compute\.regionNetworkEndpointGroups\.use/);
});

test('onboard: a waker refused at its operation\'s end is the same refusal', async () => {
  const t = setup();
  t.google.waitCompute = async () => { throw new GoogleError('Google: operation insert: INVALID_RESOURCE_USAGE: the NEG cannot be used here', { code: 400, reason: 'INVALID_RESOURCE_USAGE' }); };
  await assert.rejects(t.onboarding.onboard(INPUT), refused(400, 'not-eligible', /Google refused its waker backend service .*INVALID_RESOURCE_USAGE/));
  assert.equal(t.store.configs.size, 0);
});

// A map's change Google refuses for what the map holds: the operator can do something about it, it is no internal error.
for (const [kind, world, path] of [['global', () => {}, 'global/urlMaps/lb'], ['classic', classic, 'global/urlMaps/lb'], ['regional', regional, `regions/${REGION}/urlMaps/lb`]]) {
  for (const code of [400, 403]) {
    test(`onboard ${kind}: Google's ${code} on the map's update is a refusal in Google's words, undone`, async () => {
      const { w, store, onboarding } = setup(world);
      w.fail[`PUT ${path}`] = new GoogleError(`Google: PUT ${path}: ${code} Invalid value for field 'resource.pathMatchers[0]'`, { code });
      await assert.rejects(onboarding.onboard(INPUT), refused(400, 'not-eligible', new RegExp(`^cannot onboard demo: Google refused the update of URL map lb: .*${code} Invalid value`)));
      assert.equal(store.configs.size, 0);
      assert.equal(store.runs.size, 0);
      assert.equal(w.services[WAKER] ?? w.regions[REGION]?.services[WAKER], undefined);
      assert.ok(w.logs.some((l) => l.event === 'OnboardUndone'));
    });
  }

  test(`onboard ${kind}: anything else on the map's update stays a failure`, async () => {
    const { w, onboarding } = setup(world);
    const failure = new GoogleError('Google: 503 unavailable', { code: 503 });
    w.fail[`PUT ${path}`] = failure;
    await assert.rejects(onboarding.onboard(INPUT), failure);
  });
}

test('onboard: a map refused at its operation\'s end is the same refusal; the waker goes with it', async () => {
  const t = setup();
  const wait = t.google.waitCompute;
  let waits = 0;
  // The waker's insert, then the map's update.
  t.google.waitCompute = async (...args) => {
    waits += 1;
    if (waits === 2) throw new GoogleError('Google: operation update: INVALID_FIELD_VALUE: refused', { code: 400, reason: 'INVALID_FIELD_VALUE' });
    return wait(...args);
  };
  await assert.rejects(t.onboarding.onboard(INPUT), refused(400, 'not-eligible', /Google refused the update of URL map lb: .*INVALID_FIELD_VALUE/));
  assert.equal(t.w.services[WAKER], undefined);
  assert.equal(t.store.configs.size, 0);
});

test('onboard: the store\'s own 400 stays a failure, not a refusal of the map', async () => {
  const { store, onboarding } = setup();
  const failure = new GoogleError('Google: documents:commit: 400 bad', { code: 400 });
  store.putConfig = async () => { throw failure; };
  await assert.rejects(onboarding.onboard(INPUT), failure);
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

// --- Regional and classic load balancers (the coverage design's section 7) ------------------------------------------------

const REGION_URL = `${V1}/regions/${REGION}`;
const REGIONAL_WAKER_URL = regionalUrl(WAKER);
const inRegion = (w) => w.regions[REGION];
const SUPPORTED = 'only external Application Load Balancers are supported: global (EXTERNAL_MANAGED), classic (EXTERNAL) and regional (EXTERNAL_MANAGED)';
const REGIONAL_LB = { kind: 'regional', region: REGION };

// The same name in both scopes.
const both = (w) => { w.regions[REGION] = regionOf(); };

const LB_REFUSALS = [
  ['the same name globally and in the region, without --load-balancer', both, {}, ['URL map lb exists globally and in region europe-west1: say which with --load-balancer global, classic or regional']],
  ['a regional map in another region: it reads as not found, and the router of its region is named', (w) => {
    regional(w);
    delete w.regions[REGION];
    w.regions['us-central1'] = regionOf('us-central1');
  }, {}, ['URL map lb not found: name a global URL map of this project, or a regional one of europe-west1: regional load balancers are onboarded on the router of their region']],
  ['--load-balancer regional with a map only elsewhere', (w) => { w.regions['us-central1'] = regionOf('us-central1'); }, { loadBalancer: 'regional' }, ['URL map lb not found in region europe-west1: regional load balancers are onboarded on the router of their region']],
  ['--load-balancer global with a map only in the region', regional, { loadBalancer: 'global' }, ['URL map lb not found: name a global URL map of this project, or use --load-balancer regional']],
  ['--load-balancer classic with a map only in the region', regional, { loadBalancer: 'classic' }, ['URL map lb not found: name a global URL map of this project, or use --load-balancer regional']],
  ['a mix of EXTERNAL and EXTERNAL_MANAGED forwarding rules', (w) => {
    w.forwardingRules.push({ name: 'lb-fr2', target: w.forwardingRules[0].target, loadBalancingScheme: 'EXTERNAL' });
  }, {}, ['URL map lb has forwarding rules of a global and of a classic load balancer (lb-fr EXTERNAL_MANAGED, lb-fr2 EXTERNAL): finish its migration, then onboard again']],
  ['a global INTERNAL_MANAGED', (w) => { w.forwardingRules[0].loadBalancingScheme = 'INTERNAL_MANAGED'; }, {}, [`forwarding rule lb-fr has the scheme INTERNAL_MANAGED: ${SUPPORTED}`]],
  ['a regional INTERNAL_MANAGED', (w) => {
    regional(w);
    inRegion(w).forwardingRules[0].loadBalancingScheme = 'INTERNAL_MANAGED';
    inRegion(w).services.app.loadBalancingScheme = 'INTERNAL_MANAGED';
  }, {}, [`forwarding rule lb-fr has the scheme INTERNAL_MANAGED: ${SUPPORTED}`]],
  ['--load-balancer global on a classic load balancer', classic, { loadBalancer: 'global' }, ['URL map lb belongs to a classic load balancer, not a global one: onboard it with --load-balancer classic']],
  ['--load-balancer classic on a global load balancer', () => {}, { loadBalancer: 'classic' }, ['URL map lb belongs to a global load balancer, not a classic one: onboard it with --load-balancer global']],
  ['a classic load balancer\'s service of the other scheme', (w) => {
    classic(w);
    w.services.app.loadBalancingScheme = 'EXTERNAL_MANAGED';
  }, {}, ['backend service app has the scheme EXTERNAL_MANAGED: the backend services of a classic load balancer have EXTERNAL']],
  ['a global load balancer\'s service of the other scheme', (w) => { w.services.app.loadBalancingScheme = 'EXTERNAL'; }, {}, ['backend service app has the scheme EXTERNAL: the backend services of a global load balancer have EXTERNAL_MANAGED']],
  ['a regional service that does not exist', (w) => {
    regional(w);
    delete inRegion(w).services.app;
  }, {}, ['backend service app not found: name a regional backend service of europe-west1']],
  ['a regional map no target proxy uses', (w) => {
    regional(w);
    inRegion(w).httpsProxies = [];
  }, {}, ['URL map lb is used by no target proxy: attach it to an external Application Load Balancer, then onboard again']],
  ['a regional target proxy no forwarding rule sends to', (w) => {
    regional(w);
    inRegion(w).forwardingRules = [];
  }, {}, ['no forwarding rule sends to the target proxy of URL map lb: add one, then onboard again']],
  ['a regional service in another regional URL map', (w) => {
    regional(w);
    inRegion(w).urlMaps.second = { name: 'second', defaultService: regionalUrl('app') };
  }, {}, ['backend service app is also named in URL map second: that load balancer would lose its backends during a nap; give it a backend service of its own']],
  ['a classic waker name taken by a global waker, of one header', (w) => {
    classic(w);
    w.services[WAKER] = { name: WAKER, customRequestHeaders: ['x-dormeto-workload: demo'], backends: [] };
  }, {}, [`backend service ${WAKER} exists and is not the waker of demo: rename it, or onboard under another id`]],
  ['a global waker name taken by a classic waker, of two headers', (w) => {
    w.services[WAKER] = { name: WAKER, customRequestHeaders: ['x-dormeto-workload: demo', 'x-dormeto-switch: swap'], backends: [] };
  }, {}, [`backend service ${WAKER} exists and is not the waker of demo: rename it, or onboard under another id`]],
  ['a regional waker name taken by another service', (w) => {
    regional(w);
    inRegion(w).services[WAKER] = { name: WAKER, backends: [] };
  }, {}, [`backend service ${WAKER} exists and is not the waker of demo: rename it, or onboard under another id`]],
];

for (const [name, change, input, reasons] of LB_REFUSALS) {
  test(`dry run refuses ${name}, worded`, async () => {
    const { w, onboarding } = setup(change);
    const answer = await onboarding.dryRun({ ...INPUT, ...input });
    assert.equal(answer.eligible, false);
    assert.deepEqual(answer.reasons, reasons);
    assert.deepEqual(w.changes, []);
  });
}

// What a swap could not do, through `withSwap` tried on the map, on both kinds. The application's URL: the kind's.
const SWAPS = [
  ['classic', classic, (w) => w.urlMaps.lb, serviceUrl],
  ['regional', regional, (w) => inRegion(w).urlMaps.lb, regionalUrl],
];
const SWAP_REFUSALS = [
  ['tests naming the application', (map, url) => { map.tests = [{ host: 'demo.example.com', path: '/', service: url('app') }]; }, /has tests naming backend service app.*: change that, then onboard again$/],
  ['a mirror to the application', (map, url) => {
    map.pathMatchers[0].defaultRouteAction = { requestMirrorPolicy: { backendService: url('app') } };
    map.pathMatchers[0].defaultService = url('other');
    map.pathMatchers[0].pathRules = [{ paths: ['/x'], service: url('app') }];
  }, /mirrors requests to backend service app.*: change that, then onboard again$/],
  ['a weighted route of the application with another service', (map, url) => {
    delete map.pathMatchers[0].defaultService;
    map.pathMatchers[0].defaultRouteAction = { weightedBackendServices: [{ backendService: url('app'), weight: 90 }, { backendService: url('other'), weight: 10 }] };
  }, /has weights naming backend service app beside another service.*: change that, then onboard again$/],
  ['route rules at the hold route\'s priority', (map, url) => {
    map.pathMatchers[0].routeRules = [{ priority: 1, matchRules: [{ prefixMatch: '/x' }], service: url('app') }];
  }, /uses priority 1 for a route rule at pathMatchers\[0\]\.routeRules: the \/_dormeto\/ route needs it: change that, then onboard again$/],
];
for (const [kind, world, mapOf, url] of SWAPS) {
  for (const [name, write, reason] of SWAP_REFUSALS) {
    test(`dry run: a ${kind} map with ${name} is refused, as a swap would fail`, async () => {
      const { w, onboarding } = setup((x) => {
        world(x);
        write(mapOf(x), url);
      });
      const { eligible, reasons } = await onboarding.dryRun(INPUT);
      assert.equal(eligible, false);
      assert.equal(reasons.length, 1, reasons.join());
      assert.match(reasons[0], reason);
      assert.deepEqual(w.changes, []);
    });
  }
  test(`dry run: a ${kind} map naming the application only by a default that a host rule * hides is refused`, async () => {
    const { onboarding } = setup((x) => {
      world(x);
      const map = mapOf(x);
      map.defaultService = url('app');
      map.pathMatchers[0].defaultService = url('other');
      map.hostRules.push({ hosts: ['*'], pathMatcher: 'm' });
    });
    assert.deepEqual((await onboarding.dryRun(INPUT)).reasons, ['backend service app is named in URL map lb only by its default, which a host rule * hides: route to it in a path matcher, then onboard again']);
  });
}

test('dry run: what would refuse a swap does not refuse a global load balancer', async () => {
  const { onboarding } = setup((w) => { w.urlMaps.lb.tests = [{ host: 'demo.example.com', path: '/', service: serviceUrl('app') }]; });
  assert.deepEqual((await onboarding.dryRun(INPUT)).reasons, []);
});

test('a customer\'s error response policy does not refuse a swap, which writes none', async () => {
  const { onboarding } = setup((w) => {
    regional(w);
    inRegion(w).urlMaps.lb.pathMatchers[0].defaultCustomErrorResponsePolicy = { errorService: regionalUrl('own') };
  });
  assert.deepEqual((await onboarding.dryRun(INPUT)).reasons, []);
});

test('dry run: the load balancer it found, by the forwarding rules\' scheme, and with --load-balancer', async () => {
  assert.deepEqual((await setup().onboarding.dryRun(INPUT)).lb, { kind: 'global' });
  assert.deepEqual((await setup().onboarding.dryRun({ ...INPUT, loadBalancer: 'global' })).lb, { kind: 'global' });
  assert.deepEqual((await setup(classic).onboarding.dryRun(INPUT)).lb, { kind: 'classic' });
  assert.deepEqual((await setup(classic).onboarding.dryRun({ ...INPUT, loadBalancer: 'classic' })).lb, { kind: 'classic' });
  assert.deepEqual((await setup(regional).onboarding.dryRun(INPUT)).lb, REGIONAL_LB);
  assert.deepEqual((await setup(regional).onboarding.dryRun({ ...INPUT, loadBalancer: 'regional' })).lb, REGIONAL_LB);
});

test('dry run: a load balancer it cannot tell is named as none', async () => {
  const { onboarding } = setup((w) => { w.forwardingRules = []; });
  const answer = await onboarding.dryRun(INPUT);
  assert.equal(answer.eligible, false);
  assert.equal(answer.lb, undefined);
});

test('--load-balancer picks the scope of a name in both: only that map and that service are read and written', async () => {
  const chosen = setup(both);
  const untouched = structuredClone(chosen.w.urlMaps.lb);
  await chosen.onboarding.onboard({ ...INPUT, loadBalancer: 'regional' });
  assert.deepEqual(chosen.store.configs.get('demo').lb, REGIONAL_LB);
  assert.deepEqual(chosen.w.urlMaps.lb, untouched);
  assert.ok(inRegion(chosen.w).services[WAKER]);
  assert.equal(chosen.w.services[WAKER], undefined);

  const global = setup(both);
  const regionalUntouched = structuredClone(inRegion(global.w).urlMaps.lb);
  await global.onboarding.onboard({ ...INPUT, loadBalancer: 'global' });
  assert.equal(global.store.configs.get('demo').lb, undefined);
  assert.deepEqual(inRegion(global.w).urlMaps.lb, regionalUntouched);
  assert.ok(global.w.services[WAKER]);
  assert.equal(inRegion(global.w).services[WAKER], undefined);
});

test('a backend service\'s name is unique in its scope: the same name in the other scope is no other workload\'s, and no other map names it', async () => {
  const { store, onboarding } = setup((w) => {
    both(w);
    delete w.urlMaps.lb;
    w.urlMaps.global = { name: 'global', defaultService: serviceUrl('app') };
  });
  store.configs.set('first', { workloadId: 'first', backendService: 'app', backends: [] });
  assert.deepEqual((await onboarding.dryRun(INPUT)).reasons, []);
  store.configs.set('second', { workloadId: 'second', backendService: 'app', lb: REGIONAL_LB, backends: [] });
  assert.deepEqual((await onboarding.dryRun(INPUT)).reasons, ['backend service app is already workload second']);
});

test('onboard regional: the waker in the region, EXTERNAL_MANAGED, HTTPS, on the router\'s NEG, with the two headers', async () => {
  const { w, onboarding } = setup(regional);
  await onboarding.onboard(INPUT);
  assert.deepEqual(inRegion(w).services[WAKER], {
    name: WAKER,
    loadBalancingScheme: 'EXTERNAL_MANAGED',
    protocol: 'HTTPS',
    backends: [{ group: `${REGION_URL}/networkEndpointGroups/${NEG}` }],
    customRequestHeaders: ['x-dormeto-workload: demo', 'x-dormeto-switch: swap'],
  });
  assert.deepEqual(w.services, {}, 'nothing global');
});

test('onboard classic: the waker global, EXTERNAL, HTTPS, on the router\'s regional NEG, with the two headers', async () => {
  const { w, onboarding } = setup(classic);
  await onboarding.onboard(INPUT);
  assert.deepEqual(w.services[WAKER], {
    name: WAKER,
    loadBalancingScheme: 'EXTERNAL',
    protocol: 'HTTPS',
    backends: [{ group: `${REGION_URL}/networkEndpointGroups/${NEG}` }],
    customRequestHeaders: ['x-dormeto-workload: demo', 'x-dormeto-switch: swap'],
  });
});

const ONBOARDED = [
  ['regional', regional, (w) => inRegion(w).urlMaps.lb, REGIONAL_WAKER_URL, regionalUrl('app'), REGIONAL_LB, 700],
  ['classic', classic, (w) => w.urlMaps.lb, WAKER_URL, serviceUrl('app'), { kind: 'classic' }, 850],
];
for (const [kind, world, mapOf, wakerUrl, appUrl, lb, timeout] of ONBOARDED) {
  test(`onboard ${kind}: the route and the hold route in one update, its lb in the configuration and the Workload`, async () => {
    const { w, store, onboarding } = setup(world);
    const workload = await onboarding.onboard(INPUT);
    assert.deepEqual(w.changes, [`create ${WAKER}`, 'map lb']);
    assert.deepEqual(mapOf(w).pathMatchers[0].pathRules, [{ paths: ['/_dormeto/*'], service: wakerUrl }, { paths: ['/_dormeto/backend/*'], service: appUrl }]);
    assert.equal(mapOf(w).pathMatchers[0].defaultCustomErrorResponsePolicy, undefined);
    assert.deepEqual(store.configs.get('demo').lb, lb);
    assert.deepEqual(workload.lb, lb);
    assert.deepEqual((await onboarding.show('demo')).lb, lb);
    assert.equal(store.runs.get('demo').state, STATES.AWAKE);
  });

  test(`${kind}: wakeTimeoutSeconds is by default the VMs' 600 plus SWAP_WAIT; one set stays as it is`, async () => {
    const byDefault = setup(world);
    assert.equal((await byDefault.onboarding.onboard(INPUT)).settings.wakeTimeoutSeconds, timeout);
    assert.equal(byDefault.store.configs.get('demo').wakeTimeoutSeconds, timeout);
    const given = setup(world);
    await given.onboarding.onboard({ ...INPUT, settings: { wakeTimeoutSeconds: 400 } });
    assert.equal(given.store.configs.get('demo').wakeTimeoutSeconds, 400);
  });

  test(`offboard ${kind}: the route and the hold route in one update, then the waker`, async () => {
    const { w, store, onboarding } = setup(world);
    const original = structuredClone(mapOf(w));
    await onboarding.onboard(INPUT);
    w.changes.length = 0;
    await onboarding.offboard('demo');
    assert.deepEqual(w.changes, ['map lb', `delete ${WAKER}`]);
    assertSameMap(mapOf(w), original);
    assert.equal(store.configs.size, 0);
  });

  test(`force on ${kind}: a map left under the swap gets the application back, in the same update`, async () => {
    const { w, store, onboarding } = setup(world);
    const original = structuredClone(mapOf(w));
    await onboarding.onboard(INPUT);
    mapOf(w).pathMatchers[0].defaultService = wakerUrl;
    store.runs.get('demo').state = STATES.NAPPING;
    w.changes.length = 0;
    await onboarding.offboard('demo', { force: true });
    assert.deepEqual(w.changes, ['map lb', `delete ${WAKER}`]);
    assertSameMap(mapOf(w), original);
  });

  test(`onboard ${kind}: a failure leaves nothing behind, map and waker`, async () => {
    const { w, store, onboarding } = setup(world);
    const original = structuredClone(mapOf(w));
    const failure = new GoogleError('Google: refused', { code: 500 });
    store.initRun = async () => { throw failure; };
    await assert.rejects(onboarding.onboard(INPUT), failure);
    assert.deepEqual(w.changes, [`create ${WAKER}`, 'map lb', 'map lb', `delete ${WAKER}`]);
    assertSameMap(mapOf(w), original);
    assert.equal(store.configs.size, 0);
    assert.ok(w.logs.some((l) => l.event === 'OnboardUndone'));
  });

  test(`onboard ${kind}: the waker of a stopped run of the same workload, with its two headers, is taken over`, async () => {
    const { w, onboarding } = setup((x) => {
      world(x);
      (kind === 'regional' ? inRegion(x).services : x.services)[WAKER] = { name: WAKER, customRequestHeaders: ['x-dormeto-switch: swap', 'x-dormeto-workload: demo'], backends: [] };
    });
    assert.equal((await onboarding.dryRun(INPUT)).eligible, true);
    await onboarding.onboard(INPUT);
    assert.deepEqual(w.changes, ['map lb']);
  });

  test(`onboard ${kind}: the map's default alone names the application: dormeto-default holds both routes, and goes at the offboarding`, async () => {
    const { w, onboarding } = setup((x) => {
      world(x);
      const map = mapOf(x);
      map.defaultService = appUrl;
      delete map.hostRules;
      delete map.pathMatchers;
    });
    const original = structuredClone(mapOf(w));
    await onboarding.onboard(INPUT);
    const held = mapOf(w).pathMatchers.at(-1);
    assert.equal(held.name, 'dormeto-default');
    assert.deepEqual(held.pathRules, [{ paths: ['/_dormeto/*'], service: wakerUrl }, { paths: ['/_dormeto/backend/*'], service: appUrl }]);
    await onboarding.offboard('demo');
    assertSameMap(mapOf(w), original);
  });
}

test('onboard regional: with route rules, the hold route at priority 0, the waker\'s at 1, gone at the offboarding', async () => {
  const { w, onboarding } = setup((x) => {
    regional(x);
    inRegion(x).urlMaps.lb.pathMatchers[0].routeRules = [{ priority: 5, matchRules: [{ prefixMatch: '/x' }], service: regionalUrl('app') }];
  });
  const original = structuredClone(inRegion(w).urlMaps.lb);
  await onboarding.onboard(INPUT);
  const rules = inRegion(w).urlMaps.lb.pathMatchers[0].routeRules;
  assert.deepEqual(rules.find((r) => r.priority === 0), { priority: 0, matchRules: [{ prefixMatch: '/_dormeto/backend/' }], service: regionalUrl('app') });
  assert.deepEqual(rules.find((r) => r.priority === 1), { priority: 1, matchRules: [{ prefixMatch: '/_dormeto/' }], service: REGIONAL_WAKER_URL });
  await onboarding.offboard('demo');
  assertSameMap(inRegion(w).urlMaps.lb, original);
});

test('onboard global: no lb written, no hold route, one header, whether found or said', async () => {
  for (const input of [INPUT, { ...INPUT, loadBalancer: 'global' }]) {
    const { w, store, onboarding } = setup();
    const workload = await onboarding.onboard(input);
    assert.equal('lb' in store.configs.get('demo'), false);
    assert.deepEqual(workload.lb, { kind: 'global' });
    assert.deepEqual(w.urlMaps.lb.pathMatchers[0].pathRules, [{ paths: ['/_dormeto/*'], service: WAKER_URL }]);
    assert.deepEqual(w.services[WAKER].customRequestHeaders, ['x-dormeto-workload: demo']);
  }
});

test('wakeTimeoutSeconds: 600 by default on a global load balancer; 60 and 1700 accepted', async () => {
  assert.equal((await setup().onboarding.onboard(INPUT)).settings.wakeTimeoutSeconds, 600);
  for (const wakeTimeoutSeconds of [60, 1700]) {
    const { store, onboarding } = setup();
    await onboarding.onboard({ ...INPUT, settings: { wakeTimeoutSeconds } });
    assert.equal(store.configs.get('demo').wakeTimeoutSeconds, wakeTimeoutSeconds);
  }
});

// The map's change is included in the wake: an explicit timeout must leave room for it (the ruling of R9).
for (const [kind, world, lowest] of [['regional', regional, 160], ['classic', classic, 310]]) {
  test(`${kind}: a wakeTimeoutSeconds not above SWAP_WAIT plus 60 s is refused, with the words, at the dry run and the onboarding`, async () => {
    const { w, store, onboarding } = setup(world);
    const input = { ...INPUT, settings: { wakeTimeoutSeconds: lowest } };
    const words = new RegExp(`settings: wakeTimeoutSeconds ${lowest} is too short for a ${kind} load balancer: its wake includes the URL map's change, ${lowest - 60} s: use more than ${lowest}`);
    const { eligible, reasons } = await onboarding.dryRun(input);
    assert.equal(eligible, false);
    assert.match(reasons.join(), words);
    await assert.rejects(onboarding.onboard(input), refused(400, 'not-eligible', words));
    assert.deepEqual(w.changes, []);
    assert.equal(store.configs.has('demo'), false);
  });

  test(`${kind}: a wakeTimeoutSeconds just above SWAP_WAIT plus 60 s is taken`, async () => {
    const { store, onboarding } = setup(world);
    await onboarding.onboard({ ...INPUT, settings: { wakeTimeoutSeconds: lowest + 1 } });
    assert.equal(store.configs.get('demo').wakeTimeoutSeconds, lowest + 1);
  });

  test(`nap now of a ${kind} workload: its task asked, as a global one's`, async () => {
    const { w, clock, onboarding } = setup(world);
    await onboarding.onboard(INPUT);
    w.changes.length = 0;
    await onboarding.nap('demo');
    assert.deepEqual(w.tasks, [{ url: `${CONTROLLER}/v1/tasks`, body: { action: 'nap', workloadId: 'demo', requestedAt: clock.now() } }]);
    assert.deepEqual(w.changes, []);
  });

  test(`a ${kind} workload onboarded, napped and woken: the VM down in between, its map at the end as onboarded`, async () => {
    const { w, store, core, onboarding } = setup(world);
    const mapOf = () => (kind === 'regional' ? w.regions[REGION].urlMaps.lb : w.urlMaps.lb);
    await onboarding.onboard({ ...INPUT, settings: { hibernate: false } });
    const onboarded = structuredClone(mapOf());
    w.changes.length = 0;
    assert.equal((await core.nap('demo')).state, STATES.ASLEEP);
    assert.equal(w.vms['vm-a'].status, 'TERMINATED');
    assert.equal(mapOf().pathMatchers[0].defaultService.endsWith(`/${WAKER}`), true);
    assert.deepEqual(w.changes, ['map lb', 'stop vm-a']);
    w.changes.length = 0;
    const wakeId = await core.beginWake('demo', STATES.ASLEEP, 'operator');
    assert.equal((await core.wake('demo', wakeId)).state, STATES.AWAKE);
    assert.deepEqual(w.changes, ['start vm-a', 'map lb']);
    assertSameMap(mapOf(), onboarded);
    assert.equal(store.runs.get('demo').state, STATES.AWAKE);
  });

  test(`a ${kind} workload stopped by hand: the check writes the swap, and the next one nothing`, async () => {
    const { w, store, core, onboarding } = setup(world);
    await onboarding.onboard(INPUT);
    w.changes.length = 0;
    w.vms['vm-a'].status = 'TERMINATED';
    await core.check();
    assert.equal(store.runs.get('demo').state, STATES.ASLEEP);
    assert.deepEqual(w.changes, ['map lb']);
    await core.check();
    assert.deepEqual(w.changes, ['map lb']);
  });

  test(`an asleep ${kind} workload offboarded: its wake unswaps, the offboarding removes the routes, the map as it was`, async () => {
    const { w, store, core, onboarding } = setup(world);
    const mapOf = () => (kind === 'regional' ? w.regions[REGION].urlMaps.lb : w.urlMaps.lb);
    const original = structuredClone(mapOf());
    await onboarding.onboard(INPUT);
    await core.nap('demo');
    await onboarding.offboard('demo');
    assertSameMap(mapOf(), original);
    assert.equal(store.configs.has('demo'), false);
  });
}

test('a global load balancer: a wakeTimeoutSeconds of 60 stays allowed', async () => {
  const { store, onboarding } = setup();
  await onboarding.onboard({ ...INPUT, settings: { wakeTimeoutSeconds: 60 } });
  assert.equal(store.configs.get('demo').wakeTimeoutSeconds, 60);
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
  assertSameMap(w.urlMaps.lb, original);
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
  assertSameMap(w.urlMaps.lb, original);
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
  assertSameMap(w.urlMaps.lb, original);
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
  const { w, store, clock, onboarding } = setup();
  await onboarding.onboard(INPUT);
  w.changes.length = 0;
  assert.equal((await onboarding.nap('demo')).id, 'demo');
  assert.deepEqual(w.tasks, [{ url: `${CONTROLLER}/v1/tasks`, body: { action: 'nap', workloadId: 'demo', requestedAt: clock.now() } }]);
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

// --- A URL map changed since the onboarding: the nap goes on only with a policy that catches the service's requests ---

async function onboarded(change) {
  const world = setup();
  await world.onboarding.onboard(INPUT);
  change?.(world.w);
  world.w.changes.length = 0;
  return world;
}
const moved = (w) => {
  w.urlMaps.lb.pathMatchers[0].defaultService = serviceUrl('other');
  w.urlMaps.lb2 = { name: 'lb2', fingerprint: 'x', defaultService: serviceUrl('app') };
};
const napRefused = ({ w, store }, out, reason) => {
  assert.equal(out.state, STATES.AWAKE);
  assert.equal(out.aborted, true);
  assert.equal(store.runs.get('demo').state, STATES.AWAKE);
  assert.equal(w.vms['vm-a'].status, 'RUNNING');
  assert.equal(w.changes.some((line) => !line.startsWith('map ')), false, w.changes.join());
  assert.match(w.logs.find((l) => l.event === 'NapAborted').reason, reason);
};

test('the service moved to another URL map: the nap stops nothing, AWAKE, the log says why', async () => {
  const world = await onboarded(moved);
  napRefused(world, await world.core.nap('demo'), /backend service app is also named in URL map lb2/);
  assert.deepEqual(world.w.changes, []);
  assert.equal(world.w.urlMaps.lb2.defaultCustomErrorResponsePolicy, undefined);
});

test('the service in no URL map any more: the nap stops nothing, AWAKE, the log says why', async () => {
  const world = await onboarded((w) => { w.urlMaps.lb.pathMatchers[0].defaultService = serviceUrl('other'); });
  napRefused(world, await world.core.nap('demo'), /backend service app is named by no path matcher of URL map lb/);
  assert.deepEqual(world.w.changes, []);
});

test('the service in a second URL map too: the nap stops nothing and writes nothing', async () => {
  const world = await onboarded((w) => { w.urlMaps.lb2 = { name: 'lb2', fingerprint: 'x', defaultService: serviceUrl('app') }; });
  napRefused(world, await world.core.nap('demo'), /also named in URL map lb2/);
  assert.deepEqual(world.w.changes, []);
});

test('the service named by a second URL map during the 300 s: the policy goes again, nothing stopped', async () => {
  const world = await onboarded();
  world.clock.onSleep(() => { world.w.urlMaps.lb2 = { name: 'lb2', fingerprint: 'x', defaultService: serviceUrl('app') }; });
  napRefused(world, await world.core.nap('demo'), /also named in URL map lb2/);
  assert.deepEqual(world.w.changes, ['map lb', 'map lb']);
  assert.equal(world.w.urlMaps.lb.pathMatchers[0].defaultCustomErrorResponsePolicy, undefined);
});

test('the release of a failed workload whose service moved stops nothing either', async () => {
  const world = await onboarded(moved);
  world.store.runs.get('demo').state = STATES.FAILED;
  const out = await world.core.release('demo');
  assert.equal(out.state, STATES.FAILED);
  assert.equal(world.w.vms['vm-a'].status, 'RUNNING');
  assert.deepEqual(world.w.changes, []);
});

test('asleep, the service in no URL map any more: the check says so and changes nothing', async () => {
  const world = await onboarded((w) => { w.urlMaps.lb.pathMatchers[0].defaultService = serviceUrl('other'); });
  world.store.runs.get('demo').state = STATES.ASLEEP;
  world.w.vms['vm-a'].status = 'TERMINATED';
  const [result] = await world.core.check();
  assert.match(result.error, /named by no path matcher/);
  assert.equal(world.store.runs.get('demo').state, STATES.ASLEEP);
  assert.deepEqual(world.w.changes, []);
});

test('the map\'s default alone names the service: eligible, it gets its matcher, and the nap\'s policy goes there, not on the map', async () => {
  const change = (w) => {
    w.urlMaps.lb = { name: 'lb', fingerprint: 'f', defaultService: serviceUrl('app') };
  };
  const { w, core, onboarding } = setup(change);
  assert.deepEqual((await onboarding.dryRun(INPUT)).reasons, []);
  await onboarding.onboard(INPUT);
  assert.equal((await core.nap('demo')).state, STATES.ASLEEP);
  assert.equal(w.urlMaps.lb.defaultCustomErrorResponsePolicy, undefined);
  assert.equal(w.urlMaps.lb.pathMatchers.at(-1).name, 'dormeto-default');
  assert.equal(w.urlMaps.lb.pathMatchers.at(-1).defaultCustomErrorResponsePolicy.errorService, WAKER_URL);
});

// --- Cloud SQL companions ---------------------------------------------------------------------------------------------------

const withSql = (fields = { db: {} }) => (w) => { w.sql = structuredClone(fields); };
const SQL_INPUT = { ...INPUT, cloudSql: ['db'] };
const sqlLink = (name) => `https://sqladmin.googleapis.com/v1/projects/p/instances/${name}`;

test('the dry run names the databases asked for; none asked: an empty list', async () => {
  const { onboarding, w, store } = setup(withSql({ db: {}, second: {} }));
  const answer = await onboarding.dryRun({ ...INPUT, cloudSql: ['db', 'second'] });
  assert.equal(answer.eligible, true);
  assert.deepEqual(answer.databases, [{ name: 'db', selfLink: sqlLink('db') }, { name: 'second', selfLink: sqlLink('second') }]);
  assert.deepEqual(w.changes, []);
  assert.equal(store.configs.size, 0);
  assert.deepEqual((await onboarding.dryRun(INPUT)).databases, []);
});

test('an onboarding with a companion: a cloudsql backend after the application\'s, and shown', async () => {
  const { store, onboarding } = setup(withSql());
  const workload = await onboarding.onboard(SQL_INPUT);
  assert.deepEqual(store.configs.get('demo').backends, [{ kind: 'vm', location: ZONE, name: 'vm-a', id: '1001' }, { kind: 'cloudsql', name: 'db' }]);
  assert.deepEqual(workload.backends.at(-1), { kind: 'cloudsql', name: 'db' });
});

test('with no cloudSql, the configuration names no database and reads no Cloud SQL', async () => {
  const { w, store, onboarding } = setup();
  await onboarding.dryRun(INPUT);
  await onboarding.onboard(INPUT);
  assert.equal(store.configs.get('demo').backends.some((b) => b.kind === 'cloudsql'), false);
  assert.equal([...w.used].some((name) => name.startsWith('cloudsql.')), false);
});

for (const [title, fields, words] of [
  ['a read replica, by its primary\'s name', { masterInstanceName: 'p:primary' }, /Cloud SQL instance db is a read replica/],
  ['a read replica, by its type', { instanceType: 'READ_REPLICA_INSTANCE' }, /Cloud SQL instance db is a read replica/],
  ['a primary with replicas', { replicaNames: ['db-r1'] }, /Cloud SQL instance db has read replicas \(db-r1\)/],
]) {
  test(`${title} is refused, with its words, at the dry run and the onboarding, nothing changed`, async () => {
    const { w, store, onboarding } = setup(withSql({ db: fields }));
    const answer = await onboarding.dryRun(SQL_INPUT);
    assert.equal(answer.eligible, false);
    assert.match(answer.reasons.join('; '), words);
    await assert.rejects(onboarding.onboard(SQL_INPUT), refused(400, 'not-eligible', words));
    assert.deepEqual(w.changes, []);
    assert.equal(store.configs.size, 0);
  });
}

test('an instance not found is refused, naming it', async () => {
  const { onboarding } = setup();
  const answer = await onboarding.dryRun(SQL_INPUT);
  assert.equal(answer.eligible, false);
  assert.match(answer.reasons.join('; '), /Cloud SQL instance db not found: name an instance of this project/);
  await assert.rejects(onboarding.onboard(SQL_INPUT), refused(400, 'not-eligible', /Cloud SQL instance db not found/));
});

test('an instance the router cannot read (403: the feature missing, or Google hiding one absent) is refused, saying both', async () => {
  const { w, onboarding } = setup(withSql());
  w.fail['GET sql/instances/db'] = new GoogleError('Google: GET: 403 not authorized', { code: 403, reason: 'notAuthorized' });
  const { eligible, reasons } = await onboarding.dryRun(SQL_INPUT);
  assert.equal(eligible, false);
  assert.match(reasons.join('; '), /the router cannot read Cloud SQL instance db: it does not exist, or the router was installed without --with cloud-sql: .*403/);
});

test('another failure reading an instance stays a failure', async () => {
  const { w, onboarding } = setup(withSql());
  const failure = new GoogleError('Google: GET: 500', { code: 500 });
  w.fail['GET sql/instances/db'] = failure;
  await assert.rejects(onboarding.dryRun(SQL_INPUT), failure);
});

test('an instance another workload holds is refused, naming it', async () => {
  const { store, onboarding } = setup(withSql());
  store.configs.set('first', { workloadId: 'first', backendService: 'other', backends: [{ kind: 'cloudsql', name: 'db' }] });
  const { reasons } = await onboarding.dryRun(SQL_INPUT);
  assert.match(reasons.join('; '), /Cloud SQL instance db belongs to workload first/);
});

for (const [title, cloudSql, words] of [
  ['a name asked twice', ['db', 'db'], /cloudSql: db is named twice/],
  ['not a list', 'db', /cloudSql: must be a list of Cloud SQL instance names/],
  ['a name that is not one', ['Bad_Name'], /cloudSql: "Bad_Name" is not a Cloud SQL instance name/],
  ['a name that is no string', [1], /cloudSql: 1 is not a Cloud SQL instance name/],
]) {
  test(`cloudSql: ${title} is a 400 before any read`, async () => {
    const { w, onboarding } = setup(withSql());
    for (const call of [onboarding.dryRun, onboarding.onboard]) await assert.rejects(call({ ...INPUT, cloudSql }), refused(400, 'bad-request', words));
    assert.equal(w.used.size, 0);
  });
}

test('a companion without an application is refused: it needs the backend service, as every workload', async () => {
  const { onboarding } = setup(withSql());
  await assert.rejects(onboarding.dryRun({ urlMap: 'lb', id: 'demo', cloudSql: ['db'] }), refused(400, 'bad-request', /urlMap and backendService are needed/));
});

test('a companion behind a backend service with no backend is refused, as any', async () => {
  const { onboarding } = setup((w) => {
    withSql()(w);
    w.services.app.backends = [];
  });
  assert.match((await onboarding.dryRun(SQL_INPUT)).reasons.join('; '), /has no backend/);
});

test('wakeTimeoutSeconds: 1700 by default with a companion; one set stays as it is', async () => {
  const byDefault = setup(withSql());
  assert.equal((await byDefault.onboarding.onboard(SQL_INPUT)).settings.wakeTimeoutSeconds, 1700);
  const given = setup(withSql());
  await given.onboarding.onboard({ ...SQL_INPUT, settings: { wakeTimeoutSeconds: 900 } });
  assert.equal(given.store.configs.get('demo').wakeTimeoutSeconds, 900);
});

for (const [kind, world] of [['classic', classic], ['regional', regional]]) {
  test(`wakeTimeoutSeconds: 1700 with a companion on a ${kind} load balancer too: SWAP_WAIT added, up to the 1700`, async () => {
    const { onboarding } = setup((w) => {
      world(w);
      withSql()(w);
    });
    assert.equal((await onboarding.onboard(SQL_INPUT)).settings.wakeTimeoutSeconds, 1700);
  });
}

test('offboard --force of a sleeping workload: the stopped database is named as left, the VM too; awake: nothing left', async () => {
  const asleep = setup(withSql());
  await asleep.onboarding.onboard(SQL_INPUT);
  await asleep.core.nap('demo');
  const { left } = await asleep.onboarding.offboard('demo', { force: true });
  assert.deepEqual(left.map((b) => b.name).sort(), ['db', 'vm-a']);
  assert.deepEqual(left.find((b) => b.name === 'db'), { kind: 'cloudsql', name: 'db' });
  assert.equal(asleep.w.sql.db.settings.activationPolicy, 'NEVER');

  const awake = setup(withSql());
  await awake.onboarding.onboard(SQL_INPUT);
  assert.deepEqual((await awake.onboarding.offboard('demo', { force: true })).left, []);
});

test('offboard --force: a database that cannot be read is not known to be up: named as left, logged', async () => {
  const { w, onboarding } = setup(withSql());
  await onboarding.onboard(SQL_INPUT);
  w.fail['GET sql/instances/db'] = new GoogleError('Google: GET: 403 not authorized', { code: 403 });
  assert.deepEqual((await onboarding.offboard('demo', { force: true })).left, [{ kind: 'cloudsql', name: 'db' }]);
  assert.ok(w.logs.some((l) => l.event === 'BackendUnread' && l.backend === 'db'));
});

test('offboard of a sleeping workload: the database up, then the application, then what is Dormeto\'s goes', async () => {
  const { w, clock, store, core, onboarding } = setup(withSql());
  await onboarding.onboard(SQL_INPUT);
  await core.nap('demo');
  clock.advance(600_000);
  w.changes.length = 0;
  await onboarding.offboard('demo');
  assert.equal(w.changes[0], 'sql db ALWAYS');
  assert.equal(w.sql.db.settings.activationPolicy, 'ALWAYS');
  assert.equal(store.configs.size, 0);
});

// --- GKE pods behind standalone NEGs (the coverage design's section 8, over the fake of world.mjs: task R11's assumptions before M9 to M12) ------------------------

const kubeCalls = (w) => w.kube.calls;
const ALL_READINGS = ['description', 'annotations'];

test('review focus 4: the dry run makes no Kubernetes call, and needs no right in the cluster', async () => {
  const { w, onboarding } = setup((world) => {
    onGke(world);
    // Any call throws, were one made.
    world.kubeThrows = new Error('a Kubernetes call in a dry run');
    world.kube.denied = ['get deployments', 'list pods'];
  });
  const answer = await onboarding.dryRun(GKE_DRY);
  assert.deepEqual(answer.reasons, []);
  assert.equal(answer.eligible, true);
  assert.deepEqual(kubeCalls(w), []);
  assert.equal(w.used.has('gke.kubernetesOf'), false);
  assert.deepEqual(w.changes, []);
});

for (const reading of ALL_READINGS) {
  test(`the dry run, the NEG read by its ${reading}: names the cluster alone, answers the namespace, the Service and autopilot, as a boolean`, async () => {
    const { onboarding } = setup((w) => onGke(w, { reading }));
    const answer = await onboarding.dryRun(GKE_DRY);
    assert.deepEqual(answer.gke, { cluster: CLUSTER, namespace: 'shop', service: 'web', autopilot: true });
    assert.deepEqual(answer.vms, []);
    assert.deepEqual(answer.groups, []);
    assert.equal(answer.warnings, undefined);
  });
}

test('a dry run with no gke has no gke in its answer, no warnings, and reads no cluster', async () => {
  const { w, onboarding } = setup();
  const answer = await onboarding.dryRun(INPUT);
  assert.equal('gke' in answer, false);
  assert.equal('warnings' in answer, false);
  assert.equal(w.used.has('gke.getCluster'), false);
});

for (const [name, autopilot] of [['autopilot.enabled false', { enabled: false }], ['no autopilot in the answer', undefined]]) {
  test(`a Standard cluster, ${name}: eligible, the warning in its words, gke.autopilot false`, async () => {
    const { onboarding } = setup((w) => {
      onGke(w);
      w.clusters[`${CLUSTER.location}/${CLUSTER.name}`].autopilot = autopilot;
    });
    const answer = await onboarding.dryRun(GKE_DRY);
    assert.equal(answer.eligible, true);
    assert.equal(answer.gke.autopilot, false);
    assert.equal(answer.warnings.length, 1);
    assert.match(answer.warnings[0], /europe-west1-b\/shop is a Standard cluster: scaling pods saves money only on Autopilot, or with the node autoscaler freeing a node/);
  });
}

const GKE_REFUSALS = [
  ['a cluster that does not exist', (w) => { delete w.clusters[`${CLUSTER.location}/${CLUSTER.name}`]; }, /GKE cluster europe-west1-b\/shop not found/],
  ['a cluster with no DNS endpoint', (w) => { w.clusters[`${CLUSTER.location}/${CLUSTER.name}`].controlPlaneEndpointsConfig = {}; }, /no DNS endpoint open to traffic.*--enable-dns-access/],
  ['a DNS endpoint closed to the outside', (w) => { w.clusters[`${CLUSTER.location}/${CLUSTER.name}`].controlPlaneEndpointsConfig.dnsEndpointConfig.allowExternalTraffic = false; }, /no DNS endpoint open to traffic.*--enable-dns-access/],
  ['a router installed without the feature', (w) => { w.fail[`GET gke/locations/${CLUSTER.location}/clusters/${CLUSTER.name}`] = new GoogleError('Google: 403 denied', { code: 403 }); }, /installed without --with gke/],
  ['a NEG whose Service cannot be read', (w) => onGke(w, { reading: 'none' }), /cannot read which namespace and Service network endpoint group k8s1-.* belongs to.*a wrong guess would scale someone else's pods/],
  ['a VM NEG next to the GKE NEG', (w) => {
    w.negs.vms = { endpoints: ['neg-vm'] };
    w.vms['neg-vm'] = { id: '4001', status: 'RUNNING' };
    w.services.app.backends.push({ group: `${V1}/zones/${ZONE}/networkEndpointGroups/vms` });
  }, /network endpoint group vms of backend service app was not made by GKE, its endpoints are VMs/],
  ['an instance group next to the GKE NEG', (w) => { w.services.app.backends.push({ group: unmanagedUrl('ig') }); }, /backend ig of backend service app is an instance group/],
  ['a serverless NEG next to the GKE NEG', (w) => { w.services.app.backends.push({ group: `${V1}/regions/${REGION}/networkEndpointGroups/run` }); }, /backend run of backend service app is a regional network endpoint group \(serverless/],
  ['a NEG of another Service next to the first', (w) => {
    w.negs.second = { gkeOwner: OWNER, zone: 'europe-west1-c', ...NEG_READINGS.description('shop', 'admin') };
    w.services.app.backends.push({ group: `${V1}/zones/europe-west1-c/networkEndpointGroups/second` });
  }, /belong to different Services \(shop\/web, shop\/admin\)|belongs to Service shop\/admin, not shop\/web/],
  ['a NEG that is not of pods\' type', (w) => { w.negs[GKE_NEG].type = 'NON_GCP_PRIVATE_IP_PORT'; }, /has the type NON_GCP_PRIVATE_IP_PORT/],
  ['a NEG that is not there', (w) => { delete w.negs[GKE_NEG]; }, /not found: it was deleted/],
];

for (const [name, change, words] of GKE_REFUSALS) {
  test(`dry run and onboarding refuse ${name}, worded, with no Kubernetes call`, async () => {
    const { w, store, onboarding } = setup((world) => {
      onGke(world);
      change(world);
    });
    const answer = await onboarding.dryRun(GKE_DRY);
    assert.equal(answer.eligible, false);
    assert.match(answer.reasons.join('; '), words);
    await assert.rejects(onboarding.onboard(GKE_INPUT), refused(400, 'not-eligible', words));
    assert.deepEqual(kubeCalls(w), []);
    assert.deepEqual(w.changes, []);
    assert.equal(store.configs.size, 0);
  });
}

test('a GKE NEG with no --gke-cluster stays refused, and a VM NEG with --gke-cluster, alone, is refused', async () => {
  const neg = setup(onGke);
  assert.match((await neg.onboarding.dryRun(INPUT)).reasons.join(), /was made by GKE, its endpoints are pods: it needs --gke-cluster/);
  const vms = setup((w) => {
    onGke(w);
    delete w.negs[GKE_NEG];
    w.negs.vms = { endpoints: ['neg-vm'] };
    w.vms['neg-vm'] = { id: '4001', status: 'RUNNING' };
    w.services.app.backends = [{ group: `${V1}/zones/${ZONE}/networkEndpointGroups/vms` }];
  });
  assert.match((await vms.onboarding.dryRun(GKE_DRY)).reasons.join(), /was not made by GKE/);
});

test('--gke-cluster on a mix, the VM NEG first and with no --gke-cluster: refused both ways', async () => {
  const mix = (w) => {
    onGke(w);
    w.negs.vms = { endpoints: ['neg-vm'] };
    w.vms['neg-vm'] = { id: '4001', status: 'RUNNING' };
    w.services.app.backends.unshift({ group: `${V1}/zones/${ZONE}/networkEndpointGroups/vms` });
  };
  assert.match((await setup(mix).onboarding.dryRun(INPUT)).reasons.join(), /it needs --gke-cluster/);
  assert.match((await setup(mix).onboarding.dryRun(GKE_DRY)).reasons.join(), /was not made by GKE/);
});

for (const [name, map] of [['k8s2-', 'k8s2-um-abc-shop-web'], ['gkegw1-', 'gkegw1-abc-shop-gw'], ['gkemcg1-', 'gkemcg1-abc-shop-gw']]) {
  test(`GKE's own map ${name}: refused, saying how to use a standalone NEG, with nothing written or tried`, async () => {
    const input = { ...INPUT, urlMap: map };
    const { w, onboarding, store } = setup((world) => {
      world.urlMaps[map] = { ...world.urlMaps.lb, name: map };
      world.httpsProxies[0].urlMap = `${V1}/global/urlMaps/${map}`;
      delete world.urlMaps.lb;
    });
    const words = /belongs to a load balancer GKE owns \(a Gateway or an Ingress\).*standalone network endpoint group with the annotation cloud\.google\.com\/neg/;
    const answer = await onboarding.dryRun(input);
    assert.equal(answer.eligible, false);
    assert.match(answer.reasons.join(), words);
    await assert.rejects(onboarding.onboard(input), refused(400, 'not-eligible', words));
    assert.deepEqual(w.changes, []);
    assert.equal(store.configs.size, 0);
  });
}

test('the onboarding: a review per right, the owner read, a k8s backend of the design\'s shape, and pods\' wake timeout', async () => {
  const { w, store, onboarding } = setup(onGke);
  const workload = await onboarding.onboard(GKE_INPUT);
  const backend = { kind: 'k8s', cluster: CLUSTER, namespace: 'shop', service: 'web', owner: { kind: 'Deployment', name: 'web' } };
  assert.deepEqual(store.configs.get('demo').backends, [backend]);
  assert.deepEqual(workload.backends, [backend]);
  assert.equal(store.configs.get('demo').wakeTimeoutSeconds, 300);
  const reviews = kubeCalls(w).filter((call) => call.endsWith('/selfsubjectaccessreviews'));
  assert.equal(reviews.length, 26);
  assert.ok(kubeCalls(w).includes('GET /apis/apps/v1/namespaces/shop/deployments/web'), 'the owner read');
  assert.deepEqual(w.changes, [`create ${WAKER}`, 'map lb']);
  assert.ok(kubeCalls(w).every((call) => call.endsWith('/selfsubjectaccessreviews') || call.includes('/namespaces/shop/')), 'nothing outside the namespace');
});

test('the onboarding of a StatefulSet at 0 replicas: no endpoint is normal', async () => {
  const { store, onboarding } = setup((w) => {
    onGke(w, { replicas: 0 });
    w.kube.owners['StatefulSet shop/db'] = { replicas: 0 };
  });
  await onboarding.onboard({ ...GKE_INPUT, gke: { ...GKE_INPUT.gke, owner: { kind: 'StatefulSet', name: 'db' } } });
  assert.deepEqual(store.configs.get('demo').backends[0].owner, { kind: 'StatefulSet', name: 'db' });
});

const WAKE_TIMEOUTS = [
  ['a global load balancer', {}, () => {}, 300],
  ['a regional one, with SWAP_WAIT', {}, (w) => {
    const backends = w.services.app.backends;
    regional(w);
    w.regions[REGION].services.app.backends = backends;
  }, 400],
  ['a classic one, with SWAP_WAIT', {}, classic, 550],
  ['a companion', { cloudSql: ['db'] }, (w) => { w.sql.db = {}; }, 1700],
  ['a companion on a classic one: 1700 still wins', { cloudSql: ['db'] }, (w) => {
    classic(w);
    w.sql.db = {};
  }, 1700],
  ['an explicit one', { settings: { wakeTimeoutSeconds: 123 } }, () => {}, 123],
];
for (const [name, extra, change, seconds] of WAKE_TIMEOUTS) {
  test(`pods' wake timeout: ${name}, ${seconds} s`, async () => {
    const { store, onboarding } = setup((w) => {
      onGke(w);
      change(w);
    });
    await onboarding.onboard({ ...GKE_INPUT, ...extra });
    assert.equal(store.configs.get('demo').wakeTimeoutSeconds, seconds);
  });
}

test('a missing right is refused, naming it, with nothing written; the onboarding reads no owner', async () => {
  const { w, store, onboarding } = setup((world) => {
    onGke(world);
    world.kube.denied = ['patch deployments/scale', 'list events'];
  });
  await assert.rejects(onboarding.onboard(GKE_INPUT), refused(400, 'not-eligible', /the router lacks patch deployments\/scale \(apps\); list events in namespace shop of GKE cluster europe-west1-b\/shop/));
  assert.deepEqual(w.changes, []);
  assert.equal(store.configs.size, 0);
  assert.equal(kubeCalls(w).includes('GET /apis/apps/v1/namespaces/shop/deployments/web'), false);
});

test('an owner that does not exist is refused, named', async () => {
  const { w, onboarding } = setup(onGke);
  await assert.rejects(onboarding.onboard({ ...GKE_INPUT, gke: { ...GKE_INPUT.gke, owner: { kind: 'Deployment', name: 'gone' } } }), refused(400, 'not-eligible', /Deployment shop\/gone not found in GKE cluster europe-west1-b\/shop/));
  assert.deepEqual(w.changes, []);
});

test('an owner not behind the NEG is refused: its endpoints are another\'s pods', async () => {
  const { w, onboarding } = setup((world) => {
    onGke(world);
    world.kube.owners['Deployment shop/admin'] = { replicas: 1 };
  });
  await assert.rejects(onboarding.onboard({ ...GKE_INPUT, gke: { ...GKE_INPUT.gke, owner: { kind: 'Deployment', name: 'admin' } } }), refused(400, 'not-eligible', /that are not pods of Deployment shop\/admin/));
  assert.deepEqual(w.changes, []);
});

for (const [name, change, words] of [
  ['another namespace', { namespace: 'admin' }, /belongs to Service shop\/web, not admin\/web/],
  ['another Service', { service: 'api' }, /belongs to Service shop\/web, not shop\/api/],
]) {
  test(`the request naming ${name} than the NEG's: refused, before the cluster`, async () => {
    const { w, onboarding } = setup(onGke);
    await assert.rejects(onboarding.onboard({ ...GKE_INPUT, gke: { ...GKE_INPUT.gke, ...change } }), refused(400, 'not-eligible', words));
    assert.deepEqual(kubeCalls(w), []);
  });
}

for (const [name, change] of [
  ['refuses the reviews with a 403', (w) => { w.kube.answers['POST /apis/authorization.k8s.io/v1/selfsubjectaccessreviews'] = { status: 403, body: { message: 'container.clusters.connect' } }; }],
  ['cannot be reached', (w) => { w.kube.down = true; }],
]) {
  test(`a cluster that ${name}: a refusal in its words, not a 500, nothing written`, async () => {
    const { w, onboarding } = setup((world) => {
      onGke(world);
      change(world);
    });
    await assert.rejects(onboarding.onboard(GKE_INPUT), refused(400, 'not-eligible', /the router cannot read GKE cluster europe-west1-b\/shop: /));
    assert.deepEqual(w.changes, []);
  });
}

test('an onboarding needs all of gke, a dry run the cluster alone; a bad field is a 400 before any read', async () => {
  const { w, onboarding } = setup(onGke);
  await assert.rejects(onboarding.onboard(GKE_DRY), refused(400, 'bad-request', /an onboarding names its namespace, service and owner/));
  await assert.rejects(onboarding.dryRun({ ...INPUT, gke: { cluster: { location: 'a/b', name: 'shop' } } }), refused(400, 'bad-request', /gke\.cluster\.location/));
  await assert.rejects(onboarding.onboard({ ...GKE_INPUT, gke: { ...GKE_INPUT.gke, namespace: '../x' } }), refused(400, 'bad-request', /gke\.namespace/));
  assert.equal(w.used.size, 0);
});

test('another workload\'s Service or owner is refused', async () => {
  const { store, onboarding } = setup(onGke);
  store.configs.set('first', { workloadId: 'first', backendService: 'other', backends: [K8S_BACKEND] });
  assert.match((await onboarding.dryRun(GKE_DRY)).reasons.join(), /Service shop\/web of GKE cluster europe-west1-b\/shop belongs to workload first/);
  store.configs.set('first', { workloadId: 'first', backendService: 'other', backends: [{ ...K8S_BACKEND, service: 'admin' }] });
  await assert.rejects(onboarding.onboard(GKE_INPUT), refused(400, 'not-eligible', /Deployment shop\/web of GKE cluster europe-west1-b\/shop belongs to workload first/));
  // Another cluster's, of the same names, is no one's.
  store.configs.set('first', { workloadId: 'first', backendService: 'other', backends: [{ ...K8S_BACKEND, cluster: { location: ZONE, name: 'elsewhere' } }] });
  await onboarding.onboard(GKE_INPUT);
});

test('a regional load balancer\'s NEGs are read through its regional backend service', async () => {
  const { store, onboarding } = setup((w) => {
    onGke(w);
    const { backends } = w.services.app;
    regional(w);
    w.regions[REGION].services.app.backends = backends;
  });
  const answer = await onboarding.dryRun(GKE_DRY);
  assert.deepEqual(answer.reasons, []);
  assert.deepEqual(answer.lb, { kind: 'regional', region: REGION });
  assert.equal(answer.gke.service, 'web');
  await onboarding.onboard(GKE_INPUT);
  assert.deepEqual(store.configs.get('demo').lb, { kind: 'regional', region: REGION });
});

// --- The offboarding of pods -------------------------------------------------------------------------------------------------

const awakePods = async (change = () => {}) => {
  const t = setup((w) => {
    onGke(w);
    change(w);
  });
  await t.onboarding.onboard(GKE_INPUT);
  return t;
};
const KEDA = { metadata: { namespace: 'shop', name: 'web-scaler', annotations: {} }, spec: { scaleTargetRef: { name: 'web' } } };
const withKeda = (w) => { w.kube.scaledObjects.push(structuredClone(KEDA)); };

test('an offboarding wakes an asleep owner back to its replicas, KEDA given back, and removes what is Dormeto\'s', async () => {
  const t = await awakePods(withKeda);
  assert.equal((await t.core.nap('demo')).state, STATES.ASLEEP);
  assert.equal(t.w.kube.owners[OWNER].replicas, 0);
  await t.onboarding.offboard('demo');
  assert.equal(t.w.kube.owners[OWNER].replicas, 2);
  assert.deepEqual(t.w.kube.scaledObjects[0].metadata.annotations, {});
  assert.equal(t.store.configs.size, 0);
  assert.equal(t.w.services[WAKER], undefined);
});

test('a forced offboarding: the owner stays at 0 and is named, KEDA given back, the cluster\'s failure no obstacle', async () => {
  const t = await awakePods(withKeda);
  assert.equal((await t.core.nap('demo')).state, STATES.ASLEEP);
  const { left } = await t.onboarding.offboard('demo', { force: true });
  assert.deepEqual(left, [K8S_BACKEND]);
  assert.equal(t.w.kube.owners[OWNER].replicas, 0);
  assert.deepEqual(t.w.kube.scaledObjects[0].metadata.annotations, {});
  assert.equal(t.store.configs.size, 0);

  const down = await awakePods(withKeda);
  assert.equal((await down.core.nap('demo')).state, STATES.ASLEEP);
  down.w.kube.down = true;
  assert.deepEqual((await down.onboarding.offboard('demo', { force: true })).left, [K8S_BACKEND]);
  assert.equal(down.store.configs.size, 0);
  assert.ok(down.w.logs.some((l) => l.event === 'BackendUnread' && /Deployment shop\/web/.test(l.backend)));
  assert.ok(down.w.logs.some((l) => l.event === 'AutoscalerNotGivenBack'));
});

test('a forced offboarding of an awake owner names nothing as left', async () => {
  const t = await awakePods();
  assert.deepEqual((await t.onboarding.offboard('demo', { force: true })).left, []);
});

test('a Workload shows its k8s backend, and hibernate has no meaning for it', async () => {
  const t = setup(onGke);
  await t.onboarding.onboard({ ...GKE_INPUT, settings: { hibernate: true } });
  const shown = await t.onboarding.show('demo');
  assert.deepEqual(shown.backends, [K8S_BACKEND]);
  assert.equal((await t.core.nap('demo')).state, STATES.ASLEEP);
  assert.equal(t.w.used.has('compute.getInstance'), false);
  assert.equal(t.w.used.has('compute.suspendInstance'), false);
});

test('ready pods behind an empty NEG are refused, worded, with nothing written: the owner named is not shown to be behind it', async () => {
  const { w, store, onboarding } = setup((world) => {
    onGke(world);
    world.negs[GKE_NEG].empty = true;
  });
  await assert.rejects(onboarding.onboard(GKE_INPUT), refused(400, 'not-eligible', /hold no endpoint, and Deployment shop\/web has ready pods, not shown to be behind this load balancer/));
  assert.deepEqual(w.changes, []);
  assert.equal(store.configs.size, 0);
});

test('an empty NEG and an owner at 0 is onboarded: nothing ready to compare', async () => {
  const { store, onboarding } = setup((world) => {
    onGke(world, { replicas: 0 });
    world.negs[GKE_NEG].empty = true;
  });
  await onboarding.onboard(GKE_INPUT);
  assert.equal(store.configs.size, 1);
});
