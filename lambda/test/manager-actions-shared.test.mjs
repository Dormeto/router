// Both routers' answers to the manager (lib/manager-actions.mjs) and the wakes they ask (lib/asked-wake.mjs): the shapes they build,
// then their contract on the DynamoDB store's fake (gcp/test/manager-actions-shared.test.mjs runs it on the Firestore store).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askedWake, triggerOf } from '../src/lib/asked-wake.mjs';
import { listRouter, routerAnswer, rowPauses, scheduleView } from '../src/lib/manager-actions.mjs';
import { STATES } from '../src/lib/state.mjs';
import { managerActionsContract } from './manager-actions-contract.mjs';
import { fakeStore, testConfig } from './fakes.mjs';

const AT = Date.parse('2026-03-10T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

test('the router answer: its keys in the released order, the manager\'s level with its defaults and types when there are some, the paused workloads, the health and its figures', () => {
  const configs = [{ workloadId: 'a' }, { workloadId: 'b' }, { workloadId: 'c' }];
  const health = { status: 'warning', problems: [{ level: 'warning', code: 'x', text: 'x' }] };
  const figures = { checkSchedule: 'rate(5 minutes)', lastScheduledCheckAt: AT, lambda: { waker: {} }, queues: {}, ipLists: [], concurrency: null, drift24h: 2 };
  const answer = routerAnswer({
    router: { name: 'r', version: '1', build: 'b' }, settings: { joinMinutes: 10, by: 'adm', at: AT },
    manager: { hibernate: false, defaults: { idleMinutes: 30 }, readAt: AT, error: null }, managerUrl: 'https://m/settings.json',
    configuration: { checkSchedule: { value: 'rate(5 minutes)', source: 'terraform' } },
    routerPauses: [], pauses: [{ workloadId: 'b' }, { workloadId: 'b', exclusionId: 'x1' }], configs, byState: { AWAKE: 3 }, lastActivity: AT, health, figures,
  });
  assert.deepEqual(Object.keys(answer), ['router', 'settings', 'managerSettings', 'configuration', 'pauses', 'workloads', 'health']);
  assert.deepEqual(answer.settings, { hibernate: null, joinMinutes: 10, by: 'adm', at: iso(AT) });
  assert.deepEqual(Object.entries(answer.managerSettings), [['url', 'https://m/settings.json'], ['hibernate', false], ['joinMinutes', null], ['defaults', { idleMinutes: 30 }], ['readAt', iso(AT)], ['error', null]]);
  assert.deepEqual(answer.workloads, { total: 3, byState: { AWAKE: 3 }, paused: 1, lastActivityAt: iso(AT) });
  assert.deepEqual(Object.entries(answer.health), [
    ['status', 'warning'], ['problems', health.problems], ['checkSchedule', 'rate(5 minutes)'], ['lastScheduledCheckAt', iso(AT)], ['lambda', { waker: {} }], ['queues', {}],
    ['ipLists', []], ['concurrency', null], ['drift24h', 2],
  ]);
  // The router's pause holds every workload; no manager level, no activity, no scheduled check.
  const bare = routerAnswer({ router: {}, settings: null, manager: null, configuration: {}, routerPauses: [], pauses: [{ workloadId: null }], configs, byState: {}, lastActivity: 0, health, figures: { ...figures, lastScheduledCheckAt: null } });
  assert.deepEqual(bare.managerSettings, { url: null, hibernate: null, joinMinutes: null, readAt: null, error: null });
  assert.deepEqual([bare.workloads.paused, bare.workloads.lastActivityAt, bare.health.lastScheduledCheckAt], [3, null, null]);
});

test('the list\'s router line in the released order, its pauses\' error only when they could not be read; a row\'s pauses its own and the router\'s', () => {
  const line = { name: 'r', version: null, build: null, checkSchedule: '*/5 * * * *', lastScheduledCheckAt: null, pauses: [] };
  assert.deepEqual(Object.keys(listRouter({ ...line, pausesError: undefined })), Object.keys(line));
  assert.deepEqual(listRouter({ ...line, pausesError: 'throttled' }), { ...line, pausesError: 'throttled' });
  const pauses = [{ workloadId: 'a' }, { workloadId: 'b', exclusionId: 'x' }, { workloadId: null }, { workloadId: 'b' }];
  assert.deepEqual(rowPauses(pauses, 'b'), [pauses[1], pauses[2], pauses[3]]);
});

test('a schedule\'s view reads its join levels once it is shown: a time that is none throws first; its next events with the join in force', async () => {
  let joins = 0;
  const reads = { joins: () => { joins += 1; return { router: null, manager: 30 }; } };
  const log = { warn() {} };
  await assert.rejects(scheduleView({ now: () => AT, log }, 'demo', { maxNapDays: 3, at: 'not a time' }, reads), RangeError);
  assert.equal(joins, 0);
  const view = await scheduleView({ now: () => AT, log }, 'demo', { maxNapDays: 3, at: AT }, reads);
  assert.deepEqual(view, { schedule: { maxNapDays: 3, at: iso(AT) }, next: [], maintenanceDue: null, joinMinutes: 30, joinFrom: 'organization', joinInherited: { joinMinutes: 30, joinFrom: 'organization' } });
  assert.equal(joins, 1);
});

test('a wake asked: the cloud\'s wake of an asleep or failed workload with the trigger, its answer or the run read again; a napping one\'s pending wake; whether it woke', async () => {
  const runs = [];
  const store = { getRun: async () => runs.shift() };
  const calls = [];
  const ports = {
    find: async (id) => { calls.push(['find', id]); return {}; }, store,
    start: async (id, run, trigger) => { calls.push(['start', id, run.state, trigger]); return { woke: true, answer: null }; },
    pending: async (id, trigger) => { calls.push(['pending', id, trigger]); return false; },
  };
  runs.push({ state: STATES.FAILED }, { state: STATES.WAKING });
  assert.deepEqual(await askedWake(ports, 'demo', { kind: 'pause', by: 'ops', inline: true }), { woke: true, answer: { state: STATES.WAKING } });
  runs.push({ state: STATES.NAPPING });
  assert.deepEqual(await askedWake(ports, 'demo', { kind: 'manager' }), { woke: false, answer: { state: STATES.NAPPING, pendingWake: true } });
  runs.push(null);
  assert.deepEqual(await askedWake(ports, 'demo', { kind: 'manager' }), { woke: false, answer: { state: undefined } });
  assert.deepEqual(calls, [['find', 'demo'], ['start', 'demo', STATES.FAILED, { kind: 'pause', by: 'ops', inline: true }], ['find', 'demo'], ['pending', 'demo', { kind: 'manager' }], ['find', 'demo']]);
  assert.deepEqual(triggerOf('pause', undefined), { trigger: { kind: 'pause', by: undefined } });
});

managerActionsContract('the DynamoDB store\'s fake', async ({ run, now }) => {
  const store = fakeStore({ config: testConfig({ source: 'manager' }), run, clock: { now } });
  // The fake's write is not conditional: once offboarded, the conditional write DynamoDB makes answers false.
  return { store, offboard: () => { store.putConfig = async () => false; } };
});
