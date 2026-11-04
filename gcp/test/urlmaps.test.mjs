import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeClock } from '../../lambda/test/fakes.mjs';
import {
  hostsOf, references, UrlMapRefused, withErrorPolicy, withoutErrorPolicy, withWakerRoute, withoutWakerRoute, createUrlMaps, CALLS,
} from '../src/urlmaps.mjs';

const V1 = 'https://www.googleapis.com/compute/v1/projects/p/global/backendServices';
const BETA = 'https://compute.googleapis.com/compute/beta/projects/p/global/backendServices';
const REL = 'projects/p/global/backendServices';
const APP = 'app';
const WAKER = `${V1}/dmtr-europe-west1-app`;

// A map where the application's backend service is named in every way a matcher can name it.
function fixture() {
  return {
    name: 'dmt-dev',
    fingerprint: 'abc=',
    defaultService: `${V1}/other`,
    hostRules: [{ hosts: ['a.example.com'], pathMatcher: 'plain' }, { hosts: ['b.example.com'], pathMatcher: 'rules' },
      { hosts: ['c.example.com'], pathMatcher: 'weighted' }, { hosts: ['d.example.com'], pathMatcher: 'routes' },
      { hosts: ['e.example.com'], pathMatcher: 'unrelated' }],
    pathMatchers: [
      { name: 'plain', defaultService: `${V1}/${APP}` },
      { name: 'rules', defaultService: `${V1}/other`, pathRules: [{ paths: ['/api/*'], service: `${BETA}/${APP}` }, { paths: ['/x'], service: `${V1}/other` }] },
      { name: 'weighted', defaultRouteAction: { weightedBackendServices: [{ backendService: `${REL}/${APP}`, weight: 100 }, { backendService: `${V1}/other`, weight: 0 }] } },
      { name: 'routes', defaultService: `${V1}/other`, routeRules: [{ priority: 5, matchRules: [{ prefixMatch: '/r' }], routeAction: { weightedBackendServices: [{ backendService: `${V1}/${APP}`, weight: 1 }] } }] },
      { name: 'unrelated', defaultService: `${V1}/other` },
    ],
  };
}
const mapNaming = (service) => ({ ...fixture(), defaultService: `${V1}/${service}` });

const POLICY = { errorResponseRules: [{ matchResponseCodes: ['502', '503'], path: '/_dormeto/waiting', overrideResponseCode: 503 }], errorService: WAKER };

test('references: the matchers naming the service, whichever way and URL form', () => {
  assert.deepEqual(references(fixture(), APP), [
    'pathMatchers[0].defaultCustomErrorResponsePolicy',
    'pathMatchers[1].defaultCustomErrorResponsePolicy',
    'pathMatchers[2].defaultCustomErrorResponsePolicy',
    'pathMatchers[3].defaultCustomErrorResponsePolicy',
  ]);
});

test('references: the map\'s default comes first, and a map without the service has no path', () => {
  assert.deepEqual(references(mapNaming(APP), APP)[0], 'defaultCustomErrorResponsePolicy');
  assert.deepEqual(references(fixture(), 'nothing'), []);
  assert.deepEqual(references({ name: 'm' }, APP), []);
});

test('withErrorPolicy: the policy sits on every matcher naming the service and nothing else changes', () => {
  const before = fixture();
  const { map, paths } = withErrorPolicy(before, APP, WAKER);
  assert.deepEqual(paths, references(before, APP));
  const expected = fixture();
  for (const i of [0, 1, 2, 3]) expected.pathMatchers[i].defaultCustomErrorResponsePolicy = POLICY;
  assert.deepEqual(map, expected);
  assert.deepEqual(before, fixture(), 'the input is not changed');
});

test('withErrorPolicy: never on the map itself, which would cover the whole load balancer: on the default\'s own matcher', () => {
  const routed = withWakerRoute(mapNaming(APP), APP, WAKER).map;
  const { map, paths } = withErrorPolicy(routed, APP, WAKER);
  assert.equal(map.defaultCustomErrorResponsePolicy, undefined);
  assert.deepEqual(map.pathMatchers.at(-1).defaultCustomErrorResponsePolicy, POLICY);
  assert.equal(paths.includes('defaultCustomErrorResponsePolicy'), false);
  assert.ok(paths.includes(`pathMatchers[${map.pathMatchers.length - 1}].defaultCustomErrorResponsePolicy`));
});

test('withErrorPolicy: no matcher names the service: refused, not "already held" (the service left the map, or only a hidden default names it)', () => {
  assert.throws(() => withErrorPolicy(fixture(), 'nothing', WAKER), (err) => err instanceof UrlMapRefused && /backend service nothing is named by no path matcher of URL map dmt-dev/.test(err.message));
  assert.throws(() => withErrorPolicy({ name: 'dmt-dev', defaultService: `${V1}/${APP}` }, APP, WAKER), UrlMapRefused);
  const hidden = { name: 'dmt-dev', defaultService: `${V1}/${APP}`, hostRules: [{ hosts: ['*'], pathMatcher: 'one' }], pathMatchers: [{ name: 'one', defaultService: `${V1}/other` }] };
  assert.throws(() => withErrorPolicy(hidden, APP, WAKER), UrlMapRefused);
});

test('withoutErrorPolicy: a map-level policy of this waker\'s is still removed, a customer\'s stays', () => {
  const ours = { ...fixture(), defaultCustomErrorResponsePolicy: POLICY };
  const { map, paths } = withoutErrorPolicy(ours, WAKER);
  assert.equal(map.defaultCustomErrorResponsePolicy, undefined);
  assert.deepEqual(paths, ['defaultCustomErrorResponsePolicy']);
  const theirs = { ...fixture(), defaultCustomErrorResponsePolicy: { errorService: `${V1}/theirs` } };
  assert.deepEqual(withoutErrorPolicy(theirs, WAKER).paths, []);
});

test('withoutErrorPolicy: removed again to the byte', () => {
  for (const original of [fixture(), mapNaming(APP)]) {
    const { map } = withErrorPolicy(original, APP, WAKER);
    const back = withoutErrorPolicy(map, WAKER);
    assert.equal(JSON.stringify(back.map), JSON.stringify(original));
    assert.ok(back.paths.length > 0);
  }
});

test('withErrorPolicy and withoutErrorPolicy: idempotent', () => {
  const once = withErrorPolicy(fixture(), APP, WAKER);
  const twice = withErrorPolicy(once.map, APP, WAKER);
  assert.deepEqual(twice.map, once.map);
  assert.deepEqual(twice.paths, []);
  assert.deepEqual(withoutErrorPolicy(fixture(), WAKER).paths, []);
});

test('withoutErrorPolicy: a policy that is not the waker\'s stays', () => {
  const map = fixture();
  map.pathMatchers[0].defaultCustomErrorResponsePolicy = { errorService: `${V1}/theirs` };
  const { map: back, paths } = withoutErrorPolicy(map, WAKER);
  assert.deepEqual(back, map);
  assert.deepEqual(paths, []);
});

test('withErrorPolicy: a customer\'s own error policy is refused', () => {
  const own = { errorService: `${V1}/theirs`, errorResponseRules: [] };
  const atMatcher = fixture();
  atMatcher.pathMatchers[1].defaultCustomErrorResponsePolicy = own;
  assert.throws(() => withErrorPolicy(atMatcher, APP, WAKER), /error response policy.*pathMatchers\[1\]/);
  const atRule = fixture();
  atRule.pathMatchers[1].pathRules[0].customErrorResponsePolicy = own;
  assert.throws(() => withErrorPolicy(atRule, APP, WAKER), /error response policy/);
  const atRoute = fixture();
  atRoute.pathMatchers[3].routeRules[0].customErrorResponsePolicy = own;
  assert.throws(() => withErrorPolicy(atRoute, APP, WAKER), /error response policy/);
});

test('withErrorPolicy: a customer\'s policy on the map itself stays: nothing is written there, and a matcher\'s comes first', () => {
  const own = { errorService: `${V1}/theirs`, errorResponseRules: [] };
  const { map } = withErrorPolicy({ ...withWakerRoute(mapNaming(APP), APP, WAKER).map, defaultCustomErrorResponsePolicy: own }, APP, WAKER);
  assert.deepEqual(map.defaultCustomErrorResponsePolicy, own);
});

test('withErrorPolicy: a policy on a matcher that does not name the service does not matter', () => {
  const map = fixture();
  map.pathMatchers[4].defaultCustomErrorResponsePolicy = { errorService: `${V1}/theirs` };
  assert.equal(withErrorPolicy(map, APP, WAKER).map.pathMatchers[4].defaultCustomErrorResponsePolicy.errorService, `${V1}/theirs`);
});

const ROUTE_PATH = { paths: ['/_dormeto/*'], service: WAKER };
const ROUTE_RULE = { priority: 0, matchRules: [{ prefixMatch: '/_dormeto/' }], service: WAKER };

test('withWakerRoute: a path rule where the matcher uses path rules or none, a route rule where it uses route rules', () => {
  const { map, paths } = withWakerRoute(fixture(), APP, WAKER);
  const expected = fixture();
  expected.pathMatchers[0].pathRules = [ROUTE_PATH];
  expected.pathMatchers[1].pathRules.push(ROUTE_PATH);
  expected.pathMatchers[2].pathRules = [ROUTE_PATH];
  expected.pathMatchers[3].routeRules.push(ROUTE_RULE);
  assert.deepEqual(map, expected);
  assert.deepEqual(paths, ['pathMatchers[0].pathRules', 'pathMatchers[1].pathRules', 'pathMatchers[2].pathRules', 'pathMatchers[3].routeRules']);
});

test('withoutWakerRoute: removed again to the byte', () => {
  for (const original of [fixture(), mapNaming(APP)]) {
    const { map } = withWakerRoute(original, APP, WAKER);
    const back = withoutWakerRoute(map, WAKER);
    assert.equal(JSON.stringify(back.map), JSON.stringify(original));
    assert.ok(back.paths.length > 0);
  }
});

test('withoutWakerRoute: another workload\'s dormeto-default and its host rule stay', () => {
  const OTHER = `${V1}/dmtr-europe-west1-other`;
  const { map } = withWakerRoute(mapNaming(APP), APP, OTHER);
  const back = withoutWakerRoute(map, WAKER);
  assert.deepEqual(back.map, map);
  assert.deepEqual(back.paths, []);
});

test('hostsOf: the hosts of the matchers naming the service, and the map\'s default as *', () => {
  const map = {
    defaultService: `${V1}/other`,
    hostRules: [{ hosts: ['a.example.com', 'b.example.com'], pathMatcher: 'one' }, { hosts: ['c.example.com'], pathMatcher: 'two' }],
    pathMatchers: [{ name: 'one', defaultService: `${V1}/${APP}` }, { name: 'two', defaultService: `${V1}/other` }],
  };
  assert.deepEqual(hostsOf(map, APP), ['a.example.com', 'b.example.com']);
  assert.deepEqual(hostsOf(map, 'other'), ['c.example.com', '*']);
  assert.deepEqual(hostsOf(map, 'none'), []);
  // A host rule * means the map's default is never reached.
  const all = { defaultService: `${V1}/${APP}`, hostRules: [{ hosts: ['*'], pathMatcher: 'one' }], pathMatchers: [{ name: 'one', defaultService: `${V1}/other` }] };
  assert.deepEqual(hostsOf(all, APP), []);
});

test('createUrlMaps.list: every page of the project\'s global URL maps', async () => {
  const pages = { '': { items: [{ name: 'a' }], nextPageToken: 't' }, t: { items: [{ name: 'b' }] } };
  const seen = [];
  const google = { request: async (method, url) => {
    seen.push(`${method} ${url}`);
    return pages[new URL(url).searchParams.get('pageToken') ?? ''];
  } };
  const maps = await createUrlMaps({ google, project: 'p' }).list();
  assert.deepEqual(maps.map((m) => m.name), ['a', 'b']);
  assert.equal(seen[0], 'GET https://compute.googleapis.com/compute/v1/projects/p/global/urlMaps');
  assert.deepEqual(CALLS.list, ['compute.urlMaps.list']);
});

test('withWakerRoute: idempotent', () => {
  const once = withWakerRoute(fixture(), APP, WAKER);
  const twice = withWakerRoute(once.map, APP, WAKER);
  assert.deepEqual(twice.map, once.map);
  assert.deepEqual(twice.paths, []);
});

test('withWakerRoute: a route rule needs priority 0 to be free', () => {
  const map = fixture();
  map.pathMatchers[3].routeRules[0].priority = 0;
  assert.throws(() => withWakerRoute(map, APP, WAKER), /priority 0/);
});

test('withWakerRoute: a customer\'s own /_dormeto/ route is refused', () => {
  const rules = fixture();
  rules.pathMatchers[1].pathRules.push({ paths: ['/_dormeto/*'], service: `${V1}/theirs` });
  assert.throws(() => withWakerRoute(rules, APP, WAKER), /\/_dormeto\/ route.*pathMatchers\[1\]/);
  const routes = fixture();
  routes.pathMatchers[3].routeRules.push({ priority: 7, matchRules: [{ prefixMatch: '/_dormeto/wake' }], service: `${V1}/theirs` });
  assert.throws(() => withWakerRoute(routes, APP, WAKER), /\/_dormeto\/ route/);
  const exact = fixture();
  exact.pathMatchers[1].pathRules.push({ paths: ['/_dormeto/waiting'], service: `${V1}/theirs` });
  assert.throws(() => withWakerRoute(exact, APP, WAKER), /\/_dormeto\/ route/);
});

test('withWakerRoute: the map\'s default alone gets a host rule * and a matcher dormeto-default (ruling 25)', () => {
  const original = mapNaming(APP);
  const { map, paths } = withWakerRoute(original, APP, WAKER);
  assert.deepEqual(map.hostRules.at(-1), { hosts: ['*'], pathMatcher: 'dormeto-default' });
  assert.deepEqual(map.pathMatchers.at(-1), { name: 'dormeto-default', defaultService: `${V1}/${APP}`, pathRules: [ROUTE_PATH] });
  assert.ok(paths.includes('pathMatchers[5]'));
  assert.deepEqual(withoutWakerRoute(map, WAKER).map, original);
});

test('withWakerRoute: the weighted default is copied to dormeto-default', () => {
  const original = fixture();
  delete original.defaultService;
  original.defaultRouteAction = { weightedBackendServices: [{ backendService: `${V1}/${APP}`, weight: 1 }] };
  const { map } = withWakerRoute(original, APP, WAKER);
  const held = map.pathMatchers.at(-1);
  assert.deepEqual(held.defaultRouteAction, original.defaultRouteAction);
  assert.equal(held.defaultService, undefined);
});

test('withWakerRoute: a * host rule already there means the map\'s default takes no route', () => {
  const original = mapNaming(APP);
  original.hostRules.push({ hosts: ['*'], pathMatcher: 'unrelated' });
  const { map } = withWakerRoute(original, APP, WAKER);
  assert.equal(map.pathMatchers.some((pm) => pm.name === 'dormeto-default'), false);
  assert.equal(map.hostRules.length, original.hostRules.length);
});

test('withWakerRoute: a map without the service has no path and no change', () => {
  const { map, paths } = withWakerRoute(fixture(), 'nothing', WAKER);
  assert.deepEqual(map, fixture());
  assert.deepEqual(paths, []);
});

test('withWakerRoute: a matcher named dormeto-default of the customer\'s is refused', () => {
  const original = mapNaming(APP);
  original.pathMatchers.push({ name: 'dormeto-default', defaultService: `${V1}/other` });
  assert.throws(() => withWakerRoute(original, APP, WAKER), /dormeto-default/);
});

// The adapter, against a fake fetch.
function fakeGoogle(handler) {
  const calls = [];
  return {
    calls,
    request: async (method, url, body) => {
      calls.push({ method, url, body });
      return handler(method, url, body, calls);
    },
    waitCompute: async (op) => { calls.push({ wait: op }); },
  };
}
const gerr = (code) => Object.assign(new Error(`Google ${code}`), { code });

test('get reads the map; modify writes it with its fingerprint and waits for the operation', async () => {
  const stored = fixture();
  const google = fakeGoogle((method) => (method === 'GET' ? structuredClone(stored) : { selfLink: 'op-1', status: 'RUNNING' }));
  const urlmaps = createUrlMaps({ google, project: 'p' });
  assert.deepEqual(await urlmaps.get('dmt-dev'), stored);
  const result = await urlmaps.modify('dmt-dev', (map) => withErrorPolicy(map, APP, WAKER));
  assert.equal(result.paths.length, 4);
  const put = google.calls.find((c) => c.method === 'PUT');
  assert.equal(put.url, 'https://compute.googleapis.com/compute/v1/projects/p/global/urlMaps/dmt-dev');
  assert.equal(put.body.fingerprint, 'abc=');
  assert.deepEqual(put.body.pathMatchers[0].defaultCustomErrorResponsePolicy, POLICY);
  assert.deepEqual(google.calls.at(-1), { wait: { selfLink: 'op-1', status: 'RUNNING' } });
});

test('modify: nothing to change writes nothing', async () => {
  const google = fakeGoogle(() => fixture());
  const urlmaps = createUrlMaps({ google, project: 'p' });
  const result = await urlmaps.modify('dmt-dev', (map) => withoutErrorPolicy(map, WAKER));
  assert.deepEqual(result.paths, []);
  assert.deepEqual(google.calls.map((c) => c.method), ['GET']);
});

const notReady = () => Object.assign(new Error('Google: PUT: 400 The resource is not ready'), { code: 400, reason: 'resourceNotReady' });
const noWait = (sleeps = []) => async (ms) => { sleeps.push(ms); };

for (const [name, refusal] of [['a 412', () => gerr(412)], ['a resourceNotReady', notReady], ['an operation that ended RESOURCE_NOT_READY', () => Object.assign(new Error('op'), { code: 400, reason: 'RESOURCE_NOT_READY' })]]) {
  test(`modify: ${name} waits, reads the map again and applies the change to it: 5 s, growing, 60 s in all`, async () => {
    let puts = 0;
    const google = fakeGoogle((method) => {
      if (method === 'GET') return { ...fixture(), fingerprint: `f${google.calls.length}` };
      puts += 1;
      if (puts <= 2) throw refusal();
      return { selfLink: 'op' };
    });
    const sleeps = [];
    await assert.doesNotReject(createUrlMaps({ google, project: 'p', sleep: noWait(sleeps) }).modify('dmt-dev', (map) => withErrorPolicy(map, APP, WAKER)));
    assert.equal(google.calls.filter((c) => c.method === 'GET').length, 3);
    assert.notEqual(google.calls.filter((c) => c.method === 'PUT')[2].body.fingerprint, google.calls.filter((c) => c.method === 'PUT')[0].body.fingerprint);
    assert.deepEqual(sleeps, [5000, 10_000]);

    const always = fakeGoogle((method) => { if (method === 'GET') return fixture(); throw refusal(); });
    const paused = [];
    await assert.rejects(createUrlMaps({ google: always, project: 'p', sleep: noWait(paused) }).modify('dmt-dev', (map) => withErrorPolicy(map, APP, WAKER)), { code: refusal().code });
    assert.deepEqual(paused, [5000, 10_000, 15_000, 30_000]);
    assert.equal(paused.reduce((sum, ms) => sum + ms, 0), 60_000);
    assert.equal(always.calls.filter((c) => c.method === 'PUT').length, 5);
  });
}

// Google with an update taking 20 s (G0: 14 to 25 s): during it, another one is `resourceNotReady`; after it, an update made
// on the map read before it is a 412. Time is the fake clock's: what a fake answering at once cannot show.
function busyGoogle(clock, stored) {
  let busyUntil = 0;
  let version = 0;
  const google = {
    puts: [],
    request: async (method, url, body) => {
      if (method === 'GET') return { ...structuredClone(stored.map), fingerprint: `v${version}` };
      if (clock.now() < busyUntil) throw notReady();
      if (body.fingerprint !== `v${version}`) throw gerr(412);
      busyUntil = clock.now() + 20_000;
      version += 1;
      stored.map = body;
      google.puts.push(clock.now());
      return { selfLink: 'op' };
    },
    waitCompute: async () => {},
  };
  return google;
}

test('modify: two workloads writing one URL map at once, an update taking 20 s: both policies are there, neither fails', async () => {
  const clock = fakeClock();
  const OTHER = `${V1}/dmtr-europe-west1-other`;
  // terraform/gcp-dev's map: two workloads, one matcher each.
  const stored = { map: { name: 'dmt-dev', pathMatchers: [{ name: 'app', defaultService: `${V1}/${APP}` }, { name: 'mig', defaultService: `${V1}/mig` }] } };
  const google = busyGoogle(clock, stored);
  const urlmaps = createUrlMaps({ google, project: 'p', now: clock.now, sleep: clock.sleep });
  await assert.doesNotReject(Promise.all([
    urlmaps.modify('dmt-dev', (map) => withErrorPolicy(map, APP, WAKER)),
    urlmaps.modify('dmt-dev', (map) => withErrorPolicy(map, 'mig', OTHER)),
  ]));
  assert.equal(google.puts.length, 2);
  assert.ok(google.puts[1] - google.puts[0] >= 20_000);
  assert.equal(stored.map.pathMatchers[0].defaultCustomErrorResponsePolicy.errorService, WAKER);
  assert.equal(stored.map.pathMatchers[1].defaultCustomErrorResponsePolicy.errorService, OTHER);
});

test('modify: another error is not retried', async () => {
  const google = fakeGoogle((method) => { if (method === 'GET') return fixture(); throw gerr(403); });
  const sleeps = [];
  await assert.rejects(createUrlMaps({ google, project: 'p', sleep: noWait(sleeps) }).modify('dmt-dev', (map) => withErrorPolicy(map, APP, WAKER)), { code: 403 });
  assert.equal(google.calls.length, 2);
  assert.deepEqual(sleeps, []);
});

test('CALLS names the adapter\'s functions', () => {
  assert.deepEqual(Object.keys(CALLS).sort(), ['get', 'list', 'modify']);
});

// ---- The swap (S4, design section 7): regional and classic load balancers ----

const { withSwap, withoutSwap, withHoldRoute, withoutHoldRoute } = await import('../src/urlmaps.mjs');

const svc = (name) => `${V1}/${name}`;
const HOLD_PATH = { paths: ['/_dormeto/backend/*'], service: svc(APP) };
const HOLD_RULE = { priority: 0, matchRules: [{ prefixMatch: '/_dormeto/backend/' }], service: svc(APP) };
const WAKER_RULE_1 = { ...ROUTE_RULE, priority: 1 };

// Every kind of reference, in Google's usual key order and one URL form (what Google returns).
function swapFixture() {
  return {
    name: 'dmt-dev',
    fingerprint: 'abc=',
    defaultService: svc('other'),
    hostRules: [{ hosts: ['a.example.com'], pathMatcher: 'plain' }, { hosts: ['b.example.com'], pathMatcher: 'rules' },
      { hosts: ['c.example.com'], pathMatcher: 'weighted' }, { hosts: ['d.example.com'], pathMatcher: 'routes' }],
    pathMatchers: [
      { name: 'plain', defaultService: svc(APP) },
      { name: 'rules', defaultService: svc('other'), pathRules: [{ paths: ['/api/*'], service: svc(APP) }, { paths: ['/x'], service: svc('other') }] },
      { name: 'weighted', defaultRouteAction: { weightedBackendServices: [{ backendService: svc(APP), weight: 100 }] } },
      { name: 'routes', defaultService: svc('other'), routeRules: [
        { priority: 5, matchRules: [{ prefixMatch: '/r' }], service: svc(APP) },
        { priority: 6, matchRules: [{ prefixMatch: '/w' }], routeAction: { weightedBackendServices: [{ backendService: svc(APP), weight: 1 }] } },
      ] },
    ],
  };
}
const swapDefault = () => ({ ...swapFixture(), defaultService: svc(APP) });

test('withSwap: every reference to the application becomes the waker, the hold route aside', () => {
  const before = swapFixture();
  const { map, paths } = withSwap(before, APP, WAKER);
  const expected = swapFixture();
  expected.pathMatchers[0].defaultService = WAKER;
  expected.pathMatchers[1].pathRules[0].service = WAKER;
  expected.pathMatchers[2].defaultRouteAction.weightedBackendServices[0].backendService = WAKER;
  expected.pathMatchers[3].routeRules[0].service = WAKER;
  expected.pathMatchers[3].routeRules[1].routeAction.weightedBackendServices[0].backendService = WAKER;
  assert.deepEqual(map, expected);
  assert.deepEqual(paths, [
    'pathMatchers[0].defaultService',
    'pathMatchers[1].pathRules[0].service',
    'pathMatchers[2].defaultRouteAction',
    'pathMatchers[3].routeRules[0].service',
    'pathMatchers[3].routeRules[1].routeAction',
  ]);
  assert.deepEqual(before, swapFixture(), 'the input is not changed');
});

test('withSwap: the map\'s own default, and its weighted default', () => {
  assert.equal(withSwap(swapDefault(), APP, WAKER).map.defaultService, WAKER);
  assert.deepEqual(withSwap(swapDefault(), APP, WAKER).paths[0], 'defaultService');
  const weighted = swapFixture();
  delete weighted.defaultService;
  weighted.defaultRouteAction = { weightedBackendServices: [{ backendService: svc(APP), weight: 1 }] };
  const r = withSwap(weighted, APP, WAKER);
  assert.equal(r.map.defaultRouteAction.weightedBackendServices[0].backendService, WAKER);
  assert.equal(r.paths[0], 'defaultRouteAction');
});

test('withSwap: a URL form of the beta or a relative one names the application as well', () => {
  const map = { name: 'm', pathMatchers: [{ name: 'a', defaultService: `${BETA}/${APP}` }, { name: 'b', defaultService: `${REL}/${APP}` }] };
  const r = withSwap(map, APP, WAKER);
  assert.deepEqual(r.map.pathMatchers.map((m) => m.defaultService), [WAKER, WAKER]);
});

test('withSwap: the hold route and the /_dormeto/* route stay as they are', () => {
  const held = withWakerRoute(withHoldRoute(swapFixture(), APP, WAKER).map, APP, WAKER).map;
  const { map } = withSwap(held, APP, WAKER);
  assert.deepEqual(map.pathMatchers[1].pathRules.slice(-2), [HOLD_PATH, ROUTE_PATH]);
  assert.deepEqual(map.pathMatchers[3].routeRules.filter((r) => r.priority < 2), [HOLD_RULE, WAKER_RULE_1]);
  assert.deepEqual(map.pathMatchers[1].pathRules[0].service, WAKER);
});

test('withSwap then withoutSwap: the map back to the byte, the hold and the waker route kept', () => {
  for (const original of [swapFixture(), swapDefault()]) {
    const held = withWakerRoute(withHoldRoute(original, APP, WAKER).map, APP, WAKER).map;
    const swapped = withSwap(held, APP, WAKER);
    assert.ok(swapped.paths.length > 0);
    const back = withoutSwap(swapped.map, APP, WAKER);
    assert.ok(back.paths.length > 0);
    assert.equal(JSON.stringify(back.map), JSON.stringify(held));
    assert.deepEqual(back.map, held);
  }
  const plain = swapFixture();
  assert.equal(JSON.stringify(withoutSwap(withSwap(plain, APP, WAKER).map, APP, WAKER).map), JSON.stringify(plain));
});

test('withoutSwap: the app\'s URL takes the waker\'s scope, a regional one too', () => {
  const R = 'https://compute.googleapis.com/compute/v1/projects/p/regions/europe-west1/backendServices';
  const map = { name: 'm', pathMatchers: [{ name: 'a', defaultService: `${R}/${APP}` }] };
  const swapped = withSwap(map, APP, `${R}/dmtr-w`);
  assert.equal(swapped.map.pathMatchers[0].defaultService, `${R}/dmtr-w`);
  assert.deepEqual(withoutSwap(swapped.map, APP, `${R}/dmtr-w`).map, map);
});

test('withSwap and withoutSwap: nothing to do writes nothing', () => {
  const swapped = withSwap(swapFixture(), APP, WAKER).map;
  assert.deepEqual(withSwap(swapped, APP, WAKER).paths, []);
  assert.deepEqual(withSwap(swapped, APP, WAKER).map, swapped);
  assert.deepEqual(withoutSwap(swapFixture(), APP, WAKER).paths, []);
  assert.deepEqual(withoutSwap(swapFixture(), APP, WAKER).map, swapFixture());
});

test('withoutSwap: the /_dormeto/* route, path rule or route rule, is never swapped back', () => {
  const routed = withWakerRoute(swapFixture(), APP, WAKER).map;
  assert.deepEqual(withoutSwap(routed, APP, WAKER).paths, []);
});

test('withSwap: a map whose tests name the application is refused', () => {
  const map = { ...swapFixture(), tests: [{ host: 'a.example.com', path: '/', service: svc(APP) }] };
  assert.throws(() => withSwap(map, APP, WAKER), (e) => e instanceof UrlMapRefused && /tests/.test(e.message));
  assert.doesNotThrow(() => withSwap({ ...swapFixture(), tests: [{ host: 'a.example.com', path: '/', service: svc('other') }] }, APP, WAKER));
});

test('withSwap: a request mirror naming the application is refused, wherever the route action is', () => {
  const mirror = { requestMirrorPolicy: { backendService: svc(APP) } };
  const places = [
    (m) => { m.defaultRouteAction = mirror; },
    (m) => { m.pathMatchers[0].defaultRouteAction = mirror; },
    (m) => { m.pathMatchers[1].pathRules[1].routeAction = mirror; },
    (m) => { m.pathMatchers[3].routeRules[0].routeAction = mirror; },
  ];
  for (const place of places) {
    const map = swapFixture();
    place(map);
    assert.throws(() => withSwap(map, APP, WAKER), (e) => e instanceof UrlMapRefused && /mirror/.test(e.message));
  }
  const other = swapFixture();
  other.pathMatchers[0].defaultRouteAction = { requestMirrorPolicy: { backendService: svc('other') } };
  assert.doesNotThrow(() => withSwap(other, APP, WAKER));
});

test('withSwap: a weighted route naming the application beside another service is refused', () => {
  const map = swapFixture();
  map.pathMatchers[2].defaultRouteAction.weightedBackendServices.push({ backendService: svc('other'), weight: 0 });
  assert.throws(() => withSwap(map, APP, WAKER), (e) => e instanceof UrlMapRefused && /weight/.test(e.message));
  const route = swapFixture();
  route.pathMatchers[3].routeRules[1].routeAction.weightedBackendServices.push({ backendService: svc('other'), weight: 1 });
  assert.throws(() => withSwap(route, APP, WAKER), UrlMapRefused);
  const top = swapDefault();
  top.defaultService = undefined;
  delete top.defaultService;
  top.defaultRouteAction = { weightedBackendServices: [{ backendService: svc('other'), weight: 1 }, { backendService: svc(APP), weight: 1 }] };
  assert.throws(() => withSwap(top, APP, WAKER), UrlMapRefused);
});

test('withHoldRoute: /_dormeto/backend/* to the application in each matcher naming it: a path rule, a route rule at priority 0', () => {
  const before = swapFixture();
  const { map, paths } = withHoldRoute(before, APP, WAKER);
  const expected = swapFixture();
  expected.pathMatchers[0].pathRules = [HOLD_PATH];
  expected.pathMatchers[1].pathRules.push(HOLD_PATH);
  expected.pathMatchers[2].pathRules = [{ ...HOLD_PATH }];
  expected.pathMatchers[3].routeRules.push(HOLD_RULE);
  assert.deepEqual(map, expected);
  assert.deepEqual(paths, ['pathMatchers[0].pathRules', 'pathMatchers[1].pathRules', 'pathMatchers[2].pathRules', 'pathMatchers[3].routeRules']);
  assert.deepEqual(before, swapFixture());
});

test('withHoldRoute: idempotent, and removed again to the byte', () => {
  for (const original of [swapFixture(), swapDefault()]) {
    const once = withHoldRoute(original, APP, WAKER);
    assert.deepEqual(withHoldRoute(once.map, APP, WAKER).paths, []);
    const back = withoutHoldRoute(once.map, APP, WAKER);
    assert.ok(back.paths.length > 0);
    assert.equal(JSON.stringify(back.map), JSON.stringify(original));
    assert.deepEqual(withoutHoldRoute(original, APP, WAKER).paths, []);
  }
});

test('withHoldRoute: the map\'s default alone: the dormeto-default matcher withWakerRoute makes, either order', () => {
  const holdFirst = withWakerRoute(withHoldRoute(swapDefault(), APP, WAKER).map, APP, WAKER);
  const wakerFirst = withHoldRoute(withWakerRoute(swapDefault(), APP, WAKER).map, APP, WAKER);
  const sorted = (map) => { const c = structuredClone(map); for (const m of c.pathMatchers) { m.pathRules?.sort((a, b) => a.paths[0].localeCompare(b.paths[0])); m.routeRules?.sort((a, b) => a.priority - b.priority); } return c; };
  assert.deepEqual(sorted(holdFirst.map), sorted(wakerFirst.map));
  const held = holdFirst.map.pathMatchers.at(-1);
  assert.deepEqual(held, { name: 'dormeto-default', defaultService: svc(APP), pathRules: [HOLD_PATH, ROUTE_PATH] });
  assert.equal(holdFirst.map.hostRules.filter((h) => h.pathMatcher === 'dormeto-default').length, 1);
  // The waker route first removed, the matcher stays for the hold; then the hold goes and the matcher with it.
  const noWaker = withoutWakerRoute(holdFirst.map, WAKER).map;
  assert.deepEqual(noWaker.pathMatchers.at(-1).pathRules, [HOLD_PATH]);
  assert.deepEqual(withoutHoldRoute(noWaker, APP, WAKER).map, swapDefault());
  assert.equal(JSON.stringify(withoutHoldRoute(noWaker, APP, WAKER).map), JSON.stringify(swapDefault()));
  const noHold = withoutHoldRoute(holdFirst.map, APP, WAKER).map;
  assert.deepEqual(noHold.pathMatchers.at(-1).pathRules, [ROUTE_PATH]);
  assert.deepEqual(withoutWakerRoute(noHold, WAKER).map, swapDefault());
});

test('withHoldRoute: a swapped map keeps its hold, and the default alone is held by dormeto-default whose default is swapped', () => {
  const held = withWakerRoute(withHoldRoute(swapDefault(), APP, WAKER).map, APP, WAKER).map;
  const swapped = withSwap(held, APP, WAKER).map;
  assert.equal(swapped.defaultService, WAKER);
  assert.deepEqual(swapped.pathMatchers.at(-1), { name: 'dormeto-default', defaultService: WAKER, pathRules: [HOLD_PATH, ROUTE_PATH] });
  assert.deepEqual(withHoldRoute(swapped, APP, WAKER).paths, []);
});

test('route rules: the hold takes priority 0 and the waker\'s route 1, whichever comes first', () => {
  const holdFirst = withWakerRoute(withHoldRoute(swapFixture(), APP, WAKER).map, APP, WAKER).map;
  const wakerFirst = withHoldRoute(withWakerRoute(swapFixture(), APP, WAKER).map, APP, WAKER).map;
  for (const map of [holdFirst, wakerFirst]) {
    const rules = map.pathMatchers[3].routeRules;
    assert.deepEqual(rules.find((r) => r.priority === 0), HOLD_RULE);
    assert.deepEqual(rules.find((r) => r.priority === 1), WAKER_RULE_1);
  }
  assert.deepEqual(holdFirst.pathMatchers[3].routeRules.map((r) => r.priority).sort(), [0, 1, 5, 6]);
  // The hold removed: the waker's route is back at 0, as without a hold; a global map without hold keeps priority 0 alone.
  const noHold = withoutHoldRoute(holdFirst, APP, WAKER).map;
  assert.deepEqual(noHold.pathMatchers[3].routeRules.find((r) => r.matchRules[0].prefixMatch === '/_dormeto/'), ROUTE_RULE);
  assert.deepEqual(noHold, withWakerRoute(swapFixture(), APP, WAKER).map);
});

test('route rules: priority 0 and 1 must both be free, else refused', () => {
  for (const taken of [0, 1]) {
    const map = swapFixture();
    map.pathMatchers[3].routeRules[0].priority = taken;
    assert.throws(() => withHoldRoute(map, APP, WAKER), (e) => e instanceof UrlMapRefused && /priority/.test(e.message));
  }
  const map = withHoldRoute(swapFixture(), APP, WAKER).map;
  map.pathMatchers[3].routeRules.push({ priority: 1, matchRules: [{ prefixMatch: '/q' }], service: svc('other') });
  assert.throws(() => withWakerRoute(map, APP, WAKER), /priority 1/);
});

test('a customer\'s own /_dormeto/backend/ route stays a refusal; the two of Dormeto\'s are accepted', () => {
  const theirs = swapFixture();
  theirs.pathMatchers[1].pathRules.push({ paths: ['/_dormeto/backend/*'], service: svc('other') });
  assert.throws(() => withHoldRoute(theirs, APP, WAKER), /\/_dormeto\/ route/);
  assert.throws(() => withWakerRoute(theirs, APP, WAKER), /\/_dormeto\/ route/);
  const routes = swapFixture();
  routes.pathMatchers[3].routeRules.push({ priority: 9, matchRules: [{ prefixMatch: '/_dormeto/backend/x' }], service: svc('other') });
  assert.throws(() => withHoldRoute(routes, APP, WAKER), /\/_dormeto\/ route/);
  const both = withWakerRoute(withHoldRoute(swapFixture(), APP, WAKER).map, APP, WAKER).map;
  assert.doesNotThrow(() => withWakerRoute(both, APP, WAKER));
  assert.doesNotThrow(() => withHoldRoute(both, APP, WAKER));
  assert.deepEqual(withWakerRoute(both, APP, WAKER).paths, []);
});

test('withHoldRoute: a map without the service has no path and no change', () => {
  assert.deepEqual(withHoldRoute(swapFixture(), 'nothing', WAKER).paths, []);
  assert.deepEqual(withHoldRoute(swapFixture(), 'nothing', WAKER).map, swapFixture());
});

test('withHoldRoute: a matcher named dormeto-default of the customer\'s is refused', () => {
  const map = swapDefault();
  map.pathMatchers.push({ name: 'dormeto-default', defaultService: svc('other') });
  assert.throws(() => withHoldRoute(map, APP, WAKER), /dormeto-default/);
});

test('withoutSwap: the unswapped map reads like the original even when the hold alone kept a matcher', () => {
  const held = withHoldRoute(swapFixture(), APP, WAKER).map;
  const back = withoutSwap(withSwap(held, APP, WAKER).map, APP, WAKER).map;
  assert.equal(JSON.stringify(back), JSON.stringify(held));
});

// The adapter by scope.
test('createUrlMaps: a regional adapter reads, lists and updates under regions/<region>/urlMaps, and waits on the operation it gets', async () => {
  const base = 'https://compute.googleapis.com/compute/v1/projects/p/regions/europe-west1/urlMaps';
  const google = fakeGoogle((method) => (method === 'GET' ? structuredClone(swapFixture()) : { selfLink: 'https://compute.googleapis.com/compute/v1/projects/p/regions/europe-west1/operations/op-1', status: 'RUNNING' }));
  const urlmaps = createUrlMaps({ google, project: 'p', region: 'europe-west1', scope: 'regional' });
  await urlmaps.modify('dmt-dev', (map) => withSwap(map, APP, WAKER));
  await urlmaps.list();
  assert.deepEqual(google.calls.filter((c) => c.method).map((c) => `${c.method} ${c.url}`), [`GET ${base}/dmt-dev`, `PUT ${base}/dmt-dev`, `GET ${base}`]);
  assert.match(google.calls.find((c) => c.wait).wait.selfLink, /\/regions\/europe-west1\/operations\//);
  assert.equal(google.calls.find((c) => c.method === 'PUT').body.pathMatchers[0].defaultService, WAKER);
});

test('createUrlMaps: scope omitted is global; a regional one needs a region', () => {
  const google = fakeGoogle(() => ({}));
  assert.doesNotThrow(() => createUrlMaps({ google, project: 'p' }));
  assert.doesNotThrow(() => createUrlMaps({ google, project: 'p', scope: 'global' }));
  assert.throws(() => createUrlMaps({ google, project: 'p', scope: 'regional' }), /region/);
  assert.throws(() => createUrlMaps({ google, project: 'p', scope: 'zonal' }), /scope/);
});

test('createUrlMaps: a global adapter still uses global/urlMaps, with a region given or not', async () => {
  const google = fakeGoogle(() => fixture());
  await createUrlMaps({ google, project: 'p', region: 'europe-west1' }).get('m');
  assert.equal(google.calls[0].url, 'https://compute.googleapis.com/compute/v1/projects/p/global/urlMaps/m');
});

test('CALLS: the regional adapter\'s own', async () => {
  const { CALLS_REGIONAL } = await import('../src/urlmaps.mjs');
  assert.deepEqual(CALLS_REGIONAL.modify, ['compute.regionUrlMaps.get', 'compute.regionUrlMaps.update', 'compute.regionBackendServices.use', 'compute.regionOperations.get']);
});

// ---- Fix round 1 ----

// Production's forms: the application's URL as the map has it (www.googleapis.com), the waker's as the client makes it.
const PROD_WAKER = 'https://compute.googleapis.com/compute/v1/projects/p/global/backendServices/dmtr-europe-west1-app';

test('the swap and its undoing in production\'s URL forms: the app\'s URL comes from the hold route, to the byte', () => {
  for (const original of [swapFixture(), swapDefault()]) {
    const held = withWakerRoute(withHoldRoute(original, APP, PROD_WAKER).map, APP, PROD_WAKER).map;
    const swapped = withSwap(held, APP, PROD_WAKER).map;
    assert.equal(JSON.stringify(withoutSwap(swapped, APP, PROD_WAKER).map), JSON.stringify(held));
  }
});

test('withoutSwap: the application given as a URL is used as it is', () => {
  const swapped = withSwap(swapFixture(), APP, PROD_WAKER).map;
  const other = 'https://compute.googleapis.com/compute/v1/projects/q/global/backendServices/app';
  assert.equal(withoutSwap(swapped, other, PROD_WAKER).map.pathMatchers[0].defaultService, other);
});

test('every entry refuses a missing app or waker rather than matching holders without a service', () => {
  const map = { name: 'm', defaultRouteAction: {}, pathMatchers: [{ name: 'a', defaultService: svc(APP) }] };
  for (const f of [withSwap, withoutSwap, withHoldRoute, withoutHoldRoute, withWakerRoute]) {
    assert.throws(() => f(map, APP, undefined), /waker/, f.name);
  }
  assert.throws(() => withoutWakerRoute(map, undefined), /waker/);
  assert.throws(() => withSwap(map, undefined, WAKER), /application/);
});

test('a rule that merely contains the hold path is not the hold route: not skipped by the swap, not removed, refused as a route', () => {
  const map = swapFixture();
  map.pathMatchers[1].pathRules[0].paths = ['/api/*', '/_dormeto/backend/*'];
  assert.throws(() => withHoldRoute(map, APP, WAKER), /\/_dormeto\/ route/);
  const route = swapFixture();
  route.pathMatchers[3].routeRules[0].matchRules = [{ prefixMatch: '/_dormeto/backend/', headerMatches: [{ headerName: 'x' }] }];
  assert.throws(() => withHoldRoute(route, APP, WAKER), /\/_dormeto\/ route/);
  // Not Dormeto's: the swap treats it as any reference, the removal leaves it.
  assert.equal(withSwap(map, APP, WAKER).map.pathMatchers[1].pathRules[0].service, WAKER);
  assert.deepEqual(withoutHoldRoute(map, APP, WAKER).paths, []);
});

test('a customer\'s /_dormeto/ route to another service is refused by the hold, never moved', () => {
  const map = swapFixture();
  map.pathMatchers[3].routeRules.push({ priority: 0, matchRules: [{ prefixMatch: '/_dormeto/', headerMatches: [{ headerName: 'x' }] }], service: svc('theirs') });
  assert.throws(() => withHoldRoute(map, APP, WAKER), UrlMapRefused);
  const back = withHoldRoute(swapFixture(), APP, WAKER).map;
  back.pathMatchers[3].routeRules.push({ priority: 1, matchRules: [{ prefixMatch: '/_dormeto/' }], service: svc('theirs') });
  assert.deepEqual(withoutHoldRoute(back, APP, WAKER).map.pathMatchers[3].routeRules.at(-1).priority, 1);
});

test('another workload\'s waker route in a shared matcher is not ours to move or remove', () => {
  const OTHER = svc('dmtr-europe-west1-other');
  const map = swapFixture();
  map.pathMatchers[3].routeRules.push({ priority: 0, matchRules: [{ prefixMatch: '/_dormeto/' }], service: OTHER });
  assert.throws(() => withHoldRoute(map, APP, WAKER), UrlMapRefused);
  assert.deepEqual(withoutWakerRoute(map, WAKER).paths, []);
});

test('two workloads on one map: each one\'s hold, swap and routes leave the other\'s alone', () => {
  const OTHER_WAKER = svc('dmtr-europe-west1-other');
  const map = {
    name: 'm',
    defaultService: svc('other'),
    hostRules: [{ hosts: ['a.example.com'], pathMatcher: 'a' }, { hosts: ['b.example.com'], pathMatcher: 'b' }],
    pathMatchers: [{ name: 'a', defaultService: svc(APP) }, { name: 'b', defaultService: svc('other'), routeRules: [{ priority: 3, matchRules: [{ prefixMatch: '/x' }], service: svc('other') }] }],
  };
  const both = withWakerRoute(withHoldRoute(withWakerRoute(withHoldRoute(map, APP, WAKER).map, APP, WAKER).map, 'other', OTHER_WAKER).map, 'other', OTHER_WAKER).map;
  const swapped = withSwap(both, APP, WAKER).map;
  assert.equal(swapped.pathMatchers[0].defaultService, WAKER);
  assert.equal(swapped.pathMatchers[1].defaultService, svc('other'));
  assert.equal(swapped.defaultService, svc('other'));
  const back = withoutSwap(swapped, APP, WAKER).map;
  assert.equal(JSON.stringify(back), JSON.stringify(both));
  const unrouted = withoutHoldRoute(withoutWakerRoute(back, WAKER).map, APP, WAKER).map;
  assert.deepEqual(unrouted.pathMatchers[0], map.pathMatchers[0]);
  assert.ok(unrouted.pathMatchers.some((m) => m.name === 'dormeto-default'), 'the other workload\'s dormeto-default stays');
});

test('a matcher naming both services without a route of its own for the waker is refused rather than shared silently', () => {
  const map = swapFixture();
  map.pathMatchers[1].pathRules.push({ paths: ['/_dormeto/backend/*'], service: svc('other') });
  assert.throws(() => withHoldRoute(map, APP, WAKER), /\/_dormeto\/ route/);
});

test('withHoldRoute on a swapped map holds in the matchers that name the waker', () => {
  const swapped = withSwap(swapFixture(), APP, WAKER).map;
  const { map, paths } = withHoldRoute(swapped, APP, WAKER);
  assert.ok(paths.length > 0);
  assert.deepEqual(map.pathMatchers[0].pathRules, [HOLD_PATH]);
  assert.deepEqual(withSwap(map, APP, WAKER).paths, []);
  assert.equal(JSON.stringify(withoutHoldRoute(map, APP, WAKER).map), JSON.stringify(swapped));
});

test('withoutHoldRoute: a dormeto-default holding another workload\'s rule keeps it, and a customer\'s stays whole', () => {
  const OTHER_WAKER = svc('dmtr-europe-west1-other');
  const shared = withWakerRoute(withHoldRoute(swapDefault(), APP, WAKER).map, APP, WAKER).map;
  const kept = withoutHoldRoute(shared, APP, WAKER).map;
  assert.deepEqual(kept.pathMatchers.at(-1).pathRules, [ROUTE_PATH]);
  const other = withWakerRoute(mapNaming('other'), 'other', OTHER_WAKER).map;
  assert.deepEqual(withoutHoldRoute(other, APP, WAKER).paths, []);
  // A customer's own dormeto-default (its host rule not `*` alone) is not dropped.
  const theirs = {
    name: 'm', defaultService: svc('other'),
    hostRules: [{ hosts: ['a.example.com'], pathMatcher: 'dormeto-default' }],
    pathMatchers: [{ name: 'dormeto-default', defaultService: svc(APP), pathRules: [HOLD_PATH] }],
  };
  const r = withoutHoldRoute(theirs, APP, WAKER);
  assert.equal(r.map.pathMatchers.length, 1);
  assert.equal(r.map.hostRules.length, 1);
});

test('createUrlMaps: a regional map\'s busy update is waited on for 120 s of pauses, a global one\'s for 60 s', async () => {
  for (const [scope, total, tries] of [['global', 60_000, 5], ['regional', 120_000, 7]]) {
    const google = fakeGoogle((method) => { if (method === 'GET') return swapFixture(); throw gerr(412); });
    const sleeps = [];
    await assert.rejects(createUrlMaps({ google, project: 'p', region: 'r', scope, sleep: noWait(sleeps) }).modify('m', (map) => withSwap(map, APP, WAKER)), { code: 412 });
    assert.equal(sleeps.reduce((a, b) => a + b, 0), total, scope);
    assert.equal(google.calls.filter((c) => c.method === 'PUT').length, tries, scope);
  }
});

// ---- M4: a regional backend service takes no custom request header (Google: "not allowed for regional EXTERNAL_MANAGED") ----
// The map carries them instead, wherever it names the regional waker: a one-entry weighted service with a header action that
// replaces a client's own value (M4: it does). A plain reference swapped says so with x-dormeto-ref, to be written back plainly.

const HEADERS = [['x-dormeto-workload', 'app'], ['x-dormeto-switch', 'swap']];
const added = (pairs) => pairs.map(([headerName, headerValue]) => ({ headerName, headerValue, replace: true }));
const toWaker = (extra = []) => ({ backendService: WAKER, weight: 100, headerAction: { requestHeadersToAdd: added([...HEADERS, ...extra]) } });
const REF = [['x-dormeto-ref', 'service']];
const R_ROUTE_PATH = { paths: ['/_dormeto/*'], routeAction: { weightedBackendServices: [toWaker()] } };
const R_ROUTE_RULE = { priority: 0, matchRules: [{ prefixMatch: '/_dormeto/' }], routeAction: { weightedBackendServices: [toWaker()] } };

test('withWakerRoute with headers: the /_dormeto/* route carries them, as a path rule or a route rule; twice writes nothing', () => {
  const { map, paths } = withWakerRoute(swapFixture(), APP, WAKER, { headers: HEADERS });
  assert.deepEqual(map.pathMatchers[1].pathRules.at(-1), R_ROUTE_PATH);
  assert.deepEqual(map.pathMatchers[3].routeRules.at(-1), R_ROUTE_RULE);
  assert.ok(paths.includes('pathMatchers[1].pathRules') && paths.includes('pathMatchers[3].routeRules'));
  assert.deepEqual(withWakerRoute(map, APP, WAKER, { headers: HEADERS }).paths, []);
});

test('withoutWakerRoute: the route with headers goes, the map back to the byte', () => {
  for (const original of [swapFixture(), swapDefault()]) {
    const routed = withWakerRoute(original, APP, WAKER, { headers: HEADERS }).map;
    assert.equal(JSON.stringify(withoutWakerRoute(routed, WAKER).map), JSON.stringify(original));
  }
});

test('withSwap with headers: a plain reference becomes one weighted entry with the headers and x-dormeto-ref, a weighted one keeps its weight', () => {
  const { map, paths } = withSwap(swapFixture(), APP, WAKER, { headers: HEADERS });
  const expected = swapFixture();
  delete expected.pathMatchers[0].defaultService;
  expected.pathMatchers[0].defaultRouteAction = { weightedBackendServices: [toWaker(REF)] };
  delete expected.pathMatchers[1].pathRules[0].service;
  expected.pathMatchers[1].pathRules[0].routeAction = { weightedBackendServices: [toWaker(REF)] };
  expected.pathMatchers[2].defaultRouteAction.weightedBackendServices[0] = toWaker();
  delete expected.pathMatchers[3].routeRules[0].service;
  expected.pathMatchers[3].routeRules[0].routeAction = { weightedBackendServices: [toWaker(REF)] };
  expected.pathMatchers[3].routeRules[1].routeAction.weightedBackendServices[0] = { ...toWaker(), weight: 1 };
  assert.deepEqual(map, expected);
  assert.deepEqual(paths, [
    'pathMatchers[0].defaultService',
    'pathMatchers[1].pathRules[0].service',
    'pathMatchers[2].defaultRouteAction',
    'pathMatchers[3].routeRules[0].service',
    'pathMatchers[3].routeRules[1].routeAction',
  ]);
  // In place: the reference's key becomes the route action's, where it was.
  assert.deepEqual(Object.keys(map.pathMatchers[1].pathRules[0]), ['paths', 'routeAction']);
});

test('withSwap then withoutSwap with headers: the map back to the byte, the hold and the waker route with headers kept', () => {
  for (const original of [swapFixture(), swapDefault()]) {
    const held = withWakerRoute(withHoldRoute(original, APP, WAKER).map, APP, WAKER, { headers: HEADERS }).map;
    const swapped = withSwap(held, APP, WAKER, { headers: HEADERS });
    assert.ok(swapped.paths.length > 0);
    assert.deepEqual(withSwap(swapped.map, APP, WAKER, { headers: HEADERS }).paths, [], 'swapped already');
    const back = withoutSwap(swapped.map, APP, WAKER);
    assert.ok(back.paths.length > 0);
    assert.equal(JSON.stringify(back.map), JSON.stringify(held));
    assert.deepEqual(withoutSwap(back.map, APP, WAKER).paths, [], 'unswapped already');
  }
});

test('withSwap with headers: a customer\'s own header action and route action stay, and come back as they were', () => {
  const map = swapFixture();
  map.pathMatchers[2].defaultRouteAction.weightedBackendServices[0].headerAction = { requestHeadersToAdd: [{ headerName: 'x-team', headerValue: 'shop', replace: false }] };
  map.pathMatchers[1].pathRules[0].routeAction = { urlRewrite: { pathPrefixRewrite: '/' } };
  const swapped = withSwap(map, APP, WAKER, { headers: HEADERS }).map;
  assert.deepEqual(swapped.pathMatchers[2].defaultRouteAction.weightedBackendServices[0].headerAction.requestHeadersToAdd,
    [{ headerName: 'x-team', headerValue: 'shop', replace: false }, ...added(HEADERS)]);
  assert.deepEqual(swapped.pathMatchers[1].pathRules[0], { paths: ['/api/*'], routeAction: { urlRewrite: { pathPrefixRewrite: '/' }, weightedBackendServices: [toWaker(REF)] } });
  assert.deepEqual(withoutSwap(swapped, APP, WAKER).map, map);
});

test('the route with headers is Dormeto\'s: the swap leaves it, the hold accepts it, the hold\'s removal moves it back to priority 0', () => {
  const routed = withWakerRoute(swapFixture(), APP, WAKER, { headers: HEADERS }).map;
  const held = withHoldRoute(routed, APP, WAKER).map;
  assert.deepEqual(held.pathMatchers[3].routeRules.filter((r) => r.priority < 2), [{ ...R_ROUTE_RULE, priority: 1 }, HOLD_RULE]);
  const swapped = withSwap(held, APP, WAKER, { headers: HEADERS }).map;
  assert.deepEqual(swapped.pathMatchers[1].pathRules.slice(-2), [R_ROUTE_PATH, HOLD_PATH]);
  assert.deepEqual(withoutSwap(routed, APP, WAKER).paths, []);
  const unheld = withoutHoldRoute(held, APP, WAKER).map;
  assert.deepEqual(unheld.pathMatchers[3].routeRules.at(-1), R_ROUTE_RULE);
});

test('another workload\'s route with headers in a shared matcher is not this one\'s', () => {
  const OTHER = `${V1}/dmtr-europe-west1-other`;
  const map = withWakerRoute(swapFixture(), APP, WAKER, { headers: HEADERS }).map;
  assert.deepEqual(withoutWakerRoute(map, OTHER).paths, []);
  assert.throws(() => withWakerRoute(map, APP, OTHER, { headers: HEADERS }), /its own \/_dormeto\/ route/);
});
