import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createManagerSettings, settingsUrlOf } from '../src/lib/manager-settings.mjs';
import { fakeClock, fakeStore, silentLog, testConfig } from './fakes.mjs';

const URL = 's3://dmt-dev-manager-ip-lists-1/settings.json';
const CATALOG = 's3://dmt-dev-manager-ip-lists-1/catalog.json';
const MIN = 60_000;

// The manager's bucket as in catalog.test.mjs: objects with their ETag, 304 on the current one, failures by name.
function fakeS3() {
  const objects = new Map();
  const calls = [];
  const failures = new Map();
  let tag = 0;
  return {
    objects, calls, failures,
    put: (key, body) => objects.set(key, { body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)), etag: `"e${++tag}"` }),
    async getObjectIf({ bucket, key, etag }) {
      calls.push({ bucket, key, etag });
      if (failures.has(key)) throw Object.assign(new Error(failures.get(key)), { name: failures.get(key) });
      const object = objects.get(key);
      if (!object) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
      if (etag && etag === object.etag) return { notModified: true };
      return { body: object.body, etag: object.etag };
    },
  };
}

function setup({ url = URL } = {}) {
  const clock = fakeClock();
  const s3 = fakeS3();
  const store = fakeStore({ config: testConfig(), run: { state: 'AWAKE' }, clock });
  const make = () => createManagerSettings({ s3, url, catalogUrl: CATALOG, store, now: clock.now, log: silentLog });
  return { clock, s3, store, make, settings: make() };
}

test('settingsUrlOf: the catalog\'s prefix and settings.json', () => {
  assert.equal(settingsUrlOf('s3://b/catalog.json'), 's3://b/settings.json');
  assert.equal(settingsUrlOf('s3://b/p/catalog.json'), 's3://b/p/settings.json');
  assert.equal(settingsUrlOf(null), null);
  assert.equal(settingsUrlOf('https://x/catalog.json'), null);
});

test('the first refresh stores the value, its ETag and the time', async () => {
  const s = setup();
  s.s3.put('settings.json', { workloads: { hibernate: false } });
  await s.settings.refresh();
  assert.deepEqual(await s.settings.current(), { hibernate: false, readAt: s.clock.now(), error: null });
  assert.deepEqual(s.store.state.managerSettings, { hibernate: false, etag: '"e1"', readAt: s.clock.now(), error: null });
  assert.deepEqual(s.s3.calls, [{ bucket: 'dmt-dev-manager-ip-lists-1', key: 'settings.json', etag: null }]);
});

test('a second refresh within 5 minutes reads nothing; after 5 minutes it sends the ETag and a 304 keeps the value', async () => {
  const s = setup();
  s.s3.put('settings.json', { workloads: { hibernate: false } });
  await s.settings.refresh();
  s.clock.advance(3 * MIN);
  await s.settings.refresh();
  assert.equal(s.s3.calls.length, 1);
  s.clock.advance(MIN + 30_000);
  await s.settings.refresh();
  assert.equal(s.s3.calls.length, 2);
  assert.equal(s.s3.calls[1].etag, '"e1"');
  assert.deepEqual(await s.settings.current(), { hibernate: false, readAt: s.clock.now(), error: null });
  assert.equal(s.store.state.managerSettings.etag, '"e1"');
});

test('NoSuchKey and AccessDenied mean never set: true, no error', async () => {
  for (const name of [null, 'AccessDenied']) {
    const s = setup();
    if (name) { s.s3.put('catalog.json', { lists: [] }); s.s3.failures.set('settings.json', name); }
    await s.settings.refresh();
    assert.deepEqual(await s.settings.current(), { hibernate: true, readAt: s.clock.now(), error: null }, String(name));
  }
});

test('an unreadable object keeps the last value and records the error; a good read clears it', async () => {
  const s = setup();
  s.s3.put('settings.json', { workloads: { hibernate: false } });
  await s.settings.refresh();
  s.clock.advance(5 * MIN);
  s.s3.failures.set('settings.json', 'SlowDown');
  await s.settings.refresh();
  assert.deepEqual(await s.settings.current(), { hibernate: false, readAt: s.clock.now(), error: 'S3 SlowDown' });
  // The failed attempt counts as the last read: not tried again before 5 minutes.
  s.clock.advance(MIN);
  await s.settings.refresh();
  assert.equal(s.s3.calls.length, 2);
  s.clock.advance(5 * MIN);
  s.s3.failures.clear();
  await s.settings.refresh();
  assert.deepEqual(await s.settings.current(), { hibernate: false, readAt: s.clock.now(), error: null });
});

test('invalid content keeps the previous value and sets the error; nothing read before: true', async () => {
  const s = setup();
  s.s3.put('settings.json', { workloads: { hibernate: false } });
  await s.settings.refresh();
  s.clock.advance(5 * MIN);
  s.s3.put('settings.json', '{nope');
  await s.settings.refresh();
  const current = await s.settings.current();
  assert.equal(current.hibernate, false);
  assert.match(current.error, /^settings\.json is invalid: /);
  const fresh = setup();
  fresh.s3.put('settings.json', { workloads: { hibernate: 'yes' } });
  await fresh.settings.refresh();
  assert.equal((await fresh.settings.current()).hibernate, true);
  assert.match((await fresh.settings.current()).error, /^settings\.json is invalid: .*workloads\.hibernate/);
});

test('current() on a new instance reads the table, never S3 (a cold Lambda after an error)', async () => {
  const s = setup();
  s.s3.put('settings.json', { workloads: { hibernate: false } });
  await s.settings.refresh();
  s.clock.advance(5 * MIN);
  s.s3.failures.set('settings.json', 'SlowDown');
  await s.settings.refresh();
  const calls = s.s3.calls.length;
  const cold = s.make();
  assert.deepEqual(await cold.current(), { hibernate: false, readAt: s.clock.now(), error: 'S3 SlowDown' });
  assert.equal(s.s3.calls.length, calls);
});

test('current() is null before anything was read from the table; url null: nothing to do', async () => {
  const s = setup();
  assert.equal(await s.settings.current(), null);
  const none = setup({ url: null });
  await none.settings.refresh();
  assert.equal(none.s3.calls.length, 0);
  assert.equal(await none.settings.current(), null);
});

test('a read due after 4 minutes: each 5-minute check reads, whatever the time of the last one inside it', async () => {
  const s = setup();
  s.s3.put('settings.json', { workloads: { hibernate: true } });
  await s.settings.refresh();
  s.clock.advance(4 * MIN + 30_000);
  await s.settings.refresh();
  assert.equal(s.s3.calls.length, 2);
});

test('AccessDenied is never set only when the catalog reads; else the last value stays with the error; NoSuchKey after false is true', async () => {
  const s = setup();
  s.s3.put('settings.json', { workloads: { hibernate: false } });
  await s.settings.refresh();
  s.clock.advance(5 * MIN);
  s.s3.failures.set('settings.json', 'AccessDenied');
  s.s3.failures.set('catalog.json', 'AccessDenied');
  await s.settings.refresh();
  assert.deepEqual(await s.settings.current(), { hibernate: false, readAt: s.clock.now(), error: 'S3 AccessDenied' });
  s.clock.advance(5 * MIN);
  s.s3.failures.delete('catalog.json');
  s.s3.put('catalog.json', { lists: [] });
  await s.settings.refresh();
  assert.deepEqual(await s.settings.current(), { hibernate: true, readAt: s.clock.now(), error: null });
  const t = setup();
  t.s3.put('settings.json', { workloads: { hibernate: false } });
  await t.settings.refresh();
  t.clock.advance(5 * MIN);
  t.s3.objects.delete('settings.json');
  await t.settings.refresh();
  assert.deepEqual(await t.settings.current(), { hibernate: true, readAt: t.clock.now(), error: null });
});
