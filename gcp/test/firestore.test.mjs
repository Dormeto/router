import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFirestoreStore } from '../src/firestore.mjs';
import { GoogleError } from '../src/google.mjs';
import { BASE, ROOT, fakeFirestore } from './firestore-fake.mjs';

// `timers` holds the stats' flush timers: `fire()` runs those due, as the 10 s passing.
function setup({ now = () => Date.parse('2026-03-10T12:00:00Z'), log = null } = {}) {
  const firestore = fakeFirestore();
  const timers = new Set();
  const store = createFirestoreStore({
    google: { request: firestore.request },
    project: 'p',
    database: 'dmtr-europe-west1',
    now,
    log,
    after: (ms, fn) => {
      const timer = { ms, fn };
      timers.add(timer);
      return timer;
    },
    cancel: (timer) => timers.delete(timer),
  });
  const fire = async () => {
    for (const timer of [...timers]) {
      timers.delete(timer);
      await timer.fn();
    }
  };
  return { ...firestore, store, timers, fire };
}

const commits = (calls) => calls.filter((c) => c.url.endsWith(':commit'));

test('values: an integer above 2^31, nested maps, arrays, booleans, null and a float round trip; integers go as strings', async () => {
  const { store, calls } = setup();
  const config = {
    workloadId: 'app', big: 3_000_000_000, ratio: 0.5, on: true, off: false, nothing: null, name: 'é "q"',
    nested: { list: [1, 'two', { three: [3, null] }], empty: {}, none: [] },
  };
  await store.putConfig('app', config);
  assert.deepEqual(await store.getConfig('app'), config);
  const { update } = commits(calls)[0].body.writes[0];
  assert.equal(update.name, `${ROOT}/workloads/app`);
  assert.deepEqual(update.fields.config.mapValue.fields.big, { integerValue: '3000000000' });
  assert.deepEqual(update.fields.config.mapValue.fields.ratio, { doubleValue: 0.5 });
  assert.deepEqual(update.fields.config.mapValue.fields.nothing, { nullValue: null });
  assert.deepEqual(update.fields.config.mapValue.fields.nested.mapValue.fields.list.arrayValue.values[0], { integerValue: '1' });
});

test('getConfig, getRun and getSchedule: null for a workload that does not exist or has no schedule', async () => {
  const { store } = setup();
  assert.equal(await store.getConfig('nope'), null);
  assert.equal(await store.getRun('nope'), null);
  await store.putConfig('app', { workloadId: 'app' });
  assert.equal(await store.getSchedule('app'), null);
});

test('putConfig: mustExist is false for a workload that is gone, and nothing is written', async () => {
  const { store, docs } = setup();
  assert.equal(await store.putConfig('gone', { workloadId: 'gone' }, { mustExist: true }), false);
  assert.equal(docs.size, 0);
  assert.equal(await store.putConfig('app', { workloadId: 'app' }), true);
  assert.equal(await store.putConfig('app', { workloadId: 'app', renamed: true }, { mustExist: true }), true);
  assert.deepEqual(await store.getConfig('app'), { workloadId: 'app', renamed: true });
});

test('initRun: AWAKE once, false when a run exists', async () => {
  const { store } = setup();
  assert.equal(await store.initRun('app', 1234), true);
  assert.deepEqual(await store.getRun('app'), { state: 'AWAKE', version: 0, awakeSince: 1234, holders: 0, wakeCount: 0 });
  assert.equal(await store.initRun('app', 9999), false);
  assert.equal((await store.getRun('app')).awakeSince, 1234);
});

test('transition: set, increment, remove, version and updatedAt; the new run is returned', async () => {
  const { store } = setup();
  await store.initRun('app', 1);
  await store.transition('app', { cond: { state: 'AWAKE' }, set: { state: 'NAPPING', napInstances: 'i-1', failedAt: 5 }, increment: ['napCount'] });
  const next = await store.transition('app', {
    cond: { state: ['NAPPING', 'FAILED'] }, set: { state: 'ASLEEP' }, remove: ['napInstances'], increment: ['napCount', 'wakeCount'],
  });
  const stored = await store.getRun('app');
  assert.deepEqual(next, stored);
  assert.deepEqual(stored, {
    state: 'ASLEEP', version: 2, awakeSince: 1, holders: 0, wakeCount: 1, failedAt: 5, napCount: 2, updatedAt: Date.parse('2026-03-10T12:00:00Z'),
    stateAt: Date.parse('2026-03-10T12:00:00Z'),
  });
});

test('transition: two from ASLEEP to WAKING, one wins and the other gets null', async () => {
  const { store, docs } = setup();
  await store.initRun('app', 1);
  await store.transition('app', { cond: { state: 'AWAKE' }, set: { state: 'ASLEEP' } });
  const start = (wakeId) => store.transition('app', { cond: { state: 'ASLEEP' }, set: { state: 'WAKING', wakeId }, increment: ['wakeCount'] });
  const [a, b] = await Promise.all([start('a'), start('b')]);
  assert.equal([a, b].filter((r) => r === null).length, 1);
  const winner = a ?? b;
  const run = await store.getRun('app');
  assert.equal(run.state, 'WAKING');
  assert.equal(run.wakeId, winner.wakeId);
  assert.equal(run.wakeCount, 1);
  assert.equal(run.version, 2);
  assert.equal(docs.size, 1);
});

test('transition: a condition that does not hold is null without a write; wakeId, pendingWake and olderThan are checked', async () => {
  const { store, calls } = setup();
  await store.initRun('app', 1);
  await store.transition('app', { cond: { state: 'AWAKE' }, set: { state: 'WAKING', wakeId: 'w1', pendingWake: true } });
  const before = commits(calls).length;
  assert.equal(await store.transition('app', { cond: { state: 'ASLEEP' }, set: { state: 'WAKING' } }), null);
  assert.equal(await store.transition('app', { cond: { state: 'WAKING', wakeId: 'other' }, set: { state: 'AWAKE' } }), null);
  assert.equal(await store.transition('app', { cond: { state: 'WAKING', pendingWake: false }, set: { state: 'AWAKE' } }), null);
  assert.equal(await store.transition('app', { cond: { state: 'WAKING', olderThan: { field: 'updatedAt', ms: 1 } }, set: { state: 'AWAKE' } }), null);
  assert.equal(commits(calls).length, before);
  const ok = await store.transition('app', { cond: { state: 'WAKING', wakeId: 'w1', olderThan: { field: 'updatedAt', ms: Date.parse('2026-03-10T12:00:01Z') } }, set: { state: 'AWAKE' } });
  assert.equal(ok.state, 'AWAKE');
});

test('transition: a run that does not exist is null', async () => {
  const { store } = setup();
  assert.equal(await store.transition('nope', { cond: { state: 'ASLEEP' }, set: { state: 'WAKING' } }), null);
});

test('transition: a lost precondition is read again, and the change applies on the new version', async () => {
  const { store, request, docs } = setup();
  await store.initRun('app', 1);
  const rival = createFirestoreStore({ google: { request }, project: 'p', database: 'dmtr-europe-west1' });
  let raced = false;
  const racing = createFirestoreStore({
    google: {
      request: async (method, url, body) => {
        if (url.endsWith(':commit') && !raced) {
          raced = true;
          await rival.tryAcquireHolder('app', 5);
        }
        return request(method, url, body);
      },
    },
    project: 'p', database: 'dmtr-europe-west1', now: () => 1,
  });
  const next = await racing.transition('app', { cond: { state: 'AWAKE' }, set: { state: 'NAPPING' } });
  assert.deepEqual([next.state, next.holders], ['NAPPING', 1]);
  assert.equal(docs.get('runs/app').fields.holders.integerValue, '1');
});

test('transition: the precondition failing for good is read 5 times, then the error is thrown', async () => {
  const { store, request, calls } = setup();
  await store.initRun('app', 1);
  calls.length = 0;
  const stale = createFirestoreStore({
    google: {
      request: async (method, url, body) => {
        if (url.endsWith(':commit')) throw new GoogleError('Google: 400 stale', { code: 400, status: 'FAILED_PRECONDITION' });
        return request(method, url, body);
      },
    },
    project: 'p', database: 'dmtr-europe-west1',
  });
  await assert.rejects(stale.transition('app', { cond: { state: 'AWAKE' }, set: { state: 'NAPPING' } }), (err) => err.status === 'FAILED_PRECONDITION');
  assert.equal(calls.filter((c) => c.method === 'GET').length, 5);
});

test('transition: any other refusal is thrown at once', async () => {
  const { store, request, calls } = setup();
  await store.initRun('app', 1);
  calls.length = 0;
  const denied = createFirestoreStore({
    google: {
      request: async (method, url, body) => {
        if (url.endsWith(':commit')) throw new GoogleError('Google: 403 denied', { code: 403, status: 'PERMISSION_DENIED' });
        return request(method, url, body);
      },
    },
    project: 'p', database: 'dmtr-europe-west1',
  });
  await assert.rejects(denied.transition('app', { cond: { state: 'AWAKE' }, set: { state: 'NAPPING' } }), (err) => err.status === 'PERMISSION_DENIED');
  assert.equal(calls.filter((c) => c.method === 'GET').length, 1);
});

test('count: the day\'s counters, created by the first, added by the next; getStats adds up the last days', async () => {
  let t = Date.parse('2026-03-08T23:00:00Z');
  const { store, docs } = setup({ now: () => t });
  await store.count('app', 'ignored:bot');
  await store.count('app', 'ignored:bot');
  await store.count('app', 'wake:browser');
  t = Date.parse('2026-03-10T01:00:00Z');
  await store.count('app', 'deferred:browser mode');
  await store.count('app', 'ignored:bot');
  await store.count('other', 'ignored:bot');
  await store.flushStats();
  assert.deepEqual([...docs.keys()].sort(), ['stats/app-2026-03-08', 'stats/app-2026-03-10', 'stats/other-2026-03-10']);
  assert.deepEqual(docs.get('stats/app-2026-03-08').fields['ignored:bot'], { integerValue: '2' });
  assert.deepEqual(await store.getStats('app', 3), {
    days: 3,
    since: '2026-03-08',
    today: { ignored: { bot: 1 }, deferred: { 'browser mode': 1 }, wakes: {} },
    total: { ignored: { bot: 3 }, deferred: { 'browser mode': 1 }, wakes: { browser: 1 } },
  });
  const one = await store.getStats('app', 1);
  assert.equal(one.since, '2026-03-10');
  assert.deepEqual(one.total, { ignored: { bot: 1 }, deferred: { 'browser mode': 1 }, wakes: {} });
  assert.deepEqual(await store.getStats('nobody', 2), { days: 2, since: '2026-03-09', today: { ignored: {}, deferred: {}, wakes: {} }, total: { ignored: {}, deferred: {}, wakes: {} } });
});

test('tryAcquireHolder: refused beyond the maximum; releaseHolder gives one back and never goes below zero', async () => {
  const { store } = setup();
  await store.initRun('app', 1);
  assert.equal(await store.tryAcquireHolder('app', 2), true);
  assert.equal(await store.tryAcquireHolder('app', 2), true);
  assert.equal(await store.tryAcquireHolder('app', 2), false);
  assert.equal((await store.getRun('app')).holders, 2);
  await store.releaseHolder('app');
  assert.equal(await store.tryAcquireHolder('app', 2), true);
  await store.releaseHolder('app');
  await store.releaseHolder('app');
  await store.releaseHolder('app');
  assert.equal((await store.getRun('app')).holders, 0);
});

test('tryAcquireHolder: concurrent callers never exceed the maximum', async () => {
  const { store } = setup();
  await store.initRun('app', 1);
  const results = await Promise.all(Array.from({ length: 6 }, () => store.tryAcquireHolder('app', 3)));
  assert.equal(results.filter(Boolean).length, 3);
  assert.equal((await store.getRun('app')).holders, 3);
});

test('holders: a run that does not exist is refused, and release is a no-op', async () => {
  const { store, docs } = setup();
  assert.equal(await store.tryAcquireHolder('gone', 2), false);
  await store.releaseHolder('gone');
  assert.equal(docs.size, 0);
});

test('setPendingWake: only while NAPPING, and only the first request of a nap', async () => {
  const { store } = setup();
  await store.initRun('app', 1);
  assert.equal(await store.setPendingWake('app'), false);
  await store.transition('app', { cond: { state: 'AWAKE' }, set: { state: 'NAPPING' } });
  assert.equal(await store.setPendingWake('app'), true);
  assert.equal(await store.setPendingWake('app'), false);
  const run = await store.getRun('app');
  assert.equal(run.pendingWake, true);
  assert.equal(run.version, 1);
});

test('setBackendKinds and setHibernated: written apart from the transitions, on an existing run only', async () => {
  const { store, docs } = setup();
  assert.equal(await store.setBackendKinds('gone', 'vm'), false);
  assert.equal(await store.setHibernated('gone', { ids: ['a'], at: 1 }), false);
  assert.equal(docs.size, 0);
  await store.initRun('app', 1);
  assert.equal(await store.setBackendKinds('app', 'vm,mig'), true);
  assert.equal(await store.setHibernated('app', { ids: ['a', 'b'], at: 7 }), true);
  const run = await store.getRun('app');
  assert.equal(run.backendKinds, 'vm,mig');
  assert.deepEqual(JSON.parse(run.hibernated), { ids: ['a', 'b'], at: 7 });
  assert.equal(run.version, 0);
});

test('listConfigs and listWorkloads: every configuration across pages; no schedule, an empty map', async () => {
  const { store } = setup();
  for (let i = 0; i < 5; i += 1) await store.putConfig(`w${i}`, { workloadId: `w${i}` });
  await store.initRun('w0', 1);
  const ids = (await store.listConfigs()).map((c) => c.workloadId).sort();
  assert.deepEqual(ids, ['w0', 'w1', 'w2', 'w3', 'w4']);
  const { configs, schedules } = await store.listWorkloads();
  assert.equal(configs.length, 5);
  assert.equal(schedules.size, 0);
});

test('deleteWorkload: the configuration, the run and every daily counter go, buffered counts too; a missing workload is fine', async () => {
  const { store, docs, fire } = setup();
  await store.putConfig('app', { workloadId: 'app' });
  await store.putConfig('app-2', { workloadId: 'app-2' });
  await store.initRun('app', 1);
  await store.count('app', 'ignored:bot');
  await store.count('app-2', 'ignored:bot');
  await store.flushStats();
  docs.set('stats/app-2026-02-01', { fields: { 'ignored:bot': { integerValue: '4' } }, updateTime: 'x' });
  await store.count('app', 'wake:browser');
  await store.deleteWorkload('app');
  await fire();
  await store.flushStats();
  assert.deepEqual([...docs.keys()].sort(), ['stats/app-2-2026-03-10', 'workloads/app-2']);
  await store.deleteWorkload('app');
  assert.equal(await store.getConfig('app'), null);
});

test('count: 50 counts in 1 s are one commit with increment 50 per counter, when the 10 s pass', async () => {
  let t = Date.parse('2026-03-10T12:00:00Z');
  const { store, docs, calls, timers, fire } = setup({ now: () => t });
  for (let i = 0; i < 50; i += 1) {
    await store.count('app', i < 40 ? 'ignored:bot' : 'wake:browser');
    t += 20;
  }
  assert.equal(commits(calls).length, 0);
  assert.equal(docs.size, 0);
  assert.deepEqual([...timers].map((timer) => timer.ms), [10_000]);
  await fire();
  assert.equal(commits(calls).length, 1);
  const [write] = commits(calls)[0].body.writes;
  assert.equal(write.update.name, `${ROOT}/stats/app-2026-03-10`);
  assert.deepEqual(write.updateTransforms, [
    { fieldPath: '`ignored:bot`', increment: { integerValue: '40' } },
    { fieldPath: '`wake:browser`', increment: { integerValue: '10' } },
  ]);
  assert.deepEqual(docs.get('stats/app-2026-03-10').fields, { 'ignored:bot': { integerValue: '40' }, 'wake:browser': { integerValue: '10' } });
  // Nothing buffered is left: another window, another commit.
  await store.count('app', 'ignored:bot');
  assert.equal(timers.size, 1);
  await fire();
  assert.equal(commits(calls).length, 2);
  assert.deepEqual(docs.get('stats/app-2026-03-10').fields['ignored:bot'], { integerValue: '41' });
});

test('count: one commit per document, a day change is another document', async () => {
  let t = Date.parse('2026-03-10T23:59:59Z');
  const { store, calls, docs, fire } = setup({ now: () => t });
  await store.count('app', 'ignored:bot');
  await store.count('other', 'ignored:bot');
  t += 2000;
  await store.count('app', 'ignored:bot');
  await fire();
  assert.equal(commits(calls).length, 3);
  assert.deepEqual([...docs.keys()].sort(), ['stats/app-2026-03-10', 'stats/app-2026-03-11', 'stats/other-2026-03-10']);
});

test('flushStats: commits what is left now, resolves when done, and the timer has nothing more to do', async () => {
  const { store, docs, calls, timers, fire } = setup();
  await store.count('app', 'ignored:bot');
  await store.count('app', 'ignored:bot');
  await store.count('other', 'wake:browser');
  await store.flushStats();
  assert.deepEqual(docs.get('stats/app-2026-03-10').fields, { 'ignored:bot': { integerValue: '2' } });
  assert.deepEqual(docs.get('stats/other-2026-03-10').fields, { 'wake:browser': { integerValue: '1' } });
  assert.equal(timers.size, 0);
  const done = commits(calls).length;
  await store.flushStats();
  await fire();
  assert.equal(commits(calls).length, done);
});

test('count: a commit that fails keeps its counts for the next flush, logged StatsWriteFailed', async () => {
  const warned = [];
  const firestore = fakeFirestore();
  let refuse = true;
  const store = createFirestoreStore({
    google: {
      request: async (method, url, body) => {
        if (refuse && url.endsWith(':commit')) throw new GoogleError('Google: 503 down', { code: 503, status: 'UNAVAILABLE' });
        return firestore.request(method, url, body);
      },
    },
    project: 'p',
    database: 'dmtr-europe-west1',
    now: () => Date.parse('2026-03-10T12:00:00Z'),
    log: { warn: (event, fields) => warned.push({ event, ...fields }), info() {}, error() {} },
    after: () => ({}),
    cancel: () => {},
  });
  await store.count('app', 'ignored:bot');
  await store.count('app', 'ignored:bot');
  await store.flushStats();
  assert.equal(firestore.docs.size, 0);
  assert.deepEqual(warned.map((w) => [w.event, w.workloadId, w.error]), [['StatsWriteFailed', 'app', 'Google: 503 down']]);
  await store.count('app', 'ignored:bot');
  refuse = false;
  await store.flushStats();
  assert.deepEqual(firestore.docs.get('stats/app-2026-03-10').fields, { 'ignored:bot': { integerValue: '3' } });
});

test('sweepStats: the documents of days before the day of `before` go, the others stay; the count comes back', async () => {
  const { store, docs } = setup();
  for (const day of ['2026-01-29', '2026-02-02', '2026-02-03', '2026-03-07']) {
    for (const id of ['app', 'other']) docs.set(`stats/${id}-${day}`, { fields: { 'ignored:bot': { integerValue: '1' } }, updateTime: 'x' });
  }
  docs.set('workloads/app', { fields: {}, updateTime: 'x' });
  const swept = await store.sweepStats(Date.parse('2026-03-10T12:00:00Z') - 35 * 86_400_000);
  assert.equal(swept, 4);
  assert.deepEqual([...docs.keys()].sort(), [
    'stats/app-2026-02-03', 'stats/app-2026-03-07', 'stats/other-2026-02-03', 'stats/other-2026-03-07', 'workloads/app',
  ]);
  assert.equal(await store.sweepStats(Date.parse('2026-03-10T12:00:00Z') - 35 * 86_400_000), 0);
});

test('sweepStats: more than a batch of documents, all gone', async () => {
  const { store, docs } = setup();
  for (let i = 0; i < 250; i += 1) docs.set(`stats/w${i}-2026-01-01`, { fields: {}, updateTime: 'x' });
  assert.equal(await store.sweepStats(Date.parse('2026-02-01T00:00:00Z')), 250);
  assert.equal(docs.size, 0);
});

test('claimSweep: once a UTC day, true for the one call that wrote the day, in router/sweep', async () => {
  let t = Date.parse('2026-03-10T01:00:00Z');
  const { store, docs } = setup({ now: () => t });
  assert.deepEqual(await Promise.all([store.claimSweep(), store.claimSweep()]).then((all) => all.sort()), [false, true]);
  assert.deepEqual(docs.get('router/sweep').fields, { day: { stringValue: '2026-03-10' } });
  t = Date.parse('2026-03-10T23:59:00Z');
  assert.equal(await store.claimSweep(), false);
  t = Date.parse('2026-03-11T00:00:01Z');
  assert.equal(await store.claimSweep(), true);
  assert.equal(await store.claimSweep(), false);
  assert.deepEqual(docs.get('router/sweep').fields, { day: { stringValue: '2026-03-11' } });
});

// A store whose commits are all refused as stale (the run is contended for good), with the sleeps and warnings recorded.
async function contended() {
  const { store, request } = setup();
  await store.initRun('app', 1);
  const sleeps = [];
  const warnings = [];
  const stale = createFirestoreStore({
    google: {
      request: async (method, url, body) => {
        if (url.endsWith(':commit')) throw new GoogleError('Google: 400 stale', { code: 400, status: 'FAILED_PRECONDITION' });
        return request(method, url, body);
      },
    },
    project: 'p', database: 'dmtr-europe-west1',
    sleep: async (ms) => { sleeps.push(ms); },
    log: { warn: (event, fields) => warnings.push({ event, ...fields }) },
  });
  return { stale, store, sleeps, warnings };
}

test('a contended run: a jittered backoff between the attempts, not after the last', async () => {
  const { stale, sleeps } = await contended();
  await assert.rejects(stale.transition('app', { cond: { state: 'AWAKE' }, set: { state: 'NAPPING' } }), (err) => err.status === 'FAILED_PRECONDITION');
  assert.equal(sleeps.length, 4);
  assert.ok(sleeps.every((ms) => Number.isFinite(ms) && ms >= 0 && ms <= 1000), `delays ${sleeps}`);
});

test('tryAcquireHolder: retries exhausted, the caller is refused (false) and a warning is logged', async () => {
  const { stale, warnings } = await contended();
  assert.equal(await stale.tryAcquireHolder('app', 3), false);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].event, 'HolderContended');
  assert.equal(warnings[0].workloadId, 'app');
});

test('releaseHolder: retries exhausted, it resolves and logs a warning', async () => {
  const { stale, store, warnings } = await contended();
  await store.tryAcquireHolder('app', 3);
  await stale.releaseHolder('app');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].event, 'HolderReleaseContended');
});

const SCHEDULE = { timezone: 'Europe/Paris', nap: [{ days: ['mon'], from: '20:00', to: '07:00' }], by: 'ops', at: 1_700_000_000_000 };

test('schedules: a round trip, listWorkloads returns the map, deleteSchedule says whether there was one', async () => {
  const { store } = setup();
  await store.putConfig('app', { workloadId: 'app' });
  await store.putConfig('other', { workloadId: 'other' });
  await store.putSchedule('app', SCHEDULE);
  assert.deepEqual(await store.getSchedule('app'), SCHEDULE);
  assert.equal(await store.getSchedule('other'), null);
  const { configs, schedules } = await store.listWorkloads();
  assert.deepEqual(configs.map((c) => c.workloadId).sort(), ['app', 'other']);
  assert.deepEqual([...schedules], [['app', SCHEDULE]]);
  await store.putSchedule('app', { ...SCHEDULE, timezone: 'UTC' });
  assert.equal((await store.getSchedule('app')).timezone, 'UTC');
  assert.equal(await store.deleteSchedule('app'), true);
  assert.equal(await store.deleteSchedule('app'), false);
  assert.equal((await store.listWorkloads()).schedules.size, 0);
});

test('pauses: two workloads paused, one expired; the store gives both, the expired one with its until', async () => {
  const { store } = setup();
  const live = { by: 'ops', at: 1000, reason: 'release', until: Date.parse('2026-03-11T00:00:00Z'), keepAsleep: false };
  const old = { by: 'ops', at: 900, reason: 'freeze', until: Date.parse('2026-03-09T00:00:00Z'), keepAsleep: true };
  await store.addPause('a', live);
  await store.addPause('b', old);
  assert.deepEqual(await store.getPauses('a'), [{ workloadId: 'a', ...live }]);
  assert.deepEqual(await store.getPauses('b'), [{ workloadId: 'b', ...old }]);
  assert.deepEqual(await store.getPauses('none'), []);
  assert.deepEqual(await store.getPauses(null), []);
  assert.deepEqual((await store.listPauses()).map((p) => p.workloadId).sort(), ['a', 'b']);
  // A newer pause is kept when the removal names the older one's time.
  assert.equal(await store.removePauses('a', { at: 999 }), false);
  assert.equal((await store.getPauses('a')).length, 1);
  assert.equal(await store.removePauses('b', { at: 900 }), true);
  assert.equal(await store.removePauses('a'), true);
  assert.equal(await store.removePauses('a'), false);
  assert.deepEqual(await store.listPauses(), []);
});

test('transition: a state change sets stateAt to now, no state change leaves it; an explicit stateAt is kept', async () => {
  let t = Date.parse('2026-03-10T12:00:00Z');
  const { store } = setup({ now: () => t });
  await store.initRun('app', 1);
  assert.equal((await store.getRun('app')).stateAt, undefined);
  t += 1000;
  const napping = await store.transition('app', { cond: { state: 'AWAKE' }, set: { state: 'NAPPING' } });
  assert.equal(napping.stateAt, t);
  assert.equal((await store.getRun('app')).stateAt, t);
  const dated = t;
  t += 5000;
  const same = await store.transition('app', { cond: { state: 'NAPPING' }, set: { state: 'NAPPING', napId: 'x' } });
  assert.equal(same.stateAt, dated);
  const other = await store.transition('app', { cond: { state: 'NAPPING' }, set: { napId: 'y' } });
  assert.equal(other.stateAt, dated);
  const explicit = await store.transition('app', { cond: { state: 'NAPPING' }, set: { state: 'ASLEEP', stateAt: 42 } });
  assert.equal(explicit.stateAt, 42);
});

test('beat: beatAt alone, while the run holds the id (a wakeId WAKING, a napId NAPPING); no version or updatedAt change', async () => {
  let t = Date.parse('2026-03-10T12:00:00Z');
  const { store, calls } = setup({ now: () => t });
  await store.initRun('app', 1);
  await store.transition('app', { cond: { state: 'AWAKE' }, set: { state: 'WAKING', wakeId: 'w1', wakeStartedAt: t } });
  const before = await store.getRun('app');
  t += 60_000;
  assert.equal(await store.beat('app', 'wakeId', 'w1'), true);
  const after = await store.getRun('app');
  assert.deepEqual(after, { ...before, beatAt: t });
  const write = commits(calls).at(-1).body.writes[0];
  assert.deepEqual(write.updateMask, { fieldPaths: ['beatAt'] });
  assert.ok(write.currentDocument.updateTime);
  const count = commits(calls).length;
  assert.equal(await store.beat('app', 'wakeId', 'w2'), false);
  assert.equal(await store.beat('app', 'napId', 'w1'), false);
  assert.equal(await store.beat('nope', 'wakeId', 'w1'), false);
  assert.equal(commits(calls).length, count);
  await store.transition('app', { cond: { state: 'WAKING' }, set: { state: 'NAPPING', napId: 'n1' } });
  assert.equal(await store.beat('app', 'wakeId', 'w1'), false);
  t += 60_000;
  assert.equal(await store.beat('app', 'napId', 'n1'), true);
  assert.equal((await store.getRun('app')).beatAt, t);
});

test('claimResend: resentAt written for the run still WAKING with that wakeId, once a minute; true only for the call that wrote it', async () => {
  let t = Date.parse('2026-03-10T12:00:00Z');
  const { store } = setup({ now: () => t });
  await store.initRun('app', 1);
  await store.transition('app', { cond: { state: 'AWAKE' }, set: { state: 'WAKING', wakeId: 'w1', wakeStartedAt: t } });
  const { version, updatedAt } = await store.getRun('app');
  assert.deepEqual(await Promise.all([store.claimResend('app', 'w1'), store.claimResend('app', 'w1')]).then((all) => all.sort()), [false, true]);
  assert.equal((await store.getRun('app')).resentAt, t);
  assert.equal((await store.getRun('app')).version, version);
  assert.equal((await store.getRun('app')).updatedAt, updatedAt);
  t += 60_000;
  assert.equal(await store.claimResend('app', 'w1'), false);
  t += 1;
  assert.equal(await store.claimResend('app', 'w2'), false);
  assert.equal(await store.claimResend('app', 'w1'), true);
  assert.equal((await store.getRun('app')).resentAt, t);
  await store.transition('app', { cond: { state: 'WAKING' }, set: { state: 'AWAKE' } });
  t += 120_000;
  assert.equal(await store.claimResend('app', 'w1'), false);
  assert.equal(await store.claimResend('nope', 'w1'), false);
});

const bytes = (seed, size) => Buffer.from(Array.from({ length: size }, (_, i) => (i * 31 + seed) % 256));

test('lists: the meta is set and removed by field; parts of 350 kB round trip as bytes, in order', async () => {
  const { store } = setup();
  assert.equal(await store.getListMeta('bad'), null);
  await store.setListMeta('bad', { lastAttemptAt: 5, attemptUrl: 'https://x/l.txt' });
  await store.setListMeta('bad', { error: 'HTTP 500', errorAt: 6 });
  await store.setListMeta('bad', { entries: 3 }, ['error', 'errorAt']);
  assert.deepEqual(await store.getListMeta('bad'), { lastAttemptAt: 5, attemptUrl: 'https://x/l.txt', entries: 3 });
  const parts = Array.from({ length: 12 }, (_, i) => bytes(i, 350 * 1024));
  for (const [index, part] of parts.entries()) await store.putListPart('bad', '100', index, part, 9999999999);
  const read = await store.getListParts('bad', '100');
  assert.equal(read.length, 12);
  read.forEach((part, i) => {
    assert.ok(Buffer.isBuffer(part));
    assert.ok(part.equals(parts[i]), `part ${i}`);
  });
  assert.deepEqual(await store.getListParts('bad', '101'), []);
  assert.deepEqual(await store.getListParts('other', '100'), []);
});

test('lists: a new version leaves the old parts until the meta points at it, then they go; other lists and expired parts too', async () => {
  const { store, docs } = setup({ now: () => Date.parse('2026-03-10T12:00:00Z') });
  const future = Math.floor(Date.parse('2026-04-01T00:00:00Z') / 1000);
  const past = Math.floor(Date.parse('2026-03-01T00:00:00Z') / 1000);
  const partsOf = (name) => [...docs.keys()].filter((k) => k.startsWith('listParts/') && docs.get(k).fields.list.stringValue === name).length;
  await store.putListPart('a', '1', 0, bytes(1, 10), future);
  await store.putListPart('a', '1', 1, bytes(2, 10), future);
  await store.setListMeta('a', { version: '1', parts: 2 });
  await store.putListPart('b', '1', 0, bytes(3, 10), future);
  await store.setListMeta('b', { version: '1', parts: 1 });
  await store.putListPart('a', '2', 0, bytes(4, 10), future);
  await store.putListPart('a', '0', 0, bytes(5, 10), past);
  assert.equal(partsOf('a'), 4);
  // Not the version: the meta of attempts leaves the parts alone.
  await store.setListMeta('a', { lastAttemptAt: 7 });
  assert.equal(partsOf('a'), 4);
  assert.equal((await store.getListParts('a', '1')).length, 2);
  await store.setListMeta('a', { version: '2', parts: 1 }, ['error']);
  assert.equal(partsOf('a'), 1);
  assert.equal((await store.getListParts('a', '2')).length, 1);
  assert.equal((await store.getListParts('a', '1')).length, 0);
  assert.equal(partsOf('b'), 1);
});

test('lists: a list named with a slash or a dash is its own', async () => {
  const { store } = setup();
  await store.putListPart('a/b', '1', 0, bytes(1, 4), 9999999999);
  await store.putListPart('a', '1', 0, bytes(2, 4), 9999999999);
  assert.ok((await store.getListParts('a/b', '1'))[0].equals(bytes(1, 4)));
  assert.ok((await store.getListParts('a', '1'))[0].equals(bytes(2, 4)));
});

test('deleteWorkload: the schedule and the pause go with the configuration and the run', async () => {
  const { store, docs } = setup();
  await store.putConfig('app', { workloadId: 'app' });
  await store.initRun('app', 1);
  await store.putSchedule('app', SCHEDULE);
  await store.addPause('app', { by: 'ops', at: 1, reason: 'x', keepAsleep: false });
  await store.putSchedule('keep', SCHEDULE);
  await store.deleteWorkload('app');
  assert.deepEqual([...docs.keys()], ['schedules/keep']);
  assert.equal(await store.getSchedule('app'), null);
  assert.deepEqual(await store.getPauses('app'), []);
});
