// POST /v1/actions (vision docs/specs/2026-11-09-google-cloud-manager-design.md, section 5.1): the AWS controller's actions, as the
// manager sends them, answered in the AWS shapes by the code behind the REST routes. Each test holds an action to the keys of AWS's
// answer (lambda/src/lib/controller-core.mjs, status.mjs, summary.mjs) and, where a REST route exists, to its data on the same world.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATES } from '../../lambda/src/lib/state.mjs';
import { createActions } from '../src/actions.mjs';
import { createControllerApi } from '../src/controller.mjs';
import { INPUT, REGION, ZONE, setup } from './world.mjs';

const iso = (ms) => new Date(ms).toISOString();
const DAY = 86_400_000;
const SCHEDULE = { timeZone: 'europe/paris', windows: [{ kind: 'nap', days: ['sat', 'sun'], start: '20:00', end: '08:00' }], maxNapDays: 7 };
const CUSTOM_REFUSED = 'custom pages are off on this router: an administrator turns them on with dormeto gcp install --custom-pages';
const PAGE_HTML = '<!doctype html><p data-dormeto="status"></p>';
const NO_COUNTS = () => ({ ignored: {}, deferred: {}, wakes: {} });

// A `node:http` request as `serve` hands it to the role.
const request = (method, url, body = '') => {
  const stream = (async function* chunks() { if (body) yield Buffer.from(body); }());
  return Object.assign(stream, { method, url, headers: {} });
};

// The world as the manager reaches it, POST /v1/actions beside the REST routes, over a store with what the Firestore one adds for the
// manager: router/manager (`store.manager`), the journal (`store.events`) and the stats/ counters (`store.stats`, 7 days added up).
function world(change) {
  const t = setup(change);
  const { store, core, onboarding, config, clock, log } = t;
  Object.assign(config, { version: '0.40.0', build: 'b7' });
  Object.assign(store, {
    manager: null,
    events: [],
    stats: new Map(),
    getManagerSettings: async () => structuredClone(store.manager),
    putManagerSettings: async (doc) => {
      store.manager = structuredClone(doc);
    },
    listEvents: async ({ after = null, limit }) => {
      const events = store.events.filter((e) => after === null || e.id > after).slice(0, limit);
      return { events: structuredClone(events), next: events.length === limit ? events.at(-1).id : null };
    },
    getStats: async (id, days) => ({ days, since: '2023-11-08', today: NO_COUNTS(), total: structuredClone(store.stats.get(id) ?? NO_COUNTS()) }),
  });
  const router = { name: `dmtr-${config.region}`, version: config.version, build: config.build };
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

test('router: AWS\'s router answer, routerInfo\'s', async () => {
  const { call, act, core } = world();
  await call('POST', '/v1/workloads', INPUT);
  const res = await act({ action: 'router', refusals: true });
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body), ['router', 'settings', 'managerSettings', 'configuration', 'pauses', 'workloads', 'health']);
  assert.deepEqual(res.body, await core.routerInfo());
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
  assert.deepEqual(row.stats7d, { ignored: 2, deferred: 1, wakes: 4 });
  assert.deepEqual([row.scheduled, row.url, row.source, row.backends], [true, 'https://demo.example.com/', 'cli', ['instance']]);
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
  const res = await act({ action: 'status', workloadId: 'demo', refusals: true });
  assert.equal(res.status, 200);
  const { body } = res;
  for (const key of [...AWS_STATUS, ...GOOGLE]) assert.ok(Object.hasOwn(body, key), key);
  assert.deepEqual([body.targetGroupArn, body.servingTargetGroupArn], [undefined, undefined]);
  // The REST Workload's fields, the same; the backends and the hibernation in AWS's shape.
  const rest = (await call('GET', '/v1/workloads/demo')).body;
  for (const key of Object.keys(rest).filter((k) => k !== 'backends' && k !== 'hibernation')) assert.deepEqual(body[key], rest[key], key);
  assert.deepEqual(body.hibernation, { ...rest.hibernation, manager: { hibernate: false, readAt: iso(clock.now() - 1000), error: null }, instances: null, freshBoot: false });
  assert.deepEqual(body.backends, [{ kind: 'instance', id: 'vm-a', status: null, location: ZONE }]);
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
    { kind: 'k8s', cluster: { location: ZONE, name: 'shop' }, namespace: 'shop', service: 'web', owner: { kind: 'Deployment', name: 'web' } },
    { kind: 'cloudsql', name: 'db' },
  ];
  const { body } = await act({ action: 'status', workloadId: 'demo' });
  assert.deepEqual(body.backends, [
    { kind: 'instance', id: 'vm-a', status: null, location: ZONE },
    { kind: 'asg', id: 'web', status: null, location: REGION },
    { kind: 'k8s', id: `${ZONE}/shop/shop/Deployment/web`, status: null, cluster: `${ZONE}/shop`, namespace: 'shop', owner: { kind: 'Deployment', name: 'web' } },
    { kind: 'cloudsql-instance', id: 'db', status: null, companion: true },
  ]);
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
  assert.deepEqual(pick(w.logs.findLast((l) => l.event === 'PendingWake'), ['reason', 'by']), { reason: 'manager', by: 'ann' });
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
  assert.deepEqual((await call('GET', '/v1/workloads/demo')).body.paused, pause);
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

test('preview, onboard and offboard: the REST dry run\'s, onboarding\'s and offboarding\'s answers, with AWS\'s workloadId and databases; onboarded by the manager', async () => {
  const { call, act, store } = world();
  const asked = { urlMap: 'lb', backendService: 'app', workloadId: 'demo', name: 'Shop', tags: { team: 'a' }, settings: { idleMinutes: 30 } };
  const preview = await act({ action: 'preview', ...asked, refusals: true });
  assert.deepEqual(preview, await call('POST', '/v1/workloads?dryRun=true', { ...INPUT, name: 'Shop', tags: { team: 'a' }, settings: { idleMinutes: 30 } }));
  assert.equal(preview.body.eligible, true);
  const databases = await act({ action: 'preview', ...asked, databases: ['orders'] });
  assert.match(databases.body.reasons.join('; '), /Cloud SQL instance orders/);
  const onboarded = await act({ action: 'onboard', ...asked, by: 'ann', refusals: true });
  assert.equal(onboarded.status, 200);
  assert.deepEqual(onboarded.body, (await call('GET', '/v1/workloads/demo')).body);
  assert.deepEqual([onboarded.body.name, onboarded.body.tags, onboarded.body.settings.idleMinutes], ['Shop', { team: 'a' }, 30]);
  assert.equal(store.configs.get('demo').source, 'manager');
  assert.equal((await act({ action: 'list' })).body.workloads[0].source, 'manager');
  assert.deepEqual((await act({ action: 'onboard', ...asked, refusals: true })).body, { refused: { code: 'conflict', message: 'workload demo is onboarded already' } });
  const offboarded = await act({ action: 'offboard', workloadId: 'demo', by: 'ann', refusals: true });
  assert.deepEqual(offboarded, { status: 200, body: {} });
  assert.equal(store.configs.size, 0);
  assert.equal((await act({ action: 'offboard', workloadId: 'demo', refusals: true })).body.refused.code, 'not_found');
});

test('offboard with force: the REST forced offboarding\'s answer', async () => {
  const { call, act, store, w } = world();
  await call('POST', '/v1/workloads', INPUT);
  store.runs.get('demo').state = STATES.ASLEEP;
  w.vms['vm-a'].status = 'TERMINATED';
  const res = await act({ action: 'offboard', workloadId: 'demo', force: true, by: 'ann' });
  assert.deepEqual(res.body, { id: 'demo', left: [{ kind: 'vm', location: ZONE, name: 'vm-a', id: '1001' }] });
  assert.equal(store.configs.size, 0);
});

const EVENT_A = { id: '1700000000000-demo-NAPPING', workloadId: 'demo', from: STATES.AWAKE, to: STATES.NAPPING, router: `dmtr-${REGION}`, region: REGION, project: 'p', at: iso(1_700_000_000_000), cause: 'idle', tags: {} };
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

test('an action the router does not serve: 400 unknown-action, with refusals or without', async () => {
  const { act, w } = world();
  for (const action of ['unknown', 'ensure-awake', 'report', 'clusterCheck', 'check', 'wake', 'nap', 'release', 'refresh-lists', 'constructor', '__proto__', undefined]) {
    for (const refusals of [true, undefined]) {
      const res = await act({ action, refusals });
      assert.deepEqual(res, { status: 400, body: { error: 'unknown-action', message: `unknown action: ${action}` } }, `${action} ${refusals}`);
    }
  }
  assert.deepEqual(w.tasks, []);
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
