// The adapters' calls and the manifest's router grants (access.json) must agree: a permission an adapter needs and the
// manifest lacks is a 403 in production, found by a user.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as compute from '../src/compute.mjs';
import * as urlmaps from '../src/urlmaps.mjs';
import * as monitoring from '../src/monitoring.mjs';
import * as tasks from '../src/tasks.mjs';
import * as firestore from '../src/firestore.mjs';
import { STATES } from '../../lambda/src/lib/state.mjs';
import { INPUT, REGION, V1, ZONE, setup } from './world.mjs';

const ADAPTERS = { compute, urlmaps, monitoring, tasks, firestore };

async function granted() {
  const manifest = JSON.parse(await readFile(new URL('../access.json', import.meta.url), 'utf8'));
  const permissions = new Set();
  for (const { role } of manifest.router) {
    const custom = /\/roles\/(.+)$/.exec(role)?.[1];
    for (const p of custom ? manifest.roles[custom].permissions : manifest.predefined[role]) permissions.add(p);
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
};
const callsOf = (name) => {
  const [adapter, fn] = name.split('.');
  return ADAPTERS[adapter].CALLS[fn];
};

test('onboarding: every call it makes is in CALLS, and in the manifest\'s router grants', async () => {
  const { w, store, onboarding } = setup((world) => {
    world.managed.zonal = { kind: 'zonal', location: ZONE, id: '2001', members: ['z-1'] };
    world.managed.regional = { kind: 'regional', location: REGION, id: '2002', members: ['r-1'] };
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

test('onboarding: a call that waits or names a backend service asks what that takes', () => {
  for (const [name, needed] of Object.entries(WAITED)) {
    for (const p of needed) assert.ok(callsOf(name).includes(p), `${name} needs ${p}`);
  }
});
