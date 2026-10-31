import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { STATES } from '../../lambda/src/lib/state.mjs';
import { silentLog } from '../../lambda/test/fakes.mjs';
import { createControllerApi, fromEnvironment } from '../src/controller.mjs';
import { GoogleError } from '../src/google.mjs';
import { INPUT, REGION, V1, WAKER, ZONE, serviceUrl, setup, unmanagedUrl } from './world.mjs';

const PACKAGE = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
const PATTERN = '^[a-z]([a-z0-9-]{0,38}[a-z0-9])?$';

// A `node:http` request as `serve` hands it to the role.
const request = (method, url, body = '') => {
  const stream = (async function* chunks() { if (body) yield Buffer.from(body); }());
  return Object.assign(stream, { method, url, headers: {} });
};

// The API over the world, as the CLI and Cloud Tasks call it.
function api(change) {
  const world = setup(change);
  const handler = createControllerApi({ core: world.core, onboarding: world.onboarding, config: world.config });
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
    id: 'demo',
    state: STATES.AWAKE,
    urlMap: 'lb',
    backendService: 'app',
    wakerBackendService: WAKER,
    hosts: ['demo.example.com'],
    lb: { kind: 'global' },
    settings: { idleMinutes: 15, wakeTimeoutSeconds: 600 },
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
  assert.deepEqual(w.tasks.at(-1).body, { action: 'nap', workloadId: 'demo', requestedAt: clock.now() });
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

const SCHEDULE = { timeZone: 'europe/paris', windows: [{ kind: 'nap', days: ['sat', 'sun'], start: '20:00', end: '08:00' }], maxNapDays: 7 };

test('GET /v1/workloads/:id/schedule: none, then the schedule and its next events', async () => {
  const { call, clock } = api();
  assert.equal((await call('GET', '/v1/workloads/demo/schedule')).status, 404);
  assert.equal((await call('GET', '/v1/workloads/Bad_ID/schedule')).status, 400);
  await call('POST', '/v1/workloads', INPUT);
  assert.deepEqual((await call('GET', '/v1/workloads/demo/schedule')).body, { schedule: null, nextEvents: [] });
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
    assert.deepEqual(res.body, { schedule: null, nextEvents: [] });
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

test('any other route or method: a 404 in the same shape', async () => {
  const { call } = api();
  for (const [method, path] of [
    ['GET', '/'], ['GET', '/v1'], ['POST', '/v1/health'], ['PUT', '/v1/workloads'], ['DELETE', '/v1/workloads'],
    ['POST', '/v1/workloads/demo'], ['PUT', '/v1/workloads/demo'], ['GET', '/v1/workloads/demo/nap'], ['POST', '/v1/workloads/demo/other'], ['POST', '/v1/workloads/demo/nap/x'],
    ['GET', '/v1/tasks'], ['GET', '/v1/check'], ['POST', '/v1/workloads/demo/schedule'], ['GET', '/v1/workloads/demo/pause'], ['PUT', '/v1/workloads/demo/pause'], ['GET', '/v1/workloads/demo/resume'],
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
