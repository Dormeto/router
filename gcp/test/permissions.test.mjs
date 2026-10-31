// The adapters' calls and the manifest's router grants (access.json) must agree: a permission an adapter needs and the
// manifest lacks is a 403 in production, found by a user.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as cloudsql from '../src/cloudsql.mjs';
import * as compute from '../src/compute.mjs';
import * as gke from '../src/gke.mjs';
import * as urlmaps from '../src/urlmaps.mjs';
import * as monitoring from '../src/monitoring.mjs';
import * as tasks from '../src/tasks.mjs';
import * as firestore from '../src/firestore.mjs';
import { STATES } from '../../lambda/src/lib/state.mjs';
import { GKE_DRY, GKE_INPUT, INPUT, REGION, V1, ZONE, onGke, regional, setup } from './world.mjs';

const ADAPTERS = { cloudsql, compute, gke, urlmaps, regionalUrlmaps: { CALLS: urlmaps.CALLS_REGIONAL }, monitoring, tasks, firestore };

async function granted() {
  const manifest = JSON.parse(await readFile(new URL('../access.json', import.meta.url), 'utf8'));
  const permissions = new Set();
  const grants = [...manifest.router.map((g) => [g, manifest.roles]), ...Object.values(manifest.features).flatMap((f) => f.router.map((g) => [g, f.roles]))];
  for (const [{ role }, roles] of grants) {
    const custom = /\/roles\/(.+)$/.exec(role)?.[1];
    for (const p of custom ? roles[custom].permissions : manifest.predefined[role]) permissions.add(p);
  }
  return permissions;
}

for (const [name, adapter] of Object.entries(ADAPTERS)) {
  test(`${name}: every permission of CALLS is in the manifest's router grants`, async () => {
    const permissions = await granted();
    assert.ok(Object.keys(adapter.CALLS).length > 0);
    for (const [fn, needed] of Object.entries(adapter.CALLS)) {
      for (const p of needed) assert.ok(permissions.has(p), `${name}.${fn} needs ${p}`);
    }
  });
}

// And the other way: what the router's role grants, some call needs, so that the acceptance proves the role that ships.
test('every custom role: every permission is named by a call of an adapter', async () => {
  const { roles, features } = JSON.parse(await readFile(new URL('../access.json', import.meta.url), 'utf8'));
  const named = new Set(Object.values(ADAPTERS).flatMap((adapter) => Object.values(adapter.CALLS).flat()));
  for (const [id, role] of Object.entries({ ...roles, ...Object.assign({}, ...Object.values(features).map((f) => f.roles)) })) {
    assert.deepEqual(role.permissions.filter((p) => !named.has(p)), [], id);
  }
});

// What a call needs of what it names, though the call's own permission does not say so: a URL map's update needs .use on the backend
// services it names, a backend service's insert .use on its NEG. Not to be trimmed for having no method of their own. An unmanaged
// group's listInstances asks .get on the group, in Google's reference.
test('dormetoRouter: what a call needs implicitly stays', async () => {
  const { roles } = JSON.parse(await readFile(new URL('../access.json', import.meta.url), 'utf8'));
  for (const p of ['compute.backendServices.use', 'compute.regionBackendServices.use', 'compute.regionNetworkEndpointGroups.use', 'compute.networkEndpointGroups.get', 'compute.instanceGroups.get']) {
    assert.ok(roles.dormetoRouter.permissions.includes(p), p);
  }
});

// Google's reference, for each: the group's list calls ask .get on the group, whatever their names say.
test('a group\'s list calls name what Google\'s reference asks of them', () => {
  assert.deepEqual(compute.CALLS.listGroupInstances, ['compute.instanceGroups.get']);
  assert.deepEqual(compute.CALLS.listManagedInstances, ['compute.instanceGroupManagers.get']);
});

// Every call the onboarding and the offboarding make, seen by running them: one that CALLS does not name would escape the
// tests above. The waits are calls too: what changes something reads its operation.
const ONBOARDING_CALLS = [
  'compute.getBackendService', 'compute.getInstance', 'compute.getMachineType', 'compute.getManagedGroup', 'compute.listGroupInstances', 'compute.listManagedInstances',
  'compute.listTargetHttpsProxies', 'compute.listTargetHttpProxies', 'compute.listForwardingRules', 'compute.insertBackendService', 'compute.deleteBackendService',
  'compute.setAutoscalerMode', 'urlmaps.get', 'urlmaps.list', 'urlmaps.modify',
];
const WAITED = {
  'compute.insertBackendService': ['compute.globalOperations.get'],
  'compute.deleteBackendService': ['compute.globalOperations.get'],
  'compute.setAutoscalerMode': ['compute.zoneOperations.get', 'compute.regionOperations.get'],
  'urlmaps.modify': ['compute.globalOperations.get', 'compute.backendServices.use'],
  'compute.insertRegionBackendService': ['compute.regionOperations.get', 'compute.regionBackendServices.use', 'compute.regionNetworkEndpointGroups.use'],
  'compute.deleteRegionBackendService': ['compute.regionOperations.get'],
  'regionalUrlmaps.modify': ['compute.regionOperations.get', 'compute.regionBackendServices.use'],
};
const callsOf = (name) => {
  const [adapter, fn] = name.split('.');
  return ADAPTERS[adapter].CALLS[fn];
};

test('onboarding: every call it makes is in CALLS, and in the manifest\'s router grants', async () => {
  const { w, store, onboarding } = setup((world) => {
    world.managed.zonal = { kind: 'zonal', location: ZONE, id: '2001', members: ['z-1'] };
    world.managed.regional = { kind: 'regional', location: REGION, id: '2002', members: ['r-1'], updatePolicy: { instanceRedistributionType: 'NONE' } };
    world.vms['z-1'] = { id: '3001', status: 'RUNNING' };
    world.vms['r-1'] = { id: '3002', status: 'RUNNING' };
    world.services.app.backends.push({ group: `${V1}/zones/${ZONE}/instanceGroups/zonal` }, { group: `${V1}/regions/${REGION}/instanceGroups/regional` });
    world.autoscalers.scaler = 'OFF';
  });
  await onboarding.dryRun(INPUT);
  await onboarding.onboard(INPUT);
  Object.assign(store.runs.get('demo'), { state: STATES.FAILED, autoscalers: [{ kind: 'zonal', location: ZONE, name: 'scaler', mode: 'ON' }] });
  await onboarding.offboard('demo', { force: true });
  await onboarding.onboard(INPUT);
  await onboarding.offboard('demo');

  for (const name of ONBOARDING_CALLS) assert.ok(w.used.has(name), `the run did not exercise ${name}`);
  const permissions = await granted();
  for (const name of w.used) {
    assert.ok(callsOf(name)?.length, `${name} is not in CALLS`);
    for (const p of callsOf(name)) assert.ok(permissions.has(p), `${name} needs ${p}`);
  }
});

test('a regional load balancer\'s onboarding and offboarding: every call it makes is in CALLS, and in the manifest\'s router grants', async () => {
  const { w, onboarding } = setup(regional);
  await onboarding.dryRun(INPUT);
  await onboarding.onboard(INPUT);
  await onboarding.offboard('demo');

  for (const name of ['compute.getRegionBackendService', 'compute.listRegionTargetHttpsProxies', 'compute.listRegionTargetHttpProxies', 'compute.listRegionForwardingRules', 'compute.insertRegionBackendService', 'compute.deleteRegionBackendService', 'regionalUrlmaps.get', 'regionalUrlmaps.list', 'regionalUrlmaps.modify']) {
    assert.ok(w.used.has(name), `the run did not exercise ${name}`);
  }
  const permissions = await granted();
  for (const name of w.used) {
    assert.ok(callsOf(name)?.length, `${name} is not in CALLS`);
    for (const p of callsOf(name)) assert.ok(permissions.has(p), `${name} needs ${p}`);
  }
});

test('a regional workload\'s nap, wake and check: every call they make is in CALLS, and in the manifest\'s router grants', async () => {
  const { w, core, onboarding, store } = setup(regional);
  await onboarding.onboard(INPUT);
  w.used.clear();
  assert.equal((await core.nap('demo')).state, STATES.ASLEEP);
  await core.check();
  const wakeId = await core.beginWake('demo', STATES.ASLEEP, 'operator');
  assert.equal((await core.wake('demo', wakeId)).state, STATES.AWAKE);
  store.runs.get('demo').state = STATES.FAILED;
  assert.equal((await core.release('demo')).state, STATES.ASLEEP);

  for (const name of ['compute.getRegionBackendService', 'compute.getRegionBackendServiceHealth', 'regionalUrlmaps.list', 'regionalUrlmaps.modify']) {
    assert.ok(w.used.has(name), `the run did not exercise ${name}`);
  }
  for (const name of ['compute.getBackendService', 'compute.getBackendServiceHealth', 'urlmaps.list', 'urlmaps.modify']) {
    assert.equal(w.used.has(name), false, `${name} is the global scope's`);
  }
  const permissions = await granted();
  for (const name of w.used) {
    assert.ok(callsOf(name)?.length, `${name} is not in CALLS`);
    for (const p of callsOf(name)) assert.ok(permissions.has(p), `${name} needs ${p}`);
  }
});

test('Cloud SQL: its calls are the feature\'s roles, exactly: the read on the project, the update on the tag', async () => {
  const { features, roles } = JSON.parse(await readFile(new URL('../access.json', import.meta.url), 'utf8'));
  const feature = features['cloud-sql'];
  const needed = [...new Set(Object.values(cloudsql.CALLS).flat())].sort();
  assert.deepEqual(Object.values(feature.roles).flatMap((r) => r.permissions).sort(), needed);
  assert.deepEqual(needed.filter((p) => roles.dormetoRouter.permissions.includes(p)), [], 'not in the base role');
  const conditioned = feature.router.filter((g) => g.condition).map((g) => /\/roles\/(.+)$/.exec(g.role)[1]);
  assert.deepEqual(conditioned.flatMap((id) => feature.roles[id].permissions), ['cloudsql.instances.update']);
});

test('a workload with a companion, its onboarding, nap, wake, check and offboarding: every call it makes is in CALLS, and in the manifest\'s router grants', async () => {
  const { w, clock, core, onboarding, store } = setup((world) => {
    world.sql.db = {};
    // So that what was asked is also read by its name.
    world.sqlReading.listLagMs = 15_000;
  });
  const input = { ...INPUT, cloudSql: ['db'] };
  await onboarding.dryRun(input);
  await onboarding.onboard(input);
  assert.equal((await core.nap('demo')).state, STATES.ASLEEP);
  clock.advance(600_000);
  const wakeId = await core.beginWake('demo', STATES.ASLEEP, 'operator');
  assert.equal((await core.wake('demo', wakeId)).state, STATES.AWAKE);
  await core.check();
  store.runs.get('demo').state = STATES.FAILED;
  assert.equal((await core.release('demo')).state, STATES.ASLEEP);
  await onboarding.offboard('demo', { force: true });

  for (const name of ['cloudsql.get', 'cloudsql.listOperations', 'cloudsql.getOperation', 'cloudsql.setActivation']) assert.ok(w.used.has(name), `the run did not exercise ${name}`);
  const permissions = await granted();
  for (const name of w.used) {
    assert.ok(callsOf(name)?.length, `${name} is not in CALLS`);
    for (const p of callsOf(name)) assert.ok(permissions.has(p), `${name} needs ${p}`);
  }
});

test('GKE: its calls are the feature\'s role, exactly, and nothing of it is in the base role', async () => {
  const { features, roles } = JSON.parse(await readFile(new URL('../access.json', import.meta.url), 'utf8'));
  const needed = [...new Set(Object.values(gke.CALLS).flat())].sort();
  assert.deepEqual(Object.values(features.gke.roles).flatMap((r) => r.permissions).sort(), needed);
  assert.deepEqual(needed.filter((p) => roles.dormetoRouter.permissions.includes(p)), []);
});

test('a GKE workload, its onboarding, nap, wake, check and offboarding: every call it makes is in CALLS, and in the manifest\'s router grants', async () => {
  const { w, core, onboarding, store } = setup(onGke);
  await onboarding.dryRun(GKE_DRY);
  await onboarding.onboard(GKE_INPUT);
  assert.equal((await core.nap('demo')).state, STATES.ASLEEP);
  const wakeId = await core.beginWake('demo', STATES.ASLEEP, 'operator');
  assert.equal((await core.wake('demo', wakeId)).state, STATES.AWAKE);
  await core.check();
  store.runs.get('demo').state = STATES.FAILED;
  assert.equal((await core.release('demo')).state, STATES.ASLEEP);
  await onboarding.offboard('demo', { force: true });

  for (const name of ['gke.getCluster', 'gke.kubernetesOf', 'compute.getZonalNetworkEndpointGroup', 'compute.listNetworkEndpoints']) assert.ok(w.used.has(name), `the run did not exercise ${name}`);
  const permissions = await granted();
  for (const name of w.used) {
    assert.ok(callsOf(name)?.length, `${name} is not in CALLS`);
    for (const p of callsOf(name)) assert.ok(permissions.has(p), `${name} needs ${p}`);
  }
});

test('onboarding: a call that waits or names a backend service asks what that takes', () => {
  for (const [name, needed] of Object.entries(WAITED)) {
    for (const p of needed) assert.ok(callsOf(name).includes(p), `${name} needs ${p}`);
  }
});
