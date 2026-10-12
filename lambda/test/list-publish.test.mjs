import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createListPublisher } from '../src/lib/list-publish.mjs';
import { unpackList } from '../src/lib/ip-lists.mjs';
import { fakeClock, silentLog } from './fakes.mjs';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// The manager's bucket: what the list function reads, writes and deletes, in order.
function fakeBucket() {
  const objects = new Map();
  const writes = [];
  return {
    objects, writes,
    async getObjectIf({ key }) {
      const object = objects.get(key);
      if (!object) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
      return { body: object.body, etag: '"x"' };
    },
    async putObject({ key, body, contentType }) {
      writes.push(`put ${key}`);
      objects.set(key, { body: Buffer.from(body), contentType });
    },
    async deleteObject({ key }) {
      writes.push(`delete ${key}`);
      objects.delete(key);
    },
  };
}
const json = (bucket, key) => JSON.parse(bucket.objects.get(key).body.toString('utf8'));

function setup({ lists = [{ name: 'ipsum', url: 'https://x/ipsum', action: 'defer', refreshHours: 24 }], sources = { 'https://x/ipsum': '45.130.203.183\n8.8.8.8\n10.0.0.1\n' } } = {}) {
  const clock = fakeClock(Date.UTC(2026, 9, 8, 12));
  const bucket = fakeBucket();
  bucket.objects.set('catalog.json', { body: Buffer.from(JSON.stringify({ lists })) });
  const state = { sources };
  const downloads = [];
  const publisher = createListPublisher({
    s3: bucket, bucket: 'dmt-dev-manager-ip-lists-1', now: clock.now, log: silentLog,
    download: async (url) => {
      downloads.push(url);
      const text = state.sources[url];
      if (text instanceof Error) throw text;
      return text;
    },
  });
  return { clock, bucket, publisher, downloads, state };
}

test('publishes a list: its data, then its manifest, then the status; the reserved ranges dropped', async () => {
  const { bucket, publisher, clock } = setup();
  await publisher.run();
  const version = String(clock.now());
  assert.deepEqual(bucket.writes, [`put data/ipsum/${version}.bin`, 'put ipsum/manifest.json', 'put status.json']);
  const data = bucket.objects.get(`data/ipsum/${version}.bin`).body;
  const manifest = json(bucket, 'ipsum/manifest.json');
  assert.deepEqual(manifest, {
    name: 'ipsum', version, format: 'ranges-v1', entries: 2, dropped: 1, invalid: 0, bytes: data.length,
    sha256: createHash('sha256').update(data).digest('hex'), fetchedAt: new Date(clock.now()).toISOString(), refreshHours: 24, key: `data/ipsum/${version}.bin`,
  });
  assert.equal(unpackList([data]).has('45.130.203.183'), true);
  assert.equal(unpackList([data]).has('10.0.0.1'), false);
  assert.deepEqual(json(bucket, 'status.json').lists.map((l) => [l.name, l.version, l.entries, l.error ?? null]), [['ipsum', version, 2, null]]);
});

test('downloads a list again once its refresh period passed, not before', async () => {
  const { publisher, clock, downloads } = setup();
  await publisher.run();
  clock.advance(23 * HOUR);
  await publisher.run();
  assert.equal(downloads.length, 1);
  clock.advance(HOUR);
  await publisher.run();
  assert.equal(downloads.length, 2);
});

test('a list that lost more than half its entries keeps the previous version, with the error', async () => {
  const many = Array.from({ length: 10 }, (_, i) => `45.130.203.${i + 1}`).join('\n');
  const { bucket, publisher, clock, state } = setup({ sources: { 'https://x/ipsum': many } });
  await publisher.run();
  const before = json(bucket, 'ipsum/manifest.json');
  state.sources['https://x/ipsum'] = '45.130.203.1\n45.130.203.2\n';
  clock.advance(DAY);
  await publisher.run();
  assert.deepEqual(json(bucket, 'ipsum/manifest.json'), before);
  const [line] = json(bucket, 'status.json').lists;
  assert.equal(line.error, 'shrank from 10 to 2 entries: the previous version is kept');
  assert.equal(line.version, before.version);
});

test('a failed download keeps the previous version, and is tried again after an hour, not before', async () => {
  const { bucket, publisher, clock, state, downloads } = setup();
  await publisher.run();
  state.sources['https://x/ipsum'] = new Error('HTTP 503');
  clock.advance(DAY);
  await publisher.run();
  assert.equal(json(bucket, 'status.json').lists[0].error, 'HTTP 503');
  clock.advance(30 * 60_000);
  await publisher.run();
  assert.equal(downloads.length, 2, 'within the hour: not tried again');
  clock.advance(31 * 60_000);
  state.sources['https://x/ipsum'] = '1.2.3.4\n5.6.7.8\n';
  await publisher.run();
  assert.equal(downloads.length, 3);
  assert.equal(json(bucket, 'status.json').lists[0].error, undefined);
  assert.equal(json(bucket, 'ipsum/manifest.json').entries, 2);
});

test('nothing usable (an error page, an empty file) is refused', async () => {
  const { bucket, publisher } = setup({ sources: { 'https://x/ipsum': '<html>Service unavailable</html>' } });
  await publisher.run();
  assert.equal(bucket.objects.has('ipsum/manifest.json'), false);
  assert.match(json(bucket, 'status.json').lists[0].error, /^no usable entry/);
});

test('a new URL is downloaded at once, whatever the refresh period', async () => {
  const { bucket, publisher, clock, downloads } = setup();
  await publisher.run();
  bucket.objects.set('catalog.json', { body: Buffer.from(JSON.stringify({ lists: [{ name: 'ipsum', url: 'https://y/ipsum', action: 'defer', refreshHours: 24 }] })) });
  clock.advance(HOUR);
  await publisher.run().catch(() => {});
  assert.deepEqual(downloads, ['https://x/ipsum', 'https://y/ipsum']);
});

test('a version 20 days old is written again under a new key (the data/ prefix expires after 30 days)', async () => {
  const { bucket, publisher, clock, state } = setup({ lists: [{ name: 'ipsum', url: 'https://x/ipsum', action: 'defer', refreshHours: 24 }] });
  await publisher.run();
  const first = json(bucket, 'ipsum/manifest.json');
  state.sources['https://x/ipsum'] = new Error('HTTP 404');
  clock.advance(20 * DAY);
  bucket.writes.length = 0;
  await publisher.run();
  const again = json(bucket, 'ipsum/manifest.json');
  assert.equal(again.version, first.version, 'the same version: routers do not reload it');
  assert.notEqual(again.key, first.key);
  assert.deepEqual(bucket.objects.get(again.key).body, bucket.objects.get(first.key).body);
  assert.ok(bucket.writes.includes(`put ${again.key}`));
  assert.match(again.key, /^data\/ipsum\//);
});

test('a list removed from the catalog leaves the status, and its manifest is deleted', async () => {
  const { bucket, publisher, clock } = setup();
  await publisher.run();
  bucket.objects.set('catalog.json', { body: Buffer.from(JSON.stringify({ lists: [] })) });
  clock.advance(HOUR);
  await publisher.run();
  assert.equal(bucket.objects.has('ipsum/manifest.json'), false);
  assert.deepEqual(json(bucket, 'status.json').lists, []);
});

test('one list failing does not stop the others', async () => {
  const { bucket, publisher } = setup({
    lists: [{ name: 'bad', url: 'https://x/bad', action: 'defer', refreshHours: 24 }, { name: 'ipsum', url: 'https://x/ipsum', action: 'defer', refreshHours: 24 }],
    sources: { 'https://x/bad': new Error('HTTP 500'), 'https://x/ipsum': '1.2.3.4\n' },
  });
  await publisher.run();
  assert.deepEqual(json(bucket, 'status.json').lists.map((l) => [l.name, l.error ?? null]), [['bad', 'HTTP 500'], ['ipsum', null]]);
});
