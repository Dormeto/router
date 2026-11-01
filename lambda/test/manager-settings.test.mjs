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
  assert.deepEqual(s.store.state.managerSettings, { hibernate: false, etag: '"e1"', readAt: s.clock.now(), error: null, pageRead: true });
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

test('a failed read with nothing read before stores the level as unknown (null) with the error, never true; a good read then sets it', async () => {
  const s = setup();
  s.s3.failures.set('settings.json', 'SlowDown');
  await s.settings.refresh();
  assert.deepEqual(await s.settings.current(), { hibernate: null, readAt: s.clock.now(), error: 'S3 SlowDown' });
  assert.deepEqual(s.store.state.managerSettings, { hibernate: null, etag: null, readAt: s.clock.now(), error: 'S3 SlowDown' });
  // Reads that keep failing keep it unknown; an AccessDenied from a bucket whose catalog is unreadable too is a failure.
  s.clock.advance(5 * MIN);
  s.s3.failures.set('settings.json', 'AccessDenied');
  s.s3.failures.set('catalog.json', 'AccessDenied');
  await s.settings.refresh();
  assert.deepEqual(await s.settings.current(), { hibernate: null, readAt: s.clock.now(), error: 'S3 AccessDenied' });
  s.clock.advance(5 * MIN);
  s.s3.failures.clear();
  s.s3.put('settings.json', { workloads: { hibernate: false } });
  await s.settings.refresh();
  assert.deepEqual(await s.settings.current(), { hibernate: false, readAt: s.clock.now(), error: null });
});

test('invalid content keeps the previous value and sets the error; nothing read before: unknown (null)', async () => {
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
  assert.equal((await fresh.settings.current()).hibernate, null);
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

// --- The organization's waiting page (branded waiting page design §5) -------------------------------------------------

const ORG = { mode: 'template', icon: 'none', title: 'Acme', description: 'Sleeps at night.' };
const pageWrites = (s) => {
  const writes = [];
  const [put, remove] = [s.store.putWaitingPage, s.store.deleteWaitingPage];
  s.store.putWaitingPage = async (...args) => { writes.push(['put', args[0]]); return put(...args); };
  s.store.deleteWaitingPage = async (...args) => { writes.push(['delete', args[0]]); return remove(...args); };
  return writes;
};

test('the refresh copies settings.json\'s waitingPage into ROUTER/ORGANIZATION-PAGE, once per change; a 304 and an identical new object write nothing', async () => {
  const s = setup();
  const writes = pageWrites(s);
  s.s3.put('settings.json', { workloads: { hibernate: false }, waitingPage: ORG });
  await s.settings.refresh();
  assert.deepEqual(s.store.state.pages.organization, { page: ORG, by: 'settings.json', at: s.clock.now() });
  assert.deepEqual((await s.settings.current()).hibernate, false);
  s.clock.advance(5 * MIN);
  await s.settings.refresh();
  s.s3.put('settings.json', { workloads: { hibernate: false }, waitingPage: ORG, other: 1 });
  s.clock.advance(5 * MIN);
  await s.settings.refresh();
  assert.deepEqual(writes, [['put', 'organization']]);
  s.s3.put('settings.json', { workloads: { hibernate: false }, waitingPage: { ...ORG, title: 'Acme 2' } });
  s.clock.advance(5 * MIN);
  await s.settings.refresh();
  assert.equal(s.store.state.pages.organization.page.title, 'Acme 2');
});

test('an absent waitingPage, a bad one or a missing settings.json removes the copy; a bad field is dropped, the rest kept', async () => {
  const s = setup();
  s.store.state.pages.organization = { page: ORG, by: 'settings.json', at: 1 };
  s.s3.put('settings.json', { workloads: { hibernate: true } });
  await s.settings.refresh();
  assert.equal('organization' in s.store.state.pages, false, 'absent');

  s.s3.put('settings.json', { waitingPage: { mode: 'template', title: 'x'.repeat(100), description: 'ok' } });
  s.clock.advance(5 * MIN);
  await s.settings.refresh();
  assert.deepEqual(s.store.state.pages.organization.page, { mode: 'template', description: 'ok' });

  for (const bad of ['text', 7, [], { mode: 'custom' }, { mode: 'pdf' }]) {
    s.s3.put('settings.json', { waitingPage: bad });
    s.clock.advance(5 * MIN);
    await s.settings.refresh();
    assert.equal('organization' in s.store.state.pages, false, JSON.stringify(bad));
  }

  s.s3.put('settings.json', { waitingPage: ORG });
  s.clock.advance(5 * MIN);
  await s.settings.refresh();
  s.s3.objects.delete('settings.json');
  s.clock.advance(5 * MIN);
  await s.settings.refresh();
  assert.equal('organization' in s.store.state.pages, false, 'never set');
});

test('the two keys parse apart: a bad waitingPage leaves hibernate read, a bad hibernate leaves the page copied, a file that is not JSON touches neither copy', async () => {
  const s = setup();
  s.s3.put('settings.json', { workloads: { hibernate: false }, waitingPage: 'nonsense' });
  await s.settings.refresh();
  assert.deepEqual(await s.settings.current(), { hibernate: false, readAt: s.clock.now(), error: null });

  s.s3.put('settings.json', { workloads: { hibernate: 'maybe' }, waitingPage: ORG });
  s.clock.advance(5 * MIN);
  await s.settings.refresh();
  const current = await s.settings.current();
  assert.deepEqual([current.hibernate, current.error], [false, 'settings.json is invalid: settings.json: workloads.hibernate must be true or false']);
  assert.deepEqual(s.store.state.pages.organization.page, ORG);

  s.s3.put('settings.json', '{"waitingPage":');
  s.clock.advance(5 * MIN);
  await s.settings.refresh();
  assert.deepEqual(s.store.state.pages.organization.page, ORG, 'kept');
  assert.match((await s.settings.current()).error, /^settings.json is invalid/);
});

test('a copy that cannot be written is logged and tried again at the next read (the ETag is not kept); hibernate is stored all the same', async () => {
  const s = setup();
  const warned = [];
  const settings = createManagerSettings({ s3: s.s3, url: URL, catalogUrl: CATALOG, store: s.store, now: s.clock.now, log: { ...silentLog, warn: (event, fields) => warned.push([event, fields.error]) } });
  s.s3.put('settings.json', { workloads: { hibernate: false }, waitingPage: ORG });
  const put = s.store.putWaitingPage;
  s.store.putWaitingPage = async () => { throw new Error('throttled'); };
  await settings.refresh();
  assert.deepEqual(warned, [['WaitingPageNotCopied', 'throttled']]);
  assert.deepEqual([(await settings.current()).hibernate, s.store.state.managerSettings.etag], [false, null]);
  s.store.putWaitingPage = put;
  s.clock.advance(5 * MIN);
  await settings.refresh();
  assert.deepEqual(s.store.state.pages.organization.page, ORG);
  assert.equal(s.store.state.managerSettings.etag, '"e1"');
});

test('a settings item stored before the page was read (an upgraded router) ignores its ETag once, so the page is copied; then a 304 is a 304', async () => {
  const s = setup();
  s.s3.put('settings.json', { workloads: { hibernate: false }, waitingPage: ORG });
  // What 0.34.0 left: the ETag of the very object, no mark that the page was read.
  s.store.state.managerSettings = { hibernate: false, etag: '"e1"', readAt: s.clock.now() - 10 * MIN, error: null };
  await s.settings.refresh();
  assert.deepEqual(s.s3.calls.map((c) => c.etag), [null]);
  assert.deepEqual(s.store.state.pages.organization.page, ORG);
  assert.equal(s.store.state.managerSettings.pageRead, true);
  s.clock.advance(5 * MIN);
  await s.settings.refresh();
  assert.deepEqual(s.s3.calls.map((c) => c.etag), [null, '"e1"']);
  assert.equal(s.store.state.managerSettings.pageRead, true, 'kept by a 304');
});

test('the page is not marked read while its copy fails or the file cannot be parsed', async () => {
  const s = setup();
  s.s3.put('settings.json', '{"waitingPage":');
  await s.settings.refresh();
  assert.notEqual(s.store.state.managerSettings.pageRead, true);
  s.s3.put('settings.json', { waitingPage: ORG });
  s.store.putWaitingPage = async () => { throw new Error('throttled'); };
  s.clock.advance(5 * MIN);
  await s.settings.refresh();
  assert.notEqual(s.store.state.managerSettings.pageRead, true);
});
