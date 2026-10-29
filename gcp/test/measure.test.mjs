// G0's measuring tool (vision docs/specs/2026-10-29-google-cloud-design.md, section 12): the pure parts in
// gcp/tools/measure-core.mjs (arguments, the timeline's lines, the answers' summary, the health and status
// transitions), and the probe's one connection per request (a reused connection would hide a switch's propagation).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  UsageError, parseArgs, line, delta, pageOf, kindOfPort, summarize, changes, healthStates, managedStates, targets, actionSummary,
  swapService, createTokens, pointsOf, counted,
} from '../tools/measure-core.mjs';
import { probe } from '../tools/measure.mjs';

const BS = 'https://www.googleapis.com/compute/v1/projects/dormeto-dev/global/backendServices';
const ZONE = 'https://www.googleapis.com/compute/v1/projects/dormeto-dev/zones/europe-west1-b';

// --- Arguments ---

test('switch: the URL map, both backend services and the URL, the global load balancer by default', () => {
  assert.deepEqual(parseArgs(['switch', '--from', 'dmt-demo-app', '--to', 'dmt-demo-standin']), {
    command: 'switch',
    action: null,
    options: {
      project: 'dormeto-dev', configuration: 'dormeto-dev', timeout: 300, settle: 20, region: null,
      urlMap: 'dmt-dev', from: 'dmt-demo-app', to: 'dmt-demo-standin', url: 'https://gcp.dev.dormeto.com/', baseline: 5,
    },
  });
});

test('switch on the regional load balancer: its region, URL map and URL', () => {
  const { options } = parseArgs(['switch', '--region', 'europe-west1', '--url-map', 'dmt-dev-regional',
    '--from', 'dmt-demo-regional-app', '--to', 'dmt-demo-regional-standin', '--url', 'http://regional.gcp.dev.dormeto.com/',
    '--settle', '30', '--timeout', '120', '--baseline', '0']);
  assert.equal(options.region, 'europe-west1');
  assert.equal(options.urlMap, 'dmt-dev-regional');
  assert.equal(options.url, 'http://regional.gcp.dev.dormeto.com/');
  assert.equal(options.settle, 30);
  assert.equal(options.timeout, 120);
  assert.equal(options.baseline, 0);
});

test('vm: the demo VM, its unmanaged group and backend service by default', () => {
  for (const action of ['stop', 'start', 'suspend', 'resume']) {
    assert.deepEqual(parseArgs(['vm', action]), {
      command: 'vm',
      action,
      options: {
        project: 'dormeto-dev', configuration: 'dormeto-dev', timeout: 600, settle: 20, region: null,
        zone: 'europe-west1-b', instance: 'dmt-demo', group: 'dmt-demo', backendService: 'dmt-demo-app',
        url: 'https://gcp.dev.dormeto.com/',
      },
    });
  }
});

test('mig: the managed group, its autoscaler and backend service by default', () => {
  assert.deepEqual(parseArgs(['mig', 'suspend']), {
    command: 'mig',
    action: 'suspend',
    options: {
      project: 'dormeto-dev', configuration: 'dormeto-dev', timeout: 600, settle: 20, region: null,
      zone: 'europe-west1-b', group: 'dmt-demo-mig', autoscaler: 'dmt-demo-mig', autoscalerMode: 'ON',
      backendService: 'dmt-demo-mig-app', url: 'https://mig.gcp.dev.dormeto.com/',
    },
  });
  assert.equal(parseArgs(['mig', 'start', '--autoscaler-mode', 'ONLY_SCALE_OUT']).options.autoscalerMode, 'ONLY_SCALE_OUT');
});

test('metric: the global request count, 20 requests', () => {
  assert.deepEqual(parseArgs(['metric']), {
    command: 'metric',
    action: null,
    options: {
      project: 'dormeto-dev', configuration: 'dormeto-dev', timeout: 900, url: 'https://gcp.dev.dormeto.com/', count: 20,
      metric: 'loadbalancing.googleapis.com/https/request_count', filter: null,
    },
  });
  const { options } = parseArgs(['metric', '--filter', 'resource.labels.backend_target_name="dmt-demo-app"']);
  assert.equal(options.filter, 'resource.labels.backend_target_name="dmt-demo-app"');
});

test('help: --help, -h and help', () => {
  for (const argv of [['--help'], ['-h'], ['help'], ['vm', '--help']]) assert.deepEqual(parseArgs(argv), { help: true });
});

test('a bad command, action, flag or value is a usage error', () => {
  const bad = [
    [],
    ['measure'],
    ['vm'],
    ['vm', 'reboot'],
    ['mig', 'delete'],
    ['switch', '--to', 'dmt-demo-standin'],
    ['switch', '--from', 'dmt-demo-app'],
    ['switch', '--from', 'dmt-demo-app', '--to', 'dmt-demo-app'],
    ['switch', 'extra', '--from', 'a', '--to', 'b'],
    ['vm', 'start', 'extra'],
    ['switch', '--from', 'a', '--to', 'b', '--zone', 'europe-west1-b'],
    ['vm', 'start', '--count', '3'],
    ['metric', '--settle', '3'],
    ['vm', 'start', '--nope'],
    ['vm', 'start', '--settle', '0'],
    ['vm', 'start', '--settle', '2.5'],
    ['vm', 'start', '--timeout', 'soon'],
    ['vm', 'start', '--url', 'ftp://gcp.dev.dormeto.com/'],
    ['vm', 'start', '--url', 'not a url'],
    ['vm', 'start', '--instance', 'Dmt_Demo'],
    ['vm', 'start', '--instance', 'dmt-demo/../x'],
    ['vm', 'start', '--zone', 'europe-west1'],
    ['vm', 'start', '--region', 'europe-west1-b'],
    ['vm', 'start', '--project', 'x'],
    ['mig', 'start', '--autoscaler-mode', 'SOMETIMES'],
    ['metric', '--count', '0'],
  ];
  for (const argv of bad) assert.throws(() => parseArgs(argv), UsageError, argv.join(' '));
});

// --- The timeline ---

test('a timeline line: seconds since the start to one decimal, what, the value', () => {
  assert.equal(line(0, 'answer', 'app'), '0.0s  answer  app');
  assert.equal(line(1234, 'status', 'dmt-demo RUNNING'), '1.2s  status  dmt-demo RUNNING');
  assert.equal(line(61_250, 'first new', 'stand-in +6.7s'), '61.3s  first new  stand-in +6.7s');
  assert.equal(delta(6_740), '+6.7s');
  assert.equal(delta(-260), '-0.3s');
  assert.equal(delta(0), '+0.0s');
});

test('a page: app or stand-in, its instance and boot time; anything else by its status', () => {
  const app = '<!doctype html><title>Dormeto demo: app</title><h1>Dormeto demo: app</h1>'
    + '<p>Instance <code id="instance">dmt-demo</code> booted at <time id="boot">2026-10-29T10:00:12Z</time>.</p>';
  assert.deepEqual(pageOf(200, app), { kind: 'app', instance: 'dmt-demo', boot: '2026-10-29T10:00:12Z' });
  const standin = '<title>Dormeto demo: stand-in</title><code id="instance">dmt-demo-mig-x1k2</code><time id="boot">2026-10-29T11:00:00Z</time>';
  assert.deepEqual(pageOf(200, standin), { kind: 'stand-in', instance: 'dmt-demo-mig-x1k2', boot: '2026-10-29T11:00:00Z' });
  assert.deepEqual(pageOf(503, 'no healthy upstream'), { kind: 'http 503', instance: null, boot: null });
  assert.deepEqual(pageOf(200, '<title>Something else</title>'), { kind: 'http 200', instance: null, boot: null });
  assert.deepEqual(pageOf(502, app), { kind: 'http 502', instance: null, boot: null });
});

test('a backend service\'s page, by its named port: app or stand-in', () => {
  assert.equal(kindOfPort('app'), 'app');
  assert.equal(kindOfPort('standin'), 'stand-in');
  assert.equal(kindOfPort('http'), null);
  assert.equal(kindOfPort(undefined), null);
});

const answers = (...runs) => {
  const list = [];
  for (const [kind, n] of runs) for (let i = 0; i < n; i++) list.push({ t: list.length * 250, kind });
  return list;
};

test('the switch summary: first new answer, last old one, settled at the first of 20 new ones in a row after it', () => {
  const list = answers(['app', 3], ['stand-in', 1], ['app', 1], ['stand-in', 20]);
  assert.deepEqual(summarize(list, { old: 'app', fresh: 'stand-in' }), { firstNew: 750, lastOld: 1000, settled: 1250 });
});

test('the switch summary: 19 new ones in a row are not settled', () => {
  const list = answers(['app', 3], ['stand-in', 19]);
  assert.deepEqual(summarize(list, { old: 'app', fresh: 'stand-in' }), { firstNew: 750, lastOld: 500, settled: null });
});

test('the switch summary: an answer from neither backend breaks the run', () => {
  const list = answers(['app', 2], ['stand-in', 10], ['http 502', 1], ['stand-in', 20]);
  assert.deepEqual(summarize(list, { old: 'app', fresh: 'stand-in' }), { firstNew: 500, lastOld: 250, settled: 3250 });
});

test('the switch summary: an old answer after a run of new ones moves the settled time after it', () => {
  const list = answers(['app', 1], ['stand-in', 20], ['app', 1], ['stand-in', 20]);
  assert.deepEqual(summarize(list, { old: 'app', fresh: 'stand-in' }), { firstNew: 250, lastOld: 5250, settled: 5500 });
});

test('the switch summary: nothing new yet, answers in any order, a shorter run when asked', () => {
  assert.deepEqual(summarize(answers(['app', 4]), { old: 'app', fresh: 'stand-in' }), { firstNew: null, lastOld: 750, settled: null });
  const list = answers(['app', 2], ['stand-in', 3]).reverse();
  assert.deepEqual(summarize(list, { old: 'app', fresh: 'stand-in', settle: 3 }), { firstNew: 500, lastOld: 250, settled: 500 });
  assert.deepEqual(summarize([], { old: 'app', fresh: 'stand-in' }), { firstNew: null, lastOld: null, settled: null });
});

test('the switch summary takes predicates: after a stop, anything but the app is new', () => {
  const list = answers(['app', 2], ['error', 1], ['http 503', 20]);
  assert.deepEqual(summarize(list, { old: 'app', fresh: (k) => k !== 'app' }), { firstNew: 500, lastOld: 250, settled: 500 });
});

test('transitions: what changed, appeared or disappeared, by name', () => {
  assert.deepEqual(changes({}, { 'dmt-demo': 'RUNNING' }), [{ name: 'dmt-demo', from: null, to: 'RUNNING' }]);
  assert.deepEqual(changes({ b: 'RUNNING', a: 'RUNNING' }, { a: 'STOPPING', b: 'RUNNING' }), [{ name: 'a', from: 'RUNNING', to: 'STOPPING' }]);
  assert.deepEqual(changes({ a: 'HEALTHY', b: 'HEALTHY' }, { b: 'UNHEALTHY' }), [
    { name: 'a', from: 'HEALTHY', to: null },
    { name: 'b', from: 'HEALTHY', to: 'UNHEALTHY' },
  ]);
  assert.deepEqual(changes({ a: 'HEALTHY' }, { a: 'HEALTHY' }), []);
});

test('health: each instance\'s state in a backend service\'s group health', () => {
  const response = {
    kind: 'compute#backendServiceGroupHealth',
    healthStatus: [
      { instance: `${ZONE}/instances/dmt-demo-mig-x1k2`, ipAddress: '10.10.0.3', port: 80, healthState: 'HEALTHY' },
      { instance: `${ZONE}/instances/dmt-demo-mig-p9q8`, ipAddress: '10.10.0.4', port: 80, healthState: 'UNHEALTHY' },
    ],
  };
  assert.deepEqual(healthStates(response), { 'dmt-demo-mig-x1k2': 'HEALTHY', 'dmt-demo-mig-p9q8': 'UNHEALTHY' });
  assert.deepEqual(healthStates({ kind: 'compute#backendServiceGroupHealth' }), {});
});

test('a managed group\'s instances: their status and the group\'s current action', () => {
  const response = {
    managedInstances: [
      { instance: `${ZONE}/instances/dmt-demo-mig-x1k2`, instanceStatus: 'RUNNING', currentAction: 'STOPPING' },
      { instance: `${ZONE}/instances/dmt-demo-mig-p9q8`, instanceStatus: 'TERMINATED', currentAction: 'NONE' },
      { instance: `${ZONE}/instances/dmt-demo-mig-new1`, currentAction: 'CREATING' },
    ],
  };
  assert.deepEqual(managedStates(response), {
    status: { 'dmt-demo-mig-x1k2': 'RUNNING', 'dmt-demo-mig-p9q8': 'TERMINATED', 'dmt-demo-mig-new1': null },
    action: { 'dmt-demo-mig-x1k2': 'STOPPING', 'dmt-demo-mig-p9q8': 'NONE', 'dmt-demo-mig-new1': 'CREATING' },
  });
  assert.deepEqual(managedStates({}), { status: {}, action: {} });
});

test('the instances an action applies to: running ones are stopped or suspended, stopped started, suspended resumed', () => {
  const states = { a: 'RUNNING', b: 'TERMINATED', c: 'SUSPENDED', d: 'STOPPING', e: 'STOPPED' };
  assert.deepEqual(targets('stop', states), ['a']);
  assert.deepEqual(targets('suspend', states), ['a']);
  assert.deepEqual(targets('start', states), ['b', 'e']);
  assert.deepEqual(targets('resume', states), ['c']);
});

// A start at 1 s: STAGING, then RUNNING at 9 s, healthy at 24 s, the app answers from 25 s.
const wake = () => ({
  since: 1000,
  names: ['dmt-demo'],
  settle: 20,
  statuses: [
    { t: 0, states: { 'dmt-demo': 'TERMINATED' } },
    { t: 2000, states: { 'dmt-demo': 'STAGING' } },
    { t: 9000, states: { 'dmt-demo': 'RUNNING' } },
  ],
  health: [
    { t: 0, states: { 'dmt-demo': 'UNHEALTHY' } },
    { t: 22_000, states: { 'dmt-demo': 'UNHEALTHY' } },
    { t: 24_000, states: { 'dmt-demo': 'HEALTHY' } },
  ],
  answers: [
    ...Array.from({ length: 50 }, (_, i) => ({ t: i * 500, kind: 'http 503' })),
    ...Array.from({ length: 20 }, (_, i) => ({ t: 25_000 + i * 500, kind: 'app' })),
  ],
});

test('a start\'s summary: running, healthy, first answer from the app, settled', () => {
  assert.deepEqual(actionSummary('start', wake()), {
    reached: 9000, healthy: 24_000, firstNew: 25_000, lastOld: 24_500, settled: 25_000, done: true,
  });
});

test('a start is not done before 20 answers from the app in a row', () => {
  const run = wake();
  run.answers = run.answers.slice(0, -1);
  assert.deepEqual(actionSummary('resume', run), {
    reached: 9000, healthy: 24_000, firstNew: 25_000, lastOld: 24_500, settled: null, done: false,
  });
});

test('a start is not done while a managed group\'s instance is not running yet; health before the request does not count', () => {
  const run = wake();
  run.names = ['x1', 'x2'];
  run.statuses = [{ t: 0, states: { x1: 'RUNNING', x2: 'TERMINATED' } }, { t: 5000, states: { x1: 'RUNNING', x2: 'STAGING' } }];
  run.health = [{ t: 0, states: { x1: 'HEALTHY', x2: 'UNHEALTHY' } }, { t: 4000, states: { x1: 'HEALTHY', x2: 'UNHEALTHY' } }];
  const summary = actionSummary('start', run);
  assert.equal(summary.reached, null);
  assert.equal(summary.healthy, 4000);
  assert.equal(summary.done, false);
});

test('a stop\'s summary: stopped, no instance healthy, last answer from the app, settled on other answers', () => {
  const run = {
    since: 1000,
    names: ['dmt-demo'],
    settle: 20,
    statuses: [
      { t: 0, states: { 'dmt-demo': 'RUNNING' } },
      { t: 2000, states: { 'dmt-demo': 'STOPPING' } },
      { t: 31_000, states: { 'dmt-demo': 'TERMINATED' } },
    ],
    health: [
      { t: 0, states: { 'dmt-demo': 'HEALTHY' } },
      { t: 12_000, states: { 'dmt-demo': 'UNHEALTHY' } },
    ],
    answers: [
      ...Array.from({ length: 20 }, (_, i) => ({ t: i * 500, kind: 'app' })),
      ...Array.from({ length: 20 }, (_, i) => ({ t: 10_000 + i * 500, kind: 'http 503' })),
    ],
  };
  assert.deepEqual(actionSummary('stop', run), {
    reached: 31_000, unhealthy: 12_000, firstNew: 10_000, lastOld: 9500, settled: 10_000, done: true,
  });
  run.statuses.pop();
  assert.equal(actionSummary('suspend', run).done, false);
  run.statuses.push({ t: 31_000, states: { 'dmt-demo': 'SUSPENDED' } });
  assert.equal(actionSummary('suspend', run).reached, 31_000);
  assert.equal(actionSummary('stop', run).reached, null);
});

// --- The switch's URL map change ---

test('swap: every reference to the backend service, by name, in a copy; the rest untouched', () => {
  const map = {
    name: 'dmt-dev',
    fingerprint: 'f1=',
    defaultService: `${BS}/dmt-demo-app`,
    hostRules: [{ hosts: ['gcp.dev.dormeto.com'], pathMatcher: 'app' }, { hosts: ['mig.gcp.dev.dormeto.com'], pathMatcher: 'mig' }],
    pathMatchers: [
      { name: 'app', defaultService: `${BS}/dmt-demo-app`, pathRules: [{ paths: ['/a'], service: `${BS}/dmt-demo-app` }, { paths: ['/b'], service: `${BS}/dmt-demo-app2` }] },
      { name: 'mig', defaultService: `${BS}/dmt-demo-mig-app` },
    ],
  };
  const before = structuredClone(map);
  const { map: swapped, paths } = swapService(map, 'dmt-demo-app', 'dmt-demo-standin');
  assert.deepEqual(paths, ['defaultService', 'pathMatchers[0].defaultService', 'pathMatchers[0].pathRules[0].service']);
  assert.equal(swapped.defaultService, `${BS}/dmt-demo-standin`);
  assert.equal(swapped.pathMatchers[0].defaultService, `${BS}/dmt-demo-standin`);
  assert.equal(swapped.pathMatchers[0].pathRules[0].service, `${BS}/dmt-demo-standin`);
  assert.equal(swapped.pathMatchers[0].pathRules[1].service, `${BS}/dmt-demo-app2`);
  assert.equal(swapped.pathMatchers[1].defaultService, `${BS}/dmt-demo-mig-app`);
  assert.equal(swapped.fingerprint, 'f1=');
  assert.deepEqual(map, before);
});

test('swap: a regional map\'s default service; a map without the service changes nothing', () => {
  const regional = { defaultService: 'https://www.googleapis.com/compute/v1/projects/dormeto-dev/regions/europe-west1/backendServices/dmt-demo-regional-app' };
  assert.deepEqual(swapService(regional, 'dmt-demo-regional-app', 'dmt-demo-regional-standin'), {
    map: { defaultService: 'https://www.googleapis.com/compute/v1/projects/dormeto-dev/regions/europe-west1/backendServices/dmt-demo-regional-standin' },
    paths: ['defaultService'],
  });
  assert.deepEqual(swapService(regional, 'dmt-demo-app', 'dmt-demo-standin').paths, []);
});

// --- Tokens ---

test('tokens: gcloud once, again after 45 minutes; one call for concurrent requests', async () => {
  let clock = 0;
  let calls = 0;
  const tokens = createTokens({ run: async () => `token-${++calls}\n`, now: () => clock });
  assert.deepEqual(await Promise.all([tokens.get(), tokens.get()]), ['token-1', 'token-1']);
  clock = 45 * 60_000 - 1;
  assert.equal(await tokens.get(), 'token-1');
  clock = 45 * 60_000;
  assert.equal(await tokens.get(), 'token-2');
  assert.equal(calls, 2);
});

test('tokens: an empty answer from gcloud is an error, and the next request asks again', async () => {
  let calls = 0;
  const tokens = createTokens({ run: async () => (++calls === 1 ? '\n' : 'token'), now: () => 0 });
  await assert.rejects(tokens.get(), /no access token/);
  assert.equal(await tokens.get(), 'token');
});

// --- Cloud Monitoring ---

const series = {
  timeSeries: [
    {
      metric: { type: 'loadbalancing.googleapis.com/https/request_count', labels: { response_code: '200', cache_result: 'DISABLED' } },
      resource: { type: 'https_lb_rule', labels: { backend_target_name: 'dmt-demo-app', url_map_name: 'dmt-dev' } },
      metricKind: 'DELTA',
      valueType: 'INT64',
      points: [
        { interval: { startTime: '2026-10-29T10:01:00Z', endTime: '2026-10-29T10:02:00Z' }, value: { int64Value: '12' } },
        { interval: { startTime: '2026-10-29T10:00:00Z', endTime: '2026-10-29T10:01:00Z' }, value: { int64Value: '8' } },
      ],
    },
    {
      metric: { type: 'loadbalancing.googleapis.com/https/request_count', labels: { response_code: '503' } },
      resource: { type: 'https_lb_rule', labels: { backend_target_name: 'dmt-demo-app' } },
      points: [{ interval: { startTime: '2026-10-29T09:58:00Z', endTime: '2026-10-29T09:59:00Z' }, value: { doubleValue: 1 } }],
    },
  ],
};

test('Cloud Monitoring points: each with its series\' labels, its interval and its value', () => {
  const points = pointsOf(series);
  assert.equal(points.length, 3);
  assert.deepEqual(points[0], {
    series: JSON.stringify({ metric: series.timeSeries[0].metric, resource: series.timeSeries[0].resource }),
    key: `${JSON.stringify({ metric: series.timeSeries[0].metric, resource: series.timeSeries[0].resource })} 2026-10-29T10:02:00Z`,
    metric: series.timeSeries[0].metric,
    resource: series.timeSeries[0].resource,
    start: '2026-10-29T10:01:00Z',
    end: '2026-10-29T10:02:00Z',
    value: 12,
  });
  assert.equal(points[2].value, 1);
  assert.notEqual(points[0].series, points[2].series);
  assert.deepEqual(pointsOf({}), []);
});

test('the requests counted: the points whose interval meets the requests\' time', () => {
  const points = pointsOf(series);
  const from = Date.parse('2026-10-29T10:00:30Z');
  assert.equal(counted(points, { from, to: Date.parse('2026-10-29T10:00:40Z') }), 8);
  assert.equal(counted(points, { from, to: Date.parse('2026-10-29T10:01:10Z') }), 20);
  assert.equal(counted(points, { from: Date.parse('2026-10-29T10:05:00Z'), to: Date.parse('2026-10-29T10:05:10Z') }), 0);
});

// --- The probe ---

test('the probe opens a new connection for each request and reads the page', async (t) => {
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    sockets.add(req.socket);
    res.setHeader('content-type', 'text/html');
    res.end('<title>Dormeto demo: app</title><code id="instance">dmt-demo</code><time id="boot">2026-10-29T10:00:12Z</time>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/`;
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(await probe(url), { status: 200, kind: 'app', instance: 'dmt-demo', boot: '2026-10-29T10:00:12Z', error: null });
  }
  assert.equal(sockets.size, 3);
});

test('the probe: a refused connection is an error answer, not an exception', async () => {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  const answer = await probe(`http://127.0.0.1:${port}/`);
  assert.equal(answer.kind, 'error');
  assert.equal(answer.status, 0);
  assert.match(answer.error, /ECONNREFUSED/);
});
