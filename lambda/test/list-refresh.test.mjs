import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createListRefresher, downloadText } from '../src/lib/list-refresh.mjs';
import { unpackList } from '../src/lib/ip-lists.mjs';
import { fakeClock, fakeStore, silentLog, testConfig } from './fakes.mjs';

const HOUR = 3_600_000;
const IPSUM = { name: 'ipsum', url: 'https://example.test/ipsum.txt', action: 'defer', refreshHours: 24 };

function setup({ lists = [IPSUM], text = '45.130.203.183\t3\n142.93.0.0/16\n10.0.0.0/8\n', fail = null } = {}) {
  const clock = fakeClock();
  const store = fakeStore({ config: testConfig(), run: { state: 'AWAKE' }, clock });
  const downloads = [];
  const download = async (url) => {
    downloads.push(url);
    if (fail) throw new Error(fail);
    return text;
  };
  const refresher = createListRefresher({ store, lists, download, now: clock.now, log: silentLog });
  return { refresher, store, clock, downloads };
}

test('a list never downloaded is due; a fresh one is not', async () => {
  const { refresher, clock } = setup();
  assert.deepEqual(await refresher.due(), ['ipsum']);
  await refresher.refresh(['ipsum']);
  assert.deepEqual(await refresher.due(), []);
  clock.advance(24 * HOUR);
  assert.deepEqual(await refresher.due(), ['ipsum']);
});

test('refresh stores a filtered, versioned copy and points META to it', async () => {
  const { refresher, store } = setup();
  const [result] = await refresher.refresh(['ipsum']);
  assert.deepEqual(result, { name: 'ipsum', entries: 2, dropped: 1 });
  const { meta, parts } = store.state.lists.ipsum;
  assert.equal(meta.url, IPSUM.url);
  assert.equal(meta.entries, 2);
  assert.equal(meta.dropped, 1);
  assert.equal(meta.parts, parts[meta.version].length);
  assert.equal(meta.format, 'ranges-v1');
  const set = unpackList(parts[meta.version]);
  assert.ok(set.has('45.130.203.183') && set.has('142.93.0.66'));
  assert.ok(!set.has('10.1.2.3'), 'reserved ranges dropped');
});

test('a changed URL makes the list due at once', async () => {
  const { refresher, store } = setup();
  await refresher.refresh(['ipsum']);
  store.state.lists.ipsum.meta.url = 'https://example.test/old.txt';
  store.state.lists.ipsum.meta.attemptUrl = 'https://example.test/old.txt';
  assert.deepEqual(await refresher.due(), ['ipsum']);
});

test('a failed download keeps the previous data, records the error and retries after an hour', async () => {
  const s = setup();
  await s.refresher.refresh(['ipsum']);
  const version = s.store.state.lists.ipsum.meta.version;
  s.clock.advance(25 * HOUR);
  const failing = createListRefresher({
    store: s.store, lists: [IPSUM], download: async () => { throw new Error('HTTP 503'); }, now: s.clock.now, log: silentLog,
  });
  assert.deepEqual(await failing.refresh(['ipsum']), [{ name: 'ipsum', error: 'HTTP 503' }]);
  const { meta } = s.store.state.lists.ipsum;
  assert.equal(meta.version, version);
  assert.equal(meta.error, 'HTTP 503');
  assert.deepEqual(await failing.due(), [], 'no retry within the hour');
  s.clock.advance(HOUR);
  assert.deepEqual(await failing.due(), ['ipsum']);
  await s.refresher.refresh(['ipsum']);
  assert.equal(s.store.state.lists.ipsum.meta.error, undefined, 'a later success clears the error');
});

test('a list with no usable entry is an error, not an empty list', async () => {
  const { refresher, store } = setup({ text: '10.0.0.0/8\n# nothing else\n' });
  assert.deepEqual(await refresher.refresh(['ipsum']), [{ name: 'ipsum', error: 'no usable entry (1 reserved, 0 invalid)' }]);
  assert.equal(store.state.lists.ipsum.meta.version, undefined);
});

test('refresh ignores names that are not configured', async () => {
  const { refresher, downloads } = setup();
  assert.deepEqual(await refresher.refresh(['unknown']), []);
  assert.deepEqual(downloads, []);
});

test('downloadText enforces the status, the size and the timeout', async () => {
  const ok = async () => new Response('45.130.203.183\n');
  assert.equal(await downloadText('https://x', { fetch: ok }), '45.130.203.183\n');
  const notFound = async () => new Response('nope', { status: 404 });
  await assert.rejects(downloadText('https://x', { fetch: notFound }), /HTTP 404/);
  const big = async () => new Response('x'.repeat(2048));
  await assert.rejects(downloadText('https://x', { fetch: big, maxBytes: 1024 }), /larger than 1024 bytes/);
  let signal;
  const capture = async (url, init) => { signal = init.signal; return new Response('a'); };
  await downloadText('https://x', { fetch: capture, timeoutMs: 1234 });
  assert.ok(signal instanceof AbortSignal);
});

test('a list stored in an older format is due again', async () => {
  const { refresher, store } = setup();
  await refresher.refresh(['ipsum']);
  delete store.state.lists.ipsum.meta.format;
  delete store.state.lists.ipsum.meta.attemptFormat;
  assert.deepEqual(await refresher.due(), ['ipsum']);
});
