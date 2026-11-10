// What CLI 0.11.0 reads from the router's REST answers, asserted on the current router's (the review's rule 3: a released name keeps
// working one minor release). The lines are those of `git -C cli show v0.11.0:internal/gcponboard/<file>.go`:
//   gcp.go:216-222 (internal/gcp): an error is read as `{ "error": <text>, "reason": <code> }`: Message and Reason.
//   workloads.go:96-115: the Workload, `id`, `state`, `urlMap`, `backendService`, `wakerBackendService`, `hosts`, `settings`, `backends`,
//     `awakeSince` (a string), `lastWake.durationMs`, `failure`, `paused`, `lb`, `companionsGone`.
//   workloads.go:60-71: a backend, `kind` in vm, mig, cloudsql or k8s (:48, :89-90), `location`, `name`, `id` (a vm's, a group's numeric id:
//     a tag binding's parent), and a k8s one's `cluster`, `namespace`, `service`, `owner`.
//   workloads.go:117-153: the dry run, `eligible`, `reasons`, `vms` (Zone, Name, ID), `groups` (Kind, Location, Name, ID), `lb`, `databases`
//     (`name`, `replicas`), `gke` (`namespace`, `service`, `autopilot`).
//   workloads.go:429-446 (moves): nap and wake answer a Workload, read for `id` and `state`.
//   workloads.go:1164-1175 (backend.target), install.go:45 (regionPattern) and :60-71: a group's `location` is a zone or, of a regional group, a region (the CLI tells
//     them by shape) with its `id`: the path of the tag binding an offboarding removes.
//   workloads_schedule.go:314-321 (resumeWorkload): resume answers a Workload, read for `id` and `paused` (absent once resumed).
//   workloads.go:458-465: the onboarding request: `urlMap`, `backendService`, `id`, `settings`, `loadBalancer`, `cloudSql` (a list of names).
//   workloads.go:905-927: an offboarding that cannot wake the workload is the reason `wake-failed` (a 409, its `error` shown whole), and
//     with `?force=true` answers `left` (backends) and `notGivenBack`; workloads.go:1069-1072: a workload the router does not hold is a
//     404 with the reason `not-found` (any other 404 is not the controller's).
//   workloads.go:143-144 (lbRef): `lb.kind` and, of a regional workload, `lb.region`.
//   workloads_schedule.go:55-75 and :153-154: the schedule's answer, `schedule` (`timeZone`, `windows`, `exceptions`, `maxNapDays`, `by`, `at`)
//     and `nextEvents` (`at`, `kind`, `window`); internal/schedule/window.go:23-32 the windows' `kind`, `days`, `start`, `end`, and :239-242
//     the answer's `joinMinutes`, `joinFrom`, `joinInherited` (schedule.Join, embedded).
//   workloads_schedule.go:218-224: `paused` is `by`, `at`, `reason`, `until` (a string or null), `keepAsleep`.
//   workloads.go:350-356 and uninstall.go:40-41: the list's rows are Workloads (`id`, `state`, `backendService`, `paused`).
//   router.go:636-641: GET /v1/health answers `version`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATES } from '../../lambda/src/lib/state.mjs';
import { createActions } from '../src/actions.mjs';
import { createControllerApi } from '../src/controller.mjs';
import { CLUSTER, GKE_INPUT, INPUT, K8S_BACKEND, REGION, V1, ZONE, onGke, regional, setup } from './world.mjs';

const request = (method, url, body = '') => {
  const stream = (async function* chunks() { if (body) yield Buffer.from(body); }());
  return Object.assign(stream, { method, url, headers: {} });
};

function api(change) {
  const world = setup(change);
  const router = { name: `dmtr-${world.config.region}`, version: null, build: null, project: world.config.project, region: world.config.region };
  const actions = createActions({ controller: world.core, onboarding: world.onboarding, store: world.store, router, now: world.clock.now, log: world.log });
  const handler = createControllerApi({ core: world.core, onboarding: world.onboarding, config: world.config, actions });
  const call = async (method, path, body) => {
    const res = await handler(request(method, path, typeof body === 'object' ? JSON.stringify(body) : body));
    return { status: res.statusCode, body: JSON.parse(res.body) };
  };
  return { ...world, call };
}

const withMig = (w) => {
  w.managed.mig = { kind: 'zonal', location: ZONE, id: '2001', members: ['mig-1'] };
  w.vms['mig-1'] = { id: '3001', status: 'RUNNING' };
  w.services.app.backends = [{ group: `${V1}/zones/${ZONE}/instanceGroups/mig` }];
};
const withRegionalMig = (w) => {
  w.managed.mig = { kind: 'regional', location: REGION, id: '2002', members: ['mig-1'], updatePolicy: { instanceRedistributionType: 'NONE' } };
  w.vms['mig-1'] = { id: '3001', status: 'RUNNING', zone: ZONE };
  w.services.app.backends = [{ group: `${V1}/regions/${REGION}/instanceGroups/mig` }];
};
const withDatabase = (w) => { w.sql.db1 = {}; };

// The Workload as workloads.go:96-115 decodes it: each field's type, a missing one the zero value.
function assertWorkload(w, id) {
  assert.equal(typeof w.id, 'string');
  assert.equal(w.id, id);
  for (const key of ['state', 'urlMap', 'backendService', 'wakerBackendService']) assert.equal(typeof w[key], 'string', key);
  // A string while awake (the CLI prints it; a number would fail its decoding).
  if (w.state === STATES.AWAKE) assert.equal(typeof w.awakeSince, 'string');
  assert.ok(Object.values(STATES).includes(w.state));
  assert.ok(Array.isArray(w.hosts) && w.hosts.every((h) => typeof h === 'string'));
  assert.equal(typeof w.settings, 'object');
  assert.ok(w.settings !== null && !Array.isArray(w.settings));
  assert.ok(Array.isArray(w.backends));
  assert.equal(typeof w.lb.kind, 'string');
  assert.ok(w.paused === undefined || (typeof w.paused === 'object' && w.paused !== null));
  assert.ok(w.companionsGone === undefined || Array.isArray(w.companionsGone));
  assert.ok(w.lastWake === undefined || typeof w.lastWake.durationMs === 'number');
}

test('CLI 0.11.0: a VM workload, as GET, list and onboard answer it: id, state, the map, the services, the hosts, the settings, the backends', async () => {
  const { call } = api();
  const onboarded = await call('POST', '/v1/workloads', INPUT);
  assert.equal(onboarded.status, 200);
  assertWorkload(onboarded.body, 'demo');
  assert.deepEqual([onboarded.body.state, onboarded.body.urlMap, onboarded.body.backendService, onboarded.body.lb], [STATES.AWAKE, 'lb', 'app', { kind: 'global' }]);
  assert.deepEqual(onboarded.body.backends, [{ kind: 'vm', location: ZONE, name: 'vm-a', id: '1001' }]);
  const shown = await call('GET', '/v1/workloads/demo');
  assertWorkload(shown.body, 'demo');
  const listed = await call('GET', '/v1/workloads');
  assert.equal(listed.body.length, 1);
  assertWorkload(listed.body[0], 'demo');
  assert.equal(listed.body[0].backendService, 'app');
});

test('CLI 0.11.0: the backend kinds mig, k8s and cloudsql, each with the fields the offboarding untags by', async () => {
  const vm = api();
  assert.equal((await vm.call('POST', '/v1/workloads', INPUT)).body.backends[0].kind, 'vm');
  const group = api(withMig);
  const migWorkload = (await group.call('POST', '/v1/workloads', INPUT)).body;
  assertWorkload(migWorkload, 'demo');
  assert.deepEqual(migWorkload.backends, [{ kind: 'mig', location: ZONE, name: 'mig', id: '2001' }]);
  const pods = api(onGke);
  const k8s = (await pods.call('POST', '/v1/workloads', GKE_INPUT)).body;
  assertWorkload(k8s, 'demo');
  assert.deepEqual(k8s.backends, [K8S_BACKEND]);
  assert.deepEqual(Object.keys(k8s.backends[0].cluster), Object.keys(CLUSTER));
  const sql = api(withDatabase);
  const database = (await sql.call('POST', '/v1/workloads', { ...INPUT, cloudSql: ['db1'] })).body;
  assertWorkload(database, 'demo');
  assert.deepEqual(database.backends.filter((b) => b.kind === 'cloudsql'), [{ kind: 'cloudsql', name: 'db1' }]);
  // The released request's names: cloudSql, and the AWS names the router takes beside them read the same.
  const aws = api(withDatabase);
  assert.deepEqual((await aws.call('POST', '/v1/workloads', { ...INPUT, databases: ['db1'] })).body.backends, database.backends);
});

test('CLI 0.11.0: the dry run: eligible, reasons, vms, groups, lb, databases (name, replicas), gke', async () => {
  const world = api(withDatabase);
  const dry = (await world.call('POST', '/v1/workloads?dryRun=true', { ...INPUT, cloudSql: ['db1'] })).body;
  assert.equal(dry.eligible, true);
  assert.deepEqual(dry.reasons, []);
  assert.deepEqual(dry.vms.map(({ name, id }) => [typeof name, typeof id]), [['string', 'string']]);
  assert.ok(dry.vms.every((vmRef) => typeof vmRef.zone === 'string'));
  assert.ok(Array.isArray(dry.groups));
  assert.equal(typeof dry.lb.kind, 'string');
  assert.deepEqual(dry.databases.map((d) => d.name), ['db1']);
  const grouped = api(withMig);
  const groups = (await grouped.call('POST', '/v1/workloads?dryRun=true', INPUT)).body.groups;
  assert.deepEqual(groups.map((g) => [g.kind, g.location, g.name, g.id]), [['zonal', ZONE, 'mig', '2001']]);
  const pods = (await api(onGke).call('POST', '/v1/workloads?dryRun=true', GKE_INPUT)).body;
  assert.deepEqual([typeof pods.gke.namespace, typeof pods.gke.service, typeof pods.gke.autopilot], ['string', 'string', 'boolean']);
  const refused = (await api((w) => { delete w.urlMaps.lb; }).call('POST', '/v1/workloads?dryRun=true', INPUT)).body;
  assert.equal(refused.eligible, false);
  assert.ok(refused.reasons.length > 0 && refused.reasons.every((r) => typeof r === 'string'));
});

test('CLI 0.11.0: a paused workload answers paused with by, at, reason, until and keepAsleep', async () => {
  const { call, clock } = api();
  await call('POST', '/v1/workloads', INPUT);
  const until = new Date(clock.now() + 3_600_000).toISOString();
  const res = (await call('POST', '/v1/workloads/demo/pause', { reason: 'load test', by: 'ops', until })).body;
  assertWorkload(res, 'demo');
  for (const key of ['by', 'at', 'reason']) assert.equal(typeof res.paused[key], 'string', key);
  assert.deepEqual([res.paused.until, res.paused.keepAsleep], [until, false]);
  const open = (await call('POST', '/v1/workloads/demo/pause', { reason: 'again', by: 'ops' })).body;
  assert.ok(open.paused.until === null || typeof open.paused.until === 'string');
  assert.equal(typeof open.paused.keepAsleep, 'boolean');
});

test('CLI 0.11.0: the offboarding: wake-failed refused with its text whole, left and notGivenBack with force, not-found for a workload the router does not hold', async () => {
  const { call, w, store } = api();
  await call('POST', '/v1/workloads', INPUT);
  delete w.vms['vm-a'];
  store.runs.get('demo').state = STATES.ASLEEP;
  const refused = await call('DELETE', '/v1/workloads/demo');
  assert.deepEqual([refused.status, refused.body.reason, typeof refused.body.error], [409, 'wake-failed', 'string']);
  assert.match(refused.body.error, /--force/);
  const forced = await call('DELETE', '/v1/workloads/demo?force=true');
  assert.equal(forced.status, 200);
  assert.deepEqual(forced.body.left, [{ kind: 'vm', location: ZONE, name: 'vm-a', id: '1001' }]);
  assert.ok(forced.body.notGivenBack === undefined || Array.isArray(forced.body.notGivenBack));
  for (const [method, path] of [['GET', '/v1/workloads/demo'], ['DELETE', '/v1/workloads/demo'], ['DELETE', '/v1/workloads/demo?force=true']]) {
    const gone = await call(method, path);
    assert.deepEqual([gone.status, gone.body.reason], [404, 'not-found'], `${method} ${path}`);
    assert.equal(typeof gone.body.error, 'string');
  }
});

test('CLI 0.11.0: /v1/health answers the version, and a bad request is { error, reason } with a string reason', async () => {
  const { call } = api();
  assert.equal(typeof (await call('GET', '/v1/health')).body.version, 'string');
  const bad = await call('POST', '/v1/workloads', { ...INPUT, id: 'Bad_ID' });
  assert.deepEqual([bad.status, bad.body.reason, typeof bad.body.error], [400, 'bad-request', 'string']);
});

test('CLI 0.11.0: a regional workload names its region beside the kind of its load balancer', async () => {
  const { call } = api(regional);
  const dry = (await call('POST', '/v1/workloads?dryRun=true', { ...INPUT, loadBalancer: 'regional' })).body;
  assert.deepEqual(dry.lb, { kind: 'regional', region: REGION });
  const onboarded = await call('POST', '/v1/workloads', { ...INPUT, loadBalancer: 'regional' });
  assert.equal(onboarded.status, 200, JSON.stringify(onboarded.body));
  assert.deepEqual(onboarded.body.lb, { kind: 'regional', region: REGION });
  assert.deepEqual((await call('GET', '/v1/workloads/demo')).body.lb, { kind: 'regional', region: REGION });
});

test('CLI 0.11.0: the schedule put and get: schedule (timeZone, windows, exceptions, maxNapDays, by, at), nextEvents (at, kind, window) and the join fields', async () => {
  const { call } = api();
  await call('POST', '/v1/workloads', INPUT);
  const windows = [{ kind: 'nap', days: ['sat', 'sun'], start: '20:00', end: '08:00' }];
  const put = await call('PUT', '/v1/workloads/demo/schedule', { timeZone: 'Europe/Paris', windows, maxNapDays: 7, by: 'ann' });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  for (const answer of [put.body, (await call('GET', '/v1/workloads/demo/schedule')).body]) {
    const { schedule, nextEvents } = answer;
    assert.deepEqual([schedule.timeZone, schedule.maxNapDays, schedule.by], ['Europe/Paris', 7, 'ann']);
    assert.equal(typeof schedule.at, 'string');
    assert.deepEqual(schedule.windows.map(({ kind, days, start, end }) => ({ kind, days, start, end })), windows);
    assert.ok(schedule.exceptions === undefined || schedule.exceptions === null || Array.isArray(schedule.exceptions));
    assert.ok(nextEvents.length > 0);
    for (const event of nextEvents) {
      assert.equal(typeof event.at, 'string');
      assert.ok(['nap-start', 'nap-end', 'awake-start', 'awake-end'].includes(event.kind), event.kind);
      assert.equal(Number.isInteger(event.window), true);
    }
    assert.ok(Object.hasOwn(answer, 'joinMinutes'), 'joinMinutes');
  }
  assert.equal((await call('DELETE', '/v1/workloads/demo/schedule')).status, 200);
  assert.equal((await call('GET', '/v1/workloads/demo/schedule')).body.schedule, null);
});

test('CLI 0.11.0: nap and wake answer a Workload with its id and its state', async () => {
  const { call, store } = api();
  await call('POST', '/v1/workloads', INPUT);
  const nap = await call('POST', '/v1/workloads/demo/nap');
  assert.equal(nap.status, 200);
  assertWorkload(nap.body, 'demo');
  assert.equal(typeof nap.body.state, 'string');
  store.runs.get('demo').state = STATES.ASLEEP;
  const wake = await call('POST', '/v1/workloads/demo/wake');
  assert.equal(wake.status, 200);
  assertWorkload(wake.body, 'demo');
  assert.equal(wake.body.state, STATES.WAKING);
});

test('CLI 0.11.0: resume answers a Workload with its id, and paused only while a pause holds', async () => {
  const { call } = api();
  await call('POST', '/v1/workloads', INPUT);
  await call('POST', '/v1/workloads/demo/pause', { reason: 'load test', by: 'ops' });
  const resumed = await call('POST', '/v1/workloads/demo/resume', { by: 'ops' });
  assert.equal(resumed.status, 200);
  assertWorkload(resumed.body, 'demo');
  assert.equal(resumed.body.paused, undefined);
  // The router's pause is still one: the CLI says the workload is still paused.
  await call('POST', '/v1/pause', { reason: 'maintenance', by: 'adm' });
  const held = await call('POST', '/v1/workloads/demo/resume', { by: 'ops' });
  assertWorkload(held.body, 'demo');
  assert.equal(typeof held.body.paused.by, 'string');
});

test('CLI 0.11.0: a regional group\'s backend names its region as its location, with its id, for the tag binding\'s path', async () => {
  const { call } = api(withRegionalMig);
  const group = (await call('POST', '/v1/workloads?dryRun=true', INPUT)).body.groups;
  assert.deepEqual(group.map((g) => [g.kind, g.location, g.name, g.id]), [['regional', REGION, 'mig', '2002']]);
  const workload = (await call('POST', '/v1/workloads', INPUT)).body;
  assertWorkload(workload, 'demo');
  assert.deepEqual(workload.backends, [{ kind: 'mig', location: REGION, name: 'mig', id: '2002' }]);
  // The CLI tells a region from a zone by its shape: a zone ends with a letter after the region's name.
  assert.match(workload.backends[0].location, /^[a-z]+-[a-z]+\d+$/);
  assert.deepEqual((await call('GET', '/v1/workloads/demo')).body.backends, workload.backends);
});
