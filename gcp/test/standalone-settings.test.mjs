// Standalone workloads on Google Cloud, their settings and record (vision standalone workloads design §4, §5; plan 5, R28): the
// idle keys at every level, idleMetric's Google Cloud shape ({ type, filter, aligner, below }) and its refusals, the kind's refusals,
// the type databases' built-in on Cloud SQL, settings.json read with the idle signals; an HTTP workload's settings as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STANDALONE_KEYS, defaultsProblems } from '../../lambda/src/lib/settings-levels.mjs';
import { effectiveOf, inheritsOf, levelProblems } from '../src/levels.mjs';
import { organizationOf } from '../src/organization.mjs';
import { resourceOf } from '../src/resources.mjs';
import { createFirestoreStore } from '../src/firestore.mjs';
import { fakeFirestore } from './firestore-fake.mjs';

const VM = 'projects/p/zones/europe-west1-b/instances/batch';
const MIG = 'projects/p/regions/europe-west1/instanceGroupManagers/workers';
const SQL = 'projects/p/instances/orders';
const standalone = (overrides = {}) => ({
  workloadId: 'batch', kind: 'standalone', resource: VM, name: 'Batch', tags: {}, backends: [{ kind: 'vm', location: 'europe-west1-b', name: 'batch' }], inherits: STANDALONE_KEYS, ...overrides,
});
const metric = (overrides = {}) => ({ type: 'custom.googleapis.com/queue/depth', filter: 'resource.labels.instance_id = "${resource}"', aligner: 'ALIGN_MAX', below: 1, ...overrides });
const connections = (filter) => ({ type: 'cloudsql.googleapis.com/database/network/connections', filter, aligner: 'ALIGN_MAX', below: 1 });
const sqlFilter = (name) => `resource.type = "cloudsql_database" AND resource.labels.database_id = ends_with(":${name}")`;

test('a resource\'s path: a VM, a managed instance group (zonal or regional), a Cloud SQL instance; anything else none', () => {
  assert.deepEqual(resourceOf(VM), { kind: 'vm', project: 'p', location: 'europe-west1-b', name: 'batch' });
  assert.deepEqual(resourceOf(MIG), { kind: 'mig', project: 'p', location: 'europe-west1', name: 'workers' });
  assert.deepEqual(resourceOf('projects/p/zones/europe-west1-b/instanceGroupManagers/workers'), { kind: 'mig', project: 'p', location: 'europe-west1-b', name: 'workers' });
  assert.deepEqual(resourceOf(SQL), { kind: 'cloudsql', project: 'p', name: 'orders' });
  for (const other of ['projects/p/global/backendServices/web', 'instances/batch', '', null, 'arn:aws:ec2:eu-west-1:1:instance/i-0']) assert.equal(resourceOf(other), null, String(other));
});

test('a standalone workload resolves its keys through the levels, idleMetric in Google Cloud\'s shape; no waker key, none fixed', () => {
  const organization = { defaults: { idleMinutes: 240, waitSeconds: 30 }, types: [{ name: 'nightly', tags: { team: 'data' }, settings: { idleNetworkBytes: 5000 } }] };
  const got = effectiveOf(standalone({ tags: { team: 'data' }, idleMetric: metric(), inherits: ['idleMinutes', 'wakeTimeoutSeconds', 'idleCpuPercent', 'idleNetworkBytes'] }), {
    router: { defaults: { idleCpuPercent: 'off' } }, organization,
  });
  assert.deepEqual(got.settingsFrom, { idleMinutes: 'organization', wakeTimeoutSeconds: 'default', idleCpuPercent: 'router', idleNetworkBytes: 'type', idleMetric: 'workload' });
  assert.deepEqual([got.idleMinutes, got.idleCpuPercent, got.idleNetworkBytes, got.idleMetric, got.wakeTimeoutSeconds], [240, 'off', 5000, metric(), 600]);
  for (const key of ['waitSeconds', 'drainSeconds', 'maxHolders', 'failedRetrySeconds', 'wakeMode']) assert.equal(key in got, false, key);
  assert.deepEqual(inheritsOf(standalone()), STANDALONE_KEYS);
});

test('the type databases on Google Cloud: a Cloud SQL resource has CPU off and its connections under 1; a VM with companions keeps CPU and reads each', () => {
  const sql = effectiveOf(standalone({ resource: SQL, backends: [{ kind: 'cloudsql', name: 'orders' }] }));
  assert.deepEqual(sql.type, { name: 'databases', from: 'backends' });
  assert.deepEqual([sql.idleCpuPercent, sql.idleMetric], ['off', connections(sqlFilter('orders'))]);
  // The wake timeout: the type's 1800 s, held to Google Cloud's 1700 s, as an HTTP workload's.
  assert.deepEqual([sql.wakeTimeoutSeconds, sql.settingsFrom.wakeTimeoutSeconds], [1700, 'fixed']);
  const one = effectiveOf(standalone({ backends: [{ kind: 'vm', location: 'europe-west1-b', name: 'batch' }, { kind: 'cloudsql', name: 'orders' }] }));
  assert.deepEqual([one.idleCpuPercent, one.idleMetric], [5, connections(sqlFilter('orders'))]);
  const two = effectiveOf(standalone({ backends: [{ kind: 'vm', location: 'europe-west1-b', name: 'batch' }, { kind: 'cloudsql', name: 'orders' }, { kind: 'cloudsql', name: 'ledger' }] }));
  assert.deepEqual(two.idleMetric, { ...connections(null), filter: [sqlFilter('orders'), sqlFilter('ledger')] });
  // No database: the built-ins.
  assert.deepEqual([effectiveOf(standalone()).idleCpuPercent, effectiveOf(standalone()).idleMetric], [5, 'off']);
});

// The checks of each level on Google Cloud: a type, the router and the organization may hold both kinds' keys; a workload its kind's.
const LEVELS = {
  workload: (settings) => levelProblems(settings, { level: 'workload', cfg: standalone() }),
  router: (settings) => levelProblems(settings, { level: 'router' }),
  organization: (settings) => (organizationOf({ settings: { workloads: { defaults: settings } }, at: 1 }).error ?? null),
  type: (settings) => (organizationOf({ settings: { workloads: { types: [{ name: 'nightly', tags: { team: 'x' }, settings }] } }, at: 1 }).error ?? null),
};

for (const [level, problems] of Object.entries(LEVELS)) {
  test(`each idle key's range, off and idleMetric's Google Cloud shape at the ${level} level`, () => {
    const none = level === 'workload' || level === 'router' ? [] : null;
    for (const ok of [{ idleCpuPercent: 2.5 }, { idleCpuPercent: 'off' }, { idleNetworkBytes: 10_000_000_000 }, { idleNetworkBytes: 'off' }, { idleMetric: 'off' }, { idleMetric: metric() },
      { idleMetric: metric({ filter: undefined, aligner: 'ALIGN_SUM', below: 0.5 }) }, { idleMinutes: 1440 }]) {
      const settings = JSON.parse(JSON.stringify(ok));
      assert.deepEqual(problems(settings), none, JSON.stringify(ok));
    }
    const said = (text) => (level === 'workload' || level === 'router' ? [text]
      : `settings.json: ${level === 'organization' ? 'workloads.defaults' : 'workloads.types: type nightly: settings'}: ${text}`);
    const refused = [
      [{ idleCpuPercent: 101 }, 'idleCpuPercent: must be a number from 0 to 100, or off'],
      [{ idleNetworkBytes: 1.5 }, 'idleNetworkBytes: must be a whole number from 0 to 10000000000, or off'],
      [{ idleMetric: 'on' }, 'idleMetric: must be off or a metric { type, filter, aligner, below }'],
      [{ idleMetric: metric({ type: '' }) }, 'idleMetric: type must be a Cloud Monitoring metric type of at most 512 characters, such as custom.googleapis.com/queue/depth'],
      [{ idleMetric: metric({ filter: '' }) }, 'idleMetric: filter must be text of 1 to 2048 characters'],
      [{ idleMetric: metric({ filter: 'resource.labels.zone = "${zone}"' }) }, 'idleMetric: filter: only ${resource} is replaced'],
      [{ idleMetric: metric({ aligner: 'ALIGN_RATE' }) }, 'idleMetric: aligner must be ALIGN_MAX, ALIGN_MEAN or ALIGN_SUM'],
      [{ idleMetric: metric({ below: '1' }) }, 'idleMetric: below must be a number'],
      [{ idleMetric: metric({ unit: '1' }) }, 'idleMetric: unknown field unit'],
    ];
    for (const [settings, text] of refused) assert.deepEqual(problems(settings), said(text), JSON.stringify(settings));
  });
}

test('the organization\'s settings.json on Google Cloud: the idle signals kept, an AWS-shaped idleMetric ignored (another cloud\'s)', () => {
  const settings = { workloads: { defaults: { idleCpuPercent: 'off', idleMetric: { namespace: 'AWS/RDS', name: 'DatabaseConnections', dimensions: {}, statistic: 'Maximum', below: 1 } }, types: [{ name: 'nightly', tags: { team: 'x' }, settings: { idleMinutes: 240, idleMetric: metric() } }] } };
  const { level, error } = organizationOf({ settings, at: 1 });
  assert.equal(error, null);
  assert.deepEqual(level.defaults, { idleCpuPercent: 'off' });
  assert.deepEqual(level.types, [{ name: 'nightly', tags: { team: 'x' }, settings: { idleMinutes: 240, idleMetric: metric() } }]);
});

test('a standalone workload refuses the waker\'s keys with AWS\'s text, an HTTP one the idle signals', () => {
  for (const key of ['waitSeconds', 'drainSeconds', 'maxHolders', 'failedRetrySeconds', 'wakeMode', 'noWakeRules', 'wakeRules']) {
    assert.deepEqual(levelProblems({ [key]: null }, { level: 'workload', cfg: standalone() }), [`${key}: a standalone workload has no waker: ${key} is for an HTTP workload`], key);
  }
  assert.deepEqual(levelProblems({ wakeTimeoutSeconds: 1701 }, { level: 'workload', cfg: standalone() }), ['wakeTimeoutSeconds: must be a whole number from 60 to 1700']);
  for (const key of ['idleCpuPercent', 'idleNetworkBytes', 'idleMetric']) {
    assert.deepEqual(levelProblems({ [key]: 'off' }, { level: 'workload', cfg: { lb: { kind: 'regional', region: 'europe-west1' } } }),
      [`${key}: an HTTP workload naps on its requests: the idle signals are for a standalone workload`], key);
  }
  // Without Google Cloud's option, the shared check keeps AWS's shape.
  assert.deepEqual(defaultsProblems({ idleMetric: metric() }, { idle: true }), ['idleMetric: unknown field type', 'idleMetric: unknown field filter', 'idleMetric: unknown field aligner',
    'idleMetric: namespace must be text of 1 to 255 characters', 'idleMetric: name must be text of 1 to 255 characters',
    'idleMetric: dimensions must be an object of at most 30 names, each with text of 1 to 1024 characters', 'idleMetric: statistic must be Maximum, Average or Sum']);
});

test('an HTTP workload resolves exactly as before on Google Cloud, whatever idle signals its levels hold', () => {
  const cfg = { workloadId: 'shop', backends: [{ kind: 'vm', location: 'europe-west1-b', name: 'web' }, { kind: 'cloudsql', name: 'orders' }], lb: { kind: 'regional', region: 'europe-west1' }, inherits: ['idleMinutes'] };
  const levels = (idle) => ({
    router: { defaults: { idleMinutes: 30, ...(idle ? { idleCpuPercent: 'off' } : {}) } },
    organization: organizationOf({ settings: { workloads: { defaults: { drainSeconds: 0, ...(idle ? { idleNetworkBytes: 10, idleMetric: metric() } : {}) } } }, at: 1 }).level,
  });
  assert.equal(JSON.stringify(effectiveOf(cfg, levels(true))), JSON.stringify(effectiveOf(cfg, levels(false))));
});

test('the record\'s kind and resource are kept by the Firestore store', async () => {
  const firestore = fakeFirestore();
  const store = createFirestoreStore({ google: { request: firestore.request }, project: 'p', database: 'dmtr-europe-west1', now: () => 1, after: () => null, cancel: () => {} });
  const cfg = standalone();
  await store.putConfig('batch', cfg);
  assert.deepEqual(await store.getConfig('batch'), cfg);
  assert.deepEqual((await store.listConfigs()).map((c) => [c.kind, c.resource]), [['standalone', VM]]);
});
