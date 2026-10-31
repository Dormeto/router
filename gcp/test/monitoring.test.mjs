import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMonitoring, CALLS } from '../src/monitoring.mjs';

const point = (n) => ({ interval: { startTime: 's', endTime: 'e' }, value: { int64Value: String(n) } });

test('requestCount: the backend service\'s request_count over the interval, through any URL map, summed', async () => {
  const calls = [];
  const google = { request: async (method, url) => { calls.push({ method, url }); return { timeSeries: [{ points: [point(3), point(4)] }, { points: [point(5)] }] }; } };
  const monitoring = createMonitoring({ google, project: 'p' });
  const count = await monitoring.requestCount({ backendService: 'dmtr-x-app', from: Date.UTC(2026, 9, 30, 10, 0, 0), to: Date.UTC(2026, 9, 30, 10, 5, 0) });
  assert.equal(count, 12);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, 'https://monitoring.googleapis.com/v3/projects/p/timeSeries');
  assert.equal(url.searchParams.get('filter'),
    'metric.type = "loadbalancing.googleapis.com/https/request_count" AND resource.labels.backend_target_name = "dmtr-x-app"');
  assert.equal(url.searchParams.get('interval.startTime'), '2026-10-30T10:00:00.000Z');
  assert.equal(url.searchParams.get('interval.endTime'), '2026-10-30T10:05:00.000Z');
});

test('requestCount: pages, and counts nothing when no series', async () => {
  const pages = [{ timeSeries: [{ points: [point(1)] }], nextPageToken: 'n' }, { timeSeries: [{ points: [point(2)] }] }];
  const urls = [];
  const google = { request: async (m, url) => { urls.push(url); return pages.shift(); } };
  assert.equal(await createMonitoring({ google, project: 'p' }).requestCount({ backendService: 'b', from: 0, to: 1000 }), 3);
  assert.equal(new URL(urls[1]).searchParams.get('pageToken'), 'n');
  assert.equal(await createMonitoring({ google: { request: async () => ({}) }, project: 'p' }).requestCount({ backendService: 'b', from: 0, to: 1000 }), 0);
});

// Review focus 1 (the plan): a filter that matches nothing reads 0 and naps a busy workload. These are M5's, read back with real
// traffic (the design's section 7): `backend_target_name` is the plain name on both kinds.
const GLOBAL_FILTER = 'metric.type = "loadbalancing.googleapis.com/https/request_count" AND resource.labels.backend_target_name = "app"';
const FILTERS = [
  ['no lb, a global workload', undefined, GLOBAL_FILTER],
  ['global', { kind: 'global' }, GLOBAL_FILTER],
  ['classic', { kind: 'classic' }, GLOBAL_FILTER],
  ['regional', { kind: 'regional', region: 'europe-west1' }, 'metric.type = "loadbalancing.googleapis.com/https/external/regional/request_count" AND resource.labels.backend_target_name = "app" AND resource.labels.region = "europe-west1"'],
];
for (const [name, lb, filter] of FILTERS) {
  test(`requestCount: the exact filter of ${name} (M5)`, async () => {
    const urls = [];
    const google = { request: async (m, url) => { urls.push(url); return { timeSeries: [{ points: [point(2)] }] }; } };
    assert.equal(await createMonitoring({ google, project: 'p' }).requestCount({ backendService: 'app', lb, from: 0, to: 1000 }), 2);
    assert.equal(new URL(urls[0]).searchParams.get('filter'), filter);
  });
}

test('CALLS', () => {
  assert.deepEqual(CALLS, { requestCount: ['monitoring.timeSeries.list'] });
});
