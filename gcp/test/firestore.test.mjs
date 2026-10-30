import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFirestoreStore } from '../src/firestore.mjs';
import { GoogleError } from '../src/google.mjs';

const ROOT = 'projects/p/databases/dmtr-europe-west1/documents';
const BASE = `https://firestore.googleapis.com/v1/${ROOT}`;

// A Firestore REST server in memory: documents, `updateTime` preconditions, `exists` preconditions, update masks and
// `increment` transforms; every request yields once, so that concurrent callers interleave.
function fakeFirestore() {
  const docs = new Map();
  const calls = [];
  let clock = 0;
  const fail = (code, status, message) => new GoogleError(`Google: ${code} ${message}`, { code, status });
  const wire = (name) => ({ name: `${ROOT}/${name}`, fields: structuredClone(docs.get(name).fields), updateTime: docs.get(name).updateTime });

  function commit({ writes }) {
    const staged = new Map();
    const current = (name) => staged.get(name) ?? docs.get(name);
    for (const write of writes) {
      if (write.delete) {
        staged.set(write.delete.slice(ROOT.length + 1), null);
        continue;
      }
      const name = write.update.name.slice(ROOT.length + 1);
      const before = current(name);
      const precondition = write.currentDocument;
      if (precondition?.exists === false && before) throw fail(409, 'ALREADY_EXISTS', `${name} exists`);
      if (precondition?.exists === true && !before) throw fail(404, 'NOT_FOUND', `${name} is missing`);
      if (precondition?.updateTime && before?.updateTime !== precondition.updateTime) {
        throw fail(400, 'FAILED_PRECONDITION', 'the stored version does not match the requested one');
      }
      let fields = structuredClone(write.update.fields ?? {});
      if (write.updateMask) {
        fields = structuredClone(before?.fields ?? {});
        for (const path of write.updateMask.fieldPaths) {
          const key = path.replace(/^`(.*)`$/, '$1');
          if (key in (write.update.fields ?? {})) fields[key] = structuredClone(write.update.fields[key]);
          else delete fields[key];
        }
      }
      for (const { fieldPath, increment } of write.updateTransforms ?? []) {
        const key = fieldPath.replace(/^`(.*)`$/, '$1');
        fields[key] = { integerValue: String(Number(fields[key]?.integerValue ?? 0) + Number(increment.integerValue)) };
      }
      staged.set(name, { fields });
    }
    clock += 1;
    for (const [name, doc] of staged) {
      if (doc === null) docs.delete(name);
      else docs.set(name, { fields: doc.fields, updateTime: `2026-01-01T00:00:${String(clock).padStart(2, '0')}.000000Z` });
    }
    return { writeResults: writes.map(() => ({})), commitTime: String(clock) };
  }

  async function request(method, url, body) {
    calls.push({ method, url, body });
    await Promise.resolve();
    assert.ok(url.startsWith(BASE), `unexpected url ${url}`);
    const path = url.slice(BASE.length);
    if (method === 'POST' && path === ':commit') return commit(body);
    if (method === 'POST' && path === ':batchGet') {
      return body.documents.map((full) => {
        const name = full.slice(ROOT.length + 1);
        return docs.has(name) ? { found: wire(name) } : { missing: full };
      });
    }
    if (method === 'GET') {
      const [route, query = ''] = path.slice(1).split('?');
      if (docs.has(route)) return wire(route);
      if (!route.includes('/')) {
        const params = new URLSearchParams(query);
        const names = [...docs.keys()].filter((n) => n.startsWith(`${route}/`)).sort();
        const size = Number(params.get('pageSize') ?? 100);
        const from = Number(params.get('pageToken') ?? 0);
        const page = names.slice(from, from + size).map(wire);
        return from + size < names.length ? { documents: page, nextPageToken: String(from + size) } : (page.length ? { documents: page } : {});
      }
      throw fail(404, 'NOT_FOUND', `${route} not found`);
    }
    throw new Error(`unexpected request ${method} ${url}`);
  }

  return { request, docs, calls };
}

function setup({ now = () => Date.parse('2026-03-10T12:00:00Z') } = {}) {
  const firestore = fakeFirestore();
  const store = createFirestoreStore({
    google: { request: firestore.request },
    project: 'p',
    database: 'dmtr-europe-west1',
    now,
  });
  return { ...firestore, store };
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

test('getConfig and getRun: null for a workload that does not exist; getSchedule is always null (no schedules in G1)', async () => {
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

test('listConfigs and listWorkloads: every configuration across pages, without schedules', async () => {
  const { store } = setup();
  for (let i = 0; i < 5; i += 1) await store.putConfig(`w${i}`, { workloadId: `w${i}` });
  await store.initRun('w0', 1);
  const ids = (await store.listConfigs()).map((c) => c.workloadId).sort();
  assert.deepEqual(ids, ['w0', 'w1', 'w2', 'w3', 'w4']);
  const { configs, schedules } = await store.listWorkloads();
  assert.equal(configs.length, 5);
  assert.equal(schedules.size, 0);
});

test('deleteWorkload: the configuration and the run go, the daily counters stay; a missing workload is fine', async () => {
  const { store, docs } = setup();
  await store.putConfig('app', { workloadId: 'app' });
  await store.initRun('app', 1);
  await store.count('app', 'ignored:bot');
  await store.deleteWorkload('app');
  assert.deepEqual([...docs.keys()], ['stats/app-2026-03-10']);
  await store.deleteWorkload('app');
  assert.equal(await store.getConfig('app'), null);
});
