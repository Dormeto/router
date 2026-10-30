import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCompute, CALLS } from '../src/compute.mjs';

const BASE = 'https://compute.googleapis.com/compute/v1/projects/p';

function setup(answer = () => ({})) {
  const calls = [];
  const google = {
    request: async (method, url, body) => { calls.push({ method, url, body }); return answer(method, url, body, calls); },
    waitCompute: async (op, deadline) => { calls.push({ wait: op, deadline }); },
  };
  return { calls, compute: createCompute({ google, project: 'p', now: () => 1000 }) };
}

const ZONAL = { kind: 'zonal', location: 'europe-west1-b', name: 'mig' };
const REGIONAL = { kind: 'regional', location: 'europe-west1', name: 'mig' };

// Each read: the call and the request it sends.
const READS = [
  ['getInstance', ['europe-west1-b', 'vm'], 'GET', `${BASE}/zones/europe-west1-b/instances/vm`],
  ['getGroup', ['europe-west1-b', 'ig'], 'GET', `${BASE}/zones/europe-west1-b/instanceGroups/ig`],
  ['listGroupInstances', ['europe-west1-b', 'ig'], 'POST', `${BASE}/zones/europe-west1-b/instanceGroups/ig/listInstances`, { instanceState: 'ALL' }],
  ['getManagedGroup', [ZONAL], 'GET', `${BASE}/zones/europe-west1-b/instanceGroupManagers/mig`],
  ['getManagedGroup', [REGIONAL], 'GET', `${BASE}/regions/europe-west1/instanceGroupManagers/mig`],
  ['getAutoscaler', [ZONAL], 'GET', `${BASE}/zones/europe-west1-b/autoscalers/mig`],
  ['getAutoscaler', [REGIONAL], 'GET', `${BASE}/regions/europe-west1/autoscalers/mig`],
  ['getBackendService', ['app'], 'GET', `${BASE}/global/backendServices/app`],
  ['getBackendServiceHealth', ['app', 'https://x/groups/ig'], 'POST', `${BASE}/global/backendServices/app/getHealth`, { group: 'https://x/groups/ig' }],
  ['getNetworkEndpointGroup', ['europe-west1', 'neg'], 'GET', `${BASE}/regions/europe-west1/networkEndpointGroups/neg`],
  ['getHealthCheck', ['hc'], 'GET', `${BASE}/global/healthChecks/hc`],
  ['getMachineType', ['europe-west1-b', 'e2-small'], 'GET', `${BASE}/zones/europe-west1-b/machineTypes/e2-small`],
  ['deleteBackendService', ['waker'], 'DELETE', `${BASE}/global/backendServices/waker`],
];

for (const [fn, args, method, url, body] of READS) {
  test(`${fn}${args[0]?.kind ? ` (${args[0].kind})` : ''}: ${method} ${url.slice(BASE.length)}`, async () => {
    const { calls, compute } = setup(() => ({ selfLink: 'op' }));
    await compute[fn](...args);
    assert.deepEqual(calls[0], { method, url, body });
  });
}

test('listInstances, listBackendServices, listForwardingRules, listTargetHttpProxies and listTargetHttpsProxies page through the items', async () => {
  const lists = [
    ['listInstances', ['europe-west1-b'], `${BASE}/zones/europe-west1-b/instances`],
    ['listBackendServices', [], `${BASE}/global/backendServices`],
    ['listForwardingRules', [], `${BASE}/global/forwardingRules`],
    ['listTargetHttpProxies', [], `${BASE}/global/targetHttpProxies`],
    ['listTargetHttpsProxies', [], `${BASE}/global/targetHttpsProxies`],
  ];
  for (const [fn, args, url] of lists) {
    const { calls, compute } = setup((m, u) => (u.includes('pageToken=next')
      ? { items: [{ name: 'b' }] }
      : { items: [{ name: 'a' }], nextPageToken: 'next' }));
    assert.deepEqual(await compute[fn](...args), [{ name: 'a' }, { name: 'b' }], fn);
    assert.deepEqual(calls.map((c) => c.url), [url, `${url}?pageToken=next`], fn);
  }
});

test('a list without items is empty', async () => {
  assert.deepEqual(await setup(() => ({})).compute.listBackendServices(), []);
});

test('listManagedInstances: the group\'s instances, zonal or regional', async () => {
  const { calls, compute } = setup(() => ({ managedInstances: [{ instance: 'u', instanceStatus: 'RUNNING' }] }));
  assert.deepEqual(await compute.listManagedInstances(REGIONAL), [{ instance: 'u', instanceStatus: 'RUNNING' }]);
  assert.deepEqual(calls[0], { method: 'POST', url: `${BASE}/regions/europe-west1/instanceGroupManagers/mig/listManagedInstances`, body: undefined });
  assert.deepEqual(await setup(() => ({})).compute.listManagedInstances(ZONAL), []);
});

for (const action of ['stop', 'start', 'suspend', 'resume']) {
  test(`${action}Instance: POST .../${action}, then waits for the operation`, async () => {
    const { calls, compute } = setup(() => ({ selfLink: 'op' }));
    await compute[`${action}Instance`]('europe-west1-b', 'vm');
    assert.deepEqual(calls[0], { method: 'POST', url: `${BASE}/zones/europe-west1-b/instances/vm/${action}`, body: undefined });
    assert.equal(calls[1].wait.selfLink, 'op');
    assert.equal(calls[1].deadline, 1000 + 120_000);
  });
  test(`${action}Instances: the group's ${action}Instances with the instances, zonal and regional`, async () => {
    const { calls, compute } = setup(() => ({ selfLink: 'op' }));
    await compute[`${action}Instances`](ZONAL, ['u1', 'u2']);
    await compute[`${action}Instances`](REGIONAL, ['u1']);
    assert.deepEqual(calls[0], { method: 'POST', url: `${BASE}/zones/europe-west1-b/instanceGroupManagers/mig/${action}Instances`, body: { instances: ['u1', 'u2'] } });
    assert.deepEqual(calls[2], { method: 'POST', url: `${BASE}/regions/europe-west1/instanceGroupManagers/mig/${action}Instances`, body: { instances: ['u1'] } });
    assert.equal(calls[1].wait.selfLink, 'op');
  });
}

test('setAutoscalerMode: PATCH with the mode, zonal and regional, then waits', async () => {
  const { calls, compute } = setup(() => ({ selfLink: 'op' }));
  await compute.setAutoscalerMode(ZONAL, 'OFF');
  await compute.setAutoscalerMode(REGIONAL, 'ON');
  assert.deepEqual(calls[0], { method: 'PATCH', url: `${BASE}/zones/europe-west1-b/autoscalers?autoscaler=mig`, body: { name: 'mig', autoscalingPolicy: { mode: 'OFF' } } });
  assert.deepEqual(calls[2], { method: 'PATCH', url: `${BASE}/regions/europe-west1/autoscalers?autoscaler=mig`, body: { name: 'mig', autoscalingPolicy: { mode: 'ON' } } });
  assert.equal(calls[1].wait.selfLink, 'op');
});

test('insertBackendService: POST the body, then waits', async () => {
  const { calls, compute } = setup(() => ({ selfLink: 'op' }));
  const body = { name: 'waker', backends: [{ group: 'neg' }] };
  await compute.insertBackendService(body);
  assert.deepEqual(calls[0], { method: 'POST', url: `${BASE}/global/backendServices`, body });
  assert.equal(calls[1].wait.selfLink, 'op');
});

test('deleteBackendService waits for the operation', async () => {
  const { calls, compute } = setup(() => ({ selfLink: 'op' }));
  await compute.deleteBackendService('waker');
  assert.equal(calls[1].wait.selfLink, 'op');
});

test('names are encoded in the URL', async () => {
  const { calls, compute } = setup();
  await compute.getBackendService('a/b');
  assert.equal(calls[0].url, `${BASE}/global/backendServices/a%2Fb`);
});

test('CALLS: one entry per function, each with permissions', () => {
  const { compute } = setup();
  assert.deepEqual(Object.keys(CALLS).sort(), Object.keys(compute).sort());
  for (const [fn, permissions] of Object.entries(CALLS)) {
    assert.ok(permissions.length > 0, fn);
    for (const p of permissions) assert.match(p, /^compute\.[a-zA-Z]+\.[a-zA-Z]+$/, fn);
  }
});
