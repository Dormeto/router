// G0's measuring tool (vision docs/specs/2026-10-29-google-cloud-design.md, section 12): the pure parts in
// gcp/tools/measure-core.mjs (arguments, the timeline's lines, the answers' summary, the health and status
// transitions), and the probe's one connection per request (a reused connection would hide a switch's propagation).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  UsageError, parseArgs, line, delta, pageOf, kindOfPort, summarize, changes, healthStates, managedStates, targets, actionSummary,
  switchService, healthLevel, changesSince, periods, tokenArgs, credentialOf, createTokens, withToken, pointsOf, counted,
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
      weighted: false,
    },
  });
  assert.equal(parseArgs(['switch', '--weighted', '--from', 'dmt-demo-app', '--to', 'dmt-demo-standin']).options.weighted, true);
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

test('health: a backend service\'s health every 2 s for 2 minutes, dmt-demo-app by default, regional with --region', () => {
  assert.deepEqual(parseArgs(['health']), {
    command: 'health',
    action: null,
    options: { project: 'dormeto-dev', configuration: 'dormeto-dev', region: null, backendService: 'dmt-demo-app', duration: 120 },
  });
  const { options } = parseArgs(['health', '--backend-service', 'dmt-demo-regional-app', '--region', 'europe-west1', '--for', '300']);
  assert.equal(options.backendService, 'dmt-demo-regional-app');
  assert.equal(options.region, 'europe-west1');
  assert.equal(options.duration, 300);
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
    ['switch', '--from', 'a', '--to', 'b', '--weighted', 'yes'],
    ['switch', '--from', 'a', '--to', 'b', '--weighted=true'],
    ['vm', 'start', '--weighted'],
    ['health', 'extra'],
    ['health', '--for', '0'],
    ['health', '--for', '1.5'],
    ['health', '--timeout', '60'],
    ['health', '--url', 'https://gcp.dev.dormeto.com/'],
    ['constructor'],
    ['toString'],
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

test('a backend service\'s health: no status (not health checked), healthy (one instance at least), else unhealthy', () => {
  assert.equal(healthLevel({}), 'no status');
  assert.equal(healthLevel({ 'dmt-demo': 'UNHEALTHY' }), 'unhealthy');
  assert.equal(healthLevel({ 'dmt-demo-mig-x1k2': 'UNHEALTHY', 'dmt-demo-mig-p9q8': 'HEALTHY' }), 'healthy');
  assert.equal(healthLevel(healthStates({ kind: 'compute#backendServiceGroupHealth' })), 'no status');
});

test('changes since a time: each state just before it, then what changed from it on', () => {
  const samples = [
    { t: 4000, states: { app: 'healthy', standin: 'no status' } },
    { t: 0, states: { app: 'healthy' } },
    { t: 2000, states: { app: 'healthy', standin: 'no status' } },
    { t: 6000, states: { app: 'healthy', standin: 'unhealthy' } },
    { t: 8000, states: { app: 'no status', standin: 'unhealthy' } },
    { t: 10_000, states: { app: 'no status', standin: 'healthy' } },
  ];
  assert.deepEqual(changesSince(samples, 5000), {
    before: { app: 'healthy', standin: 'no status' },
    after: [
      { t: 6000, name: 'standin', from: 'no status', to: 'unhealthy' },
      { t: 8000, name: 'app', from: 'healthy', to: 'no status' },
      { t: 10_000, name: 'standin', from: 'unhealthy', to: 'healthy' },
    ],
  });
  assert.deepEqual(changesSince(samples, 0).before, {});
  assert.deepEqual(changesSince(samples, 0).after.slice(0, 2), [
    { t: 0, name: 'app', from: null, to: 'healthy' },
    { t: 2000, name: 'standin', from: null, to: 'no status' },
  ]);
  assert.deepEqual(changesSince([], 0), { before: {}, after: [] });
});

test('periods: each run of one state, from its first sample to its last', () => {
  const samples = [
    { t: 2000, states: { app: 'healthy' } },
    { t: 0, states: { app: 'healthy' } },
    { t: 4000, states: { app: 'unhealthy' } },
    { t: 6000, states: {} },
    { t: 8000, states: { app: 'no status' } },
    { t: 10_000, states: { app: 'healthy' } },
  ];
  assert.deepEqual(periods(samples, 'app'), [
    { state: 'healthy', from: 0, to: 2000, samples: 2 },
    { state: 'unhealthy', from: 4000, to: 4000, samples: 1 },
    { state: null, from: 6000, to: 6000, samples: 1 },
    { state: 'no status', from: 8000, to: 8000, samples: 1 },
    { state: 'healthy', from: 10_000, to: 10_000, samples: 1 },
  ]);
  assert.deepEqual(periods([], 'app'), []);
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

test('switch: every reference to the backend service, by name, in a copy; the rest untouched', () => {
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
  const { map: swapped, paths } = switchService(map, 'dmt-demo-app', 'dmt-demo-standin');
  assert.deepEqual(paths, ['defaultService', 'pathMatchers[0].defaultService', 'pathMatchers[0].pathRules[0].service']);
  assert.equal(swapped.defaultService, `${BS}/dmt-demo-standin`);
  assert.equal(swapped.pathMatchers[0].defaultService, `${BS}/dmt-demo-standin`);
  assert.equal(swapped.pathMatchers[0].pathRules[0].service, `${BS}/dmt-demo-standin`);
  assert.equal(swapped.pathMatchers[0].pathRules[1].service, `${BS}/dmt-demo-app2`);
  assert.equal(swapped.pathMatchers[1].defaultService, `${BS}/dmt-demo-mig-app`);
  assert.equal(swapped.fingerprint, 'f1=');
  assert.deepEqual(map, before);
});

test('switch: a regional map\'s default service; a map without the service changes nothing', () => {
  const regional = { defaultService: 'https://www.googleapis.com/compute/v1/projects/dormeto-dev/regions/europe-west1/backendServices/dmt-demo-regional-app' };
  assert.deepEqual(switchService(regional, 'dmt-demo-regional-app', 'dmt-demo-regional-standin'), {
    map: { defaultService: 'https://www.googleapis.com/compute/v1/projects/dormeto-dev/regions/europe-west1/backendServices/dmt-demo-regional-standin' },
    paths: ['defaultService'],
  });
  assert.deepEqual(switchService(regional, 'dmt-demo-app', 'dmt-demo-standin').paths, []);
});

// gcp-dev's global map, as Terraform writes it.
const devMap = () => ({
  name: 'dmt-dev',
  fingerprint: 'f1=',
  defaultService: `${BS}/dmt-demo-app`,
  hostRules: [{ hosts: ['gcp.dev.dormeto.com'], pathMatcher: 'app' }, { hosts: ['mig.gcp.dev.dormeto.com'], pathMatcher: 'mig' }],
  pathMatchers: [
    { name: 'app', defaultService: `${BS}/dmt-demo-app` },
    { name: 'mig', defaultService: `${BS}/dmt-demo-mig-app` },
  ],
});
const weights = (first, second) => ({
  weightedBackendServices: [{ backendService: `${BS}/${first}`, weight: 1000 }, { backendService: `${BS}/${second}`, weight: 0 }],
});

test('switch --weighted: the old service at weight 0 beside the new one at 1000, instead of the default service', () => {
  const map = devMap();
  const { map: weighted, paths } = switchService(map, 'dmt-demo-app', 'dmt-demo-standin', { weighted: true });
  assert.deepEqual(paths, ['defaultRouteAction.weightedBackendServices', 'pathMatchers[0].defaultRouteAction.weightedBackendServices']);
  const { defaultService, ...rest } = devMap();
  assert.equal(defaultService, `${BS}/dmt-demo-app`);
  assert.deepEqual(weighted, {
    ...rest,
    defaultRouteAction: weights('dmt-demo-standin', 'dmt-demo-app'),
    pathMatchers: [
      { name: 'app', defaultRouteAction: weights('dmt-demo-standin', 'dmt-demo-app') },
      { name: 'mig', defaultService: `${BS}/dmt-demo-mig-app` },
    ],
  });
  assert.deepEqual(map, devMap());
});

test('switch --weighted back: the weights reversed; the other matcher untouched', () => {
  const asleep = switchService(devMap(), 'dmt-demo-app', 'dmt-demo-standin', { weighted: true }).map;
  const { map: awake, paths } = switchService(asleep, 'dmt-demo-standin', 'dmt-demo-app', { weighted: true });
  assert.deepEqual(paths, ['defaultRouteAction.weightedBackendServices', 'pathMatchers[0].defaultRouteAction.weightedBackendServices']);
  assert.deepEqual(awake.defaultRouteAction, weights('dmt-demo-app', 'dmt-demo-standin'));
  assert.deepEqual(awake.pathMatchers[0], { name: 'app', defaultRouteAction: weights('dmt-demo-app', 'dmt-demo-standin') });
  assert.deepEqual(awake.pathMatchers[1], devMap().pathMatchers[1]);
  assert.equal('defaultService' in awake, false);
});

test('switch without --weighted from a weighted map: the default service again, the weights cleared', () => {
  const asleep = switchService(devMap(), 'dmt-demo-app', 'dmt-demo-standin', { weighted: true }).map;
  const { map: plain, paths } = switchService(asleep, 'dmt-demo-standin', 'dmt-demo-app');
  assert.deepEqual(paths, ['defaultService', 'pathMatchers[0].defaultService']);
  assert.deepEqual(plain, devMap());

  const awake = switchService(asleep, 'dmt-demo-standin', 'dmt-demo-app', { weighted: true }).map;
  const napped = switchService(awake, 'dmt-demo-app', 'dmt-demo-standin').map;
  assert.equal(napped.defaultService, `${BS}/dmt-demo-standin`);
  assert.deepEqual(napped.pathMatchers[0], { name: 'app', defaultService: `${BS}/dmt-demo-standin` });
  assert.deepEqual(napped.pathMatchers[1], devMap().pathMatchers[1]);
});

test('switch: a service at weight 0 is not served, so not switched; a route action\'s other settings stay', () => {
  const awake = switchService(switchService(devMap(), 'dmt-demo-app', 'dmt-demo-standin', { weighted: true }).map,
    'dmt-demo-standin', 'dmt-demo-app', { weighted: true }).map;
  assert.deepEqual(switchService(awake, 'dmt-demo-standin', 'dmt-demo-app').paths, []);
  assert.deepEqual(switchService(awake, 'dmt-demo-standin', 'dmt-demo-app', { weighted: true }).paths, []);

  const map = { pathMatchers: [{ name: 'app', defaultService: `${BS}/dmt-demo-app`, defaultRouteAction: { timeout: { seconds: '30' } } }] };
  const weighted = switchService(map, 'dmt-demo-app', 'dmt-demo-standin', { weighted: true }).map;
  assert.deepEqual(weighted.pathMatchers[0], { name: 'app', defaultRouteAction: { timeout: { seconds: '30' }, ...weights('dmt-demo-standin', 'dmt-demo-app') } });
  const plain = switchService(weighted, 'dmt-demo-standin', 'dmt-demo-app').map;
  assert.deepEqual(plain.pathMatchers[0], { name: 'app', defaultService: `${BS}/dmt-demo-app`, defaultRouteAction: { timeout: { seconds: '30' } } });
});

test('switch --weighted: a path rule\'s service in its route action; a weight Google left out is 0', () => {
  const map = { pathMatchers: [{ name: 'app', defaultService: `${BS}/other`, pathRules: [{ paths: ['/a'], service: `${BS}/dmt-demo-app` }] }] };
  const { map: weighted, paths } = switchService(map, 'dmt-demo-app', 'dmt-demo-standin', { weighted: true });
  assert.deepEqual(paths, ['pathMatchers[0].pathRules[0].routeAction.weightedBackendServices']);
  assert.deepEqual(weighted.pathMatchers[0].pathRules[0], { paths: ['/a'], routeAction: weights('dmt-demo-standin', 'dmt-demo-app') });
  const fromGoogle = { defaultRouteAction: { weightedBackendServices: [{ backendService: `${BS}/dmt-demo-standin`, weight: 1000 }, { backendService: `${BS}/dmt-demo-app` }] } };
  assert.deepEqual(switchService(fromGoogle, 'dmt-demo-app', 'dmt-demo-standin').paths, []);
  assert.deepEqual(switchService(fromGoogle, 'dmt-demo-standin', 'dmt-demo-app').map, { defaultService: `${BS}/dmt-demo-app` });
});

// --- Tokens ---

// gcloud config config-helper --format=json: the token, its expiry as gcloud writes it (UTC, to the second).
const helper = (token, expiry) => `${JSON.stringify({
  configuration: { active_configuration: 'dormeto-dev', properties: { core: { project: 'dormeto-dev' } } },
  credential: { access_token: token, id_token: 'eyJ.x.y', token_expiry: expiry === undefined ? undefined : expiry },
  sentinels: { config_sentinel: '/home/u/.config/gcloud/config_sentinel' },
}, null, 2)}\n`;
const utc = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const T0 = Date.parse('2026-10-29T10:00:00Z');

test('the token from gcloud: config-helper, at least 20 minutes left, or a forced refresh after a 401', () => {
  assert.deepEqual(tokenArgs('dormeto-dev'), ['config', 'config-helper', '--format=json', '--min-expiry=20m', '--configuration', 'dormeto-dev']);
  assert.deepEqual(tokenArgs('other', { force: true }), ['config', 'config-helper', '--format=json', '--force-auth-refresh', '--configuration', 'other']);
});

test('the token from gcloud: its access token and expiry; without an expiry, the 20 minutes gcloud was asked for', () => {
  assert.deepEqual(credentialOf(helper('ya29.a', '2026-10-29T10:41:07Z'), { askedAt: T0 }), { token: 'ya29.a', expiresAt: Date.parse('2026-10-29T10:41:07Z') });
  assert.deepEqual(credentialOf(helper('ya29.b'), { askedAt: T0 }), { token: 'ya29.b', expiresAt: T0 + 20 * 60_000 });
  assert.deepEqual(credentialOf(helper('ya29.c', null), { askedAt: T0 }), { token: 'ya29.c', expiresAt: T0 + 20 * 60_000 });
  assert.deepEqual(credentialOf(helper('ya29.d', 'soon'), { askedAt: T0 }), { token: 'ya29.d', expiresAt: T0 + 20 * 60_000 });
  assert.throws(() => credentialOf(helper(''), { askedAt: T0 }), /no access token/);
  assert.throws(() => credentialOf('{"configuration": {}}', { askedAt: T0 }), /no access token/);
  assert.throws(() => credentialOf('ERROR: (gcloud.config.config-helper) You do not currently have an active account', { askedAt: T0 }), /config-helper.*not JSON/);
});

test('tokens: gcloud once, again 5 minutes before the token expires; one call for concurrent requests', async () => {
  let clock = T0;
  const calls = [];
  const run = async ({ force }) => {
    calls.push(force);
    return helper(`token-${calls.length}`, utc(clock + 25 * 60_000));
  };
  const tokens = createTokens({ run, now: () => clock });
  assert.deepEqual(await Promise.all([tokens.get(), tokens.get()]), ['token-1', 'token-1']);
  clock = T0 + 20 * 60_000 - 1;
  assert.equal(await tokens.get(), 'token-1');
  clock = T0 + 20 * 60_000;
  assert.deepEqual(await Promise.all([tokens.get(), tokens.get()]), ['token-2', 'token-2']);
  clock = T0 + 40 * 60_000 - 1;
  assert.equal(await tokens.get(), 'token-2');
  assert.deepEqual(calls, [false, false]);
});

test('tokens: a dropped token is asked again with a forced refresh, once for concurrent 401s; an older one changes nothing', async () => {
  const calls = [];
  const run = async ({ force }) => {
    calls.push(force);
    return helper(`token-${calls.length}`, utc(T0 + 60 * 60_000));
  };
  const tokens = createTokens({ run, now: () => T0 });
  assert.equal(await tokens.get(), 'token-1');
  tokens.drop('token-1');
  tokens.drop('token-1');
  assert.deepEqual(await Promise.all([tokens.get(), tokens.get()]), ['token-2', 'token-2']);
  tokens.drop('token-1');
  assert.equal(await tokens.get(), 'token-2');
  assert.deepEqual(calls, [false, true]);
});

test('tokens: a gcloud failure or an answer without a token is an error, and the next request asks again', async () => {
  let calls = 0;
  const answers = [() => { throw new Error('gcloud exited 1'); }, () => helper(''), () => helper('token', utc(T0 + 60 * 60_000))];
  const tokens = createTokens({ run: async () => answers[calls++](), now: () => T0 });
  await assert.rejects(tokens.get(), /exited 1/);
  await assert.rejects(tokens.get(), /no access token/);
  assert.equal(await tokens.get(), 'token');
});

test('a request refused with a 401 is sent once more with a new token, and no more', async () => {
  const fake = (statuses) => {
    const sent = [];
    let n = 0;
    const tokens = { get: async () => `token-${n + 1}`, drop: (token) => { if (token === `token-${n + 1}`) n += 1; } };
    const send = async (token) => {
      sent.push(token);
      return { status: statuses[sent.length - 1] };
    };
    return { sent, run: () => withToken(tokens, send) };
  };
  const ok = fake([200]);
  assert.equal((await ok.run()).status, 200);
  assert.deepEqual(ok.sent, ['token-1']);
  const once = fake([401, 200]);
  assert.equal((await once.run()).status, 200);
  assert.deepEqual(once.sent, ['token-1', 'token-2']);
  const twice = fake([401, 401, 200]);
  assert.equal((await twice.run()).status, 401);
  assert.deepEqual(twice.sent, ['token-1', 'token-2']);
  const denied = fake([403, 200]);
  assert.equal((await denied.run()).status, 403);
  assert.deepEqual(denied.sent, ['token-1']);
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
