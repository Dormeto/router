// What the Google Cloud router answers, held to stored answers: each of the manager's actions (POST /v1/actions, with and without
// refusals) and the REST routes the CLI reads of a schedule, the settings and the waiting page, as the HTTP status and the body's JSON
// text, so a key's order and a key absent or null count (vision docs/specs/2026-11-12-cloud-duplication-design.md, §2 rule 2).
// lambda/test/manager-actions-answers.test.mjs holds AWS's. A change meant to change an answer rewrites the fixture:
// `DORMETO_FIXTURES=write node --test <this file>`, then read its diff.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { STATES } from '../../lambda/src/lib/state.mjs';
import { createActions } from '../src/actions.mjs';
import { createControllerApi } from '../src/controller.mjs';
import { INPUT, setup } from './world.mjs';

const FIXTURE = new URL('./fixtures/manager-actions-answers.json', import.meta.url);
const WEEKEND = { timeZone: 'europe/paris', windows: [{ kind: 'nap', days: ['sat', 'sun'], start: '20:00', end: '08:00' }], maxNapDays: 7 };
const PAGE_HTML = '<!doctype html><p data-dormeto="status"></p>';
const NO_COUNTS = () => ({ ignored: {}, deferred: {}, wakes: {} });

// A `node:http` request as `serve` hands it to the role.
const request = (method, url, body = '') => {
  const stream = (async function* chunks() { if (body) yield Buffer.from(body); }());
  return Object.assign(stream, { method, url, headers: {} });
};

// The world of actions.test.mjs: the store with router/manager and 7 days of counters, the actions beside the REST routes.
function router(change) {
  const t = setup(change);
  const { store, core, onboarding, config, clock, log } = t;
  Object.assign(config, { version: '0.40.0', build: 'b7' });
  Object.assign(store, {
    manager: null,
    getManagerSettings: async () => structuredClone(store.manager),
    putManagerSettings: async (doc) => { store.manager = structuredClone(doc); },
    getStats: async (id, days) => ({ days, since: '2023-11-08', today: NO_COUNTS(), total: NO_COUNTS() }),
  });
  const actions = createActions({ controller: core, onboarding, store, router: { name: `dmtr-${config.region}`, version: config.version, build: config.build, project: config.project, region: config.region }, now: clock.now, log });
  const handler = createControllerApi({ core, onboarding, config, actions });
  const call = async (method, path, body) => {
    const res = await handler(request(method, path, body === undefined ? '' : JSON.stringify(body)));
    return { status: res.statusCode, body: JSON.parse(res.body) };
  };
  return { ...t, call };
}

async function answers() {
  const found = [];
  const rest = async (label, r, method, path, body) => { found.push([label, await r.call(method, path, body)]); };
  const act = (label, r, payload) => rest(label, r, 'POST', '/v1/actions', payload);
  const both = async (label, r, payload) => {
    await act(label, r, { ...payload, refusals: true });
    await act(`${label}, without refusals`, r, payload);
  };

  const g = router();
  await rest('REST onboard', g, 'POST', '/v1/workloads', { ...INPUT, name: 'Demo', tags: { team: 'a' } });
  await rest('REST schedule, none', g, 'GET', '/v1/workloads/demo/schedule');
  await rest('REST schedule put', g, 'PUT', '/v1/workloads/demo/schedule', { ...WEEKEND, by: 'ops' });
  await rest('REST schedule put, its own join and no by', g, 'PUT', '/v1/workloads/demo/schedule', { ...WEEKEND, joinMinutes: 30 });
  await rest('REST schedule put, problems', g, 'PUT', '/v1/workloads/demo/schedule', { windows: [{ kind: 'nap', days: ['someday'], start: '20:00', end: '08:00' }] });
  await rest('REST schedule put, an unknown workload', g, 'PUT', '/v1/workloads/nope/schedule', WEEKEND);
  await rest('REST schedule put, a bad id', g, 'PUT', '/v1/workloads/Bad_ID/schedule', WEEKEND);
  await rest('REST schedule', g, 'GET', '/v1/workloads/demo/schedule');
  Object.assign(g.store.runs.get('demo'), { state: STATES.ASLEEP, stateAt: g.clock.now() });
  await both('status, scheduled and asleep', g, { action: 'status', workloadId: 'demo' });
  await both('schedule', g, { action: 'schedule', workloadId: 'demo', schedule: WEEKEND, by: 'ann' });
  await both('schedule, problems', g, { action: 'schedule', workloadId: 'demo', schedule: { windows: [{ kind: 'nap', days: ['someday'], start: '20:00', end: '08:00' }] }, by: 'ann' });
  await both('schedule, not an object', g, { action: 'schedule', workloadId: 'demo', schedule: 'weekends' });
  await both('schedule, an unknown workload', g, { action: 'schedule', workloadId: 'nope', schedule: WEEKEND });
  // A schedule the router cannot read (B3), asleep with a maximum nap.
  g.store.schedules.set('demo', { ...WEEKEND, timeZone: 'Nowhere/Land', joinMinutes: 30, at: 1 });
  await rest('REST schedule, one it cannot read', g, 'GET', '/v1/workloads/demo/schedule');
  await act('status, a schedule it cannot read', g, { action: 'status', workloadId: 'demo', refusals: true });
  g.store.runs.get('demo').state = STATES.AWAKE;
  await rest('REST schedule delete', g, 'DELETE', '/v1/workloads/demo/schedule');
  await rest('REST schedule delete, none', g, 'DELETE', '/v1/workloads/demo/schedule');
  await both('clear-schedule, none', g, { action: 'clear-schedule', workloadId: 'demo', by: 'ann' });
  await both('clear-schedule, an unknown workload', g, { action: 'clear-schedule', workloadId: 'nope' });

  await rest('REST settings', g, 'GET', '/v1/settings');
  await rest('REST settings put', g, 'PUT', '/v1/settings', { joinMinutes: 10, defaults: { idleMinutes: 30 }, by: 'adm' });
  await rest('REST settings put, problems', g, 'PUT', '/v1/settings', { defaults: { waitSeconds: 30 } });
  await rest('REST settings put, read', g, 'PUT', '/v1/settings', {});
  await rest('REST workload settings put', g, 'PUT', '/v1/workloads/demo/settings', { idleMinutes: 45, hibernate: false, by: 'ann' });
  await rest('REST workload settings put, problems', g, 'PUT', '/v1/workloads/demo/settings', { idleMinutes: 1 });
  await rest('REST workload settings put, an unknown workload', g, 'PUT', '/v1/workloads/nope/settings', { idleMinutes: 30 });
  g.store.manager = { settings: { workloads: { hibernate: false } }, etag: 'e1', at: g.clock.now() - 1000 };
  await both('settings of the router', g, { action: 'settings', settings: { joinMinutes: 20 }, by: 'adm' });
  await both('settings of the router, problems', g, { action: 'settings', settings: { defaults: { waitSeconds: 30 } } });
  await both('settings, not an object', g, { action: 'settings', settings: 'x' });
  await both('settings of a workload', g, { action: 'settings', workloadId: 'demo', settings: { idleMinutes: 50 }, by: 'ann' });
  await both('settings of a workload, problems', g, { action: 'settings', workloadId: 'demo', settings: { idleMinutes: 1, joinMinutes: 5 } });
  await both('settings of an unknown workload', g, { action: 'settings', workloadId: 'nope', settings: { idleMinutes: 30 } });

  await rest('REST waiting page', g, 'GET', '/v1/waiting-page');
  await rest('REST waiting page put', g, 'PUT', '/v1/waiting-page', { page: { mode: 'template', title: 'Acme' }, by: 'adm' });
  await rest('REST waiting page put, no by', g, 'PUT', '/v1/waiting-page', { page: { mode: 'template' } });
  await rest('REST waiting page put, problems', g, 'PUT', '/v1/waiting-page', { page: { mode: 'template', title: '' }, by: 'adm' });
  await rest('REST waiting page put, custom while off', g, 'PUT', '/v1/workloads/demo/waiting-page', { page: { mode: 'custom', html: PAGE_HTML }, by: 'adm' });
  await rest('REST workload waiting page put', g, 'PUT', '/v1/workloads/demo/waiting-page', { page: { mode: 'template', description: 'Back soon.' }, by: 'ann' });
  await rest('REST workload waiting page', g, 'GET', '/v1/workloads/demo/waiting-page');
  await rest('REST waiting page of an unknown workload', g, 'GET', '/v1/workloads/nope/waiting-page');
  await both('waiting page of a workload', g, { action: 'waiting-page', op: 'get', workloadId: 'demo' });
  await both('waiting page, problems', g, { action: 'waiting-page', op: 'put', page: { mode: 'template', title: '' }, by: 'adm' });
  await both('waiting page, custom while off', g, { action: 'waiting-page', op: 'put', workloadId: 'demo', page: { mode: 'custom', html: PAGE_HTML }, by: 'adm' });
  await both('waiting page, a put without by', g, { action: 'waiting-page', op: 'put', page: { mode: 'template' } });
  await both('waiting page, an empty workload id', g, { action: 'waiting-page', op: 'get', workloadId: '' });
  await both('waiting page, an unknown op', g, { action: 'waiting-page', op: 'other' });
  await rest('REST workload waiting page delete', g, 'DELETE', '/v1/workloads/demo/waiting-page');
  await both('waiting page of the router, delete', g, { action: 'waiting-page', op: 'delete', by: 'adm' });

  await both('rename', g, { action: 'rename', workloadId: 'demo', name: '  Shop  ', by: 'ann' });
  await both('rename, empty', g, { action: 'rename', workloadId: 'demo', name: '' });
  await both('rename, a bad id', g, { action: 'rename', workloadId: 'Bad_ID', name: 'a' });
  await both('tag', g, { action: 'tag', workloadId: 'demo', tags: { team: 'a' }, by: 'ann' });
  await both('tag, reserved', g, { action: 'tag', workloadId: 'demo', tags: { 'dormeto:x': 'y' } });
  await both('tag, an unknown workload', g, { action: 'tag', workloadId: 'nope', tags: {} });
  await both('request-nap, an unknown workload', g, { action: 'request-nap', workloadId: 'nope', by: 'ann' });
  await act('request-nap', g, { action: 'request-nap', workloadId: 'demo', by: 'ann', refusals: true });
  await rest('REST pause', g, 'POST', '/v1/workloads/demo/pause', { reason: 'deploy', by: 'ops' });
  await act('request-nap, paused', g, { action: 'request-nap', workloadId: 'demo', by: 'ann', refusals: true });
  await rest('REST resume', g, 'POST', '/v1/workloads/demo/resume');
  await rest('REST router pause', g, 'POST', '/v1/pause', { reason: 'maintenance', by: 'adm', keepAsleep: true });
  await act('request-nap, the router paused', g, { action: 'request-nap', workloadId: 'demo', by: 'ann', refusals: true });
  await act('list, paused', g, { action: 'list', refusals: true });
  await act('router, paused', g, { action: 'router', refusals: true });
  await rest('REST router resume', g, 'POST', '/v1/resume', { by: 'adm' });
  for (const state of [STATES.AWAKE, STATES.ASLEEP, STATES.WAKING, STATES.NAPPING, STATES.FAILED]) {
    Object.assign(g.store.runs.get('demo'), { state, pendingWake: false });
    await act(`force-wake, ${state}`, g, { action: 'force-wake', workloadId: 'demo', by: 'ann', refusals: true });
    Object.assign(g.store.runs.get('demo'), { state });
    await act(`request-nap, ${state}`, g, { action: 'request-nap', workloadId: 'demo', by: 'ann', refusals: true });
  }
  await both('force-wake, an unknown workload', g, { action: 'force-wake', workloadId: 'nope', by: 'ann' });
  g.store.listPauses = async () => { throw new Error('Google: 503 firestore'); };
  await act('list, pauses unreadable', g, { action: 'list', refusals: true });
  await act('router, pauses unreadable', g, { action: 'router', refusals: true });

  const custom = router((w) => { w.customPages = true; });
  await rest('REST onboard, custom pages on', custom, 'POST', '/v1/workloads', INPUT);
  await rest('REST workload waiting page put, custom', custom, 'PUT', '/v1/workloads/demo/waiting-page', { page: { mode: 'custom', html: PAGE_HTML }, by: 'adm' });
  await act('waiting page of the router put, custom', custom, { action: 'waiting-page', op: 'put', page: { mode: 'custom', html: PAGE_HTML }, by: 'adm', refusals: true });

  const racing = router();
  await rest('REST onboard, to offboard', racing, 'POST', '/v1/workloads', INPUT);
  const put = racing.store.putConfig;
  racing.store.putConfig = async (id, cfg, options) => (options?.mustExist ? false : put(id, cfg, options));
  await act('rename racing an offboarding', racing, { action: 'rename', workloadId: 'demo', name: 'a', by: 'ann', refusals: true });
  await act('settings racing an offboarding', racing, { action: 'settings', workloadId: 'demo', settings: { idleMinutes: 30 }, by: 'ann', refusals: true });
  await rest('REST settings racing an offboarding', racing, 'PUT', '/v1/workloads/demo/settings', { idleMinutes: 30 });
  return found;
}

// One case a line: its label, and the answer as JSON holds it.
const written = (found) => `{\n${found.map(([label, answer]) => `  ${JSON.stringify(label)}: ${JSON.stringify(answer)}`).join(',\n')}\n}\n`;

test('the Google Cloud router answers the manager\'s actions and the CLI\'s REST routes as its stored answers say, keys in order, absent and null as they are', async () => {
  const found = await answers();
  if (process.env.DORMETO_FIXTURES === 'write') writeFileSync(FIXTURE, written(found));
  const stored = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  assert.deepEqual(found.map(([label]) => label), Object.keys(stored));
  for (const [label, answer] of found) assert.equal(JSON.stringify(answer), JSON.stringify(stored[label]), label);
});
