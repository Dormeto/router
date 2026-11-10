import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeStopped } from '../src/stopped.mjs';
import { GoogleError } from '../src/google.mjs';

const log = { info() {}, warn() {}, error() {} };
const URL = 'https://www.googleapis.com/compute/v1/projects/p/zones/europe-west2-b/machineTypes/';
const LICENSE = 'https://www.googleapis.com/compute/v1/projects/windows-cloud/global/licenses/';

// `types`: machine type name -> { guestCpus, memoryMb }; `vms`: name -> the instance as Compute Engine answers it.
function fakeCompute({ types = {}, vms = {} } = {}) {
  const calls = { types: [], vms: [] };
  return {
    calls,
    getInstance: async (zone, name) => {
      calls.vms.push(name);
      const vm = vms[name];
      if (vm instanceof Error) throw vm;
      if (!vm) throw Object.assign(new Error(`Google: GET: 404 ${name} not found`), { code: 404 });
      return vm;
    },
    getMachineType: async (zone, type) => {
      calls.types.push(`${zone}/${type}`);
      if (!types[type]) throw Object.assign(new Error(`Google: GET: 404 machine type ${type}`), { code: 404 });
      return types[type];
    },
  };
}
const vmOf = (type, extra = {}) => ({ machineType: `${URL}${type}`, disks: [{ boot: true, licenses: [] }], scheduling: {}, ...extra });
const one = (name, extra = {}) => ({ name, zone: 'europe-west2-b', backend: `instance:${name}`, suspended: false, ...extra });
const describe = (clients, input) => describeStopped({ compute: fakeCompute(), cloudsql: {}, log, ...clients }, { vms: [], pods: [], companions: [], ...input });

test('an e2-small: its shared 0.5 vCPU, 2 GiB, Linux, on demand', async () => {
  const compute = fakeCompute({ types: { 'e2-small': { guestCpus: 2, memoryMb: 2048 } }, vms: { a: vmOf('e2-small') } });
  assert.deepEqual(await describe({ compute }, { vms: [one('a')] }), [
    { kind: 'gce', machineType: 'e2-small', family: 'e2', vcpus: 0.5, memoryGb: 2, count: 1, os: 'Linux', zone: 'europe-west2-b' },
  ]);
});

test('three Spot n2d-standard-2 of a group, two suspended: two items, the machine type read once', async () => {
  const spot = vmOf('n2d-standard-2', { scheduling: { provisioningModel: 'SPOT' } });
  const compute = fakeCompute({ types: { 'n2d-standard-2': { guestCpus: 2, memoryMb: 8192 } }, vms: { a: spot, b: spot, c: spot } });
  const group = (name, suspended) => ({ name, zone: 'europe-west2-b', backend: 'asg:mig-demo', suspended });
  const items = await describe({ compute }, { vms: [group('a', true), group('b', true), group('c', false)] });
  const base = { kind: 'gce', machineType: 'n2d-standard-2', family: 'n2d', vcpus: 2, memoryGb: 8, os: 'Linux', spot: true, zone: 'europe-west2-b' };
  assert.deepEqual(items, [{ ...base, count: 2, suspended: true }, { ...base, count: 1 }]);
  assert.equal(compute.calls.types.length, 1);
});

test('a preemptible VM is Spot', async () => {
  const compute = fakeCompute({ types: { 'e2-medium': { guestCpus: 2, memoryMb: 4096 } }, vms: { a: vmOf('e2-medium', { scheduling: { preemptible: true } }) } });
  assert.equal((await describe({ compute }, { vms: [one('a')] }))[0].spot, true);
});

test('a windows-cloud license on the boot disk: windows', async () => {
  const windows = vmOf('n2-standard-2', { disks: [{ boot: false, licenses: [] }, { boot: true, licenses: [`${LICENSE}windows-server-2022-dc`] }] });
  const compute = fakeCompute({ types: { 'n2-standard-2': { guestCpus: 2, memoryMb: 8192 } }, vms: { a: windows } });
  assert.equal((await describe({ compute }, { vms: [one('a')] }))[0].os, 'Windows');
});

test('custom types: custom-2-4096 is n1, n2-custom-4-8192 is n2', async () => {
  const compute = fakeCompute({
    types: { 'custom-2-4096': { guestCpus: 2, memoryMb: 4096 }, 'n2-custom-4-8192': { guestCpus: 4, memoryMb: 8192 } },
    vms: { a: vmOf('custom-2-4096'), b: vmOf('n2-custom-4-8192') },
  });
  const items = await describe({ compute }, { vms: [one('a'), one('b')] });
  assert.deepEqual(items.map((i) => [i.family, i.vcpus, i.memoryGb]), [['n1', 2, 4], ['n2', 4, 8]]);
});

test('a refused getInstance: the backend is an unknown item with the reason, cut at 200 characters', async () => {
  const compute = fakeCompute({ vms: { a: new Error(`Google: GET: 403 ${'x'.repeat(300)}`) } });
  const [item] = await describe({ compute }, { vms: [{ name: 'a', zone: 'europe-west2-b', backend: 'asg:mig-demo', suspended: false }] });
  assert.equal(item.kind, 'unknown');
  assert.equal(item.backend, 'asg:mig-demo');
  assert.equal(item.reason.length, 200);
  assert.match(item.reason, /^Google: GET: 403/);
});

test('a machine type that cannot be read: the unknown item, the other VMs described', async () => {
  const compute = fakeCompute({ types: { 'e2-small': { guestCpus: 2, memoryMb: 2048 } }, vms: { a: vmOf('e2-small'), b: vmOf('m9-odd') } });
  const items = await describe({ compute }, { vms: [one('a'), one('b')] });
  assert.deepEqual(items.map((i) => i.kind === 'unknown' ? i.backend : i.kind), ['gce', 'instance:b']);
});

test('a GKE backend: its unknown item, GKE pods are not priced', async () => {
  const pods = { kind: 'k8s', cluster: { location: 'europe-west2', name: 'c1' }, namespace: 'app', owner: { kind: 'Deployment', name: 'web' } };
  const [item] = await describe({}, { pods: [pods] });
  assert.equal(item.kind, 'unknown');
  assert.equal(item.backend, 'k8s:europe-west2/c1/app/Deployment/web');
  assert.equal(item.reason, 'GKE pods are not priced');
});

const sql = (instance) => ({ cloudsql: { get: async (name) => { if (instance instanceof Error) throw instance; return { name, region: 'europe-west2', ...instance }; } } });

test('Cloud SQL db-custom-2-7680 POSTGRES_15 REGIONAL', async () => {
  const items = await describe(sql({ databaseVersion: 'POSTGRES_15', settings: { tier: 'db-custom-2-7680', edition: 'ENTERPRISE', availabilityType: 'REGIONAL' } }), { companions: ['db'] });
  assert.deepEqual(items, [{ kind: 'cloudsql', tier: 'db-custom-2-7680', engine: 'postgres', edition: 'enterprise', ha: true, region: 'europe-west2', vcpus: 2, memoryGb: 7.5 }]);
});

test('Cloud SQL db-f1-micro MYSQL_8_0: no vcpus and no memory', async () => {
  const [item] = await describe(sql({ databaseVersion: 'MYSQL_8_0', settings: { tier: 'db-f1-micro', availabilityType: 'ZONAL' } }), { companions: ['db'] });
  assert.deepEqual(item, { kind: 'cloudsql', tier: 'db-f1-micro', engine: 'mysql', edition: 'enterprise', ha: false, region: 'europe-west2' });
});

test('Cloud SQL db-perf-optimized-N-4 ENTERPRISE_PLUS: 4 vCPUs, 32 GiB', async () => {
  const [item] = await describe(sql({ databaseVersion: 'SQLSERVER_2019_STANDARD', settings: { tier: 'db-perf-optimized-N-4', edition: 'ENTERPRISE_PLUS' } }), { companions: ['db'] });
  assert.deepEqual([item.engine, item.edition, item.vcpus, item.memoryGb], ['sqlserver', 'enterprise-plus', 4, 32]);
});

test('a Cloud SQL instance gone (404): no item; unreadable otherwise: its unknown item', async () => {
  assert.deepEqual(await describe(sql(Object.assign(new Error('gone'), { code: 404 })), { companions: ['db'] }), []);
  const [item] = await describe(sql(Object.assign(new Error('Google: GET: 503 down'), { code: 503 })), { companions: ['db'] });
  assert.deepEqual(item, { kind: 'unknown', backend: 'cloudsql-instance:db', reason: 'Google: GET: 503 down' });
});

test('60 VMs of 60 types: 50 items', async () => {
  const names = Array.from({ length: 60 }, (_, i) => `vm-${i}`);
  const types = Object.fromEntries(names.map((n, i) => [`n2-custom-${i + 1}-1024`, { guestCpus: i + 1, memoryMb: 1024 }]));
  const vms = Object.fromEntries(names.map((n, i) => [n, vmOf(`n2-custom-${i + 1}-1024`)]));
  const items = await describe({ compute: fakeCompute({ types, vms }) }, { vms: names.map((n) => one(n)) });
  assert.equal(items.length, 50);
});

test('a Google error: the reason starts with its status and message, the URL left out, cut at 200 characters', async () => {
  const url = `https://compute.googleapis.com/compute/v1/projects/p/zones/europe-west2-b/instances/${'long'.repeat(40)}`;
  const refused = new GoogleError(`Google: GET ${url}: 403 The caller does not have permission ${'x'.repeat(300)}`, { code: 403, status: 'PERMISSION_DENIED' });
  const [item] = await describe({ compute: fakeCompute({ vms: { a: refused } }) }, { vms: [one('a')] });
  assert.equal(item.reason.length, 200);
  assert.match(item.reason, /^403 PERMISSION_DENIED: The caller does not have permission x/);
  assert.doesNotMatch(item.reason, /https:/);
});

test('a Cloud SQL instance whose engine or tier is unreadable: its unknown item', async () => {
  const [odd] = await describe(sql({ databaseVersion: 'ORACLE_19', settings: { tier: 'db-custom-2-7680' } }), { companions: ['db'] });
  assert.deepEqual(odd, { kind: 'unknown', backend: 'cloudsql-instance:db', reason: 'its engine or tier is not readable (ORACLE_19, db-custom-2-7680)' });
  const [bare] = await describe(sql({ databaseVersion: 'POSTGRES_15', settings: {} }), { companions: ['db'] });
  assert.equal(bare.reason, 'its engine or tier is not readable (POSTGRES_15, no tier)');
});

test('every unknown item of a read that failed is one warn line; the GKE ones are not failures', async () => {
  const warned = [];
  const compute = fakeCompute({ vms: { a: new Error('refused') } });
  const pods = { kind: 'k8s', cluster: { location: 'europe-west2', name: 'c1' }, namespace: 'app', owner: { kind: 'Deployment', name: 'web' } };
  await describe({ compute, log: { ...log, warn: (event, fields) => warned.push([event, fields]) } }, { vms: [one('a')], pods: [pods], companions: [] });
  assert.deepEqual(warned, [['StoppedItemUnread', { backend: 'instance:a', reason: 'refused' }]]);
});

test('the VMs are read 10 at a time, and the Cloud SQL instances meanwhile', async () => {
  let open = 0;
  let peak = 0;
  let databaseAsked = false;
  const compute = {
    getInstance: async () => {
      open += 1;
      peak = Math.max(peak, open);
      await new Promise((resolve) => { setTimeout(resolve, 5); });
      open -= 1;
      return vmOf('e2-small');
    },
    getMachineType: async () => ({ guestCpus: 2, memoryMb: 2048 }),
  };
  const cloudsql = { get: async (name) => { databaseAsked = open > 0; return { name, region: 'r', databaseVersion: 'MYSQL_8_0', settings: { tier: 'db-f1-micro' } }; } };
  const names = Array.from({ length: 35 }, (_, i) => `vm-${i}`);
  const items = await describe({ compute, cloudsql }, { vms: names.map((n) => one(n)), companions: ['db'] });
  assert.equal(peak, 10);
  assert.equal(databaseAsked, true);
  assert.deepEqual(items.map((i) => i.kind), ['gce', 'cloudsql']);
  assert.equal(items[0].count, 35);
});
