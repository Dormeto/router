import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCount, fallbacksOf, workloadRow, workloadSummary } from '../src/lib/summary.mjs';
import { silentLog, testConfig } from './fakes.mjs';

test('a workload summary gives the last failure and the consecutive failures (R7a), none after a successful wake', () => {
  const failure = { kind: 'capacity', step: 'wake', backend: 'rds:db', message: 'no capacity', at: Date.UTC(2026, 9, 8, 12) };
  const failed = workloadSummary(testConfig(), { state: 'FAILED', failure: JSON.stringify(failure), consecutiveFailures: 2, failedAt: failure.at });
  assert.deepEqual(failed.failure, { ...failure, at: '2026-10-08T12:00:00.000Z' });
  assert.equal(failed.consecutiveFailures, 2);
  const awake = workloadSummary(testConfig(), { state: 'AWAKE' });
  assert.equal(awake.failure, null);
  assert.equal(awake.consecutiveFailures, 0);
  assert.equal(workloadSummary(testConfig(), { state: 'FAILED', failure: 'not json' }).failure, null, 'an unreadable record is no failure');
});

test('a failed workload\'s summary gives its next attempt (R7a)', () => {
  const at = Date.UTC(2026, 9, 8, 12);
  const summary = workloadSummary(testConfig({ failedRetrySeconds: 60 }), { state: 'FAILED', failedAt: at, consecutiveFailures: 3 });
  assert.equal(summary.nextAttemptAt, new Date(at + 240_000).toISOString());
  assert.equal(workloadSummary(testConfig(), { state: 'ASLEEP' }).nextAttemptAt, null);
});

test('a workload awake on fallback instance types says which (R7a), and nothing when on its own types', () => {
  const run = { state: 'AWAKE', instanceTypes: JSON.stringify({ 'i-1': { from: 't3.medium', to: 't3.large' } }) };
  assert.deepEqual(workloadSummary(testConfig(), run).fallbacks, [{ instance: 'i-1', from: 't3.medium', to: 't3.large' }]);
  assert.equal('fallbacks' in workloadSummary(testConfig(), { state: 'AWAKE' }), false, 'absent, to keep check events small');
  assert.equal('fallbacks' in workloadSummary(testConfig(), { state: 'AWAKE', instanceTypes: '{' }), false, 'an unreadable record is none');
});

test('a workload summary gives when its state began (stateAt, router 0.26.0)', () => {
  const at = Date.UTC(2026, 9, 8, 12);
  assert.equal(workloadSummary(testConfig(), { state: 'ASLEEP', stateAt: at }).stateAt, '2026-10-08T12:00:00.000Z');
  assert.equal(workloadSummary(testConfig(), { state: 'ASLEEP' }).stateAt, null);
});

test('a workload summary carries the tags ({} without)', () => {
  assert.deepEqual(workloadSummary(testConfig({ tags: { team: 'payments', env: 'staging' } })).tags, { team: 'payments', env: 'staging' });
  assert.deepEqual(workloadSummary(testConfig()).tags, {});
});

test('a workload summary says scheduled only when it has a schedule', () => {
  assert.equal(workloadSummary(testConfig(), { state: 'AWAKE' }, null, null, [], true).scheduled, true);
  assert.equal('scheduled' in workloadSummary(testConfig(), { state: 'AWAKE' }), false);
});

test('a workload summary says hibernated while asleep hibernated (hibernation), and nothing otherwise', () => {
  const hibernated = JSON.stringify({ ids: ['i-0123456789abcdef0'], at: 1 });
  assert.equal(workloadSummary(testConfig(), { state: 'ASLEEP', hibernated }).hibernated, true);
  assert.equal('hibernated' in workloadSummary(testConfig(), { state: 'ASLEEP' }), false);
  assert.equal('hibernated' in workloadSummary(testConfig(), { state: 'FAILED', hibernated }), false, 'a failed wake: not asleep');
  assert.equal('hibernated' in workloadSummary(testConfig()), false);
});

// --- Both routers' row (lambda/src/lib is Google Cloud's library too) ------------------------------------------------------

test('the fallbacks read the run\'s instanceTypes as DynamoDB holds them (JSON) or as Firestore does (a map); an unreadable record is none', () => {
  const types = { 'i-1': { from: 't3.medium', to: 't3.large' } };
  const fallbacks = [{ instance: 'i-1', from: 't3.medium', to: 't3.large' }];
  assert.deepEqual(fallbacksOf({ instanceTypes: JSON.stringify(types) }), fallbacks);
  assert.deepEqual(fallbacksOf({ instanceTypes: types }), fallbacks);
  for (const run of [undefined, null, {}, { instanceTypes: '' }, { instanceTypes: '{' }, { instanceTypes: { 'i-1': null } }]) {
    assert.deepEqual(fallbacksOf(run), [], JSON.stringify(run));
  }
});

test('workloadRow: the row both routers answer, each cloud giving its identity right after the name, its default source, its host, its backends and whether it hibernated', () => {
  const at = Date.UTC(2026, 9, 8, 12);
  const cfg = testConfig({ name: 'Demo', tags: { team: 'a' }, settingsFrom: { idleMinutes: 'workload' }, type: { name: 'instance' } });
  const row = workloadRow(cfg, { state: 'ASLEEP', stateAt: at, wakeCount: 2, instanceTypes: { 'vm-a': { from: 'n2', to: 'e2' } } }, {
    identity: { backendService: 'app', urlMap: 'lb' }, defaultSource: 'cli', host: 'app.example.com', backends: ['instance'], hibernated: true,
    stats7d: { wakes: 1, ignored: 0, deferred: 0 }, pauses: [{ reason: 'r' }], scheduled: true,
  });
  assert.deepEqual(Object.keys(row).slice(0, 5), ['workloadId', 'name', 'backendService', 'urlMap', 'source']);
  assert.deepEqual([row.name, row.source, row.tags, row.state, row.stateAt, row.url, row.wakeCount], ['Demo', 'cli', { team: 'a' }, 'ASLEEP', '2026-10-08T12:00:00.000Z', 'https://app.example.com/', 2]);
  assert.deepEqual([row.backends, row.hibernated, row.scheduled, row.pauses, row.stats7d], [['instance'], true, true, [{ reason: 'r' }], { wakes: 1, ignored: 0, deferred: 0 }]);
  assert.deepEqual(row.fallbacks, [{ instance: 'vm-a', from: 'n2', to: 'e2' }]);
  assert.deepEqual([row.type, row.settingsFrom], ['instance', { idleMinutes: 'workload' }]);
  assert.deepEqual(row.settings, { waitSeconds: 20, idleMinutes: 15, drainSeconds: 10, wakeTimeoutSeconds: 600, maxHolders: 5 });
  const bare = workloadRow(testConfig({ source: 'manager' }), null, { identity: {}, defaultSource: 'cli' });
  assert.deepEqual([bare.source, bare.state, bare.url, bare.backends, bare.pauses, bare.stats7d], ['manager', 'UNKNOWN', null, [], [], null]);
  for (const key of ['fallbacks', 'scheduled', 'hibernated', 'type', 'settingsFrom']) assert.equal(key in bare, false, key);
  assert.equal('hibernated' in workloadRow(cfg, { state: 'AWAKE' }, { identity: {}, hibernated: true }), false, 'hibernated only while asleep');
});

test('a daily counter that cannot be written is logged, never thrown: the answer never waits on the statistics', async () => {
  const counted = [];
  const logs = [];
  const log = { ...silentLog, warn: (event, fields) => logs.push({ event, ...fields }) };
  await createCount({ store: { count: async (workloadId, counter) => { counted.push([workloadId, counter]); } }, log })('demo', 'wake:visitor');
  assert.deepEqual(counted, [['demo', 'wake:visitor']]);
  await createCount({ store: { count: async () => { throw new Error('throttled'); } }, log })('demo', 'ignored:bot');
  assert.deepEqual(logs, [{ event: 'StatsWriteFailed', workloadId: 'demo', counter: 'ignored:bot', error: 'throttled' }]);
});
