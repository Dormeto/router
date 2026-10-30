import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hostsOf, references, withErrorPolicy, withoutErrorPolicy, withWakerRoute, withoutWakerRoute, createUrlMaps, CALLS,
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

test('withErrorPolicy: the map\'s default too when it names the service', () => {
  const { map } = withErrorPolicy(mapNaming(APP), APP, WAKER);
  assert.deepEqual(map.defaultCustomErrorResponsePolicy, POLICY);
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
  const atMap = mapNaming(APP);
  atMap.defaultCustomErrorResponsePolicy = own;
  assert.throws(() => withErrorPolicy(atMap, APP, WAKER), /error response policy/);
  const atRule = fixture();
  atRule.pathMatchers[1].pathRules[0].customErrorResponsePolicy = own;
  assert.throws(() => withErrorPolicy(atRule, APP, WAKER), /error response policy/);
  const atRoute = fixture();
  atRoute.pathMatchers[3].routeRules[0].customErrorResponsePolicy = own;
  assert.throws(() => withErrorPolicy(atRoute, APP, WAKER), /error response policy/);
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

test('modify: a 412 reads the map again and applies the change to it, three times at most', async () => {
  let puts = 0;
  const google = fakeGoogle((method) => {
    if (method === 'GET') return { ...fixture(), fingerprint: `f${google.calls.length}` };
    puts += 1;
    if (puts <= 2) throw gerr(412);
    return { selfLink: 'op' };
  });
  const urlmaps = createUrlMaps({ google, project: 'p' });
  await urlmaps.modify('dmt-dev', (map) => withErrorPolicy(map, APP, WAKER));
  assert.equal(google.calls.filter((c) => c.method === 'GET').length, 3);
  assert.notEqual(google.calls.filter((c) => c.method === 'PUT')[2].body.fingerprint, google.calls.filter((c) => c.method === 'PUT')[0].body.fingerprint);

  const always = fakeGoogle((method) => { if (method === 'GET') return fixture(); throw gerr(412); });
  await assert.rejects(createUrlMaps({ google: always, project: 'p' }).modify('dmt-dev', (map) => withErrorPolicy(map, APP, WAKER)), { code: 412 });
  assert.equal(always.calls.filter((c) => c.method === 'GET').length, 4);
});

test('modify: another error is not retried', async () => {
  const google = fakeGoogle((method) => { if (method === 'GET') return fixture(); throw gerr(403); });
  await assert.rejects(createUrlMaps({ google, project: 'p' }).modify('dmt-dev', (map) => withErrorPolicy(map, APP, WAKER)), { code: 403 });
  assert.equal(google.calls.length, 2);
});

test('CALLS names the adapter\'s functions', () => {
  assert.deepEqual(Object.keys(CALLS).sort(), ['get', 'list', 'modify']);
});
