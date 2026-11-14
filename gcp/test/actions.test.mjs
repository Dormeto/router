// POST /v1/actions (vision docs/specs/2026-11-09-google-cloud-manager-design.md, section 5.1): the AWS controller's actions, as the
// manager sends them, answered in the AWS shapes by the code behind the REST routes. Each test holds an action to the keys of AWS's
// answer (lambda/src/lib/controller-core.mjs, status.mjs, summary.mjs) and, where a REST route exists, to its data on the same world.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATES } from '../../lambda/src/lib/state.mjs';
import { createActions } from '../src/actions.mjs';
import { createControllerApi } from '../src/controller.mjs';
import { createFirestoreStore } from '../src/firestore.mjs';
import { organizationOf } from '../src/organization.mjs';
import { fakeFirestore } from './firestore-fake.mjs';
import { GKE_INPUT, INPUT, REGION, WAKER, ZONE, onGke, setup, virtualClock } from './world.mjs';

const iso = (ms) => new Date(ms).toISOString();
const DAY = 86_400_000;
const SCHEDULE = { timeZone: 'europe/paris', windows: [{ kind: 'nap', days: ['sat', 'sun'], start: '20:00', end: '08:00' }], maxNapDays: 7 };
const CUSTOM_REFUSED = 'custom pages are off on this router: an administrator turns them on with dormeto gcp routers install --custom-pages';
const PAGE_HTML = '<!doctype html><p data-dormeto="status"></p>';
const NO_COUNTS = () => ({ ignored: {}, deferred: {}, wakes: {} });

// A `node:http` request as `serve` hands it to the role.
const request = (method, url, body = '') => {
  const stream = (async function* chunks() { if (body) yield Buffer.from(body); }());
  return Object.assign(stream, { method, url, headers: {} });
};

// The world as the manager reaches it, POST /v1/actions beside the REST routes, over a store with what the Firestore one adds for the
// manager: router/manager (`store.manager`), the journal (`store.events`) and the stats/ counters (`store.stats`, 7 days added up).
function world(change, options) {
  const t = setup(change, options);
  const { store, core, onboarding, config, clock, log } = t;
  Object.assign(config, { version: '0.40.0', build: 'b7' });
  Object.assign(store, {
    manager: null,
    events: [],
    stats: new Map(),
    getManagerSettings: async () => structuredClone(store.manager),
    // As Firestore's: a push without events keeps the stored one; one of events alone leaves the settings and their ETag.
    putManagerSettings: async (doc) => {
      store.manager = structuredClone({ ...(doc.settings === undefined ? store.manager : {}), ...(doc.events === undefined && store.manager?.events !== undefined ? { events: store.manager.events } : {}), ...doc });
    },
    listEvents: async ({ after = null, limit }) => {
      const events = store.events.filter((e) => after === null || e.id > after).slice(0, limit);
      return { events: structuredClone(events), next: events.length === limit ? events.at(-1).id : null };
    },
    getStats: async (id, days) => ({ days, since: '2023-11-08', today: NO_COUNTS(), total: structuredClone(store.stats.get(id) ?? NO_COUNTS()) }),
  });
  const router = { name: `dmtr-${config.region}`, version: config.version, build: config.build, project: config.project, region: config.region };
  const actions = createActions({ controller: core, onboarding, store, router, now: clock.now, log });
  const handler = createControllerApi({ core, onboarding, config, actions });
  const call = async (method, path, body) => {
    const res = await handler(request(method, path, body === undefined ? '' : JSON.stringify(body)));
    return { status: res.statusCode, body: JSON.parse(res.body) };
  };
  return { ...t, call, act: (payload) => call('POST', '/v1/actions', payload) };
}

// The keys of AWS's `list` row (lambda/src/lib/summary.mjs's workloadSummary), its optional ones apart.
const AWS_ROW = [
  'workloadId', 'name', 'targetGroupArn', 'source', 'tags', 'state', 'stateAt', 'url', 'wakeMode', 'wakeCount', 'awakeSince', 'wakeStartedAt', 'failedAt', 'failure',
  'consecutiveFailures', 'nextAttemptAt', 'updatedAt', 'pendingWake', 'backends', 'pauses', 'stats7d', 'type', 'settingsFrom', 'settings',
];
// Instead of the target group, the workload's Google Cloud resources (G2 §5.2).
const GOOGLE = ['backendService', 'wakerBackendService', 'urlMap', 'lb'];
const ROW = [...AWS_ROW.filter((key) => key !== 'targetGroupArn'), ...GOOGLE];
const sorted = (keys) => [...keys].sort();
// AWS's `list` row's settings, five of the Workload's.
const ROW_SETTINGS = ['waitSeconds', 'idleMinutes', 'drainSeconds', 'wakeTimeoutSeconds', 'maxHolders'];
const pick = (object, keys) => Object.fromEntries(keys.map((key) => [key, object[key]]));

// The keys of AWS's `status` answer (lambda/src/lib/status.mjs, then controller-core.mjs's scheduleView), the target groups apart.
const AWS_STATUS = [
  'workloadId', 'name', 'router', 'source', 'tags', 'state', 'stateAt', 'drift', 'updatedAt', 'awakeSince', 'wakeStartedAt', 'failedAt', 'failure',
  'consecutiveFailures', 'nextAttemptAt', 'fallbacks', 'wakeCount', 'holders', 'pendingWake', 'pauses', 'lastRequestAt', 'nap', 'route', 'rules', 'issues',
  'discovery', 'instances', 'hibernation', 'backends', 'ignoredTargets', 'recommendations', 'targets', 'settings', 'settingsFrom', 'type', 'stats', 'ipLists',
  'wakeMode', 'wakeRules', 'noWakeRules', 'schedule', 'next', 'maintenanceDue', 'joinMinutes', 'joinFrom', 'joinInherited',
];

test('router: AWS\'s router answer, routerInfo\'s, and where its reports stand (report, Google Cloud\'s: null without events)', async () => {
  const { call, act, core } = world();
  await call('POST', '/v1/workloads', INPUT);
  const res = await act({ action: 'router', refusals: true });
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body), ['router', 'settings', 'managerSettings', 'configuration', 'pauses', 'workloads', 'health', 'report']);
  assert.deepEqual(res.body, { ...(await core.routerInfo()), report: null });
  assert.deepEqual(res.body.router, { name: `dmtr-${REGION}`, version: '0.40.0', build: 'b7' });
});

test('list: AWS\'s answer, the router and a row per workload in the AWS row\'s keys, with the REST list\'s data, its pauses, schedule and 7 days of counters', async () => {
  const { call, act, store, clock } = world();
  await call('POST', '/v1/workloads', { ...INPUT, name: 'Demo', tags: { team: 'a' } });
  await call('POST', '/v1/workloads/demo/pause', { reason: 'deploy', by: 'ops' });
  clock.advance(1000);
  await call('POST', '/v1/pause', { reason: 'maintenance', by: 'adm', keepAsleep: true });
  await call('PUT', '/v1/workloads/demo/schedule', SCHEDULE);
  store.stats.set('demo', { ignored: { bot: 2 }, deferred: { 'ip-list': 1 }, wakes: { normal: 3, manager: 1 } });
  const res = await act({ action: 'list', refusals: true });
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body), ['router', 'workloads']);
  const routerPause = { scope: 'router', by: 'adm', at: iso(clock.now()), reason: 'maintenance', until: null, keepAsleep: true };
  assert.deepEqual(res.body.router, { name: `dmtr-${REGION}`, version: '0.40.0', build: 'b7', checkSchedule: '*/5 * * * *', lastScheduledCheckAt: null, pauses: [routerPause] });
  const [row] = res.body.workloads;
  assert.deepEqual(sorted(Object.keys(row)), sorted([...ROW, 'scheduled']));
  const [rest] = (await call('GET', '/v1/workloads')).body;
  assert.equal(row.workloadId, rest.id);
  for (const key of ['name', 'tags', 'state', 'settingsFrom', ...GOOGLE]) assert.deepEqual(row[key], rest[key], key);
  assert.deepEqual([row.type, row.settings, row.wakeMode], [rest.type.name, pick(rest.settings, ROW_SETTINGS), rest.settings.wakeMode]);
  assert.deepEqual(row.pauses, [{ scope: 'workload', by: 'ops', at: iso(clock.now() - 1000), reason: 'deploy', until: null, keepAsleep: false }, routerPause]);
  // The REST Workload's pauses are the row's, a workload's pause and the router's both carrying their scope; `paused` is the first.
  assert.deepEqual(rest.pauses, row.pauses);
  assert.deepEqual(rest.paused, row.pauses[0]);
  assert.deepEqual((await call('GET', '/v1/workloads/demo')).body.pauses, row.pauses);
  assert.deepEqual(row.stats7d, { ignored: 2, deferred: 1, wakes: 4 });
  assert.deepEqual([row.scheduled, row.url, row.source, row.backends], [true, 'https://demo.example.com/', 'cli', ['instance']]);
});

test('list: a row\'s pauses show an exclusion\'s first, with its exclusionId, then the workload\'s own, then the router\'s', async () => {
  const { call, act, clock } = world();
  await call('POST', '/v1/workloads', INPUT);
  await act({ action: 'pause', workloadId: 'demo', reason: 'deploy', by: 'ops' });
  clock.advance(1000);
  await act({ action: 'pause', workloadId: 'demo', reason: 'excluded: a', exclusionId: 'x1', by: 'mgr' });
  clock.advance(1000);
  await call('POST', '/v1/pause', { reason: 'maintenance', by: 'adm' });
  clock.advance(1000);
  await act({ action: 'pause', workloadId: 'demo', reason: 'excluded: b', exclusionId: 'x2', by: 'mgr' });
  const [row] = (await act({ action: 'list' })).body.workloads;
  assert.deepEqual(row.pauses.map((p) => [p.scope, p.by, p.exclusionId ?? null]), [['workload', 'mgr', 'x2'], ['workload', 'mgr', 'x1'], ['workload', 'ops', null], ['router', 'adm', null]]);
});

test('list: an unreadable pause store is said in pausesError, the rows without pauses, as AWS\'s', async () => {
  const { call, act, store } = world();
  await call('POST', '/v1/workloads', INPUT);
  store.listPauses = async () => { throw new Error('Google: 503 firestore'); };
  const { body } = await act({ action: 'list' });
  assert.deepEqual([body.router.pauses, body.router.pausesError, body.workloads[0].pauses], [[], 'Google: 503 firestore', []]);
});

test('status: AWS\'s status keys, the Google Cloud resources instead of the target groups, with the REST Workload\'s and schedule\'s data', async () => {
  const { call, act, store, clock } = world();
  await call('POST', '/v1/workloads', { ...INPUT, name: 'Demo', tags: { team: 'a' } });
  await call('PUT', '/v1/workloads/demo/schedule', { ...SCHEDULE, by: 'ops' });
  store.manager = { settings: { workloads: { hibernate: false } }, etag: 'e1', at: clock.now() - 1000 };
  store.stats.set('demo', { ignored: { bot: 2 }, deferred: {}, wakes: { normal: 3 } });
  const asleep = clock.now() - 60_000;
  Object.assign(store.runs.get('demo'), { state: STATES.ASLEEP, stateAt: asleep, suspended: ['vm-a'], holders: 2 });
  // A workload's pause and the router's: the status and the REST Workload list them alike, each with its scope.
  await act({ action: 'pause', workloadId: 'demo', reason: 'deploy', by: 'ops', keepAsleep: true });
  await act({ action: 'pause', reason: 'maintenance', by: 'adm', keepAsleep: true });
  const res = await act({ action: 'status', workloadId: 'demo', refusals: true });
  assert.equal(res.status, 200);
  const { body } = res;
  for (const key of [...AWS_STATUS, ...GOOGLE]) assert.ok(Object.hasOwn(body, key), key);
  assert.deepEqual([body.targetGroupArn, body.servingTargetGroupArn], [undefined, undefined]);
  // The REST Workload's fields, the same; the backends and the hibernation in AWS's shape.
  const rest = (await call('GET', '/v1/workloads/demo')).body;
  for (const key of Object.keys(rest).filter((k) => !['backends', 'hibernation', 'settings'].includes(k))) assert.deepEqual(body[key], rest[key], key);
  // The status's settings are AWS's six: the wake mode is at the top.
  const { wakeMode: _, ...six } = rest.settings;
  assert.deepEqual(body.settings, six);
  assert.deepEqual(body.pauses.map((p) => [p.scope, p.by]), [['workload', 'ops'], ['router', 'adm']]);
  assert.deepEqual(rest.pauses, body.pauses);
  assert.deepEqual(body.hibernation, { ...rest.hibernation, manager: { hibernate: false, readAt: iso(clock.now() - 1000), error: null }, instances: null, freshBoot: false });
  assert.deepEqual(body.backends, [{ kind: 'instance', id: 'vm-a', status: null, location: ZONE, resourceId: '1001' }]);
  assert.deepEqual([body.wakeMode, body.wakeRules, body.noWakeRules], [rest.settings.wakeMode, rest.wakeRules, rest.noWakeRules]);
  // The schedule's answer, AWS's `next` for the REST nextEvents, and the maintenance wake its maxNapDays asks.
  const schedule = (await call('GET', '/v1/workloads/demo/schedule')).body;
  assert.deepEqual(pick(body, ['schedule', 'next', 'joinMinutes', 'joinFrom', 'joinInherited']), { ...pick(schedule, ['schedule', 'joinMinutes', 'joinFrom', 'joinInherited']), next: schedule.nextEvents });
  assert.equal(body.maintenanceDue, iso(asleep + 7 * DAY));
  // The row's and the run's.
  assert.deepEqual(pick(body, ['workloadId', 'stateAt', 'holders', 'hibernated', 'scheduled', 'url', 'stats7d']), {
    workloadId: 'demo', stateAt: iso(asleep), holders: 2, hibernated: true, scheduled: true, url: 'https://demo.example.com/', stats7d: { ignored: 2, deferred: 0, wakes: 3 },
  });
  assert.deepEqual(body.stats, { days: 7, since: '2023-11-08', today: NO_COUNTS(), total: { ignored: { bot: 2 }, deferred: {}, wakes: { normal: 3 } } });
  assert.deepEqual(body.router, { version: '0.40.0', build: 'b7' });
  // What AWS reads live and the Google Cloud status does not: its key, empty.
  assert.deepEqual(pick(body, ['drift', 'lastRequestAt', 'nap', 'route', 'rules', 'issues', 'discovery', 'instances', 'ignoredTargets', 'recommendations', 'targets', 'fallbacks', 'ipLists']), {
    drift: [], lastRequestAt: null, nap: null, route: null, rules: [], issues: [], discovery: null, instances: [], ignoredTargets: [], recommendations: [], targets: [], fallbacks: [], ipLists: [],
  });
});

test('status: each backend in AWS\'s kinds, a database a companion', async () => {
  const { call, act, store } = world();
  await call('POST', '/v1/workloads', INPUT);
  const cfg = store.configs.get('demo');
  cfg.backends = [
    { kind: 'vm', location: ZONE, name: 'vm-a', id: '1001' },
    { kind: 'mig', location: REGION, name: 'web' },
    { kind: 'mig', location: REGION, name: 'api', id: 77 },
    { kind: 'k8s', cluster: { location: ZONE, name: 'shop' }, namespace: 'shop', service: 'web', owner: { kind: 'Deployment', name: 'web' } },
    { kind: 'cloudsql', name: 'db' },
  ];
  const { body } = await act({ action: 'status', workloadId: 'demo' });
  assert.deepEqual(body.backends, [
    { kind: 'instance', id: 'vm-a', status: null, location: ZONE, resourceId: '1001' },
    { kind: 'asg', id: 'web', status: null, location: REGION },
    { kind: 'asg', id: 'api', status: null, location: REGION, resourceId: '77' },
    { kind: 'k8s', id: `${ZONE}/shop/shop/Deployment/web`, status: null, cluster: `${ZONE}/shop`, namespace: 'shop', owner: { kind: 'Deployment', name: 'web' } },
    { kind: 'cloudsql-instance', id: 'db', status: null, companion: true },
  ]);
});

test('status: settings holds AWS\'s six keys, and wakeMode is at the top only', async () => {
  const { call, act } = world();
  await call('POST', '/v1/workloads', INPUT);
  const { body } = await act({ action: 'status', workloadId: 'demo' });
  assert.deepEqual(Object.keys(body.settings).sort(), ['drainSeconds', 'failedRetrySeconds', 'idleMinutes', 'maxHolders', 'waitSeconds', 'wakeTimeoutSeconds']);
  assert.equal(typeof body.wakeMode, 'string');
});

test('status: an unknown workload is refused as not found, and without refusals answers the REST route\'s 404', async () => {
  const { call, act } = world();
  assert.deepEqual(await act({ action: 'status', workloadId: 'nope', refusals: true }), { status: 200, body: { refused: { code: 'not_found', message: 'no workload nope' } } });
  assert.deepEqual(await act({ action: 'status', workloadId: 'nope' }), await call('GET', '/v1/workloads/nope'));
});

test('request-nap: AWS\'s answers; its task names the manager and who asked, and so does its NAPPING', async () => {
  const { call, act, store, w, clock } = world();
  await call('POST', '/v1/workloads', INPUT);
  assert.deepEqual(await act({ action: 'request-nap', workloadId: 'demo', by: 'ann@example.com', refusals: true }), { status: 200, body: { requested: true } });
  const task = w.tasks.at(-1).body;
  assert.deepEqual(task, { action: 'nap', workloadId: 'demo', cause: 'manager', requestedAt: clock.now(), by: 'ann@example.com' });
  assert.equal(w.logs.find((l) => l.event === 'NapRequested').trigger.by, 'ann@example.com');
  await call('POST', '/v1/tasks', task);
  const napping = w.logs.find((l) => l.event === 'StateChanged' && l.to === STATES.NAPPING);
  assert.deepEqual([napping.cause, napping.by], ['manager', 'ann@example.com']);
  const tasks = w.tasks.length;
  store.runs.get('demo').state = STATES.ASLEEP;
  assert.deepEqual((await act({ action: 'request-nap', workloadId: 'demo', by: 'ann' })).body, { requested: false, reason: 'not awake (ASLEEP)' });
  store.runs.get('demo').state = STATES.AWAKE;
  await call('POST', '/v1/workloads/demo/pause', { reason: 'deploy', by: 'ops' });
  assert.deepEqual((await act({ action: 'request-nap', workloadId: 'demo', by: 'ann' })).body, { requested: false, reason: 'paused by ops: deploy' });
  await call('POST', '/v1/workloads/demo/resume');
  await call('POST', '/v1/pause', { reason: 'maintenance', by: 'adm', keepAsleep: true });
  assert.deepEqual((await act({ action: 'request-nap', workloadId: 'demo', by: 'ann' })).body, { requested: false, reason: 'router paused by adm: maintenance' });
  assert.equal(w.tasks.length, tasks);
});

test('force-wake: AWS\'s answers by state; the wake names the manager and who asked', async () => {
  const { call, act, store, w } = world();
  await call('POST', '/v1/workloads', INPUT);
  assert.deepEqual((await act({ action: 'force-wake', workloadId: 'demo', by: 'ann' })).body, { state: STATES.AWAKE });
  store.runs.get('demo').state = STATES.ASLEEP;
  assert.deepEqual((await act({ action: 'force-wake', workloadId: 'demo', by: 'ann' })).body, { state: STATES.WAKING });
  const waking = w.logs.find((l) => l.event === 'StateChanged' && l.to === STATES.WAKING);
  assert.deepEqual([waking.cause, waking.by], ['manager', 'ann']);
  assert.deepEqual(w.tasks.at(-1).body, { action: 'wake', workloadId: 'demo', wakeId: 'wake-1' });
  // Waking already: its state, where the REST route answers 409.
  assert.deepEqual((await act({ action: 'force-wake', workloadId: 'demo', by: 'ann' })).body, { state: STATES.WAKING });
  assert.equal((await call('POST', '/v1/workloads/demo/wake')).status, 409);
  Object.assign(store.runs.get('demo'), { state: STATES.NAPPING, pendingWake: false });
  assert.deepEqual((await act({ action: 'force-wake', workloadId: 'demo', by: 'ann' })).body, { state: STATES.NAPPING, pendingWake: true });
  assert.equal(store.runs.get('demo').pendingWake, true);
  assert.deepEqual(w.logs.findLast((l) => l.event === 'PendingWake').trigger, { kind: 'manager', by: 'ann' });
});

test('pause and resume: a workload\'s or, without workloadId, the router\'s, in AWS\'s answers, its wake saying who paused; the REST Workload shows the pause', async () => {
  const { call, act, store, clock, w } = world();
  await call('POST', '/v1/workloads', INPUT);
  store.runs.get('demo').state = STATES.ASLEEP;
  const until = iso(clock.now() + 3_600_000);
  const own = await act({ action: 'pause', workloadId: 'demo', reason: 'deploy', until, by: 'ann', refusals: true });
  const pause = { by: 'ann', at: iso(clock.now()), reason: 'deploy', until, keepAsleep: false };
  assert.deepEqual(own, { status: 200, body: { pause: { scope: 'workload', ...pause }, woken: ['demo'] } });
  const woken = w.logs.find((l) => l.event === 'StateChanged' && l.to === STATES.WAKING);
  assert.deepEqual([woken.cause, woken.by], ['pause', 'ann']);
  assert.deepEqual((await call('GET', '/v1/workloads/demo')).body.paused, { scope: 'workload', ...pause });
  assert.deepEqual((await act({ action: 'resume', workloadId: 'demo', by: 'ann' })).body, { resumed: true });
  assert.deepEqual((await act({ action: 'resume', workloadId: 'demo', by: 'ann' })).body, { resumed: false });
  const routerPause = await act({ action: 'pause', reason: 'maintenance', keepAsleep: true, by: 'adm' });
  assert.deepEqual(routerPause.body, { pause: { scope: 'router', by: 'adm', at: iso(clock.now()), reason: 'maintenance', until: null, keepAsleep: true }, woken: [] });
  assert.equal((await call('GET', '/v1/workloads/demo')).body.paused.scope, 'router');
  assert.deepEqual((await act({ action: 'resume', by: 'adm' })).body, { resumed: true });
  assert.equal(store.pauses.size, 0);
  assert.deepEqual((await act({ action: 'pause', workloadId: 'demo', by: 'ann', refusals: true })).body, { refused: { code: 'invalid', message: 'reason required (1 to 256 characters)' } });
  assert.deepEqual((await act({ action: 'pause', workloadId: 'nope', reason: 'r', refusals: true })).body.refused.code, 'not_found');
});

test('pause and resume: an exclusion\'s, with its exclusionId and the workload\'s backend service, sits beside the operator\'s and is listed first; lifting it leaves the operator\'s, and the operator\'s resume leaves it', async () => {
  const { call, act, store, clock } = world();
  await call('POST', '/v1/workloads', INPUT);
  await act({ action: 'pause', workloadId: 'demo', reason: 'deploy', by: 'ops' });
  const path = 'projects/p/global/backendServices/app';
  const asked = { action: 'pause', workloadId: 'demo', reason: 'excluded: batch', exclusionId: 'x1', backendService: path, by: 'mgr' };
  const answer = await act({ ...asked, refusals: true });
  const exclusion = { scope: 'workload', by: 'mgr', at: iso(clock.now()), reason: 'excluded: batch', until: null, keepAsleep: false, exclusionId: 'x1' };
  assert.deepEqual(answer, { status: 200, body: { pause: exclusion, woken: [] } });
  assert.deepEqual([...store.pauses.keys()].sort(), ['demo', 'demo#x1']);
  const { body } = await act({ action: 'status', workloadId: 'demo' });
  assert.deepEqual(body.pauses.map((p) => [p.by, p.exclusionId ?? null]), [['mgr', 'x1'], ['ops', null]]);
  // A name is compared as the path's last part.
  assert.equal((await act({ ...asked, backendService: 'app', refusals: true })).body.pause.exclusionId, 'x1');
  assert.deepEqual(await act({ action: 'resume', workloadId: 'demo', exclusionId: 'x1', by: 'mgr' }), { status: 200, body: { resumed: true } });
  assert.deepEqual(await act({ action: 'resume', workloadId: 'demo', exclusionId: 'x1', by: 'mgr' }), { status: 200, body: { resumed: false } });
  assert.deepEqual([...store.pauses.keys()], ['demo']);
  await act({ ...asked });
  assert.deepEqual((await act({ action: 'resume', workloadId: 'demo', by: 'ops' })).body, { resumed: true });
  assert.deepEqual([...store.pauses.keys()], ['demo#x1']);
});

test('pause: an exclusion\'s backend service path must be the workload\'s own, by project and scope: the same name in another region, another project or the global scope is refused, and a regional one is paused', async () => {
  const { call, act, store } = world();
  await call('POST', '/v1/workloads', INPUT);
  const exclusion = { action: 'pause', workloadId: 'demo', reason: 'excluded: batch', exclusionId: 'x1', by: 'mgr', refusals: true };
  const notConfigured = (path) => ({ refused: { code: 'not_found', message: `workload not configured: demo (its backend service is not ${path})` } });
  // The global workload: its scope is global, in the router's project.
  for (const path of ['projects/other/global/backendServices/app', `projects/p/regions/${REGION}/backendServices/app`]) {
    assert.deepEqual((await act({ ...exclusion, backendService: path })).body, notConfigured(path), path);
  }
  assert.equal(store.pauses.size, 0);
  assert.equal((await act({ ...exclusion, backendService: 'projects/p/global/backendServices/app' })).body.pause.exclusionId, 'x1');
  // A regional workload: its region, not the router\'s other ones, and not the global scope.
  store.configs.get('demo').lb = { kind: 'regional', region: 'europe-west2' };
  store.pauses.clear();
  for (const path of ['projects/p/regions/europe-west1/backendServices/app', 'projects/p/global/backendServices/app', 'projects/other/regions/europe-west2/backendServices/app']) {
    assert.deepEqual((await act({ ...exclusion, backendService: path })).body, notConfigured(path), path);
  }
  assert.equal(store.pauses.size, 0);
  assert.equal((await act({ ...exclusion, backendService: 'projects/p/regions/europe-west2/backendServices/app' })).body.pause.exclusionId, 'x1');
  store.configs.get('demo').lb = { kind: 'internal', region: 'europe-west2' };
  assert.equal((await act({ ...exclusion, exclusionId: 'x2', backendService: 'projects/p/regions/europe-west2/backendServices/app' })).body.pause.exclusionId, 'x2');
  for (const kind of ['classic', 'cross-region-internal']) {
    store.configs.get('demo').lb = { kind };
    assert.equal((await act({ ...exclusion, exclusionId: 'x3', backendService: 'projects/p/global/backendServices/app' })).body.pause.exclusionId, 'x3', kind);
    assert.equal((await act({ ...exclusion, backendService: 'projects/p/regions/europe-west2/backendServices/app' })).body.refused.code, 'not_found', kind);
  }
});

test('pause: another backend service, or an unknown workload, is refused "workload not configured", whatever the exclusion; a targetGroupArn is a bad request', async () => {
  const { call, act, store } = world();
  await call('POST', '/v1/workloads', INPUT);
  const notConfigured = { refused: { code: 'not_found', message: 'workload not configured: demo (its backend service is not projects/p/global/backendServices/other)' } };
  const exclusion = { action: 'pause', reason: 'excluded: batch', exclusionId: 'x1', by: 'mgr', refusals: true };
  assert.deepEqual((await act({ ...exclusion, workloadId: 'demo', backendService: 'projects/p/global/backendServices/other' })).body, notConfigured);
  assert.deepEqual((await act({ ...exclusion, workloadId: 'nope', backendService: 'projects/p/global/backendServices/app' })).body, { refused: { code: 'not_found', message: 'workload not configured: nope' } });
  assert.equal(store.pauses.size, 0);
  const arn = 'arn:aws:elasticloadbalancing:eu-west-1:1:targetgroup/demo/1';
  for (const action of ['pause', 'resume']) {
    assert.deepEqual(await act({ action, workloadId: 'demo', reason: 'r', exclusionId: 'x1', targetGroupArn: arn, by: 'mgr' }), { status: 400, body: { error: 'a Google Cloud router has no targetGroupArn: name the backendService', reason: 'bad-request' } });
  }
  // An exclusionId is a document id's part: not empty, not long, no / or #.
  for (const exclusionId of ['', 'a/b', 'a#b', 'a?b', 'a%b', 'a b', 'x'.repeat(65)]) {
    const res = await act({ action: 'pause', workloadId: 'demo', reason: 'r', exclusionId, by: 'mgr' });
    assert.equal(res.status, 400, JSON.stringify(exclusionId));
    assert.equal(res.body.error, 'exclusionId must be 1 to 64 characters, with only letters, digits, . _ and -', JSON.stringify(exclusionId));
  }
  // An exclusion pauses a workload: without workloadId, pause and resume refuse it.
  for (const action of ['pause', 'resume']) {
    const res = await act({ action, reason: 'r', exclusionId: 'x1', by: 'mgr' });
    assert.deepEqual([res.status, res.body.error], [400, 'an exclusion pauses a workload: workloadId is needed'], action);
  }
  assert.equal(store.pauses.size, 0);
});

test('REST pause routes act on the operator\'s pause only: an exclusionId in the body is dropped, the router\'s pause keeps none', async () => {
  const { call, act, store } = world();
  await call('POST', '/v1/workloads', INPUT);
  await call('POST', '/v1/workloads/demo/pause', { reason: 'deploy', by: 'ops', exclusionId: 'x?1' });
  assert.deepEqual([...store.pauses.keys()], ['demo']);
  assert.equal(store.pauses.get('demo').exclusionId, undefined);
  await call('POST', '/v1/workloads/demo/resume');
  assert.equal(store.pauses.has('demo'), false);
  await call('POST', '/v1/pause', { reason: 'maintenance', by: 'adm', exclusionId: 'x1' });
  assert.equal(store.pauses.get(null).exclusionId, undefined);
});

test('resume of a workload offboarded since: an exclusion\'s lift answers resumed false as AWS\'s; without an exclusionId, "workload not configured"', async () => {
  const { act } = world();
  assert.deepEqual(await act({ action: 'resume', workloadId: 'gone', exclusionId: 'x1', by: 'mgr' }), { status: 200, body: { resumed: false } });
  assert.deepEqual(await act({ action: 'resume', workloadId: 'gone', by: 'mgr', refusals: true }), { status: 200, body: { refused: { code: 'not_found', message: 'workload not configured: gone' } } });
});

// A router of asleep workloads, each read and write of the store taking 100 ms (a Firestore call), on a clock where time passes
// only once every request waits: what a call to the router lasts is its longest chain of awaits.
function asleepRouter(count) {
  const clock = virtualClock();
  const t = world(() => {}, { clock });
  const ids = Array.from({ length: count }, (_, i) => `w${String(i).padStart(2, '0')}`);
  for (const id of ids) {
    t.store.configs.set(id, { workloadId: id, urlMap: 'lb', backendService: 'app', wakerBackendService: `dmtr-${REGION}-${id}`, backends: [{ kind: 'vm', location: ZONE, name: 'vm-a' }] });
    t.store.runs.set(id, { state: STATES.ASLEEP, version: 1, stateAt: 1 });
  }
  for (const name of ['getRun', 'transition', 'setPendingWake', 'listConfigs', 'addPause']) {
    const call = t.store[name];
    t.store[name] = async (...args) => {
      await clock.sleep(100);
      return call(...args);
    };
  }
  return { ...t, clock, ids };
}

test('pause: the router\'s wakes run 8 at a time, so 40 asleep workloads are woken within the manager\'s 10 s call bound, each once', async () => {
  const { act, clock, ids, w } = asleepRouter(40);
  const started = clock.now();
  const { status, body } = await clock.until(act({ action: 'pause', reason: 'freeze', by: 'ops', refusals: true }));
  assert.equal(status, 200);
  assert.ok(clock.now() - started <= 10_000, `the pause answered after ${clock.now() - started} ms`);
  assert.deepEqual(body.woken, ids);
  assert.deepEqual(w.tasks.map((task) => task.body.workloadId).sort(), ids);
  assert.equal(w.logs.filter((l) => l.event === 'WakeRequested' && l.trigger?.kind === 'pause').length, 40);
});

test('pause: the router\'s woken lists only the wakes it started: one a waker started first is not listed, a napping one\'s pending wake is', async () => {
  const { act, clock, store } = asleepRouter(3);
  store.runs.get('w02').state = STATES.NAPPING;
  // w01's wake is taken by another between the pause's read and its own write.
  const transition = store.transition;
  store.transition = async (id, change) => {
    if (id === 'w01' && change.set?.state === STATES.WAKING) store.runs.get('w01').state = STATES.WAKING;
    return transition(id, change);
  };
  const { body } = await clock.until(act({ action: 'pause', reason: 'freeze', by: 'ops', refusals: true }));
  assert.deepEqual(body.woken, ['w00', 'w02']);
  assert.equal(store.runs.get('w02').pendingWake, true);
});

test('rename and tag: AWS\'s answers, setName\'s and setTags\'; the REST Workload shows them; a bad tag refused in AWS\'s words', async () => {
  const { call, act } = world();
  await call('POST', '/v1/workloads', INPUT);
  assert.deepEqual((await act({ action: 'rename', workloadId: 'demo', name: '  Shop  ', by: 'ann' })).body, { workloadId: 'demo', name: 'Shop' });
  assert.deepEqual((await act({ action: 'tag', workloadId: 'demo', tags: { team: 'a' }, by: 'ann' })).body, { workloadId: 'demo', tags: { team: 'a' } });
  const rest = (await call('GET', '/v1/workloads/demo')).body;
  assert.deepEqual([rest.name, rest.tags], ['Shop', { team: 'a' }]);
  assert.deepEqual((await act({ action: 'tag', workloadId: 'demo', tags: { 'dormeto:x': 'y' }, refusals: true })).body, { refused: { code: 'invalid', message: 'tag "dormeto:x": the dormeto: prefix is reserved' } });
  assert.deepEqual((await act({ action: 'rename', workloadId: 'demo', name: '', refusals: true })).body, { refused: { code: 'invalid', message: 'name: required' } });
});

test('settings: the router\'s, the REST route\'s answer; a workload\'s in AWS\'s answer; problems answered as AWS\'s, nothing written', async () => {
  const { call, act, store } = world();
  await call('POST', '/v1/workloads', INPUT);
  const routerLevel = await act({ action: 'settings', settings: { joinMinutes: 10, defaults: { idleMinutes: 30 } }, by: 'adm', refusals: true });
  assert.equal(routerLevel.status, 200);
  assert.deepEqual(routerLevel.body, (await call('GET', '/v1/settings')).body);
  assert.deepEqual([routerLevel.body.settings.joinMinutes, routerLevel.body.settings.by], [10, 'adm']);
  const workload = await act({ action: 'settings', workloadId: 'demo', settings: { idleMinutes: 45, hibernate: false }, by: 'ann' });
  assert.deepEqual(Object.keys(workload.body), ['level', 'settings', 'hibernation', 'resolved']);
  const rest = (await call('GET', '/v1/workloads/demo')).body;
  assert.deepEqual(workload.body.level, 'workload');
  assert.deepEqual(workload.body.settings, { idleMinutes: 45, hibernate: false });
  assert.deepEqual(workload.body.hibernation, { ...rest.hibernation, instances: null, freshBoot: false });
  assert.deepEqual(workload.body.resolved, pick(rest, ['settings', 'settingsFrom', 'type']));
  const before = structuredClone(store.configs.get('demo'));
  const refused = await act({ action: 'settings', workloadId: 'demo', settings: { idleMinutes: 1 }, by: 'ann', refusals: true });
  const rested = await call('PUT', '/v1/workloads/demo/settings', { idleMinutes: 1 });
  assert.deepEqual(refused, { status: 200, body: { problems: rested.body.problems } });
  assert.deepEqual((await act({ action: 'settings', settings: { defaults: { waitSeconds: 30 } } })).body, { problems: (await call('PUT', '/v1/settings', { defaults: { waitSeconds: 30 } })).body.problems });
  assert.deepEqual((await act({ action: 'settings', workloadId: 'demo', settings: 'idle' })).body, { problems: ['settings must be an object'] });
  assert.deepEqual(store.configs.get('demo'), before);
});

test('waiting-page: get, put and delete, the REST route\'s answers; problems answered as AWS\'s; a custom page with the switch off refused as a conflict', async () => {
  const { call, act, store } = world();
  await call('POST', '/v1/workloads', INPUT);
  const put = await act({ action: 'waiting-page', op: 'put', page: { mode: 'template', title: 'Acme' }, by: 'adm', refusals: true });
  assert.equal(put.status, 200);
  assert.deepEqual(put.body, (await call('GET', '/v1/waiting-page')).body);
  assert.equal(put.body.by, 'adm');
  const own = await act({ action: 'waiting-page', op: 'put', workloadId: 'demo', page: { mode: 'template', description: 'Back soon.' }, by: 'ann' });
  assert.deepEqual(own.body, (await call('GET', '/v1/workloads/demo/waiting-page')).body);
  assert.deepEqual((await act({ action: 'waiting-page', op: 'get', workloadId: 'demo' })).body, own.body);
  assert.deepEqual((await act({ action: 'waiting-page', op: 'put', page: { mode: 'template', title: '' }, by: 'adm' })).body, { problems: ['title must be one line of text'] });
  assert.deepEqual((await act({ action: 'waiting-page', op: 'put', workloadId: 'demo', page: { mode: 'custom', html: PAGE_HTML }, by: 'adm', refusals: true })).body, { refused: { code: 'conflict', message: CUSTOM_REFUSED } });
  assert.deepEqual((await act({ action: 'waiting-page', op: 'put', page: { mode: 'template' }, refusals: true })).body, { refused: { code: 'invalid', message: 'a put needs by: who sets the page' } });
  assert.deepEqual((await act({ action: 'waiting-page', op: 'get', workloadId: '', refusals: true })).body, { refused: { code: 'invalid', message: 'workloadId must be the id of a workload' } });
  assert.deepEqual((await act({ action: 'waiting-page', op: 'other', refusals: true })).body, { refused: { code: 'invalid', message: 'unknown waiting-page op: other' } });
  const cleared = await act({ action: 'waiting-page', op: 'delete', workloadId: 'demo', by: 'ann' });
  assert.deepEqual([cleared.body.own, cleared.body.effective.title], [null, 'Acme']);
  await act({ action: 'waiting-page', op: 'delete', by: 'adm' });
  assert.equal(store.pages.size, 0);
});

test('waiting-page: a custom page, with the switch on, stored as the REST route stores it', async () => {
  const { call, act, store } = world((w) => { w.customPages = true; });
  await call('POST', '/v1/workloads', INPUT);
  const res = await act({ action: 'waiting-page', op: 'put', workloadId: 'demo', page: { mode: 'custom', html: PAGE_HTML }, by: 'adm' });
  assert.deepEqual([res.status, res.body.effective.mode], [200, 'custom']);
  assert.deepEqual(store.pages.get('pages/demo').page, { mode: 'custom', html: PAGE_HTML });
});

test('waiting-page: the organization\'s page (router/manager) inherited and effective at the router and workload levels, as AWS\'s view gives it', async () => {
  const { call, act } = world();
  await call('POST', '/v1/workloads', INPUT);
  await act({ action: 'manager-settings', settings: { waitingPage: { mode: 'template', title: 'Acme Org', description: 'Back soon.' } }, etag: '"e1"' });
  const routerLevel = (await act({ action: 'waiting-page', op: 'get', refusals: true })).body;
  assert.deepEqual([routerLevel.own, routerLevel.inherited.title, routerLevel.effective.title, routerLevel.from.title], [null, 'Acme Org', 'Acme Org', 'organization']);
  await act({ action: 'waiting-page', op: 'put', workloadId: 'demo', page: { mode: 'template', title: 'Shop' }, by: 'ann' });
  const workload = (await act({ action: 'waiting-page', op: 'get', workloadId: 'demo' })).body;
  assert.deepEqual([workload.inherited.title, workload.effective.title, workload.effective.description, workload.from.title, workload.from.description], ['Acme Org', 'Shop', 'Back soon.', 'workload', 'organization']);
  assert.deepEqual((await call('GET', '/v1/workloads/demo/waiting-page')).body, workload);
});

test('waiting-page: the organization\'s custom page is not effective with the install\'s switch off, as the waker does not serve it; with it on, it is', async () => {
  for (const customPages of [false, true]) {
    const { act } = world((w) => { w.customPages = customPages; });
    await act({ action: 'manager-settings', settings: { waitingPage: { mode: 'custom', html: PAGE_HTML } }, etag: '"e1"' });
    const { body } = await act({ action: 'waiting-page', op: 'get' });
    const [mode, from] = customPages ? ['custom', 'organization'] : ['template', 'default'];
    assert.deepEqual([body.effective.mode, body.effective.from.mode, body.inherited.mode], [mode, from, mode], String(customPages));
  }
});

test('waiting-page: an organization\'s settings that cannot be read leave its page out, said, and the view answers', async () => {
  const { act, store, w } = world();
  store.getManagerSettings = async () => { throw new Error('Google: 503 firestore'); };
  const { status, body } = await act({ action: 'waiting-page', op: 'get' });
  assert.deepEqual([status, body.effective.from.mode], [200, 'default']);
  assert.deepEqual(pick(w.logs.find((l) => l.event === 'WaitingPageUnread'), ['level', 'error']), { level: 'organization', error: 'Google: 503 firestore' });
});

test('schedule and clear-schedule: AWS\'s answers with the REST schedule\'s data, `next` and the maintenance wake; problems answered as AWS\'s', async () => {
  const { call, act, store, clock } = world();
  await call('POST', '/v1/workloads', INPUT);
  const set = await act({ action: 'schedule', workloadId: 'demo', schedule: SCHEDULE, by: 'ann', refusals: true });
  assert.equal(set.status, 200);
  assert.deepEqual(Object.keys(set.body), ['schedule', 'next', 'maintenanceDue', 'joinMinutes', 'joinFrom', 'joinInherited']);
  const rest = (await call('GET', '/v1/workloads/demo/schedule')).body;
  assert.deepEqual(set.body, { ...pick(rest, ['schedule', 'joinMinutes', 'joinFrom', 'joinInherited']), next: rest.nextEvents, maintenanceDue: null });
  assert.deepEqual([set.body.schedule.by, set.body.schedule.timeZone], ['ann', 'Europe/Paris']);
  // Asleep, the maximum nap's wake is due.
  Object.assign(store.runs.get('demo'), { state: STATES.ASLEEP, stateAt: clock.now() });
  const again = await act({ action: 'schedule', workloadId: 'demo', schedule: set.body.schedule, by: 'ann' });
  assert.equal(again.body.maintenanceDue, iso(clock.now() + 7 * DAY));
  const refused = await act({ action: 'schedule', workloadId: 'demo', schedule: { windows: [{ kind: 'nap', days: ['someday'], start: '20:00', end: '08:00' }] }, by: 'ann' });
  assert.deepEqual(refused.body, { problems: ['timeZone: required with windows', 'windows[0].days: one or more of mon, tue, wed, thu, fri, sat, sun, each once'] });
  assert.deepEqual((await act({ action: 'schedule', workloadId: 'demo', schedule: 'weekends' })).body, { problems: ['schedule: an object'] });
  assert.equal(store.schedules.get('demo').by, 'ann');
  assert.deepEqual((await act({ action: 'clear-schedule', workloadId: 'demo', by: 'ann', refusals: true })).body, { cleared: true });
  assert.deepEqual((await act({ action: 'clear-schedule', workloadId: 'demo', by: 'ann' })).body, { cleared: false });
  assert.equal(store.schedules.size, 0);
  assert.equal((await act({ action: 'clear-schedule', workloadId: 'nope', refusals: true })).body.refused.code, 'not_found');
});

// AWS's onboarder's answers (lambda/src/lib/onboarding.mjs): the preview's keys (:392, :451), its backends' and databases' (:442, :449),
// the onboarding's (:552) and the offboarding's (:793), each step's (:477, :671-673).
const AWS_PREVIEW = ['workloadId', 'name', 'tags', 'targetGroupArn', 'wakerTargetGroupName', 'loadBalancerArn', 'rules', 'backends', 'databases', 'ok', 'problems'];
const AWS_BACKEND = ['kind', 'id', 'tagged'];
const AWS_ONBOARD = ['steps', 'workload'];
const AWS_ONBOARDED = ['workloadId', 'name', 'wakerTargetGroupArn'];
const AWS_OFFBOARD = ['steps'];
const AWS_STEP = ['name', 'status', 'detail'];
// Instead of the target groups and the load balancer, the Google Cloud resources (G2 §5.2). A dry run reads no route the onboarding
// would add, so the rules have no Google Cloud reading here.
const GOOGLE_PREVIEW = { targetGroupArn: ['backendService', 'urlMap'], wakerTargetGroupName: ['wakerBackendService'], loadBalancerArn: ['urlMap', 'lb'], rules: [] };
const PREVIEW = [...new Set(AWS_PREVIEW.flatMap((key) => GOOGLE_PREVIEW[key] ?? [key]))];
const ONBOARDED = AWS_ONBOARDED.map((key) => (key === 'wakerTargetGroupArn' ? 'wakerBackendService' : key));
const STEP_KEYS = (steps) => steps.every((step) => Object.keys(step).every((key) => AWS_STEP.includes(key)) && ['done', 'skipped', 'failed'].includes(step.status));

test('preview: AWS\'s preview keys, the Google Cloud resources instead of the target groups, beside the REST dry run\'s fields', async () => {
  const { call, act } = world((w) => { w.sql.db = {}; });
  const asked = { urlMap: 'lb', backendService: 'app', workloadId: 'demo', name: 'Shop', tags: { team: 'a' }, settings: { idleMinutes: 30 } };
  const preview = await act({ action: 'preview', ...asked, databases: ['db'], refusals: true });
  assert.equal(preview.status, 200);
  for (const key of PREVIEW) assert.ok(Object.hasOwn(preview.body, key), key);
  assert.deepEqual([preview.body.targetGroupArn, preview.body.loadBalancerArn, preview.body.rules], [undefined, undefined, undefined]);
  assert.deepEqual(pick(preview.body, ['workloadId', 'name', 'tags', 'urlMap', 'backendService', 'wakerBackendService', 'lb', 'ok', 'problems']), {
    workloadId: 'demo', name: 'Shop', tags: { team: 'a' }, urlMap: 'lb', backendService: 'app', wakerBackendService: WAKER, lb: { kind: 'global' }, ok: true, problems: [],
  });
  // AWS's backends and databases, `tagged` unknown: the router cannot see Google's tags, which the CLI binds.
  assert.deepEqual(preview.body.backends, [{ kind: 'instance', id: 'vm-a', tagged: null, location: ZONE }]);
  for (const entry of [...preview.body.backends, ...preview.body.databases]) for (const key of AWS_BACKEND) assert.ok(Object.hasOwn(entry, key), key);
  const rest = (await call('POST', '/v1/workloads?dryRun=true', { ...INPUT, name: 'Shop', tags: { team: 'a' }, settings: { idleMinutes: 30 }, cloudSql: ['db'] })).body;
  assert.deepEqual(preview.body.databases, rest.databases.map((d) => ({ kind: 'cloudsql-instance', id: d.name, tagged: null, ...d })));
  for (const key of Object.keys(rest).filter((k) => k !== 'databases')) assert.deepEqual(preview.body[key], rest[key], key);
  // Not eligible: ok false and the reasons as AWS's problems.
  const refused = await act({ action: 'preview', ...asked, databases: ['orders'] });
  assert.deepEqual([refused.body.ok, refused.body.problems, refused.body.eligible], [false, refused.body.reasons, false]);
  assert.match(refused.body.problems.join('; '), /Cloud SQL instance orders/);
  // No name: the workload's id, the Workload's own default.
  assert.deepEqual(pick((await act({ action: 'preview', urlMap: 'lb', backendService: 'app' })).body, ['workloadId', 'name', 'tags']), { workloadId: 'app', name: 'app', tags: {} });
});

test('onboard: AWS\'s answer, the steps of what the onboarding changed and the workload, with the REST Workload in it; onboarded by the manager', async () => {
  const { call, act, store } = world();
  const asked = { urlMap: 'lb', backendService: 'app', workloadId: 'demo', name: 'Shop', tags: { team: 'a' }, settings: { idleMinutes: 30 } };
  const onboarded = await act({ action: 'onboard', ...asked, by: 'ann', refusals: true });
  assert.equal(onboarded.status, 200);
  assert.deepEqual(Object.keys(onboarded.body), AWS_ONBOARD);
  assert.ok(STEP_KEYS(onboarded.body.steps));
  assert.deepEqual(onboarded.body.steps, [
    { name: 'waker backend service', status: 'done', detail: WAKER },
    { name: 'instrument URL map', status: 'done', detail: 'URL map lb' },
    { name: 'workload configuration', status: 'done' },
  ]);
  for (const key of ONBOARDED) assert.ok(Object.hasOwn(onboarded.body.workload, key), key);
  assert.deepEqual(onboarded.body.workload, { workloadId: 'demo', ...(await call('GET', '/v1/workloads/demo')).body });
  assert.deepEqual([onboarded.body.workload.name, onboarded.body.workload.tags, onboarded.body.workload.settings.idleMinutes], ['Shop', { team: 'a' }, 30]);
  assert.equal(store.configs.get('demo').source, 'manager');
  assert.equal((await act({ action: 'list' })).body.workloads[0].source, 'manager');
  assert.deepEqual((await act({ action: 'onboard', ...asked, refusals: true })).body, { refused: { code: 'conflict', message: 'workload demo is onboarded already' } });
});

test('onboard: a waker backend service of the workload\'s already there is a step skipped, as AWS\'s waker target group', async () => {
  const { act } = world((w) => {
    w.services[WAKER] = { name: WAKER, loadBalancingScheme: 'EXTERNAL_MANAGED', customRequestHeaders: ['x-dormeto-workload: demo'], backends: [] };
  });
  const { body } = await act({ action: 'onboard', urlMap: 'lb', backendService: 'app', workloadId: 'demo' });
  assert.deepEqual(body.steps[0], { name: 'waker backend service', status: 'skipped', detail: WAKER });
});

test('onboard and offboard: who asked is kept in the configuration as AWS\'s onboardedBy, unknown when the manager names none, and said in Onboarded and Offboarded', async () => {
  const { act, call, store, w } = world();
  const asked = { action: 'onboard', urlMap: 'lb', backendService: 'app', workloadId: 'demo' };
  await act({ ...asked, by: 'ann' });
  assert.equal(store.configs.get('demo').onboardedBy, 'ann');
  await act({ action: 'offboard', workloadId: 'demo', by: 'bob' });
  await act(asked);
  assert.equal(store.configs.get('demo').onboardedBy, 'unknown');
  assert.equal((await act({ action: 'status', workloadId: 'demo' })).body.onboardedBy, 'unknown');
  await act({ action: 'offboard', workloadId: 'demo', force: true, by: 'bob' });
  // The CLI's names no one: nothing kept, its lines say unknown.
  await call('POST', '/v1/workloads', INPUT);
  assert.equal(Object.hasOwn(store.configs.get('demo'), 'onboardedBy'), false);
  await call('DELETE', '/v1/workloads/demo');
  assert.deepEqual(w.logs.filter((l) => l.event === 'Onboarded').map((l) => l.by), ['ann', 'unknown', 'unknown']);
  assert.deepEqual(w.logs.filter((l) => l.event === 'Offboarded').map((l) => [l.by, l.force === true]), [['bob', false], ['bob', true], ['unknown', false]]);
});

test('offboard: AWS\'s answer, the steps of what the offboarding undid; the REST route keeps its own answer', async () => {
  const { call, act, store } = world();
  await call('POST', '/v1/workloads', INPUT);
  const offboarded = await act({ action: 'offboard', workloadId: 'demo', by: 'ann', refusals: true });
  assert.equal(offboarded.status, 200);
  assert.deepEqual(Object.keys(offboarded.body), AWS_OFFBOARD);
  assert.ok(STEP_KEYS(offboarded.body.steps));
  assert.deepEqual(offboarded.body.steps, [
    { name: 'wake', status: 'skipped' },
    { name: 'restore autoscalers', status: 'skipped' },
    { name: 'restore URL map', status: 'done', detail: 'URL map lb' },
    { name: 'waker backend service', status: 'done', detail: WAKER },
    { name: 'workload configuration', status: 'done' },
  ]);
  assert.equal(store.configs.size, 0);
  assert.equal((await act({ action: 'offboard', workloadId: 'demo', refusals: true })).body.refused.code, 'not_found');
  await call('POST', '/v1/workloads', INPUT);
  assert.deepEqual((await call('DELETE', '/v1/workloads/demo')).body, {});
});

test('offboard: an asleep workload woken first, a step done, the wake giving its autoscaler back; one left on an awake run given back, a step done', async () => {
  const autoscaler = { kind: 'zonal', location: ZONE, name: 'scaler', mode: 'ON' };
  const asleep = world((w) => { w.autoscalers.scaler = 'OFF'; });
  await asleep.call('POST', '/v1/workloads', INPUT);
  asleep.w.vms['vm-a'].status = 'TERMINATED';
  Object.assign(asleep.store.runs.get('demo'), { state: STATES.ASLEEP, autoscalers: [autoscaler] });
  const woken = await asleep.act({ action: 'offboard', workloadId: 'demo', by: 'ann' });
  assert.deepEqual(woken.body.steps.slice(0, 2), [{ name: 'wake', status: 'done', detail: `from ${STATES.ASLEEP}` }, { name: 'restore autoscalers', status: 'skipped' }]);
  assert.deepEqual([asleep.w.autoscalers.scaler, asleep.w.vms['vm-a'].status, asleep.store.configs.size], ['ON', 'RUNNING', 0]);
  const awake = world((w) => { w.autoscalers.scaler = 'OFF'; });
  await awake.call('POST', '/v1/workloads', INPUT);
  awake.store.runs.get('demo').autoscalers = [autoscaler];
  const restored = await awake.act({ action: 'offboard', workloadId: 'demo', by: 'ann' });
  assert.deepEqual(restored.body.steps.slice(0, 2), [{ name: 'wake', status: 'skipped' }, { name: 'restore autoscalers', status: 'done', detail: `autoscaler scaler (${ZONE}): ON` }]);
  assert.equal(awake.w.autoscalers.scaler, 'ON');
});

test('offboard with force: AWS\'s steps beside the REST forced offboarding\'s answer; an autoscaler not given back a step failed', async () => {
  const { call, act, store, w } = world((world) => { world.autoscalers.scaler = 'OFF'; });
  await call('POST', '/v1/workloads', INPUT);
  w.vms['vm-a'].status = 'TERMINATED';
  Object.assign(store.runs.get('demo'), { state: STATES.ASLEEP, autoscalers: [{ kind: 'zonal', location: ZONE, name: 'scaler', mode: 'ON' }] });
  w.fail[`PATCH zones/${ZONE}/autoscalers?autoscaler=scaler`] = new Error('Google: refused');
  const { body } = await act({ action: 'offboard', workloadId: 'demo', force: true, by: 'ann' });
  const notGivenBack = [`autoscaler scaler (${ZONE}) is still off: set its mode back to ON`];
  assert.deepEqual(body, {
    steps: [
      { name: 'restore autoscalers', status: 'failed', detail: notGivenBack[0] },
      { name: 'restore URL map', status: 'done', detail: 'URL map lb' },
      { name: 'waker backend service', status: 'done', detail: WAKER },
      { name: 'workload configuration', status: 'done' },
    ],
    id: 'demo',
    left: [{ kind: 'vm', location: ZONE, name: 'vm-a', id: '1001' }],
    notGivenBack,
  });
  assert.ok(STEP_KEYS(body.steps));
  assert.equal(store.configs.size, 0);
});

// Design §8: setting the request logs back needs compute.backendServices.update, and a GKE workload's RBAC objects are the operator's.
test('offboard: a GKE workload, or one whose onboarding turned its request logs on, is refused as a conflict naming the CLI\'s command; nothing removed, the REST route still offboards', async () => {
  const command = `dormeto gcp workloads offboard demo --project p --region ${REGION}`;
  const logs = world();
  await logs.call('POST', '/v1/workloads', { ...INPUT, requestLogs: { before: { enable: false, sampleRate: 1 } } });
  const gke = world((w) => onGke(w));
  await gke.call('POST', '/v1/workloads', GKE_INPUT);
  for (const [t, why] of [
    [logs, 'its onboarding turned its backend service\'s request logs on, which the CLI sets back'],
    [gke, 'a GKE workload\'s Kubernetes access is the CLI\'s to remove'],
  ]) {
    const message = `cannot offboard demo through the manager: ${why}: ${command}`;
    for (const force of [undefined, true]) {
      assert.deepEqual(await t.act({ action: 'offboard', workloadId: 'demo', force, by: 'ann', refusals: true }), { status: 200, body: { refused: { code: 'conflict', message } } }, why);
    }
    assert.deepEqual(await t.act({ action: 'offboard', workloadId: 'demo', by: 'ann' }), { status: 409, body: { error: message, reason: 'cli-only' } });
    assert.ok(t.store.configs.has('demo'), why);
    assert.equal((await t.call('DELETE', '/v1/workloads/demo')).status, 200, why);
  }
});

const EVENT_A ={ id: '1700000000000-demo-NAPPING', workloadId: 'demo', from: STATES.AWAKE, to: STATES.NAPPING, router: `dmtr-${REGION}`, region: REGION, project: 'p', at: iso(1_700_000_000_000), cause: 'idle', tags: {} };
const EVENT_B = { ...EVENT_A, id: '1700000060000-demo-ASLEEP', from: STATES.NAPPING, to: STATES.ASLEEP, at: iso(1_700_000_060_000) };

test('events: the journal after `after`, `limit` at most, with the last check\'s summary and the etag of the organization\'s settings', async () => {
  const { call, act, store, clock } = world();
  const none = await act({ action: 'events', after: null, limit: 10, refusals: true });
  assert.deepEqual(none, { status: 200, body: { events: [], next: null, check: null, managerSettings: { etag: null } } });
  await call('POST', '/v1/workloads', INPUT);
  await call('POST', '/v1/check');
  store.events = [EVENT_A, EVENT_B];
  store.manager = { settings: { workloads: { hibernate: false } }, etag: '"e1"', at: 1 };
  const first = await act({ action: 'events', after: null, limit: 1 });
  assert.deepEqual(Object.keys(first.body), ['events', 'next', 'check', 'managerSettings']);
  assert.deepEqual([first.body.events, first.body.next, first.body.managerSettings], [[EVENT_A], EVENT_A.id, { etag: '"e1"' }]);
  const stored = store.router.check;
  assert.deepEqual(first.body.check, { ...stored, checkedAt: iso(clock.now()), lastScheduledCheckAt: null });
  assert.deepEqual(Object.keys(first.body.check).sort(), ['checkSchedule', 'checkedAt', 'counts', 'durationMs', 'health', 'lastScheduledCheckAt', 'pauses']);
  const second = await act({ action: 'events', after: first.body.next, limit: 500 });
  assert.deepEqual([second.body.events, second.body.next], [[EVENT_B], null]);
  // `after` absent: from the oldest kept.
  assert.deepEqual((await act({ action: 'events', limit: 2 })).body.events, [EVENT_A, EVENT_B]);
});

test('events: a limit outside 1..500, or an after that is no event\'s id: 400, or refused with refusals', async () => {
  const { act } = world();
  for (const limit of [600, 501, 0, -1, 1.5, '10', null, undefined]) {
    const res = await act({ action: 'events', after: null, limit });
    assert.deepEqual(res, { status: 400, body: { error: 'limit must be a whole number from 1 to 500', reason: 'bad-request' } }, String(limit));
  }
  for (const after of ['x', '../router/manager', 'events/1700000000000-demo-ASLEEP', 12, '']) {
    const res = await act({ action: 'events', after, limit: 10 });
    assert.deepEqual(res, { status: 400, body: { error: 'after must be the id of an event, or null', reason: 'bad-request' } }, String(after));
  }
  assert.deepEqual((await act({ action: 'events', after: null, limit: 600, refusals: true })).body, { refused: { code: 'invalid', message: 'limit must be a whole number from 1 to 500' } });
});

test('manager-settings: stored with its etag and date, answered with the etag; the next router answer and events show the organization\'s level', async () => {
  const { call, act, store, clock } = world();
  await call('POST', '/v1/workloads', INPUT);
  const settings = { workloads: { hibernate: false, joinMinutes: 10, defaults: { idleMinutes: 45 } }, waitingPage: { mode: 'template', title: 'Acme' } };
  const res = await act({ action: 'manager-settings', settings, etag: '"abc"', refusals: true });
  assert.deepEqual(res, { status: 200, body: { etag: '"abc"' } });
  assert.deepEqual(store.manager, { settings, etag: '"abc"', at: clock.now() });
  const { managerSettings, health } = (await act({ action: 'router' })).body;
  assert.deepEqual(managerSettings, { url: null, hibernate: false, joinMinutes: 10, defaults: { idleMinutes: 45 }, readAt: iso(clock.now()), error: null });
  assert.equal(health.problems.some((p) => p.code === 'manager-settings-unreadable'), false);
  assert.deepEqual((await act({ action: 'events', after: null, limit: 1 })).body.managerSettings, { etag: '"abc"' });
  const shown = (await call('GET', '/v1/workloads/demo')).body;
  assert.deepEqual([shown.settings.idleMinutes, shown.settingsFrom.idleMinutes, shown.hibernation.from], [45, 'organization', 'manager']);
  // One that is not an object is stored as pushed: unset, and the health says so.
  clock.advance(60_000);
  await act({ action: 'manager-settings', settings: 'oops', etag: '"def"' });
  const unreadable = (await act({ action: 'router' })).body;
  assert.deepEqual([unreadable.managerSettings.hibernate, unreadable.managerSettings.error], [null, 'settings.json is invalid: settings.json must be an object']);
  assert.equal(unreadable.health.problems.some((p) => p.code === 'manager-settings-unreadable'), true);
});

test('manager-settings: where the router reports (events: the route\'s URL and the API\'s audience) is stored with the settings; null stops the reports; the router answer says where it reports', async () => {
  const { act, store, clock } = world();
  Object.assign(store, { getReport: async () => ({ sentThrough: null, lastSentAt: clock.now(), recent: [] }) });
  const events = { url: 'https://abc.execute-api.eu-west-1.amazonaws.com/routers/events', audience: 'https://abc.execute-api.eu-west-1.amazonaws.com' };
  assert.deepEqual(await act({ action: 'manager-settings', settings: {}, etag: '"e1"', events }), { status: 200, body: { etag: '"e1"' } });
  assert.deepEqual(store.manager, { settings: {}, etag: '"e1"', at: clock.now(), events });
  assert.deepEqual((await act({ action: 'router' })).body.report, { host: 'abc.execute-api.eu-west-1.amazonaws.com', lastSentAt: iso(clock.now()), sentThrough: null });
  await act({ action: 'manager-settings', settings: {}, etag: '"e2"', events: null });
  assert.deepEqual(store.manager, { settings: {}, etag: '"e2"', at: clock.now(), events: null });
  assert.equal((await act({ action: 'router' })).body.report, null);
});

test('manager-settings: events alone (an organization whose settings were never written) stores where to report and leaves the settings and their ETag as they are, none staying none', async () => {
  const { act, store, clock } = world();
  const events = { url: 'https://abc.execute-api.eu-west-1.amazonaws.com/routers/events', audience: 'https://abc.execute-api.eu-west-1.amazonaws.com' };
  assert.deepEqual(await act({ action: 'manager-settings', events, refusals: true }), { status: 200, body: { etag: null } });
  assert.deepEqual(store.manager, { events });
  // No settings pushed: the organization's level is unset, not unreadable.
  assert.deepEqual((await act({ action: 'router' })).body.managerSettings, { url: null, hibernate: null, joinMinutes: null, readAt: null, error: null });
  await act({ action: 'manager-settings', settings: { workloads: { hibernate: false } }, etag: '"e1"' });
  const other = { ...events, url: 'https://abc.execute-api.eu-west-1.amazonaws.com/v2/routers/events' };
  assert.deepEqual(await act({ action: 'manager-settings', events: other }), { status: 200, body: { etag: '"e1"' } });
  assert.deepEqual(store.manager, { settings: { workloads: { hibernate: false } }, etag: '"e1"', at: clock.now(), events: other });
  // With settings, the etag is still needed; neither settings nor events: refused as before.
  assert.deepEqual(await act({ action: 'manager-settings', settings: {}, events }), { status: 400, body: { error: 'etag: the ETag of settings.json, a string of 1 to 256 characters', reason: 'bad-request' } });
  assert.deepEqual(await act({ action: 'manager-settings' }), { status: 400, body: { error: 'settings: the manager\'s settings.json is needed', reason: 'bad-request' } });
});

test('manager-settings: events that are not an https URL and an audience, 400, nothing stored', async () => {
  const { act, store } = world();
  const error = 'events: { url, audience }, the https URL the router reports to and the audience of its identity token';
  for (const events of ['x', { url: 'http://api.example.com/routers/events', audience: 'https://api.example.com' }, { url: 'https://api.example.com/routers/events' }, { url: 'nope', audience: 'a' }, { url: `https://${'a'.repeat(2048)}`, audience: 'a' }]) {
    assert.deepEqual(await act({ action: 'manager-settings', settings: {}, etag: '"e"', events }), { status: 400, body: { error, reason: 'bad-request' } }, JSON.stringify(events).slice(0, 80));
  }
  assert.equal(store.manager, null);
});

test('manager-settings: without settings or a string etag, 400, nothing stored', async () => {
  const { act, store } = world();
  for (const [payload, error] of [
    [{ etag: '"e"' }, 'settings: the manager\'s settings.json is needed'],
    [{ settings: {} }, 'etag: the ETag of settings.json, a string of 1 to 256 characters'],
    [{ settings: {}, etag: 7 }, 'etag: the ETag of settings.json, a string of 1 to 256 characters'],
    [{ settings: {}, etag: 'e'.repeat(257) }, 'etag: the ETag of settings.json, a string of 1 to 256 characters'],
  ]) {
    assert.deepEqual(await act({ action: 'manager-settings', ...payload }), { status: 400, body: { error, reason: 'bad-request' } });
  }
  assert.equal(store.manager, null);
});

// The manager's push over the Firestore store (firestore.mjs) on the fake Firestore, which holds Firestore's limits, through the
// controller's route as the manager calls it.
function overFirestore() {
  const firestore = fakeFirestore();
  const store = createFirestoreStore({ google: { request: firestore.request }, project: 'p', database: `dmtr-${REGION}` });
  const log = { info: () => {}, warn: () => {}, error: () => {} };
  const actions = createActions({ controller: null, onboarding: null, store, router: { name: `dmtr-${REGION}` }, now: () => 7, log });
  const handler = createControllerApi({ core: null, onboarding: null, config: {}, actions });
  const post = async (payload) => {
    const res = await handler(request('POST', '/v1/actions', JSON.stringify(payload)));
    return { status: res.statusCode, body: JSON.parse(res.body) };
  };
  return { store, post, actions };
}

// A page of exactly 256 KiB, and a PNG icon of 64 KiB once decoded: the most the manager's waiting page takes.
const PAGE_256K = `${PAGE_HTML}${'x'.repeat(256 * 1024 - PAGE_HTML.length)}`;
const ICON_64K = `data:image/png;base64,${Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64 * 1024 - 8, 7)]).toString('base64')}`;

test('manager-settings over Firestore: a large organization document, 20 custom types, a 256 KiB custom page and a 64 KiB icon, is stored and read back whole; a body over 1 MiB leaves the last one in place', async () => {
  const { store, post, actions } = overFirestore();
  const types = Array.from({ length: 20 }, (_, i) => ({ name: `type-${i}`, description: 'd'.repeat(200), tags: { team: `t${i}`, tier: 'batch' }, settings: { idleMinutes: 30 + i, wakeTimeoutSeconds: 900 } }));
  const settings = { workloads: { hibernate: false, joinMinutes: 10, defaults: { idleMinutes: 30 }, types }, waitingPage: { mode: 'custom', html: PAGE_256K, icon: ICON_64K, title: 'Acme' } };
  assert.deepEqual(await post({ action: 'manager-settings', settings, etag: 'e1', refusals: true }), { status: 200, body: { etag: 'e1' } });
  const stored = await store.getManagerSettings();
  assert.deepEqual(stored, { settings, etag: 'e1', at: 7 });
  const { level, page, error } = organizationOf(stored);
  assert.deepEqual([error, level.hibernate, level.joinMinutes, level.types.length, page], [null, false, 10, 20, { mode: 'custom', html: PAGE_256K }]);
  // Over 1 MiB: the controller refuses the body before any action, and Firestore a document it cannot hold.
  const big = { ...settings, waitingPage: { mode: 'custom', html: 'x'.repeat(1024 * 1024) } };
  assert.deepEqual(await post({ action: 'manager-settings', settings: big, etag: 'e2', refusals: true }), { status: 400, body: { error: 'the body is larger than 1048576 bytes', reason: 'bad-request' } });
  await assert.rejects(actions({ action: 'manager-settings', settings: big, etag: 'e2' }), /exceeds the maximum allowed size of 1048576 bytes/);
  assert.deepEqual(await store.getManagerSettings(), { settings, etag: 'e1', at: 7 });
  assert.deepEqual((await post({ action: 'events', after: null, limit: 1 })).body.managerSettings, { etag: 'e1' });
});

test('an action the router does not serve: as AWS\'s controller answers it, refused unsupported with refusals, else a 400 unknown-action', async () => {
  const { act, w } = world();
  for (const action of ['unknown', 'ensure-awake', 'report', 'clusterCheck', 'check', 'wake', 'nap', 'release', 'refresh-lists', 'constructor', '__proto__', undefined]) {
    const message = `unknown action: ${action}`;
    assert.deepEqual(await act({ action, refusals: true }), { status: 200, body: { refused: { code: 'unsupported', message } } }, `${action} with refusals`);
    assert.deepEqual(await act({ action }), { status: 400, body: { error: message, reason: 'unknown-action' } }, `${action} without`);
  }
  assert.deepEqual(w.tasks, []);
});

test('an action the router does not serve: the Refused line says what was answered, unsupported with refusals, the 400 without', async () => {
  const { act, w } = world();
  const last = () => w.logs.findLast((l) => l.event === 'Refused');
  await act({ action: 'ensure-awake', workloadId: 'demo', refusals: true });
  assert.deepEqual(last(), { level: 'info', event: 'Refused', action: 'ensure-awake', workloadId: 'demo', code: 'unsupported', message: 'unknown action: ensure-awake' });
  await act({ action: 'ensure-awake', workloadId: 'demo' });
  assert.deepEqual(last(), { level: 'info', event: 'Refused', action: 'ensure-awake', workloadId: 'demo', status: 400, reason: 'unknown-action', message: 'unknown action: ensure-awake' });
});

test('a refusal: with refusals, AWS\'s answer { refused: { code, message } } and the Refused line; without, the REST route\'s error and status', async () => {
  const { call, act, w } = world();
  await call('POST', '/v1/workloads', INPUT);
  const cases = [
    [{ action: 'rename', workloadId: 'demo', name: 'x'.repeat(200) }, 'invalid'],
    [{ action: 'rename', workloadId: 'nope', name: 'Shop' }, 'not_found'],
    [{ action: 'onboard', urlMap: 'lb', backendService: 'app', workloadId: 'demo' }, 'conflict'],
  ];
  for (const [payload, code] of cases) {
    const without = await act(payload);
    assert.equal(without.status, { invalid: 400, not_found: 404, conflict: 409 }[code]);
    assert.deepEqual(Object.keys(without.body), ['error', 'reason']);
    const res = await act({ ...payload, refusals: true });
    assert.deepEqual(res, { status: 200, body: { refused: { code, message: without.body.error } } });
    assert.deepEqual(w.logs.findLast((l) => l.event === 'Refused'), { level: 'info', event: 'Refused', action: payload.action, workloadId: payload.workloadId, code, message: without.body.error });
  }
});

test('preview and onboard: AWS\'s databases entries name a Cloud SQL instance beside the names; another kind, or a mixed list, is refused', async () => {
  const { act, store } = world((w) => { w.sql.db1 = {}; });
  const asked = { action: 'preview', urlMap: 'lb', backendService: 'app', workloadId: 'demo' };
  const entries = await act({ ...asked, databases: [{ kind: 'cloudsql-instance', id: 'db1' }], refusals: true });
  assert.deepEqual([entries.body.ok, entries.body.databases.map((d) => d.id)], [true, ['db1']]);
  assert.deepEqual((await act({ ...asked, databases: ['db1'] })).body.databases, entries.body.databases);
  await act({ ...asked, action: 'onboard', databases: [{ kind: 'cloudsql-instance', id: 'db1' }] });
  assert.deepEqual(store.configs.get('demo').backends.filter((b) => b.kind === 'cloudsql'), [{ kind: 'cloudsql', name: 'db1' }]);
  const other = await act({ ...asked, databases: [{ kind: 'rds-instance', id: 'db1' }], refusals: true });
  assert.equal(other.body.refused.code, 'invalid');
  assert.equal(other.body.refused.message, 'databases: "rds-instance" is not a Cloud SQL instance\'s kind: the kind is cloudsql-instance');
  for (const entry of [{ kind: 'cloudsql-instance' }, { kind: 'cloudsql-instance', id: 'Bad_Name' }]) {
    const bad = await act({ ...asked, databases: [entry], refusals: true });
    assert.equal(bad.body.refused.code, 'invalid', JSON.stringify(entry));
    assert.match(bad.body.refused.message, /^databases: /, JSON.stringify(entry));
    assert.doesNotMatch(bad.body.refused.message, /undefined|cloudSql/, JSON.stringify(entry));
  }
  const mixed = await act({ ...asked, databases: ['db1', { kind: 'cloudsql-instance', id: 'db1' }], refusals: true });
  assert.equal(mixed.body.refused.code, 'invalid');
});

test('onboard: settings.fallbackInstanceTypes is stored as the workload\'s fallback types, and given twice is refused', async () => {
  const { act, store } = world((w) => { w.machineTypes['e2-medium'] = { name: 'e2-medium', memoryMb: 4096 }; });
  const asked = { action: 'onboard', urlMap: 'lb', backendService: 'app', workloadId: 'demo' };
  assert.equal((await act({ ...asked, settings: { idleMinutes: 30, fallbackInstanceTypes: ['e2-medium'] }, refusals: true })).body.refused, undefined);
  assert.deepEqual(store.configs.get('demo').fallbackInstanceTypes, ['e2-medium']);
  assert.equal(Object.hasOwn(store.configs.get('demo').settings ?? {}, 'fallbackInstanceTypes'), false);
  const twice = await act({ ...asked, action: 'preview', settings: { fallbackInstanceTypes: ['e2-medium'] }, fallbackInstanceTypes: ['e2-small'], refusals: true });
  assert.equal(twice.body.refused.code, 'invalid');
  assert.match(twice.body.refused.message, /fallbackInstanceTypes/);
});

test('status: a workload the manager onboarded shows who onboarded it, and one onboarded with request logs shows requestLogs.before', async () => {
  const { act, call } = world();
  await act({ action: 'onboard', urlMap: 'lb', backendService: 'app', workloadId: 'demo', by: 'ann' });
  assert.equal((await act({ action: 'status', workloadId: 'demo' })).body.onboardedBy, 'ann');
  assert.equal((await call('GET', '/v1/workloads/demo')).body.onboardedBy, 'ann');
  await act({ action: 'offboard', workloadId: 'demo', by: 'ann' });
  await call('POST', '/v1/workloads', { ...INPUT, requestLogs: { before: { enable: false, sampleRate: 1 } } });
  const { body } = await act({ action: 'status', workloadId: 'demo' });
  assert.deepEqual(body.requestLogs, { before: { enable: false, sampleRate: 1 } });
});

test('onboard: the answer\'s Workload shows the router\'s pause, as the Workload read afterwards does', async () => {
  const { call, act } = world();
  await call('POST', '/v1/pause', { reason: 'maintenance', by: 'adm' });
  const res = await call('POST', '/v1/workloads', INPUT);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.pauses.map((p) => [p.scope, p.by, p.reason]), [['router', 'adm', 'maintenance']]);
  assert.deepEqual(res.body.paused.scope, 'router');
  assert.deepEqual(res.body.pauses, (await call('GET', '/v1/workloads/demo')).body.pauses);
  await act({ action: 'offboard', workloadId: 'demo', by: 'ops' });
  const viaAction = await act({ action: 'onboard', ...INPUT, by: 'ops' });
  assert.deepEqual(viaAction.body.workload.pauses.map((p) => p.scope), ['router']);
});
