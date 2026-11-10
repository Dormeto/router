import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { STATES } from '../../lambda/src/lib/state.mjs';
import { silentLog } from '../../lambda/test/fakes.mjs';
import { createActions } from '../src/actions.mjs';
import { createControllerApi, fromEnvironment } from '../src/controller.mjs';
import { toFields } from '../src/firestore.mjs';
import { GoogleError } from '../src/google.mjs';
import { createCloudRunWaker } from '../src/waker.mjs';
import { fakeFirestore } from './firestore-fake.mjs';
import {
  CONTROLLER, DEFAULT_FROM, DEFAULT_SETTINGS, INPUT, REGION, V1, WAKER, ZONE, regional, serviceUrl, setup, unmanagedUrl,
} from './world.mjs';

const PACKAGE = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
const PATTERN = '^[a-z]([a-z0-9-]{0,38}[a-z0-9])?$';

// A `node:http` request as `serve` hands it to the role.
const request = (method, url, body = '', headers = {}) => {
  const stream = (async function* chunks() { if (body) yield Buffer.from(body); }());
  return Object.assign(stream, { method, url, headers });
};

// The API over the world, as the CLI, Cloud Tasks and the manager (POST /v1/actions) call it.
function api(change) {
  const world = setup(change);
  const router = { name: `dmtr-${world.config.region}`, version: null, build: null, project: world.config.project, region: world.config.region };
  const actions = createActions({ controller: world.core, onboarding: world.onboarding, store: world.store, router, now: world.clock.now, log: world.log });
  const handler = createControllerApi({ core: world.core, onboarding: world.onboarding, config: world.config, actions });
  const call = async (method, path, body) => {
    const res = await handler(request(method, path, typeof body === 'object' ? JSON.stringify(body) : body));
    return { status: res.statusCode, body: JSON.parse(res.body), type: res.multiValueHeaders['content-type'][0], cache: res.multiValueHeaders['cache-control'][0] };
  };
  return { ...world, handler, call };
}

test('GET /v1/health: the version built into the image, the project, the region', async () => {
  const { call } = api();
  const res = await call('GET', '/v1/health');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { version: PACKAGE.version, project: 'p', region: REGION });
  assert.equal(res.type, 'application/json');
  assert.equal(res.cache, 'no-store');
});

test('GET /v1/workloads: none, then each as a Workload the CLI can read', async () => {
  const { call, clock } = api();
  assert.deepEqual(await call('GET', '/v1/workloads').then((r) => [r.status, r.body]), [200, []]);
  await call('POST', '/v1/workloads', INPUT);
  const res = await call('GET', '/v1/workloads');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, [{
    workloadId: 'demo',
    id: 'demo',
    pauses: [],
    name: 'demo',
    tags: {},
    state: STATES.AWAKE,
    urlMap: 'lb',
    backendService: 'app',
    wakerBackendService: WAKER,
    hosts: ['demo.example.com'],
    lb: { kind: 'global' },
    settings: DEFAULT_SETTINGS,
    settingsFrom: DEFAULT_FROM,
    type: { name: 'instance', from: 'backends' },
    noWakeRules: [],
    wakeRules: [],
    hibernation: { hibernate: true, from: 'default', workload: null, router: null, manager: null },
    backends: [{ kind: 'vm', location: ZONE, name: 'vm-a', id: '1001' }],
    // The CLI reads it as a string: a number would fail its decoding.
    awakeSince: new Date(clock.now()).toISOString(),
  }]);
});

test('GET /v1/workloads/:id: the Workload; unknown: 404; a bad ID: 400 naming the pattern', async () => {
  const { call } = api();
  const unknown = await call('GET', '/v1/workloads/demo');
  assert.equal(unknown.status, 404);
  assert.deepEqual(unknown.body, { error: 'no workload demo', reason: 'not-found' });
  const bad = await call('GET', '/v1/workloads/Bad_ID');
  assert.equal(bad.status, 400);
  assert.equal(bad.body.reason, 'bad-request');
  assert.ok(bad.body.error.includes(PATTERN), bad.body.error);
  const encoded = await call('GET', '/v1/workloads/%2e%2e%2Fx');
  assert.equal(encoded.status, 400);
  assert.ok(encoded.body.error.includes(PATTERN), encoded.body.error);
  const malformed = await call('GET', '/v1/workloads/%E0%A4%A');
  assert.equal(malformed.status, 400);
  await call('POST', '/v1/workloads', INPUT);
  const found = await call('GET', '/v1/workloads/demo');
  assert.equal(found.status, 200);
  assert.equal(found.body.id, 'demo');
  assert.equal(found.body.state, STATES.AWAKE);
});

test('POST /v1/workloads?dryRun=true: eligible with the VMs and the groups, or the reasons, a 200 either way', async () => {
  const { call, w, store } = api();
  const res = await call('POST', '/v1/workloads?dryRun=true', INPUT);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    eligible: true, reasons: [], vms: [{ zone: ZONE, name: 'vm-a', selfLink: `${V1}/zones/${ZONE}/instances/vm-a`, id: '1001' }], groups: [], databases: [], lb: { kind: 'global' },
  });
  assert.deepEqual(w.changes, []);
  assert.equal(store.configs.size, 0);
  delete w.services.app.healthChecks;
  const refused = await call('POST', '/v1/workloads?dryRun=true', INPUT);
  assert.equal(refused.status, 200);
  assert.equal(refused.body.eligible, false);
  assert.match(refused.body.reasons[0], /no health check/);
});

test('POST /v1/workloads: the Workload; twice: 409; not eligible: 400; bad input: 400', async () => {
  const { call, w } = api();
  const created = await call('POST', '/v1/workloads', { ...INPUT, settings: { idleMinutes: 30 } });
  assert.equal(created.status, 200);
  assert.equal(created.body.id, 'demo');
  assert.equal(created.body.state, STATES.AWAKE);
  assert.equal(created.body.settings.idleMinutes, 30);
  const twice = await call('POST', '/v1/workloads', INPUT);
  assert.equal(twice.status, 409);
  assert.deepEqual(twice.body, { error: 'workload demo is onboarded already', reason: 'exists' });
  w.services.other.backends = [{ group: `${V1}/zones/${ZONE}/networkEndpointGroups/neg` }];
  const ineligible = await call('POST', '/v1/workloads', { urlMap: 'lb', backendService: 'other', id: 'second' });
  assert.equal(ineligible.status, 400);
  assert.equal(ineligible.body.reason, 'not-eligible');
  assert.match(ineligible.body.error, /^cannot onboard second: .*network endpoint group/);
  const noFields = await call('POST', '/v1/workloads', {});
  assert.equal(noFields.status, 400);
  assert.deepEqual(noFields.body, { error: 'urlMap and backendService are needed', reason: 'bad-request' });
  const noBody = await call('POST', '/v1/workloads');
  assert.equal(noBody.status, 400);
  const notJson = await call('POST', '/v1/workloads', '{');
  assert.equal(notJson.status, 400);
  assert.equal(notJson.body.reason, 'bad-request');
  const notObject = await call('POST', '/v1/workloads', '[]');
  assert.equal(notObject.status, 400);
  const tooBig = await call('POST', '/v1/workloads', JSON.stringify({ ...INPUT, padding: 'x'.repeat(2_000_000) }));
  assert.equal(tooBig.status, 400);
  const badId = await call('POST', '/v1/workloads', { ...INPUT, id: 'Bad_ID' });
  assert.equal(badId.status, 400);
  assert.ok(badId.body.error.includes(PATTERN), badId.body.error);
});

test('DELETE /v1/workloads/:id: 200 once it is gone; unknown: 404; a bad ID: 400; busy: 409', async () => {
  const { call, w, store } = api();
  assert.equal((await call('DELETE', '/v1/workloads/demo')).status, 404);
  assert.equal((await call('DELETE', '/v1/workloads/Bad_ID')).status, 400);
  await call('POST', '/v1/workloads', INPUT);
  store.runs.get('demo').state = STATES.NAPPING;
  const busy = await call('DELETE', '/v1/workloads/demo');
  assert.equal(busy.status, 409);
  assert.equal(busy.body.reason, 'busy');
  store.runs.get('demo').state = STATES.AWAKE;
  const res = await call('DELETE', '/v1/workloads/demo');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {});
  assert.equal(store.configs.size, 0);
  assert.equal(w.services[WAKER], undefined);
});

test('DELETE /v1/workloads/:id?force=true: without the wake, what was left down named; any other value: 400', async () => {
  const { call, w, store } = api();
  await call('POST', '/v1/workloads', INPUT);
  delete w.vms['vm-a'];
  store.runs.get('demo').state = STATES.ASLEEP;
  const plain = await call('DELETE', '/v1/workloads/demo');
  assert.equal(plain.status, 409);
  assert.equal(plain.body.reason, 'wake-failed');
  assert.match(plain.body.error, /--force/);
  for (const value of ['false', '', '1', 'TRUE']) {
    const res = await call('DELETE', `/v1/workloads/demo?force=${value}`);
    assert.equal(res.status, 400, value);
    assert.equal(res.body.reason, 'bad-request');
    assert.match(res.body.error, /force/);
  }
  assert.equal(store.configs.size, 1);
  const forced = await call('DELETE', '/v1/workloads/demo?force=true');
  assert.equal(forced.status, 200);
  assert.deepEqual(forced.body, { id: 'demo', left: [{ kind: 'vm', location: ZONE, name: 'vm-a', id: '1001' }] });
  assert.equal(store.configs.size, 0);
  assert.equal(w.services[WAKER], undefined);
  assert.equal((await call('DELETE', '/v1/workloads/demo?force=true')).status, 404);
});

test('POST /v1/workloads/:id/nap and /wake: the Workload; unknown: 404; busy: 409', async () => {
  const { call, w, store, clock } = api();
  for (const verb of ['nap', 'wake']) {
    assert.equal((await call('POST', `/v1/workloads/demo/${verb}`)).status, 404);
    assert.equal((await call('POST', `/v1/workloads/Bad_ID/${verb}`)).status, 400);
  }
  await call('POST', '/v1/workloads', INPUT);
  const nap = await call('POST', '/v1/workloads/demo/nap');
  assert.equal(nap.status, 200);
  assert.equal(nap.body.id, 'demo');
  assert.deepEqual(w.tasks.at(-1).body, { action: 'nap', workloadId: 'demo', cause: 'operator', requestedAt: clock.now() });
  store.runs.get('demo').state = STATES.ASLEEP;
  const wake = await call('POST', '/v1/workloads/demo/wake');
  assert.equal(wake.status, 200);
  assert.equal(wake.body.state, STATES.WAKING);
  assert.deepEqual(w.tasks.at(-1).body, { action: 'wake', workloadId: 'demo', wakeId: 'wake-1' });
  const busy = await call('POST', '/v1/workloads/demo/wake');
  assert.equal(busy.status, 409);
  assert.deepEqual(busy.body, { error: 'workload demo is WAKING', reason: 'busy' });
});

test('POST /v1/tasks: wake, nap and release reach the core', async () => {
  const { call, w, store, clock } = api();
  await call('POST', '/v1/workloads', INPUT);
  w.vms['vm-a'].status = 'TERMINATED';
  Object.assign(store.runs.get('demo'), { state: STATES.WAKING, wakeId: 'w1', wakeStartedAt: clock.now() });
  const superseded = await call('POST', '/v1/tasks', { action: 'wake', workloadId: 'demo', wakeId: 'other' });
  assert.equal(superseded.status, 200);
  assert.equal(superseded.body.state, 'SUPERSEDED');
  w.changes.length = 0;
  const skipped = await call('POST', '/v1/tasks', { action: 'release', workloadId: 'demo' });
  assert.equal(skipped.status, 200);
  assert.deepEqual(skipped.body, { state: 'SKIPPED', reason: STATES.WAKING });
  const nap = await call('POST', '/v1/tasks', { action: 'nap', workloadId: 'demo' });
  assert.equal(nap.status, 200);
  assert.deepEqual(nap.body, { state: 'SKIPPED' });
});

test('POST /v1/tasks: a wake task runs the wake to its end in the request', async () => {
  const { call, w, store, clock } = api();
  await call('POST', '/v1/workloads', INPUT);
  w.vms['vm-a'].status = 'TERMINATED';
  Object.assign(store.runs.get('demo'), { state: STATES.WAKING, wakeId: 'w1', wakeStartedAt: clock.now() });
  const res = await call('POST', '/v1/tasks', { action: 'wake', workloadId: 'demo', wakeId: 'w1' });
  assert.equal(res.status, 200);
  assert.equal(res.body.state, STATES.AWAKE);
  assert.equal(w.vms['vm-a'].status, 'RUNNING');
});

test('POST /v1/tasks: what is not a task is a 400, a workload gone a 404', async () => {
  const { call } = api();
  const unknownAction = await call('POST', '/v1/tasks', { action: 'constructor', workloadId: 'demo' });
  assert.equal(unknownAction.status, 400);
  assert.equal(unknownAction.body.reason, 'bad-request');
  assert.match(unknownAction.body.error, /wake, nap or release/);
  assert.equal((await call('POST', '/v1/tasks', { action: 'wake', workloadId: 'Bad_ID', wakeId: 'w' })).status, 400);
  assert.equal((await call('POST', '/v1/tasks', { action: 'nap' })).status, 400);
  const gone = await call('POST', '/v1/tasks', { action: 'nap', workloadId: 'demo' });
  assert.equal(gone.status, 404);
  assert.deepEqual(gone.body, { error: 'no workload demo', reason: 'not-found' });
});

test('POST /v1/tasks: refreshLists needs no workload ID, any other action does', async () => {
  const { call } = api();
  const refresh = await call('POST', '/v1/tasks', { action: 'refreshLists', names: ['scanners'] });
  assert.equal(refresh.status, 200);
  assert.deepEqual(refresh.body, { results: [] });
  const wake = await call('POST', '/v1/tasks', { action: 'wake', wakeId: 'w1' });
  assert.equal(wake.status, 400);
  assert.equal(wake.body.reason, 'bad-request');
  assert.equal((await call('POST', '/v1/tasks', { action: 'refreshLists', names: 'scanners' })).status, 400);
});

test('POST /v1/tasks: a wake without its wakeId is a 400', async () => {
  const { call } = api();
  await call('POST', '/v1/workloads', INPUT);
  const res = await call('POST', '/v1/tasks', { action: 'wake', workloadId: 'demo' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /wakeId/);
});

test('POST /v1/check: what the check found, workload by workload', async () => {
  const { call } = api();
  await call('POST', '/v1/workloads', INPUT);
  const res = await call('POST', '/v1/check');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { results: [{ workloadId: 'demo', state: STATES.AWAKE }] });
});

test('POST /v1/check: Cloud Scheduler\'s call (its user agent) is the scheduled check; an operator\'s is not', async () => {
  const { handler, clock, store } = api();
  const post = (headers) => handler(request('POST', '/v1/check', '', headers));
  await post({ 'user-agent': 'curl/8.7.1' });
  assert.equal((await store.getCheck()).lastScheduledCheckAt, null);
  await post({ 'user-agent': 'Google-Cloud-Scheduler' });
  assert.equal((await store.getCheck()).lastScheduledCheckAt, clock.now());
  clock.advance(60_000);
  await post({});
  assert.equal((await store.getCheck()).lastScheduledCheckAt, clock.now() - 60_000);
});

test('POST /v1/tasks: a nap task passes on what the check asked it with', async () => {
  const { call, store, clock, w } = api();
  await call('POST', '/v1/workloads', INPUT);
  clock.advance(1000);
  const body = { action: 'nap', workloadId: 'demo', cause: 'schedule', requestedAt: clock.now(), until: clock.now() };
  assert.deepEqual((await call('POST', '/v1/tasks', body)).body, { state: 'SKIPPED', reason: 'the nap window ended' });
  assert.equal(store.runs.get('demo').state, STATES.AWAKE);
  assert.deepEqual(w.changes.filter((line) => line.startsWith('stop')), []);
  await call('POST', '/v1/tasks', { ...body, until: clock.now() + 3_600_000 });
  assert.equal(w.logs.find((l) => l.event === 'StateChanged' && l.to === STATES.NAPPING).cause, 'schedule');
});

// --- Schedules and pauses --------------------------------------------------------------------------------------------

const NO_SCHEDULE = { schedule: null, nextEvents: [], joinMinutes: 15, joinFrom: 'default', joinInherited: { joinMinutes: 15, joinFrom: 'default' } };
const SCHEDULE = { timeZone: 'europe/paris', windows: [{ kind: 'nap', days: ['sat', 'sun'], start: '20:00', end: '08:00' }], maxNapDays: 7 };

test('GET /v1/workloads/:id/schedule: none, then the schedule and its next events', async () => {
  const { call, clock } = api();
  assert.equal((await call('GET', '/v1/workloads/demo/schedule')).status, 404);
  assert.equal((await call('GET', '/v1/workloads/Bad_ID/schedule')).status, 400);
  await call('POST', '/v1/workloads', INPUT);
  assert.deepEqual((await call('GET', '/v1/workloads/demo/schedule')).body, NO_SCHEDULE);
  await call('PUT', '/v1/workloads/demo/schedule', { ...SCHEDULE, by: 'ops' });
  const res = await call('GET', '/v1/workloads/demo/schedule');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.schedule, { timeZone: 'Europe/Paris', windows: SCHEDULE.windows, maxNapDays: 7, by: 'ops', at: new Date(clock.now()).toISOString() });
  assert.deepEqual(res.body.nextEvents[0], { at: '2023-11-18T19:00:00.000Z', kind: 'nap-start', window: 0 });
});

test('PUT /v1/workloads/:id/schedule: stored as normalized, answered with its next events; unknown: 404', async () => {
  const { call, store, clock } = api();
  assert.equal((await call('PUT', '/v1/workloads/demo/schedule', SCHEDULE)).status, 404);
  await call('POST', '/v1/workloads', INPUT);
  const res = await call('PUT', '/v1/workloads/demo/schedule', SCHEDULE);
  assert.equal(res.status, 200);
  assert.equal(res.body.schedule.timeZone, 'Europe/Paris');
  assert.equal(res.body.schedule.by, 'unknown');
  assert.equal(res.body.nextEvents.length > 0, true);
  assert.deepEqual(store.schedules.get('demo'), { timeZone: 'Europe/Paris', windows: SCHEDULE.windows, maxNapDays: 7, by: 'unknown', at: clock.now() });
  // A schedule read back can be sent again as it is.
  const again = await call('PUT', '/v1/workloads/demo/schedule', res.body.schedule);
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, res.body);
});

test('PUT /v1/workloads/:id/schedule: a recurrence is stored as sent, a bad cron is refused, the overlap counts from its clock', async () => {
  const { call, store } = api();
  await call('POST', '/v1/workloads', INPUT);
  const windows = [{ kind: 'awake', repeat: { pattern: 'cron', cron: '30 8 1 * *', minutes: 630 }, from: '2023-12-01', until: '2030-12-31' }];
  const res = await call('PUT', '/v1/workloads/demo/schedule', { timeZone: 'Europe/Paris', windows });
  assert.equal(res.status, 200);
  assert.deepEqual(store.schedules.get('demo').windows, windows);
  assert.deepEqual(res.body.nextEvents[0], { at: '2023-12-01T07:30:00.000Z', kind: 'awake-start', window: 0 });
  const bad = await call('PUT', '/v1/workloads/demo/schedule', { timeZone: 'UTC', windows: [{ kind: 'awake', repeat: { pattern: 'cron', cron: 'cron(0 8 * * ? *)', minutes: 60 } }] });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'windows[0].repeat.cron: five fields: minute hour day-of-month month day-of-week');
  // Overlapping up to 2025 only: still to come at the world's clock, past on any real date.
  const overlapping = await call('PUT', '/v1/workloads/demo/schedule', {
    timeZone: 'UTC',
    windows: [{ kind: 'awake', days: ['mon'], start: '08:00', end: '12:00', until: '2025-01-06' }, { kind: 'nap', days: ['mon'], start: '08:00', end: '12:00' }],
  });
  assert.equal(overlapping.status, 400);
  assert.match(overlapping.body.error, /^windows\[1\]: the nap window overlaps the awake window windows\[0\] \(2023-/);
});

test('schedule: no manager, so the workload\'s joinMinutes then the default; the answer says which', async () => {
  const { call, store } = api();
  await call('POST', '/v1/workloads', INPUT);
  assert.deepEqual((await call('GET', '/v1/workloads/demo/schedule')).body, NO_SCHEDULE);
  const windows = [{ kind: 'awake', days: ['mon'], start: '08:00', end: '12:00' }, { kind: 'awake', days: ['mon'], start: '12:10', end: '18:00' }];
  const inherited = await call('PUT', '/v1/workloads/demo/schedule', { timeZone: 'UTC', windows });
  assert.deepEqual([inherited.body.joinMinutes, inherited.body.joinFrom], [15, 'default']);
  assert.deepEqual(inherited.body.nextEvents.slice(0, 2).map((e) => e.kind), ['awake-start', 'awake-start']);
  const own = await call('PUT', '/v1/workloads/demo/schedule', { timeZone: 'UTC', windows, joinMinutes: 0 });
  assert.deepEqual([own.body.joinMinutes, own.body.joinFrom, own.body.joinInherited], [0, 'workload', { joinMinutes: 15, joinFrom: 'default' }]);
  assert.deepEqual(own.body.nextEvents.slice(0, 2).map((e) => e.kind), ['awake-start', 'awake-end']);
  assert.equal(store.schedules.get('demo').joinMinutes, 0);
  const bad = await call('PUT', '/v1/workloads/demo/schedule', { timeZone: 'UTC', windows, joinMinutes: 7 });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'joinMinutes: a whole number from 0 to 120, a multiple of 5');
});

// The router level's joinMinutes (PUT /v1/settings), as AWS's: the check, the waker and the schedule's answer resolve it through the
// same levels (lambda/src/lib/schedule.mjs's resolveJoin), so that they agree on where a nap window ends.
test('a router joinMinutes 0, a schedule with none of its own: the check\'s nap, the waker\'s page and its probe end with the first of two nap windows 10 minutes apart; the answer names the router', async () => {
  const { call, store, clock, w } = api();
  await call('POST', '/v1/workloads', INPUT);
  // On the fake clock, Tuesday 22:13 UTC, in the first window: by default (15 minutes) the two join, until 23:50.
  const windows = [{ kind: 'nap', days: ['tue'], start: '22:00', end: '23:00' }, { kind: 'nap', days: ['tue'], start: '23:10', end: '23:50' }];
  const joined = await call('PUT', '/v1/workloads/demo/schedule', { timeZone: 'UTC', windows });
  assert.deepEqual([joined.body.joinMinutes, joined.body.joinFrom], [15, 'default']);
  assert.equal((await call('PUT', '/v1/settings', { joinMinutes: 0, by: 'ops' })).status, 200);
  const answer = (await call('GET', '/v1/workloads/demo/schedule')).body;
  assert.deepEqual([answer.joinMinutes, answer.joinFrom, answer.joinInherited], [0, 'router', { joinMinutes: 0, joinFrom: 'router' }]);
  const END = '2023-11-14T23:00:00.000Z';
  assert.deepEqual(answer.nextEvents[0], { at: END, kind: 'nap-end', window: 0 });
  // The check's nap.
  await call('POST', '/v1/check');
  assert.deepEqual(w.tasks.map(({ body }) => [body.action, body.cause, body.until]), [['nap', 'schedule', Date.parse(END)]]);
  // The waker on the same store, once the nap is done: its page and its probe say the same end.
  store.runs.get('demo').state = STATES.ASLEEP;
  const waker = createCloudRunWaker({ store, tasks: { enqueue: async () => assert.fail('a nap window wakes nothing') }, controllerUrl: CONTROLLER, now: clock.now, log: silentLog });
  const headers = { 'x-dormeto-workload': 'demo', 'x-forwarded-for': '1.2.3.4, 35.1.1.1', 'user-agent': 'Mozilla/5.0' };
  const page = await waker({ method: 'GET', url: '/_dormeto/waiting', headers });
  assert.equal(page.multiValueHeaders['x-dormeto-nap-until'][0], END);
  assert.match(page.body, /Napping on schedule until Tue 23:00 \(UTC\)/);
  const probed = await waker({ method: 'GET', url: '/_dormeto/wake', headers: { ...headers, accept: '*/*', 'x-dormeto-probe': '1' } });
  assert.equal(probed.multiValueHeaders['x-dormeto-nap-until'][0], END);
  // The schedule's own value wins over the router's, everywhere.
  await call('PUT', '/v1/workloads/demo/schedule', { timeZone: 'UTC', windows, joinMinutes: 15 });
  const own = (await call('GET', '/v1/workloads/demo/schedule')).body;
  assert.deepEqual([own.joinMinutes, own.joinFrom, own.joinInherited], [15, 'workload', { joinMinutes: 0, joinFrom: 'router' }]);
  const later = await waker({ method: 'GET', url: '/_dormeto/waiting', headers });
  assert.equal(later.multiValueHeaders['x-dormeto-nap-until'][0], '2023-11-14T23:50:00.000Z');
});

test('a router level that cannot be read: the schedule\'s answer as with none, said in JoinLevelUnreadable, as AWS\'s', async () => {
  const { call, store, w } = api();
  await call('POST', '/v1/workloads', INPUT);
  store.getRouterSettings = async () => { throw new Error('Google: 503 firestore'); };
  const res = await call('GET', '/v1/workloads/demo/schedule');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, NO_SCHEDULE);
  assert.deepEqual(w.logs.filter((l) => l.event === 'JoinLevelUnreadable').map(({ level, error }) => ({ level, error })), [{ level: 'router', error: 'Google: 503 firestore' }]);
});

test('PUT /v1/workloads/:id/schedule: a bad schedule → 400 with scheduleProblems\' words, nothing stored', async () => {
  const { call, store } = api();
  await call('POST', '/v1/workloads', INPUT);
  const res = await call('PUT', '/v1/workloads/demo/schedule', { windows: [{ kind: 'nap', days: ['someday'], start: '20:00', end: '08:00' }], other: 1 });
  assert.equal(res.status, 400);
  assert.equal(res.body.reason, 'bad-request');
  assert.equal(res.body.error, 'timeZone: required with windows; windows[0].days: one or more of mon, tue, wed, thu, fri, sat, sun, each once; other: unknown field');
  const empty = await call('PUT', '/v1/workloads/demo/schedule', {});
  assert.equal(empty.status, 400);
  assert.equal(empty.body.error, 'schedule: windows or maxNapDays required');
  assert.equal(store.schedules.size, 0);
});

test('DELETE /v1/workloads/:id/schedule: gone, and none left is no failure; unknown: 404', async () => {
  const { call, store, w } = api();
  assert.equal((await call('DELETE', '/v1/workloads/demo/schedule')).status, 404);
  await call('POST', '/v1/workloads', INPUT);
  await call('PUT', '/v1/workloads/demo/schedule', SCHEDULE);
  for (const cleared of [true, false]) {
    const res = await call('DELETE', '/v1/workloads/demo/schedule');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, NO_SCHEDULE);
    assert.equal(w.logs.findLast((l) => l.event === 'ScheduleCleared').cleared, cleared);
  }
  assert.equal(store.schedules.size, 0);
});

test('GET /v1/workloads/:id/schedule: one the router cannot read is shown, with no next events, logged', async () => {
  const { call, store, w } = api();
  await call('POST', '/v1/workloads', INPUT);
  store.schedules.set('demo', { ...SCHEDULE, timeZone: 'Nowhere/Land', at: 1 });
  const res = await call('GET', '/v1/workloads/demo/schedule');
  assert.equal(res.status, 200);
  assert.equal(res.body.schedule.timeZone, 'Nowhere/Land');
  assert.deepEqual(res.body.nextEvents, []);
  assert.equal(w.logs.filter((l) => l.event === 'ScheduleSkipped').length, 1);
});

test('POST /v1/workloads/:id/pause: the Workload with its pause; a sleeper woken; unknown: 404; a bad one: 400', async () => {
  const { call, store, clock, w } = api();
  assert.equal((await call('POST', '/v1/workloads/demo/pause', { reason: 'r' })).status, 404);
  assert.equal((await call('POST', '/v1/workloads/Bad_ID/pause', { reason: 'r' })).status, 400);
  await call('POST', '/v1/workloads', INPUT);
  store.runs.get('demo').state = STATES.ASLEEP;
  const until = new Date(clock.now() + 3_600_000).toISOString();
  const res = await call('POST', '/v1/workloads/demo/pause', { reason: 'load test', by: 'ops', until });
  assert.equal(res.status, 200);
  assert.equal(res.body.state, STATES.WAKING);
  assert.deepEqual(res.body.paused, { by: 'ops', at: new Date(clock.now()).toISOString(), reason: 'load test', until, keepAsleep: false });
  assert.deepEqual(w.tasks.at(-1).body, { action: 'wake', workloadId: 'demo', wakeId: 'wake-1' });
  for (const [body, words] of [[{}, /reason required/], [{ reason: 'r', until: 'soon' }, /until must be/], [{ reason: 'r', keepAsleep: 'yes' }, /keepAsleep must be/]]) {
    const refused = await call('POST', '/v1/workloads/demo/pause', body);
    assert.equal(refused.status, 400, JSON.stringify(body));
    assert.equal(refused.body.reason, 'bad-request');
    assert.match(refused.body.error, words);
  }
});

test('POST /v1/workloads/:id/pause with keepAsleep: the sleeper stays asleep', async () => {
  const { call, store, w } = api();
  await call('POST', '/v1/workloads', INPUT);
  store.runs.get('demo').state = STATES.ASLEEP;
  const res = await call('POST', '/v1/workloads/demo/pause', { reason: 'load test', keepAsleep: true });
  assert.equal(res.body.state, STATES.ASLEEP);
  assert.equal(res.body.paused.keepAsleep, true);
  assert.deepEqual(w.tasks, []);
});

test('POST /v1/workloads/:id/resume: the Workload without its pause, with or without one; unknown: 404', async () => {
  const { call } = api();
  assert.equal((await call('POST', '/v1/workloads/demo/resume')).status, 404);
  await call('POST', '/v1/workloads', INPUT);
  await call('POST', '/v1/workloads/demo/pause', { reason: 'load test' });
  for (const body of [{ by: 'ops' }, undefined]) {
    const res = await call('POST', '/v1/workloads/demo/resume', body);
    assert.equal(res.status, 200);
    assert.equal(res.body.id, 'demo');
    assert.equal(res.body.paused, undefined);
  }
});

test('POST /v1/pause and /v1/resume: the router\'s pause and its resume; a bad body: 400', async () => {
  const { call, store, clock, w } = api();
  await call('POST', '/v1/workloads', INPUT);
  store.runs.get('demo').state = STATES.ASLEEP;
  const until = new Date(clock.now() + 3_600_000).toISOString();
  const res = await call('POST', '/v1/pause', { reason: 'maintenance', by: 'ops', until });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { pause: { scope: 'router', by: 'ops', at: new Date(clock.now()).toISOString(), reason: 'maintenance', until, keepAsleep: false }, woken: ['demo'] });
  assert.equal(store.runs.get('demo').state, STATES.WAKING);
  assert.deepEqual(w.tasks.at(-1).body, { action: 'wake', workloadId: 'demo', wakeId: 'wake-1' });
  assert.equal((await call('GET', '/v1/workloads/demo')).body.paused.scope, 'router');
  for (const [body, words] of [[{}, /reason required/], [{ reason: 'r', until: 'soon' }, /until must be/], [{ reason: 'r', keepAsleep: 'yes' }, /keepAsleep must be/]]) {
    const refused = await call('POST', '/v1/pause', body);
    assert.equal(refused.status, 400, JSON.stringify(body));
    assert.equal(refused.body.reason, 'bad-request');
    assert.match(refused.body.error, words);
  }
  for (const body of [{ by: 'ops' }, undefined]) {
    const resumed = await call('POST', '/v1/resume', body);
    assert.equal(resumed.status, 200);
    assert.deepEqual(resumed.body, { resumed: body !== undefined });
  }
  assert.equal(store.pauses.size, 0);
});

test('GET /v1/workloads and /:id show the pause, not an expired one', async () => {
  const { call, clock } = api();
  await call('POST', '/v1/workloads', INPUT);
  assert.equal((await call('GET', '/v1/workloads/demo')).body.paused, undefined);
  await call('POST', '/v1/workloads/demo/pause', { reason: 'load test', until: clock.now() + 60_000 });
  assert.equal((await call('GET', '/v1/workloads/demo')).body.paused.reason, 'load test');
  assert.equal((await call('GET', '/v1/workloads')).body[0].paused.reason, 'load test');
  clock.advance(60_000);
  assert.equal((await call('GET', '/v1/workloads/demo')).body.paused, undefined);
  assert.equal((await call('GET', '/v1/workloads')).body[0].paused, undefined);
});

test('POST /v1/workloads/:id/nap of a paused workload: a 409 saying whose pause, no task', async () => {
  const { call, w } = api();
  await call('POST', '/v1/workloads', INPUT);
  await call('POST', '/v1/workloads/demo/pause', { reason: 'load test', by: 'ops' });
  const res = await call('POST', '/v1/workloads/demo/nap');
  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { error: 'workload demo is paused by ops: load test', reason: 'paused' });
  assert.deepEqual(w.tasks, []);
  await call('POST', '/v1/workloads/demo/resume');
  assert.equal((await call('POST', '/v1/workloads/demo/nap')).status, 200);
});

test('an offboarding takes the schedule and the pause with it', async () => {
  const { call, store } = api();
  await call('POST', '/v1/workloads', INPUT);
  await call('PUT', '/v1/workloads/demo/schedule', SCHEDULE);
  await call('POST', '/v1/workloads/demo/pause', { reason: 'load test' });
  assert.equal((await call('DELETE', '/v1/workloads/demo')).status, 200);
  assert.equal(store.schedules.size + store.pauses.size, 0);
});

// --- Settings by level (vision docs/specs/2026-11-08-google-cloud-router-features-design.md, section 4.5) --------------------------

const WAIT_FIXED = 'settings: waitSeconds is 0 on Google Cloud: the waker holds no request, it answers the waiting page at once and the page waits for the wake';
const BROWSER_ONLY = 'settings: the global load balancer\'s waiting page can\'t see the visitor\'s request, so only the page\'s probe, an explicit wake or a wake rule wakes it (wake mode browser)';

test('PUT /v1/workloads/:id/settings: AWS\'s answer; a level\'s refusal: 400 with the problems, nothing written; unknown: 404; a bad ID or body: 400', async () => {
  const { call, store, w } = api();
  assert.equal((await call('PUT', '/v1/workloads/demo/settings', { idleMinutes: 30 })).status, 404);
  assert.equal((await call('PUT', '/v1/workloads/Bad_ID/settings', { idleMinutes: 30 })).status, 400);
  await call('POST', '/v1/workloads', INPUT);
  const res = await call('PUT', '/v1/workloads/demo/settings', { idleMinutes: 30, hibernate: false, by: 'ops' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    level: 'workload',
    settings: { idleMinutes: 30, hibernate: false },
    hibernation: { hibernate: false, from: 'workload', workload: false, router: null, manager: null },
    resolved: { settings: { ...DEFAULT_SETTINGS, idleMinutes: 30 }, settingsFrom: { ...DEFAULT_FROM, idleMinutes: 'workload' }, type: { name: 'instance', from: 'backends' } },
  });
  assert.equal(w.logs.find((l) => l.event === 'WorkloadSettings').by, 'ops');
  const before = structuredClone(store.configs.get('demo'));
  const refused = await call('PUT', '/v1/workloads/demo/settings', { waitSeconds: 30, wakeMode: 'any' });
  assert.equal(refused.status, 400);
  assert.deepEqual(refused.body, { error: `${WAIT_FIXED}; ${BROWSER_ONLY}`, reason: 'bad-request', problems: [WAIT_FIXED, BROWSER_ONLY] });
  assert.deepEqual(store.configs.get('demo'), before);
  for (const body of ['{', '[]']) assert.equal((await call('PUT', '/v1/workloads/demo/settings', body)).status, 400);
});

test('GET /v1/workloads/:id: each setting resolved, where it comes from, the type and the rules', async () => {
  const { call, store } = api();
  await call('POST', '/v1/workloads', { ...INPUT, settings: { noWakeRules: [{ name: 'health', pathPrefixes: ['/health'] }] } });
  store.router.settings = { defaults: { idleMinutes: 5 }, by: 'ops', at: 1 };
  const { body } = await call('GET', '/v1/workloads/demo');
  assert.deepEqual(body.settings, { ...DEFAULT_SETTINGS, idleMinutes: 5 });
  assert.deepEqual(body.settingsFrom, { ...DEFAULT_FROM, idleMinutes: 'router' });
  assert.deepEqual(body.type, { name: 'instance', from: 'backends' });
  assert.deepEqual(body.noWakeRules, [{ name: 'health', level: 'workload', conditions: { pathPrefixes: ['/health'] } }]);
  assert.deepEqual(body.wakeRules, []);
});

test('GET /v1/settings: the router level, none as AWS\'s empty answer; PUT: stored and answered; a refusal: 400 with the problems', async () => {
  const { call, store, clock } = api();
  const none = await call('GET', '/v1/settings');
  assert.equal(none.status, 200);
  assert.deepEqual(none.body, { level: 'router', settings: { hibernate: null, joinMinutes: null, by: null, at: null } });
  const set = await call('PUT', '/v1/settings', { hibernate: false, defaults: { idleMinutes: 30 }, by: 'ops' });
  assert.equal(set.status, 200);
  const settings = { hibernate: false, joinMinutes: null, defaults: { idleMinutes: 30 }, by: 'ops', at: new Date(clock.now()).toISOString() };
  assert.deepEqual(set.body, { level: 'router', settings });
  assert.deepEqual((await call('GET', '/v1/settings')).body, { level: 'router', settings });
  const refused = await call('PUT', '/v1/settings', { defaults: { waitSeconds: 30 } });
  assert.equal(refused.status, 400);
  const problem = WAIT_FIXED.replace('settings: ', 'settings: defaults: ');
  assert.deepEqual(refused.body, { error: problem, reason: 'bad-request', problems: [problem] });
  assert.deepEqual(store.router.settings, { hibernate: false, defaults: { idleMinutes: 30 }, by: 'ops', at: clock.now() });
  for (const body of ['{', '[]']) assert.equal((await call('PUT', '/v1/settings', body)).status, 400);
});

// --- The waiting page (vision docs/specs/2026-11-08-google-cloud-router-features-design.md, section 5.2) ---------------------------

const CUSTOM_REFUSED = 'custom pages are off on this router: an administrator turns them on with dormeto gcp install --custom-pages';
const PAGE_HTML = '<!doctype html><p data-dormeto="status"></p>';

test('GET|PUT|DELETE /v1/waiting-page and /v1/workloads/:id/waiting-page: AWS\'s answer; the page\'s refusal: 400 with the problems; unknown: 404', async () => {
  const { call, store, clock } = api();
  assert.equal((await call('GET', '/v1/workloads/demo/waiting-page')).status, 404);
  assert.equal((await call('PUT', '/v1/workloads/Bad_ID/waiting-page', { page: { mode: 'template' } })).status, 400);
  await call('POST', '/v1/workloads', INPUT);
  const at = new Date(clock.now()).toISOString();
  const router = await call('PUT', '/v1/waiting-page', { page: { mode: 'template', title: 'Acme' }, by: 'adm' });
  assert.equal(router.status, 200);
  assert.deepEqual(Object.keys(router.body), ['own', 'inherited', 'effective', 'from', 'favicon', 'warnings', 'terraform', 'by', 'at']);
  assert.deepEqual([router.body.own, router.body.by, router.body.at, router.body.terraform], [{ mode: 'template', title: 'Acme' }, 'adm', at, false]);
  assert.deepEqual((await call('GET', '/v1/waiting-page')).body, router.body);
  const own = await call('PUT', '/v1/workloads/demo/waiting-page', { page: { mode: 'template', description: 'Back soon.' }, by: 'ops' });
  assert.deepEqual([own.body.effective.title, own.body.effective.description, own.body.from], ['Acme', 'Back soon.', { mode: 'workload', icon: 'default', title: 'router', description: 'workload' }]);
  assert.deepEqual((await call('GET', '/v1/workloads/demo/waiting-page')).body, own.body);
  const refused = await call('PUT', '/v1/workloads/demo/waiting-page', { page: { mode: 'custom', html: PAGE_HTML }, by: 'ops' });
  assert.deepEqual([refused.status, refused.body], [400, { error: CUSTOM_REFUSED, reason: 'bad-request', problems: [CUSTOM_REFUSED] }]);
  const bad = await call('PUT', '/v1/waiting-page', { page: { mode: 'template', title: '' }, by: 'adm' });
  assert.deepEqual([bad.status, bad.body.problems], [400, ['title must be one line of text']]);
  const cleared = await call('DELETE', '/v1/workloads/demo/waiting-page', { by: 'ops' });
  assert.deepEqual([cleared.status, cleared.body.own, cleared.body.effective.title], [200, null, 'Acme']);
  assert.equal((await call('DELETE', '/v1/waiting-page')).body.own, null);
  assert.equal(store.pages.size, 0);
  for (const body of ['{', '[]']) assert.equal((await call('PUT', '/v1/waiting-page', body)).status, 400);
});

test('PUT /v1/workloads/:id/waiting-page: a custom page, with the switch on, stored and answered', async () => {
  const { call, store } = api((w) => { w.customPages = true; });
  await call('POST', '/v1/workloads', INPUT);
  const res = await call('PUT', '/v1/workloads/demo/waiting-page', { page: { mode: 'custom', html: PAGE_HTML }, by: 'ops' });
  assert.equal(res.status, 200);
  assert.deepEqual([res.body.effective.mode, res.body.warnings], ['custom', []]);
  assert.deepEqual(store.pages.get('pages/demo').page, { mode: 'custom', html: PAGE_HTML });
});

test('POST /v1/workloads: the regional onboarding with wakeTimeoutSeconds 120 is refused as before G5', async () => {
  const { call, store } = api(regional);
  const res = await call('POST', '/v1/workloads', { ...INPUT, settings: { wakeTimeoutSeconds: 120 } });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, {
    error: 'cannot onboard demo: settings: wakeTimeoutSeconds 120 is too short for a regional load balancer: its wake includes the URL map\'s change, 100 s: use more than 160',
    reason: 'not-eligible',
  });
  assert.equal(store.configs.size, 0);
});

test('POST /v1/actions: the manager\'s action, its answer; a body that is no JSON object: 400 as any route\'s; none: no action', async () => {
  const { call } = api();
  await call('POST', '/v1/workloads', INPUT);
  const res = await call('POST', '/v1/actions', { action: 'rename', workloadId: 'demo', name: 'Shop', by: 'ann', refusals: true });
  assert.deepEqual([res.status, res.body, res.type, res.cache], [200, { workloadId: 'demo', name: 'Shop' }, 'application/json', 'no-store']);
  for (const body of ['{', '[]', 'null', '"router"', '7']) {
    const refused = await call('POST', '/v1/actions', body);
    assert.equal(refused.status, 400, body);
    assert.equal(refused.body.reason, 'bad-request', body);
  }
  assert.deepEqual((await call('POST', '/v1/actions', JSON.stringify({ action: 'rename', padding: 'x'.repeat(2_000_000) }))).status, 400);
  const none = await call('POST', '/v1/actions');
  assert.deepEqual([none.status, none.body], [400, { error: 'unknown action: undefined', reason: 'unknown-action' }]);
});

test('any other route or method: a 404 in the same shape', async () => {
  const { call } = api();
  for (const [method, path] of [
    ['GET', '/v1/actions'], ['PUT', '/v1/actions'], ['POST', '/v1/actions/router'],
    ['GET', '/'], ['GET', '/v1'], ['POST', '/v1/health'], ['PUT', '/v1/workloads'], ['DELETE', '/v1/workloads'],
    ['POST', '/v1/workloads/demo'], ['PUT', '/v1/workloads/demo'], ['GET', '/v1/workloads/demo/nap'], ['POST', '/v1/workloads/demo/other'], ['POST', '/v1/workloads/demo/nap/x'],
    ['GET', '/v1/tasks'], ['GET', '/v1/check'], ['POST', '/v1/workloads/demo/schedule'], ['GET', '/v1/workloads/demo/pause'], ['PUT', '/v1/workloads/demo/pause'], ['GET', '/v1/workloads/demo/resume'],
    ['GET', '/v1/workloads/demo/settings'], ['POST', '/v1/workloads/demo/settings'], ['DELETE', '/v1/workloads/demo/settings'], ['POST', '/v1/settings'], ['DELETE', '/v1/settings'], ['GET', '/v1/settings/x'],
    ['POST', '/v1/waiting-page'], ['PATCH', '/v1/waiting-page'], ['GET', '/v1/waiting-page/x'], ['POST', '/v1/workloads/demo/waiting-page'],
  ]) {
    const res = await call(method, path);
    assert.equal(res.status, 404, `${method} ${path}`);
    assert.equal(res.body.reason, 'not-found');
    assert.match(res.body.error, /no route/);
  }
});

test('a failure at Google is left to serve, which answers the 500 and logs it', async () => {
  const { handler, w } = api();
  const failure = new GoogleError('Google: secret detail', { code: 500 });
  w.fail['GET global/urlMaps'] = failure;
  await assert.rejects(handler(request('POST', '/v1/workloads?dryRun=true', JSON.stringify(INPUT))), failure);
});

// --- On the router's environment -------------------------------------------------------------------------------------

const ENV = {
  DMT_PROJECT: 'p',
  DMT_REGION: REGION,
  DMT_DATABASE: 'dmtr-europe-west1',
  DMT_QUEUE: 'dmtr-europe-west1',
  DMT_CONTROLLER_URL: 'https://dmtr-europe-west1-controller-123.europe-west1.run.app',
  DMT_SERVICE_ACCOUNT: 'dmtr-europe-west1@p.iam.gserviceaccount.com',
  DMT_WAKER_NEG: 'dmtr-europe-west1-waker',
  DMT_VERSION: '9.9.9',
};

// Google's REST APIs as the environment's adapters reach them.
function fakeFetch(answers) {
  const seen = [];
  const fetch = async (url, { method = 'GET', body } = {}) => {
    if (url.includes('metadata.google.internal')) return Response.json({ access_token: 't', expires_in: 3600 });
    seen.push(`${method} ${url}`);
    const answer = answers(method, url, body && JSON.parse(body));
    if (answer) return Response.json(answer);
    return Response.json({ error: { code: 404, message: 'not found', status: 'NOT_FOUND' } }, { status: 404 });
  };
  return { fetch, seen };
}

test('fromEnvironment: health answers the image\'s version, not DMT_VERSION', async () => {
  const handler = fromEnvironment(ENV, { fetch: fakeFetch(() => null).fetch, log: silentLog });
  const res = await handler(request('GET', '/v1/health'));
  assert.deepEqual(JSON.parse(res.body), { version: PACKAGE.version, project: 'p', region: REGION });
});

test('fromEnvironment: the database, the project and the NEG of the environment', async () => {
  const created = [];
  const { fetch, seen } = fakeFetch((method, url, body) => {
    if (url.includes('firestore.googleapis.com')) {
      if (method !== 'GET') return {};
      return url.includes('/documents/workloads?') ? { documents: [] } : null;
    }
    if (url.endsWith('/global/urlMaps/lb') && method === 'GET') return { name: 'lb', defaultService: serviceUrl('app') };
    if (url.endsWith('/global/urlMaps/lb') && method === 'PUT') return { status: 'DONE' };
    if (url.endsWith('/global/urlMaps')) return { items: [{ name: 'lb', defaultService: serviceUrl('app') }] };
    if (url.endsWith('/global/targetHttpsProxies')) return { items: [{ name: 'lb-https', selfLink: 'x/targetHttpsProxies/lb-https', urlMap: 'x/lb' }] };
    if (url.endsWith('/global/targetHttpProxies')) return { items: [] };
    if (url.endsWith('/aggregated/forwardingRules')) return { items: {} };
    if (url.endsWith('/global/forwardingRules')) return { items: [{ name: 'fr', target: 'x/targetHttpsProxies/lb-https', loadBalancingScheme: 'EXTERNAL_MANAGED' }] };
    if (url.endsWith('/global/backendServices/app')) return { name: 'app', loadBalancingScheme: 'EXTERNAL_MANAGED', healthChecks: ['hc'], backends: [{ group: unmanagedUrl('ig') }] };
    if (url.endsWith('/global/backendServices') && method === 'POST') {
      created.push(body);
      return { status: 'DONE' };
    }
    if (url.endsWith('/instanceGroups/ig/listInstances')) return { items: [{ instance: `${V1}/zones/${ZONE}/instances/vm-a` }] };
    if (url.endsWith('/instances/vm-a')) return { id: '1001', name: 'vm-a', selfLink: `${V1}/zones/${ZONE}/instances/vm-a`, machineType: 'x/machineTypes/e2-small', disks: [] };
    if (url.endsWith('/machineTypes/e2-small')) return { name: 'e2-small' };
    return null;
  });
  const handler = fromEnvironment(ENV, { fetch, log: silentLog });
  const res = await handler(request('POST', '/v1/workloads', JSON.stringify(INPUT)));
  assert.equal(res.statusCode, 200, res.body);
  assert.ok(seen.includes('POST https://firestore.googleapis.com/v1/projects/p/databases/dmtr-europe-west1/documents:commit'), seen.join('\n'));
  assert.equal(created[0].backends[0].group, `${V1}/regions/${REGION}/networkEndpointGroups/dmtr-europe-west1-waker`);
  assert.deepEqual(created[0].customRequestHeaders, ['x-dormeto-workload: demo']);
});

test('fromEnvironment: Cloud SQL is read in the environment\'s project', async () => {
  const { fetch, seen } = fakeFetch((method, url) => {
    if (url.includes('firestore.googleapis.com')) return url.includes('/documents/workloads?') ? { documents: [] } : null;
    if (url.includes('sqladmin.googleapis.com')) return { name: 'db', selfLink: 'https://sql/db', state: 'RUNNABLE', settings: { activationPolicy: 'ALWAYS' } };
    return null;
  });
  const handler = fromEnvironment(ENV, { fetch, log: silentLog });
  const res = await handler(request('POST', '/v1/workloads?dryRun=true', JSON.stringify({ ...INPUT, cloudSql: ['db'] })));
  assert.equal(res.statusCode, 200, res.body);
  assert.ok(seen.includes('GET https://sqladmin.googleapis.com/v1/projects/p/instances/db'), seen.join('\n'));
  assert.deepEqual(JSON.parse(res.body).databases, [{ name: 'db', selfLink: 'https://sql/db' }]);
});

test('fromEnvironment: a GKE cluster is read in the environment\'s project', async () => {
  const { fetch, seen } = fakeFetch((method, url) => {
    if (url.includes('firestore.googleapis.com')) return url.includes('/documents/workloads?') ? { documents: [] } : null;
    if (url.includes('container.googleapis.com')) return { autopilot: { enabled: false }, controlPlaneEndpointsConfig: { dnsEndpointConfig: { endpoint: 'c.europe-west1-b.gke.goog', allowExternalTraffic: true } } };
    const app = `${V1}/global/backendServices/app`;
    if (url.endsWith('/global/urlMaps/lb')) return { name: 'lb', defaultService: app, hostRules: [{ hosts: ['demo.example.com'], pathMatcher: 'm' }], pathMatchers: [{ name: 'm', defaultService: app }] };
    if (url.endsWith('/global/targetHttpsProxies')) return { items: [{ name: 'p', selfLink: `${V1}/global/targetHttpsProxies/p`, urlMap: `${V1}/global/urlMaps/lb` }] };
    if (url.endsWith('/aggregated/forwardingRules')) return { items: {} };
    if (url.endsWith('/global/forwardingRules')) return { items: [{ name: 'r', target: `${V1}/global/targetHttpsProxies/p`, loadBalancingScheme: 'EXTERNAL_MANAGED' }] };
    if (url.endsWith('/global/backendServices/app')) return { name: 'app', loadBalancingScheme: 'EXTERNAL_MANAGED', healthChecks: ['hc'], backends: [{ group: `${V1}/zones/europe-west1-b/networkEndpointGroups/k8s1-a` }] };
    if (url.endsWith('/networkEndpointGroups/k8s1-a')) return { name: 'k8s1-a', networkEndpointType: 'GCE_VM_IP_PORT', description: '{"namespace":"shop","service-name":"web"}' };
    if (url.endsWith('/global/urlMaps') || url.endsWith('/global/targetHttpProxies')) return { items: [] };
    return null;
  });
  const handler = fromEnvironment(ENV, { fetch, log: silentLog });
  const res = await handler(request('POST', '/v1/workloads?dryRun=true', JSON.stringify({ ...INPUT, gke: { cluster: { location: 'europe-west1-b', name: 'shop' } } })));
  assert.equal(res.statusCode, 200, res.body);
  assert.ok(seen.includes('GET https://container.googleapis.com/v1/projects/p/locations/europe-west1-b/clusters/shop'), seen.join('\n'));
  assert.deepEqual(JSON.parse(res.body).reasons, []);
  assert.deepEqual(JSON.parse(res.body).gke, { cluster: { location: 'europe-west1-b', name: 'shop' }, namespace: 'shop', service: 'web', autopilot: false });
  assert.equal(seen.some((line) => line.includes('gke.goog')), false, 'no Kubernetes call in a dry run');
});

test('fromEnvironment: the regional URL maps are those of the environment\'s region', async () => {
  const regionalMap = `${V1}/regions/${REGION}/urlMaps/lb`;
  const { fetch, seen } = fakeFetch((method, url) => {
    if (url.includes('firestore.googleapis.com')) return url.includes('/documents/workloads?') ? { documents: [] } : null;
    return null;
  });
  const handler = fromEnvironment(ENV, { fetch, log: silentLog });
  const res = await handler(request('POST', '/v1/workloads?dryRun=true', JSON.stringify(INPUT)));
  assert.equal(res.statusCode, 200, res.body);
  assert.ok(seen.includes(`GET ${regionalMap}`), seen.join('\n'));
  assert.match(JSON.parse(res.body).reasons[0], /^URL map lb not found/);
});

// The router's log view (DMT_LOG_VIEW, set by the CLI's install): what the idle check reads of a backend service logging every
// request. A check of one AWAKE workload long idle but for two scanners' requests, through the environment's adapters.
const LOG_VIEW = 'projects/p/locations/global/buckets/_Default/views/dmtr-europe-west1-lb';
function idleWorld() {
  const firestore = fakeFirestore();
  const config = { workloadId: 'demo', urlMap: 'lb', backendService: 'app', wakerBackendService: WAKER, backends: [{ kind: 'vm', location: ZONE, name: 'vm-a' }], idleMinutes: 15, wakeTimeoutSeconds: 600 };
  firestore.docs.set('workloads/demo', { fields: toFields({ config }), updateTime: 't0' });
  firestore.docs.set('runs/demo', { fields: toFields({ state: STATES.AWAKE, awakeSince: 1, version: 0 }), updateTime: 't0' });
  const logBodies = [];
  const app = serviceUrl('app');
  const google = fakeFetch((method, url, body) => {
    if (url.endsWith('/global/urlMaps/lb') && method === 'PUT') return { status: 'DONE' };
    if (url.endsWith('/global/urlMaps/lb')) {
      return { name: 'lb', fingerprint: 'f', defaultService: app, hostRules: [{ hosts: ['demo.example.com'], pathMatcher: 'm' }], pathMatchers: [{ name: 'm', defaultService: app, pathRules: [{ paths: ['/_dormeto/*'], service: serviceUrl(WAKER) }] }] };
    }
    if (url.endsWith('/global/urlMaps')) return { items: [] };
    if (url.endsWith('/instances/vm-a')) return { name: 'vm-a', status: 'RUNNING' };
    if (url.includes('monitoring.googleapis.com')) return { timeSeries: [{ points: [{ value: { int64Value: '2' } }] }] };
    if (url.endsWith('/global/backendServices/app')) return { name: 'app', logConfig: { enable: true, sampleRate: 1 } };
    if (url === 'https://logging.googleapis.com/v2/entries:list') {
      logBodies.push(body);
      return { entries: ['/.env', '/wp-login.php'].map((path) => ({ httpRequest: { requestMethod: 'GET', requestUrl: `https://demo.example.com${path}`, userAgent: 'Mozilla/5.0', remoteIp: '203.0.113.7' } })) };
    }
    if (url.includes('cloudtasks.googleapis.com')) return { name: 'task' };
    return null;
  });
  // Firestore's answers and refusals as its REST API gives them.
  const fetch = async (url, init = {}) => {
    if (!url.includes('firestore.googleapis.com')) return google.fetch(url, init);
    try {
      return Response.json(await firestore.request(init.method ?? 'GET', url, init.body && JSON.parse(init.body)));
    } catch (err) {
      return Response.json({ error: { code: err.code, message: err.message, status: err.status } }, { status: err.code });
    }
  };
  return { firestore, fetch, seen: google.seen, logBodies };
}

test('fromEnvironment: DMT_LOG_VIEW is the view the idle check reads the request logs in', async () => {
  const { firestore, fetch, logBodies } = idleWorld();
  const handler = fromEnvironment({ ...ENV, DMT_LOG_VIEW: LOG_VIEW }, { fetch, log: silentLog });
  const res = await handler(request('POST', '/v1/check'));
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(JSON.parse(res.body).results, [{ workloadId: 'demo', state: STATES.AWAKE, nap: 'requested' }]);
  assert.equal(logBodies.length, 1);
  assert.deepEqual(logBodies[0].resourceNames, [LOG_VIEW]);
  assert.match(logBodies[0].filter, /^resource\.type="http_load_balancer" AND resource\.labels\.backend_service_name="app" AND /);
  assert.equal(firestore.docs.get('runs/demo').fields.idleReads.stringValue, 'request logs');
});

test('fromEnvironment: without DMT_LOG_VIEW, no log is read and the count decides', async () => {
  const { fetch, seen, logBodies } = idleWorld();
  const handler = fromEnvironment(ENV, { fetch, log: silentLog });
  const res = await handler(request('POST', '/v1/check'));
  assert.deepEqual(JSON.parse(res.body).results, [{ workloadId: 'demo', state: STATES.AWAKE }]);
  assert.deepEqual(logBodies, []);
  assert.equal(seen.some((line) => line.includes('/global/backendServices/app')), false);
});

test('fromEnvironment: DMT_CUSTOM_PAGES=1 is the install\'s switch: a custom page is taken; without it, refused with the verbatim text', async () => {
  const page = { mode: 'custom', html: PAGE_HTML };
  for (const [env, status] of [[{ ...ENV, DMT_CUSTOM_PAGES: '1' }, 200], [ENV, 400], [{ ...ENV, DMT_CUSTOM_PAGES: 'true' }, 400]]) {
    const { firestore, fetch } = idleWorld();
    const handler = fromEnvironment(env, { fetch, log: silentLog });
    const res = await handler(request('PUT', '/v1/waiting-page', JSON.stringify({ page, by: 'adm' })));
    assert.equal(res.statusCode, status, res.body);
    if (status === 400) assert.equal(JSON.parse(res.body).error, CUSTOM_REFUSED);
    assert.equal(firestore.docs.has('router/page'), status === 200);
  }
});

test('fromEnvironment: POST /v1/actions over the router\'s Firestore: manager-settings stored in router/manager, then events and router read it', async () => {
  const { firestore, fetch } = idleWorld();
  const handler = fromEnvironment({ ...ENV, DMT_BUILD: 'b7' }, { fetch, log: silentLog });
  const act = async (payload) => {
    const res = await handler(request('POST', '/v1/actions', JSON.stringify({ ...payload, refusals: true })));
    assert.equal(res.statusCode, 200, res.body);
    return JSON.parse(res.body);
  };
  const settings = { workloads: { hibernate: false, joinMinutes: 10 } };
  assert.deepEqual(await act({ action: 'manager-settings', settings, etag: '"e1"' }), { etag: '"e1"' });
  assert.ok(firestore.docs.has('router/manager'));
  assert.deepEqual(await act({ action: 'events', after: null, limit: 10 }), { events: [], next: null, check: null, managerSettings: { etag: '"e1"' } });
  const { router, managerSettings } = await act({ action: 'router' });
  assert.deepEqual(router, { name: `dmtr-${REGION}`, version: PACKAGE.version, build: 'b7' });
  assert.deepEqual([managerSettings.hibernate, managerSettings.joinMinutes, managerSettings.error], [false, 10, null]);
  const listed = await act({ action: 'list' });
  assert.deepEqual([listed.router.name, listed.router.version, listed.router.build, listed.workloads.map((w) => w.workloadId)], [`dmtr-${REGION}`, PACKAGE.version, 'b7', ['demo']]);
});

// R13: the Workload answers with AWS's name beside the CLI's (the released names stay one minor release).
test('a Workload answer has workloadId beside id, and pauses (a list) beside paused', async () => {
  const { call } = api();
  const created = await call('POST', '/v1/workloads', INPUT);
  assert.deepEqual([created.body.id, created.body.workloadId, created.body.pauses], ['demo', 'demo', []]);
  assert.equal(Object.hasOwn(created.body, 'paused'), false);
  const paused = (await call('POST', '/v1/workloads/demo/pause', { reason: 'load test', by: 'ops' })).body;
  assert.deepEqual([paused.id, paused.workloadId, paused.pauses, paused.paused.reason], ['demo', 'demo', [paused.paused], 'load test']);
  const read = (await call('GET', '/v1/workloads/demo')).body;
  assert.deepEqual([read.workloadId, read.pauses], ['demo', [read.paused]]);
  assert.deepEqual((await call('GET', '/v1/workloads')).body.map((w) => [w.id, w.workloadId, w.pauses.length]), [['demo', 'demo', 1]]);
});

test('POST /v1/workloads: databases beside cloudSql, settings.fallbackInstanceTypes beside the top-level one; both given and different: 400 naming both', async () => {
  const types = (w) => { w.sql.db1 = {}; w.machineTypes['e2-medium'] = { name: 'e2-medium', memoryMb: 4096 }; w.machineTypes['e2-small'] = { name: 'e2-small', memoryMb: 2048 }; };
  const stored = async (extra, id) => {
    const { call, store } = api(types);
    const res = await call('POST', '/v1/workloads', { ...INPUT, ...extra });
    return { res, cfg: store.configs.get('demo'), id };
  };
  const old = await stored({ cloudSql: ['db1'], fallbackInstanceTypes: ['e2-medium'] });
  assert.equal(old.res.status, 200, JSON.stringify(old.res.body));
  for (const extra of [{ databases: ['db1'], settings: { fallbackInstanceTypes: ['e2-medium'] } }, { databases: [{ kind: 'cloudsql-instance', id: 'db1' }], settings: { fallbackInstanceTypes: ['e2-medium'] } }]) {
    const next = await stored(extra);
    assert.equal(next.res.status, 200, JSON.stringify(next.res.body));
    assert.deepEqual(next.cfg.backends, old.cfg.backends);
    assert.deepEqual(next.cfg.fallbackInstanceTypes, ['e2-medium']);
    assert.equal(Object.hasOwn(next.cfg.settings ?? {}, 'fallbackInstanceTypes'), false);
  }
  const same = await stored({ databases: ['db1'], cloudSql: ['db1'], settings: { fallbackInstanceTypes: ['e2-medium'] }, fallbackInstanceTypes: ['e2-medium'] });
  assert.equal(same.res.status, 200, JSON.stringify(same.res.body));
  const dry = api(types);
  assert.equal((await dry.call('POST', '/v1/workloads?dryRun=true', { ...INPUT, databases: ['db1'] })).body.databases.length, 1);
  for (const [extra, words] of [
    [{ databases: ['db1'], cloudSql: ['db2'] }, /databases.*cloudSql|cloudSql.*databases/],
    [{ settings: { fallbackInstanceTypes: ['e2-medium'] }, fallbackInstanceTypes: ['e2-small'] }, /settings\.fallbackInstanceTypes.*fallbackInstanceTypes|fallbackInstanceTypes.*settings/],
  ]) {
    const { call, store } = api(types);
    const res = await call('POST', '/v1/workloads', { ...INPUT, ...extra });
    assert.equal(res.status, 400, JSON.stringify(extra));
    assert.equal(res.body.reason, 'bad-request');
    assert.match(res.body.error, words);
    assert.equal(store.configs.size, 0);
  }
});

test('a waiting page put without by: 400 bad-request, nothing written; a delete or a get needs none', async () => {
  const { call, store } = api();
  await call('POST', '/v1/workloads', INPUT);
  for (const path of ['/v1/waiting-page', '/v1/workloads/demo/waiting-page']) {
    for (const body of [{ page: { mode: 'template', title: 'Acme' } }, { page: { mode: 'template', title: 'Acme' }, by: '' }]) {
      const res = await call('PUT', path, body);
      assert.deepEqual([res.status, res.body.reason, /by/.test(res.body.error)], [400, 'bad-request', true], path);
    }
    assert.equal(store.pages.size, 0);
    assert.equal((await call('GET', path)).status, 200);
    assert.equal((await call('DELETE', path)).status, 200);
  }
});
