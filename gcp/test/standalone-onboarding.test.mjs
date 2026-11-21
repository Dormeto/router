// Onboarding by resource on Google Cloud (vision standalone workloads design §2, §5; plan 5, R31): the dry run, the onboarding and the
// offboarding of a VM, a managed instance group or a Cloud SQL instance, through the REST route (the CLI's) and the action (the
// manager's); the eligibility reasons; a resource in one workload on both paths; the row, the status and the REST Workload; the refusals.
// No URL map, backend service, forwarding rule or proxy call, read or written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { STANDALONE_KEYS } from '../../lambda/src/lib/settings-levels.mjs';
import { STATES } from '../../lambda/src/lib/state.mjs';
import { createActions } from '../src/actions.mjs';
import * as cloudsqlAdapter from '../src/cloudsql.mjs';
import * as computeAdapter from '../src/compute.mjs';
import { createControllerApi } from '../src/controller.mjs';
import { INPUT, ZONE, setup } from './world.mjs';

const request = (method, url, body = '') => {
  const stream = (async function* chunks() { if (body) yield Buffer.from(body); }());
  return Object.assign(stream, { method, url, headers: {} });
};
const VM = `projects/p/zones/${ZONE}/instances/batch`;
const MIG = `projects/p/zones/${ZONE}/instanceGroupManagers/workers`;
const SQL = 'projects/p/instances/orders';
// What a standalone workload's path must never call: the route's and the load balancer's.
const ROUTE_CALLS = /^(urlmaps|regionalUrlmaps)\.|^compute\.(get|insert|delete|getRegion|insertRegion|deleteRegion)BackendService|^compute\.(get|getRegion)BackendServiceHealth|^compute\.list.*(ForwardingRules|Proxies)|^compute\.(getZonalNetworkEndpointGroup|listNetworkEndpoints|listGroupInstances)$/;

function world(change = () => {}) {
  const t = setup((w) => {
    w.vms.batch = { id: '2001', status: 'RUNNING' };
    w.vms['workers-1'] = { id: '2002', status: 'RUNNING' };
    w.managed.workers = { kind: 'zonal', location: ZONE, members: ['workers-1'] };
    w.sql.orders = {};
    w.sql.side = {};
    change(w);
  });
  const { store, core, onboarding, config, clock, log } = t;
  Object.assign(config, { version: '0.42.0', build: 'b7' });
  Object.assign(store, {
    manager: null,
    getManagerSettings: async () => structuredClone(store.manager),
    getStats: async (id, days) => ({ days, since: '2023-11-08', today: { ignored: {}, deferred: {}, wakes: {} }, total: { ignored: { bot: 2 }, deferred: {}, wakes: { manager: 1 } } }),
  });
  const router = { name: `dmtr-${config.region}`, version: config.version, build: config.build, project: config.project, region: config.region };
  const actions = createActions({ controller: core, onboarding, store, router, now: clock.now, log });
  const handler = createControllerApi({ core, onboarding, config, actions });
  const call = async (method, path, body) => {
    const res = await handler(request(method, path, body === undefined ? '' : JSON.stringify(body)));
    return { status: res.statusCode, body: JSON.parse(res.body) };
  };
  const routeCalls = () => [...t.w.used].filter((c) => ROUTE_CALLS.test(c));
  return { ...t, call, act: (payload) => call('POST', '/v1/actions', payload), routeCalls };
}

const KINDS = {
  vm: { resource: VM, backend: { kind: 'vm', location: ZONE, name: 'batch', id: '2001' }, entry: { kind: 'instance', id: 'batch', tagged: null, location: ZONE } },
  mig: { resource: MIG, backend: { kind: 'mig', location: ZONE, name: 'workers' }, entry: { kind: 'asg', id: 'workers', tagged: null, location: ZONE } },
  cloudsql: { resource: SQL, backend: { kind: 'cloudsql', name: 'orders' }, entry: { kind: 'cloudsql-instance', id: 'orders', tagged: null } },
};

for (const [kind, { resource, backend, entry }] of Object.entries(KINDS)) {
  test(`a standalone ${kind}: dry run, onboarding (its record and run) and offboarding, on the REST route and the action, with no route call`, async () => {
    const t = world();
    const dry = await t.call('POST', '/v1/workloads?dryRun=true', { resource, id: 'batch', settings: { idleCpuPercent: 'off' } });
    assert.deepEqual([dry.status, dry.body.eligible, dry.body.reasons], [200, true, []]);
    assert.deepEqual(dry.body.backend, backend);
    const preview = (await t.act({ action: 'preview', resource, workloadId: 'batch' })).body;
    assert.deepEqual([preview.ok, preview.problems, preview.workloadId, preview.kind, preview.resource, preview.backend], [true, [], 'batch', 'standalone', resource, entry]);
    const onboarded = await t.call('POST', '/v1/workloads', { resource, id: 'batch', name: 'Batch', tags: { team: 'data' }, settings: { idleCpuPercent: 'off', hibernate: false }, ...(kind === 'vm' ? { cloudSql: ['side'] } : {}) });
    assert.equal(onboarded.status, 200);
    const cfg = t.store.configs.get('batch');
    assert.deepEqual({ ...cfg, onboardedAt: undefined }, {
      workloadId: 'batch', kind: 'standalone', resource, name: 'Batch', tags: { team: 'data' },
      backends: [backend, ...(kind === 'vm' ? [{ kind: 'cloudsql', name: 'side' }] : [])],
      idleCpuPercent: 'off', hibernate: false, inherits: STANDALONE_KEYS.filter((k) => k !== 'idleCpuPercent'), source: 'cli', onboardedAt: undefined,
    });
    for (const key of ['urlMap', 'backendService', 'wakerBackendService', 'lb', 'hosts', 'noWakeRules', 'wakeRules', 'waitSeconds']) assert.equal(key in cfg, false, key);
    assert.equal(t.store.runs.get('batch').state, STATES.AWAKE);
    const off = await t.call('DELETE', '/v1/workloads/batch');
    assert.equal(off.status, 200);
    assert.equal(t.store.configs.has('batch'), false);
    // The manager's action, once more.
    const done = (await t.act({ action: 'onboard', resource, workloadId: 'batch', by: 'ana' })).body;
    assert.deepEqual([done.steps.map((s) => s.name), done.workload.workloadId, done.workload.kind], [['workload configuration'], 'batch', 'standalone']);
    assert.deepEqual((await t.act({ action: 'offboard', workloadId: 'batch' })).body.steps.map((s) => [s.name, s.status]), [['wake', 'skipped'], ['restore autoscalers', 'skipped'], ['workload configuration', 'done']]);
    assert.deepEqual(t.routeCalls(), []);
  });
}

test('each eligibility reason, in plain words', async () => {
  const cases = [
    ['not a path', 'batch', (w) => w, 'the resource must be the path of a Compute Engine VM (projects/<project>/zones/<zone>/instances/<name>), a managed instance group (projects/<project>/zones|regions/<location>/instanceGroupManagers/<name>) or a Cloud SQL instance (projects/<project>/instances/<name>)'],
    ['another project', 'projects/q/instances/orders', (w) => w, 'the resource is in project q: this router serves project p'],
    ['a VM gone', `projects/p/zones/${ZONE}/instances/gone`, (w) => w, `VM gone not found in zone ${ZONE}`],
    ['a VM of a group', VM, (w) => { w.vms.batch.metadata = { items: [{ key: 'created-by', value: `projects/1/zones/${ZONE}/instanceGroupManagers/workers` }] }; }, 'VM batch is a member of managed group workers: onboard the group (it would repair a stopped VM)'],
    ['a GKE node', VM, (w) => { w.vms.batch.labels = { 'goog-gke-node': '' }; }, 'VM batch is a GKE node: onboard the Kubernetes workloads that run on it'],
    ['a GPU', VM, (w) => { w.vms.batch.guestAccelerators = [{ acceleratorCount: 1 }]; }, 'VM batch has a GPU: GPU VMs are not supported'],
    ['a local SSD', VM, (w) => { w.vms.batch.disks = [{ type: 'SCRATCH' }]; }, 'VM batch has a local SSD: a stop would lose its data'],
    ['a group gone', `projects/p/zones/${ZONE}/instanceGroupManagers/gone`, (w) => w, `managed group gone not found in ${ZONE}`],
    ['a group of GKE nodes', MIG, (w) => { w.vms['workers-1'].labels = { 'goog-gke-node': '' }; }, 'managed group workers holds GKE nodes: onboard the Kubernetes workloads that run on them'],
    ['a stateful group', MIG, (w) => { w.managed.workers.status = { stateful: { hasStatefulConfig: true } }; }, 'managed group workers has a stateful configuration: a nap might not keep it'],
    ['a Cloud SQL replica', SQL, (w) => { w.sql.orders.masterInstanceName = 'p:main'; }, 'Cloud SQL instance orders is a read replica: Google cannot stop one'],
    ['a Cloud SQL instance gone', 'projects/p/instances/gone', (w) => w, 'Cloud SQL instance gone not found: name an instance of this project'],
  ];
  for (const [what, resource, change, text] of cases) {
    const t = world(change);
    const dry = (await t.call('POST', '/v1/workloads?dryRun=true', { resource, id: 'batch' })).body;
    assert.deepEqual([dry.eligible, dry.reasons], [false, [text]], what);
  }
});

test('a resource is in one workload: an HTTP workload\'s backend, another standalone workload\'s resource or companion, one onboarded already; the HTTP onboarding names a standalone one', async () => {
  const t = world((w) => { w.vms['vm-a'].status = 'RUNNING'; });
  await t.call('POST', '/v1/workloads', INPUT);
  assert.deepEqual((await t.call('POST', '/v1/workloads?dryRun=true', { resource: `projects/p/zones/${ZONE}/instances/vm-a`, id: 'other' })).body.reasons, ['VM vm-a belongs to workload demo']);
  await t.call('POST', '/v1/workloads', { resource: VM, id: 'batch', name: 'Batch', cloudSql: ['side'] });
  assert.deepEqual((await t.call('POST', '/v1/workloads?dryRun=true', { resource: VM, id: 'again' })).body.reasons, ['VM batch is already onboarded: workload Batch (batch)']);
  assert.deepEqual((await t.call('POST', '/v1/workloads?dryRun=true', { resource: 'projects/p/instances/side', id: 'side' })).body.reasons, ['Cloud SQL instance side is a companion of workload Batch (batch)']);
  const sameId = await t.call('POST', '/v1/workloads', { resource: MIG, id: 'batch' });
  assert.deepEqual([sameId.status, sameId.body.error], [409, 'workload batch is onboarded already']);
  // The HTTP onboarding of a service whose VM is the standalone workload's.
  const h = world((w) => { w.unmanaged.ig = ['batch']; });
  await h.call('POST', '/v1/workloads', { resource: VM, id: 'batch', name: 'Batch' });
  const refused = (await h.call('POST', '/v1/workloads?dryRun=true', INPUT)).body.reasons;
  assert.ok(refused.includes('VM batch is the standalone workload Batch (batch): offboard it first'), refused.join('; '));
});

test('offboarding: an asleep workload is woken first; one whose resource is deleted is offboarded in any state', async () => {
  const t = world();
  await t.call('POST', '/v1/workloads', { resource: VM, id: 'batch', cloudSql: ['side'] });
  Object.assign(t.store.runs.get('batch'), { state: STATES.ASLEEP });
  t.w.vms.batch.status = 'TERMINATED';
  const off = (await t.act({ action: 'offboard', workloadId: 'batch' })).body;
  assert.deepEqual(off.steps.map((s) => [s.name, s.status]), [['wake', 'done'], ['restore autoscalers', 'skipped'], ['workload configuration', 'done']]);
  assert.equal(t.w.vms.batch.status, 'RUNNING');
  const gone = world();
  await gone.call('POST', '/v1/workloads', { resource: VM, id: 'batch' });
  delete gone.w.vms.batch;
  Object.assign(gone.store.runs.get('batch'), { state: STATES.FAILED, resourceMissing: true });
  const removed = await gone.call('DELETE', '/v1/workloads/batch');
  assert.equal(removed.status, 200);
  assert.equal(gone.store.configs.has('batch'), false);
  assert.deepEqual([t.routeCalls(), gone.routeCalls()], [[], []]);
});

const ROW_KEYS = ['workloadId', 'name', 'kind', 'resource', 'source', 'tags', 'state', 'stateAt', 'wakeCount', 'awakeSince', 'wakeStartedAt', 'failedAt', 'failure',
  'consecutiveFailures', 'nextAttemptAt', 'updatedAt', 'pendingWake', 'backends', 'pauses', 'stats7d', 'type', 'settingsFrom', 'settings'];
const STATUS_KEYS = ['workloadId', 'name', 'kind', 'resource', 'router', 'source', 'tags', 'state', 'stateAt', 'drift', 'updatedAt', 'awakeSince', 'wakeStartedAt', 'failedAt',
  'failure', 'consecutiveFailures', 'nextAttemptAt', 'fallbacks', 'wakeCount', 'pendingWake', 'pauses', 'idle', 'nap', 'discovery', 'instances', 'hibernation', 'backends',
  'ignoredTargets', 'recommendations', 'settings', 'settingsFrom', 'type', 'stats'];
const WORKLOAD_KEYS = ['workloadId', 'id', 'name', 'tags', 'state', 'kind', 'resource', 'settings', 'settingsFrom', 'type', 'hibernation', 'backends', 'awakeSince', 'pauses'];

test('the row, the status and the REST Workload of a standalone workload: AWS\'s keys, resource for resourceArn, nothing of a route', async () => {
  const t = world();
  await t.call('POST', '/v1/workloads', { resource: VM, id: 'batch', name: 'Batch' });
  const { workloads: [row] } = (await t.act({ action: 'list' })).body;
  assert.deepEqual(Object.keys(row), ROW_KEYS);
  assert.deepEqual([row.kind, row.resource, row.backends, row.stats7d], ['standalone', VM, ['instance'], { wakes: 1 }]);
  assert.deepEqual(Object.keys(row.settings), STANDALONE_KEYS);
  const shownStatus = (await t.act({ action: 'status', workloadId: 'batch' })).body;
  assert.deepEqual(Object.keys(shownStatus).slice(0, STATUS_KEYS.length), STATUS_KEYS);
  assert.deepEqual(Object.keys(shownStatus).slice(STATUS_KEYS.length), ['schedule', 'next', 'maintenanceDue', 'joinMinutes', 'joinFrom', 'joinInherited']);
  assert.deepEqual(shownStatus.idle.map((s) => [s.signal, s.applies, s.from]), [['cpu', true, 'default'], ['network', false, 'default'], ['metric', false, 'default']]);
  assert.deepEqual(Object.keys(shownStatus.stats.total), ['wakes']);
  const shown = (await t.call('GET', '/v1/workloads/batch')).body;
  assert.deepEqual(Object.keys(shown), WORKLOAD_KEYS);
  assert.deepEqual([shown.kind, shown.resource], ['standalone', VM]);
  // While its resource is gone: said after backends.
  t.store.runs.get('batch').resourceMissing = true;
  const missing = (await t.act({ action: 'list' })).body.workloads[0];
  assert.deepEqual(Object.keys(missing).slice(Object.keys(missing).indexOf('backends'), Object.keys(missing).indexOf('backends') + 2), ['backends', 'resourceMissing']);
  assert.equal((await t.call('GET', '/v1/workloads/batch')).body.resourceMissing, true);
  const status = (await t.act({ action: 'status', workloadId: 'batch' })).body;
  assert.deepEqual(Object.keys(status).slice(Object.keys(status).indexOf('backends'), Object.keys(status).indexOf('backends') + 2), ['backends', 'resourceMissing']);
  assert.deepEqual(t.routeCalls(), []);
});

test('refused for a standalone workload: the waiting page, an exclusion by backend service, a nap window\'s wake; a waker setting', async () => {
  const t = world();
  await t.call('POST', '/v1/workloads', { resource: VM, id: 'batch' });
  const refusal = (message) => ({ refused: { code: 'unsupported', message } });
  assert.deepEqual((await t.act({ action: 'waiting-page', op: 'get', workloadId: 'batch', refusals: true })).body, refusal('workload batch is a standalone workload: it has no waiting page'));
  assert.deepEqual((await t.call('GET', '/v1/workloads/batch/waiting-page')).body, { error: 'workload batch is a standalone workload: it has no waiting page', reason: 'unsupported' });
  assert.deepEqual((await t.act({ action: 'pause', workloadId: 'batch', exclusionId: 'e1', backendService: 'app', by: 'ops', reason: 'x', refusals: true })).body,
    refusal('workload batch is a standalone workload: it has no backend service to exclude'));
  const schedule = { timeZone: 'UTC', windows: [{ kind: 'nap', days: ['sat'], start: '00:00', end: '23:00', wake: 'header' }] };
  assert.deepEqual((await t.act({ action: 'schedule', workloadId: 'batch', schedule, by: 'ana' })).body,
    { problems: ['windows[0].wake: a standalone workload has no waiting page: nothing arrives to wake it in a nap window'] });
  assert.deepEqual((await t.call('PUT', '/v1/workloads/batch/schedule', schedule)).body.problems, ['windows[0].wake: a standalone workload has no waiting page: nothing arrives to wake it in a nap window']);
  assert.deepEqual((await t.act({ action: 'settings', workloadId: 'batch', settings: { waitSeconds: 30 } })).body,
    { problems: ['settings: waitSeconds: a standalone workload has no waker: waitSeconds is for an HTTP workload'] });
});

test('the resource path\'s calls are each in the router\'s grants of access.json (its own roles and the feature cloud-sql)', async () => {
  const manifest = JSON.parse(await readFile(new URL('../access.json', import.meta.url), 'utf8'));
  const granted = new Set();
  const grants = [...manifest.router.map((g) => [g, manifest.roles]), ...Object.values(manifest.features).flatMap((f) => f.router.map((g) => [g, f.roles]))];
  for (const [{ role }, roles] of grants) {
    const custom = /\/roles\/(.+)$/.exec(role)?.[1];
    for (const p of custom ? roles[custom].permissions : manifest.predefined[role]) granted.add(p);
  }
  const t = world();
  for (const resource of [VM, MIG, SQL]) {
    await t.call('POST', '/v1/workloads?dryRun=true', { resource, id: 'x' });
    await t.call('POST', '/v1/workloads', { resource, id: 'x', ...(resource === VM ? { cloudSql: ['side'] } : {}) });
    await t.call('DELETE', '/v1/workloads/x');
  }
  const CALLS = { compute: computeAdapter.CALLS, cloudsql: cloudsqlAdapter.CALLS };
  const used = [...t.w.used].filter((c) => c.startsWith('compute.') || c.startsWith('cloudsql.'));
  assert.ok(used.includes('compute.getInstance') && used.includes('compute.listManagedInstances') && used.includes('cloudsql.get'), used.join());
  for (const c of used) {
    const [adapter, fn] = c.split('.');
    for (const p of CALLS[adapter][fn]) assert.ok(granted.has(p), `${c} needs ${p}`);
  }
});

// --- The R30 review's fix round 1, on the onboarding ---------------------------------------------------------------------------

test('R30 review, M5: a group sized 0 is onboarded, as AWS onboards a resource at its desired 0', async () => {
  const t = world((w) => { w.managed.workers.members = []; });
  assert.deepEqual((await t.call('POST', '/v1/workloads?dryRun=true', { resource: MIG, id: 'batch' })).body.reasons, []);
});

test('R30 review, M6: a Cloud SQL resource on a router that cannot read it is refused up front, in the HTTP path\'s words', async () => {
  const { GoogleError } = await import('../src/google.mjs');
  const t = world((w) => { w.fail['GET sql/instances/orders'] = new GoogleError('Google: 403 not authorized', { code: 403 }); });
  const dry = (await t.call('POST', '/v1/workloads?dryRun=true', { resource: SQL, id: 'batch' })).body;
  assert.deepEqual([dry.eligible, dry.reasons], [false, ['the router cannot read Cloud SQL instance orders: it does not exist, or the router was installed without --with cloud-sql: Google: 403 not authorized']]);
});

test('R30 review, M7: a settings write refused after it was decided leaves no idle hold to clear for the next write', async () => {
  const t = world();
  await t.call('POST', '/v1/workloads', { resource: VM, id: 'batch' });
  const hold = Date.UTC(2026, 10, 24);
  t.store.runs.get('batch').idleNotBefore = hold;
  const put = t.store.putConfig;
  t.store.putConfig = async () => false;
  await t.onboarding.setSettings('batch', { idleCpuPercent: 10, by: 'ana' }).catch(() => {});
  t.store.putConfig = put;
  await t.onboarding.setSettings('batch', { hibernate: false, by: 'ana' });
  assert.equal(t.store.runs.get('batch').idleNotBefore, hold);
});
