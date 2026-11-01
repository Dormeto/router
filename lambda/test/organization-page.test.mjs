import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOrganizationPage } from '../src/lib/organization-page.mjs';
import { createManagerSettings } from '../src/lib/manager-settings.mjs';
import { fakeClock, fakeStore, silentLog, testConfig } from './fakes.mjs';

const URL = 's3://bucket/lists/settings.json';
const CATALOG = 's3://bucket/lists/catalog.json';
const ORG = { mode: 'template', icon: 'none', title: 'Acme', description: 'Sleeps at night.' };

// The manager's bucket: objects with their ETag, 304 on the current one, failures by name.
function fakeS3() {
  const objects = new Map();
  const calls = [];
  const failures = new Map();
  let tag = 0;
  return {
    objects, calls, failures,
    put: (key, body) => objects.set(key, { body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)), etag: `"e${++tag}"` }),
    async getObjectIf({ bucket, key, etag, signal }) {
      calls.push({ bucket, key, etag, signal });
      if (failures.has(key)) throw Object.assign(new Error(failures.get(key)), { name: failures.get(key) });
      const object = objects.get(key);
      if (!object) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
      if (etag && etag === object.etag) return { notModified: true };
      return { body: object.body, etag: object.etag };
    },
  };
}
const setup = ({ url = URL } = {}) => {
  const s3 = fakeS3();
  const warned = [];
  const log = { ...silentLog, warn: (event, fields) => warned.push([event, fields]) };
  return { s3, warned, org: createOrganizationPage({ s3, url, catalogUrl: CATALOG, log }) };
};

test('reads the waitingPage key of settings.json with a conditional GET; a 304 keeps the page', async () => {
  const s = setup();
  s.s3.put('lists/settings.json', { workloads: { hibernate: false }, waitingPage: ORG });
  assert.deepEqual(await s.org.read(), ORG);
  assert.deepEqual(await s.org.read(), ORG);
  assert.deepEqual(s.s3.calls.map((c) => [c.bucket, c.key, c.etag]), [['bucket', 'lists/settings.json', null], ['bucket', 'lists/settings.json', '"e1"']]);
  s.s3.put('lists/settings.json', { waitingPage: { ...ORG, title: 'New' } });
  assert.equal((await s.org.read()).title, 'New');
});

test('the page is what is valid of the key: a bad field is dropped, a bad or absent key is none, whatever hibernate says', async () => {
  const s = setup();
  s.s3.put('lists/settings.json', { workloads: { hibernate: 'maybe' }, waitingPage: { mode: 'template', title: 'x'.repeat(100), description: 'ok' } });
  assert.deepEqual(await s.org.read(), { mode: 'template', description: 'ok' });
  for (const bad of ['text', 7, [], { mode: 'custom' }, { mode: 'pdf' }, undefined]) {
    s.s3.put('lists/settings.json', { waitingPage: bad });
    assert.equal(await s.org.read(), null, JSON.stringify(bad));
  }
});

test('hibernate and the page do not affect each other: a bad waitingPage leaves hibernate read by the check, a bad hibernate leaves the page', async () => {
  const s = setup();
  const clock = fakeClock();
  const store = fakeStore({ config: testConfig(), run: { state: 'AWAKE' }, clock });
  const settings = createManagerSettings({ s3: s.s3, url: URL, catalogUrl: CATALOG, store, now: clock.now, log: silentLog });
  s.s3.put('lists/settings.json', { workloads: { hibernate: false }, waitingPage: 'nonsense' });
  await settings.refresh();
  assert.deepEqual([(await settings.current()).hibernate, (await settings.current()).error, await s.org.read()], [false, null, null]);
  s.s3.put('lists/settings.json', { workloads: { hibernate: 'maybe' }, waitingPage: ORG });
  assert.deepEqual(await s.org.read(), ORG);
  assert.deepEqual(store.state.pages, {}, 'no store write for the organization\'s page');
});

test('a file that is not JSON or a read that fails keeps the last page, none on a cold instance, and the failure is thrown for the caller to log', async () => {
  const s = setup();
  s.s3.put('lists/settings.json', { waitingPage: ORG });
  await s.org.read();
  s.s3.put('lists/settings.json', '{"waitingPage":');
  assert.deepEqual(await s.org.read(), ORG, 'not JSON: kept');
  s.s3.failures.set('lists/settings.json', 'SlowDown');
  await assert.rejects(s.org.read(), { name: 'SlowDown' });
  const cold = createOrganizationPage({ s3: s.s3, url: URL, catalogUrl: CATALOG, log: silentLog });
  await assert.rejects(cold.read(), { name: 'SlowDown' });
});

test('a missing object is none; AccessDenied is none only where the catalog reads; no url reads nothing', async () => {
  const s = setup();
  assert.equal(await s.org.read(), null);
  s.s3.put('lists/settings.json', { waitingPage: ORG });
  await s.org.read();
  s.s3.objects.delete('lists/settings.json');
  assert.equal(await s.org.read(), null, 'gone: none');

  const denied = setup();
  denied.s3.failures.set('lists/settings.json', 'AccessDenied');
  await assert.rejects(denied.org.read(), { name: 'AccessDenied' });
  denied.s3.put('lists/catalog.json', {});
  assert.equal(await denied.org.read(), null);

  const none = setup({ url: null });
  assert.equal(await none.org.read(), null);
  assert.deepEqual(none.s3.calls, []);
});

test('the signal of the caller goes to the read', async () => {
  const s = setup();
  const control = new AbortController();
  await s.org.read({ signal: control.signal });
  assert.equal(s.s3.calls[0].signal, control.signal);
});
