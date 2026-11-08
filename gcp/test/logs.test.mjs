import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GoogleError } from '../src/google.mjs';
import { CALLS, createLogs } from '../src/logs.mjs';

const VIEW = 'projects/p/locations/global/buckets/_Default/views/dmtr-europe-west1-lb';
const ENTRIES = 'https://logging.googleapis.com/v2/entries:list';
const FROM = Date.UTC(2026, 10, 7, 10, 0, 0);
const TO = Date.UTC(2026, 10, 7, 10, 18, 30);
const WINDOW = 'timestamp>="2026-11-07T10:00:00.000Z" AND timestamp<"2026-11-07T10:18:30.000Z"';

const entry = (requestUrl, { method = 'GET', userAgent = 'Mozilla/5.0', remoteIp = '203.0.113.7' } = {}) => ({
  timestamp: '2026-11-07T10:05:00Z',
  resource: { type: 'http_load_balancer', labels: { backend_service_name: 'app' } },
  httpRequest: { requestMethod: method, requestUrl, userAgent, remoteIp, status: 200 },
});

// `pages`: the answers, in order; a function, for each call.
function setup(pages) {
  const calls = [];
  const logs = [];
  const google = {
    request: async (method, url, body) => {
      calls.push({ method, url, body: structuredClone(body) });
      return typeof pages === 'function' ? pages(calls.length) : pages.shift();
    },
  };
  const log = Object.fromEntries(['info', 'warn', 'error'].map((level) => [level, (event, fields = {}) => logs.push({ level, event, ...fields })]));
  return { calls, logs, reader: createLogs({ google, view: VIEW, log }) };
}

const read = (reader, more = {}) => reader.requests({ backendService: 'app', from: FROM, to: TO, limit: 1000, ...more });

test('requests: one entries.list on the view, filtered by the resource type, the backend service and the window, oldest first', async () => {
  const { calls, reader } = setup([{ entries: [entry('https://demo.example.com/')] }]);
  await read(reader);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, ENTRIES);
  assert.deepEqual(calls[0].body, {
    resourceNames: [VIEW],
    filter: `resource.type="http_load_balancer" AND resource.labels.backend_service_name="app" AND ${WINDOW}`,
    orderBy: 'timestamp asc',
    pageSize: 1000,
  });
});

// Global and classic log as `http_load_balancer`; a regional one as its own resource, whose labels are its metric's (M5: the
// service's plain name in `backend_target_name`), with the region, as a regional service's name is unique only there.
const GLOBAL_FILTER = `resource.type="http_load_balancer" AND resource.labels.backend_service_name="app" AND ${WINDOW}`;
const FILTERS = [
  ['no lb, a global workload', undefined, GLOBAL_FILTER],
  ['global', { kind: 'global' }, GLOBAL_FILTER],
  ['classic', { kind: 'classic' }, GLOBAL_FILTER],
  ['regional', { kind: 'regional', region: 'europe-west1' },
    `resource.type="http_external_regional_lb_rule" AND resource.labels.backend_target_name="app" AND resource.labels.region="europe-west1" AND ${WINDOW}`],
];
for (const [name, lb, filter] of FILTERS) {
  test(`requests: the exact filter of ${name}`, async () => {
    const { calls, reader } = setup([{ entries: [entry('https://demo.example.com/')] }]);
    await read(reader, lb ? { lb } : {});
    assert.equal(calls[0].body.filter, filter);
  });
}

test('requests: each entry as the method, the URL, its path as received, the user agent and the client\'s address', async () => {
  const { reader } = setup([{
    entries: [
      entry('https://demo.example.com/.env?x=1', { userAgent: 'curl/8.4.0', remoteIp: '198.51.100.4' }),
      entry('http://34.120.1.2', { method: 'HEAD' }),
      entry('https://demo.example.com/a/../wp-login.php'),
      { httpRequest: { requestMethod: 'GET', requestUrl: 'https://demo.example.com/shop/cart' } },
    ],
  }]);
  assert.deepEqual(await read(reader), [
    { method: 'GET', url: 'https://demo.example.com/.env?x=1', path: '/.env', userAgent: 'curl/8.4.0', remoteIp: '198.51.100.4' },
    { method: 'HEAD', url: 'http://34.120.1.2', path: '/', userAgent: 'Mozilla/5.0', remoteIp: '203.0.113.7' },
    { method: 'GET', url: 'https://demo.example.com/a/../wp-login.php', path: '/a/../wp-login.php', userAgent: 'Mozilla/5.0', remoteIp: '203.0.113.7' },
    { method: 'GET', url: 'https://demo.example.com/shop/cart', path: '/shop/cart', userAgent: undefined, remoteIp: undefined },
  ]);
});

// M2: the regional load balancer logs the client's address with its port, the global and classic ones without. The address alone
// is the client's, which the IP lists match.
test('requests: the client\'s address without its port, IPv4 or bracketed IPv6, brackets with no port too; a bare IPv6 address and an empty one as they are', async () => {
  const { reader } = setup([{
    entries: [
      entry('https://demo.example.com/', { remoteIp: '82.127.11.49:56212' }),
      entry('https://demo.example.com/', { remoteIp: '[2001:db8::1]:443' }),
      entry('https://demo.example.com/', { remoteIp: '2001:db8::1' }),
      entry('https://demo.example.com/', { remoteIp: '82.127.11.49' }),
      entry('https://demo.example.com/', { remoteIp: '[2001:db8::1]' }),
      entry('https://demo.example.com/', { remoteIp: '' }),
    ],
  }]);
  assert.deepEqual((await read(reader)).map((r) => r.remoteIp), ['82.127.11.49', '2001:db8::1', '2001:db8::1', '82.127.11.49', '2001:db8::1', '']);
});

test('requests: the pages are read in turn, each asking what the limit leaves', async () => {
  const { calls, reader } = setup([
    { entries: [entry('https://demo.example.com/1'), entry('https://demo.example.com/2')], nextPageToken: 'n1' },
    { entries: [], nextPageToken: 'n2' },
    { entries: [entry('https://demo.example.com/3')] },
  ]);
  const requests = await read(reader, { limit: 5 });
  assert.deepEqual(requests.map((r) => r.path), ['/1', '/2', '/3']);
  assert.deepEqual(calls.map((c) => [c.body.pageSize, c.body.pageToken]), [[5, undefined], [3, 'n1'], [3, 'n2']]);
  assert.ok(calls.every((c) => c.body.filter === calls[0].body.filter));
});

// The one loop on an idle nap's path while visitors may be at the waker, and each page spends the project's entries.list quota,
// which other workloads' reads need: cut short, and the count decides.
test('requests: a token after 10 pages is null, said in LogsUnread: no more pages read', async () => {
  const { calls, logs, reader } = setup((n) => ({ entries: [entry(`https://demo.example.com/${n}`)], nextPageToken: `n${n}` }));
  assert.equal(await read(reader), null);
  assert.equal(calls.length, 10);
  assert.deepEqual(logs.map((l) => [l.level, l.event, l.backendService]), [['info', 'LogsUnread', 'app']]);
  assert.match(logs[0].reason, /more than 10 pages/);
  const ten = setup((n) => ({ entries: [entry(`https://demo.example.com/${n}`)], ...(n < 10 ? { nextPageToken: `n${n}` } : {}) }));
  assert.equal((await read(ten.reader)).length, 10);
});

test('requests: a fourth page with a token and no entries is null, said in LogsUnread; three are read through', async () => {
  const { calls, logs, reader } = setup(() => ({ nextPageToken: 'n' }));
  assert.equal(await read(reader), null);
  assert.equal(calls.length, 4);
  assert.match(logs[0].reason, /more than 3 empty pages/);
  const three = setup((n) => (n <= 3 ? { entries: [], nextPageToken: `n${n}` } : { entries: [entry('https://demo.example.com/')] }));
  assert.equal((await read(three.reader)).length, 1);
  assert.equal(three.calls.length, 4);
});

test('requests: none in the window reads an empty list', async () => {
  const { reader } = setup([{}]);
  assert.deepEqual(await read(reader), []);
});

test('requests: more entries than the limit is null, said in LogsUnread', async () => {
  const { calls, logs, reader } = setup([{ entries: [entry('https://demo.example.com/1'), entry('https://demo.example.com/2')], nextPageToken: 'n' }]);
  assert.equal(await read(reader, { limit: 2 }), null);
  assert.equal(calls.length, 1);
  assert.deepEqual(logs.map((l) => [l.event, l.backendService]), [['LogsUnread', 'app']]);
  assert.match(logs[0].reason, /more than 2/);
});

test('requests: the limit reached on the last page is no more than it', async () => {
  const { reader } = setup([{ entries: [entry('https://demo.example.com/1'), entry('https://demo.example.com/2')] }]);
  assert.equal((await read(reader, { limit: 2 })).length, 2);
});

test('requests: a 403 (the view\'s grant missing) is null, said in LogsUnread with Google\'s words', async () => {
  const { logs, reader } = setup(() => {
    throw new GoogleError('Google: POST https://logging.googleapis.com/v2/entries:list: 403 Permission \'logging.views.access\' denied', { code: 403, status: 'PERMISSION_DENIED' });
  });
  assert.equal(await read(reader), null);
  assert.deepEqual(logs.map((l) => [l.level, l.event]), [['warn', 'LogsUnread']]);
  assert.match(logs[0].reason, /403 Permission 'logging\.views\.access' denied/);
});

test('requests: any other failure, on a later page too, is null', async () => {
  const { reader } = setup((n) => {
    if (n === 2) throw new TypeError('fetch failed');
    return { entries: [entry('https://demo.example.com/1')], nextPageToken: 'n' };
  });
  assert.equal(await read(reader), null);
});

// M2: Monitoring's request_count is sampled and batched (13 for minutes that logged 4, gaps of six minutes), so it tells nothing of
// whether the logs are complete: the entries the view holds are the requests, none compared with a count.
test('requests: the entries the view holds are the requests, said in no LogsUnread', async () => {
  const { logs, reader } = setup([{ entries: [entry('https://demo.example.com/1'), entry('https://demo.example.com/2')] }]);
  assert.deepEqual((await read(reader)).map((r) => r.path), ['/1', '/2']);
  assert.deepEqual(logs, []);
});

test('CALLS: the view\'s read', () => {
  assert.deepEqual(CALLS, { requests: ['logging.views.access'] });
});
