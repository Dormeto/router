import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createListCache, parseLists } from '../src/lib/list-cache.mjs';
import { encodeParts } from '../src/lib/ip-lists.mjs';
import { classify } from '../src/lib/http.mjs';
import { albEvent, fakeClock, fakeStore, silentLog, testConfig } from './fakes.mjs';

const LISTS = [{ name: 'ipsum', url: 'https://x/ipsum', action: 'defer', refreshHours: 24 }, { name: 'bad', url: 'https://x/bad', action: 'ignore', refreshHours: 24 }];

function storeWith(clock, entries = { ipsum: ['45.130.203.183/32'], bad: ['142.93.0.0/16'] }) {
  const store = fakeStore({ config: testConfig(), run: { state: 'ASLEEP' }, clock });
  for (const [name, list] of Object.entries(entries)) {
    const parts = encodeParts(list);
    store.state.lists[name] = { meta: { version: 'v1', parts: parts.length, entries: list.length, fetchedAt: 1_700_000_000_000 }, parts: { v1: parts } };
  }
  return store;
}

test('parseLists reads the router lists and skips invalid ones', () => {
  const errors = [];
  const lists = parseLists(JSON.stringify([
    { name: 'ipsum', url: 'https://x', action: 'defer', refreshHours: 24 },
    { name: 'no-url', action: 'defer' },
    { name: 'odd', url: 'https://y', action: 'block' },
  ]), (e) => errors.push(e));
  assert.deepEqual(lists, [{ name: 'ipsum', url: 'https://x', action: 'defer', refreshHours: 24 }]);
  assert.equal(errors.length, 2);
  assert.deepEqual(parseLists(undefined), []);
});

test('the cache loads each list once and reloads only a new version', async () => {
  const clock = fakeClock();
  const store = storeWith(clock);
  let partReads = 0;
  const read = store.getListParts;
  store.getListParts = async (...args) => { partReads += 1; return read(...args); };
  const cache = createListCache({ store, lists: LISTS, now: clock.now, log: silentLog });
  const lists = await cache.get();
  assert.deepEqual(lists.map((l) => [l.name, l.action, l.has('45.130.203.183'), l.has('142.93.0.66')]),
    [['ipsum', 'defer', true, false], ['bad', 'ignore', false, true]]);
  await cache.get();
  clock.advance(6 * 60_000);
  await cache.get();
  assert.equal(partReads, 2, 'same version: parts not read again');
  const parts = encodeParts(['8.229.112.0/20']);
  store.state.lists.ipsum = { meta: { version: 'v2', parts: parts.length, entries: 1 }, parts: { v2: parts } };
  clock.advance(6 * 60_000);
  const [ipsum] = await cache.get();
  assert.equal(ipsum.has('8.229.112.122'), true);
  assert.equal(ipsum.has('45.130.203.183'), false);
});

test('a list not downloaded yet or failing to load is skipped, the previous version kept', async () => {
  const clock = fakeClock();
  const store = storeWith(clock, { ipsum: ['45.130.203.183/32'] });
  const cache = createListCache({ store, lists: LISTS, now: clock.now, log: silentLog });
  assert.deepEqual((await cache.get()).map((l) => l.name), ['ipsum']);
  store.getListMeta = async () => { throw new Error('throttled'); };
  clock.advance(6 * 60_000);
  assert.equal((await cache.get())[0].has('45.130.203.183'), true);
  const described = await cache.describe();
  assert.deepEqual(described.map((d) => [d.name, d.action, d.entries]), [['ipsum', 'defer', 1], ['bad', 'ignore', 0]]);
  assert.equal(described[1].error, 'throttled');
});

test('classify: explicit wakes override lists; defer lets the probe wake, ignore does not', async () => {
  const clock = fakeClock();
  const lists = await createListCache({ store: storeWith(clock), lists: LISTS, now: clock.now, log: silentLog }).get();
  const from = (ip, headers = {}) => albEvent({ headers: { 'x-forwarded-for': ip, ...headers } });
  const probe = { 'x-dormeto-probe': '1', accept: '*/*' };
  assert.deepEqual(classify(from('45.130.203.183'), [], { lists }), { kind: 'normal', deferred: true, reason: 'list ipsum' });
  assert.deepEqual(classify(from('45.130.203.183', probe), [], { lists }), { kind: 'probe' });
  assert.deepEqual(classify(from('142.93.0.66'), [], { lists }), { kind: 'no-wake', reason: 'list bad' });
  assert.deepEqual(classify(from('142.93.0.66', probe), [], { lists }), { kind: 'no-wake', reason: 'list bad' });
  assert.deepEqual(classify(from('142.93.0.66', { 'x-dormeto-wake': '1' }), [], { lists }), { kind: 'normal', trigger: 'header' });
  assert.deepEqual(classify(from('82.127.11.49'), [], { lists }), { kind: 'normal' });
  assert.deepEqual(classify(from('82.127.11.49'), [], { lists, browserMode: true }), { kind: 'normal', deferred: true, reason: 'browser mode' });
});

test('waker: a listed source is deferred in any mode, its probe wakes, an awake workload skips the lists', async () => {
  const { createWaker } = await import('../src/lib/waker-core.mjs');
  const clock = fakeClock();
  const store = storeWith(clock);
  store.state.run = { state: 'ASLEEP' };
  const invocations = [];
  let loads = 0;
  const cache = createListCache({ store, lists: LISTS, now: clock.now, log: silentLog });
  const listCache = { get: async () => { loads += 1; return cache.get(); }, describe: () => cache.describe() };
  const handler = createWaker({
    store, invokeController: async (p) => { invocations.push(p); }, prefix: 'dmt-dev-', now: clock.now, sleep: clock.sleep,
    newId: () => 'w1', log: silentLog, listCache,
  });
  const listed = { 'x-forwarded-for': '45.130.203.183' };
  const res = await handler(albEvent({ headers: listed }));
  assert.equal(res.statusCode, 503);
  assert.equal(store.state.run.state, 'ASLEEP');
  assert.deepEqual(store.state.stats, { 'deferred:list ipsum': 1 });
  await handler(albEvent({ headers: { ...listed, 'x-dormeto-probe': '1', accept: '*/*' } }));
  assert.equal(store.state.run.state, 'WAKING');
  assert.equal(invocations.length, 1);
  store.state.run = { state: 'AWAKE', awakeSince: 0 };
  const before = loads;
  await handler(albEvent({ headers: listed }));
  assert.equal(loads, before, 'no list lookup while awake');
});

test('waker: requests settled by the filters or an explicit wake do not load the lists', async () => {
  const { createWaker } = await import('../src/lib/waker-core.mjs');
  const clock = fakeClock();
  const store = storeWith(clock);
  store.state.run = { state: 'ASLEEP' };
  let loads = 0;
  const listCache = { get: async () => { loads += 1; return []; }, describe: async () => [] };
  const handler = createWaker({
    store, invokeController: async () => {}, prefix: 'dmt-dev-', now: clock.now, sleep: clock.sleep, newId: () => 'w1',
    log: silentLog, listCache,
  });
  await handler(albEvent({ method: 'HEAD' }));
  await handler(albEvent({ headers: { 'user-agent': 'Googlebot/2.1' } }));
  await handler(albEvent({ path: '/.env' }));
  assert.equal(loads, 0);
  await handler(albEvent({ headers: { 'x-dormeto-wake': '1', accept: 'application/json' } }));
  assert.equal(loads, 0);
  store.state.run = { state: 'ASLEEP' };
  await handler(albEvent());
  assert.equal(loads, 1);
});
