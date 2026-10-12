import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createCatalog, parseCatalogUrl } from '../src/lib/catalog.mjs';
import { packList } from '../src/lib/ip-lists.mjs';
import { fakeClock, silentLog } from './fakes.mjs';

const URL = 's3://dmt-dev-manager-ip-lists-121014831971/catalog.json';
const MIN = 60_000;

// The manager's bucket: objects with their ETag; a GET with the current ETag answers 304 (notModified).
function fakeS3() {
  const objects = new Map();
  const calls = [];
  const failures = new Map();
  let tag = 0;
  const put = (key, body) => objects.set(key, { body: Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)), etag: `"e${++tag}"` });
  return {
    objects, calls, failures, put,
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

// A list published as the manager's list function does: its data, then its manifest.
function publish(s3, name, entries, version, over = {}) {
  const data = Buffer.concat(packList(entries));
  s3.put(`${name}/${version}.bin`, data);
  s3.put(`${name}/manifest.json`, {
    name, version, format: 'ranges-v1', entries: entries.length, dropped: 0, invalid: 0, bytes: data.length,
    sha256: createHash('sha256').update(data).digest('hex'), fetchedAt: '2026-10-08T12:00:00.000Z', refreshHours: 24, key: `${name}/${version}.bin`, ...over,
  });
}

function setup({ own = [] } = {}) {
  const clock = fakeClock();
  const s3 = fakeS3();
  s3.put('catalog.json', { lists: [{ name: 'ipsum', url: 'https://x/ipsum', action: 'defer', refreshHours: 24 }, { name: 'aws', url: 'https://x/aws', action: 'ignore', refreshHours: 12 }] });
  publish(s3, 'ipsum', ['45.130.203.183/32'], 'v1');
  publish(s3, 'aws', ['3.5.0.0/16'], 'v1');
  const catalog = createCatalog({ s3, url: URL, own, now: clock.now, log: silentLog });
  return { clock, s3, catalog };
}

test('parseCatalogUrl takes an s3:// catalog URL, nothing else', () => {
  assert.deepEqual(parseCatalogUrl(URL), { bucket: 'dmt-dev-manager-ip-lists-121014831971', key: 'catalog.json', prefix: '' });
  assert.deepEqual(parseCatalogUrl('s3://b-1/lists/catalog.json'), { bucket: 'b-1', key: 'lists/catalog.json', prefix: 'lists/' });
  assert.equal(parseCatalogUrl('https://x/catalog.json'), null);
  assert.equal(parseCatalogUrl(''), null);
});

test('loads the catalog\'s lists from the manager\'s bucket, with their actions', async () => {
  const { catalog } = setup();
  const lists = await catalog.get();
  assert.deepEqual(lists.map((l) => [l.name, l.action, l.has('45.130.203.183'), l.has('3.5.1.1')]), [['ipsum', 'defer', true, false], ['aws', 'ignore', false, true]]);
});

test('reads again only every 5 minutes, with conditional GETs: an unchanged list costs 304s, its data is not read again', async () => {
  const { catalog, clock, s3 } = setup();
  await catalog.get();
  const first = s3.calls.length;
  await catalog.get();
  assert.equal(s3.calls.length, first, 'within 5 minutes: nothing read');
  clock.advance(6 * MIN);
  await catalog.get();
  const again = s3.calls.slice(first);
  assert.deepEqual(again.map((c) => c.key), ['catalog.json', 'ipsum/manifest.json', 'aws/manifest.json']);
  assert.ok(again.every((c) => c.etag), 'each with the ETag it holds');
});

test('a new version in the manifest loads the new data', async () => {
  const { catalog, clock, s3 } = setup();
  await catalog.get();
  publish(s3, 'ipsum', ['8.229.112.0/20'], 'v2');
  clock.advance(6 * MIN);
  const [ipsum] = await catalog.get();
  assert.equal(ipsum.has('8.229.112.122'), true);
  assert.equal(ipsum.has('45.130.203.183'), false);
});

test('data that does not match its manifest (SHA-256, size or format) is refused, the previous version kept', async () => {
  const { catalog, clock, s3 } = setup();
  await catalog.get();
  publish(s3, 'ipsum', ['8.229.112.0/20'], 'v2', { sha256: 'f'.repeat(64) });
  clock.advance(6 * MIN);
  const [ipsum] = await catalog.get();
  assert.equal(ipsum.has('45.130.203.183'), true, 'v1 kept');
  const described = await catalog.describe();
  assert.match(described.lists.find((l) => l.name === 'ipsum').error, /version v2: SHA-256 differs from the manifest/);
  publish(s3, 'aws', ['3.6.0.0/16'], 'v2', { format: 'ranges-v9' });
  clock.advance(6 * MIN);
  await catalog.get();
  assert.match((await catalog.describe()).lists.find((l) => l.name === 'aws').error, /format ranges-v9/);
});

test('an unreadable catalog is reported, and the lists already loaded are kept', async () => {
  const { catalog, clock, s3 } = setup();
  await catalog.get();
  s3.failures.set('catalog.json', 'AccessDenied');
  clock.advance(6 * MIN);
  assert.equal((await catalog.get()).length, 2);
  assert.equal((await catalog.describe()).error, 'S3 AccessDenied');
});

test('a list the manager has not published yet is pending, not an error', async () => {
  const { catalog, s3 } = setup();
  s3.objects.delete('aws/manifest.json');
  const described = await catalog.describe();
  assert.deepEqual(described.lists.map((l) => [l.name, l.source, l.entries, l.pending ?? false, l.error ?? null]), [
    ['ipsum', 'manager', 1, false, null],
    ['aws', 'manager', 0, true, 'not published by the manager yet'],
  ]);
});

test('a manifest refused while the catalog of the same bucket was read is a list not published yet (no s3:ListBucket: a missing object answers AccessDenied)', async () => {
  const { catalog, s3 } = setup();
  s3.failures.set('aws/manifest.json', 'AccessDenied');
  const aws = (await catalog.describe()).lists.find((l) => l.name === 'aws');
  assert.equal(aws.pending, true);
  assert.equal(aws.error, 'not published by the manager yet');
});

test('describe reads the manifests only, never the data (the controller\'s health and configuration)', async () => {
  const { catalog, s3 } = setup();
  const described = await catalog.describe();
  assert.ok(!s3.calls.some((c) => c.key.endsWith('.bin')));
  assert.deepEqual(described.lists[0], {
    name: 'ipsum', action: 'defer', source: 'manager', refreshHours: 24, entries: 1, dropped: 0, version: 'v1', fetchedAt: '2026-10-08T12:00:00.000Z',
  });
  assert.equal(described.url, URL);
});

test('a list of the router\'s own (Terraform ip_lists) wins over the catalog\'s list of the same name', async () => {
  const { catalog } = setup({ own: ['aws'] });
  assert.deepEqual((await catalog.get()).map((l) => l.name), ['ipsum']);
  assert.deepEqual((await catalog.describe()).lists.map((l) => l.name), ['ipsum']);
});
