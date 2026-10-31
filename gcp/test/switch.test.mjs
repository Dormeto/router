import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inOneUpdate, SWAP_WAIT_MS, switchOf } from '../src/switch.mjs';
import { withErrorPolicy, withoutErrorPolicy, withoutSwap, withSwap, withWakerRoute } from '../src/urlmaps.mjs';

const V1 = 'https://compute.googleapis.com/compute/v1/projects/p';
const WAKER = 'dmtr-europe-west1-demo';
const urlmaps = { scope: 'global' };
const regionalUrlmaps = { scope: 'regional' };
const place = { urlmaps, regionalUrlmaps, project: 'p', region: 'europe-west1' };
const cfgOf = (lb) => ({ backendService: 'app', wakerBackendService: WAKER, ...(lb ? { lb } : {}) });
const mapOf = (base) => ({
  name: 'lb',
  defaultService: `${base}/backendServices/other`,
  hostRules: [{ hosts: ['demo.example.com'], pathMatcher: 'm' }],
  pathMatchers: [{ name: 'm', defaultService: `${base}/backendServices/app` }],
});

for (const [name, lb] of [['no lb', undefined], ['global', { kind: 'global' }]]) {
  test(`${name}: the policy, its 300 s, on the global scope, as G1's functions write it`, () => {
    const sw = switchOf(cfgOf(lb), place);
    const waker = `${V1}/global/backendServices/${WAKER}`;
    const map = mapOf(`${V1}/global`);
    assert.equal(sw.kind, 'policy');
    assert.equal(sw.urlmaps, urlmaps);
    assert.equal(sw.waker, waker);
    assert.equal(sw.waitMs, 300_000);
    assert.deepEqual(sw.route(map), withWakerRoute(map, 'app', waker));
    assert.deepEqual(sw.asleep(map), withErrorPolicy(map, 'app', waker));
    const asleep = withErrorPolicy(map, 'app', waker).map;
    assert.deepEqual(sw.awake(asleep), withoutErrorPolicy(asleep, waker));
  });
}

for (const [kind, lb, base, adapter, waitMs] of [
  ['regional', { kind: 'regional', region: 'europe-west1' }, `${V1}/regions/europe-west1`, regionalUrlmaps, 100_000],
  ['classic', { kind: 'classic' }, `${V1}/global`, urlmaps, 250_000],
]) {
  const waker = `${base}/backendServices/${WAKER}`;
  const app = `${base}/backendServices/app`;
  const sw = switchOf(cfgOf(lb), place);

  test(`${kind}: the swap, its SWAP_WAIT, the adapter and the waker of its scope`, () => {
    assert.equal(sw.kind, 'swap');
    assert.equal(sw.urlmaps, adapter);
    assert.equal(sw.waker, waker);
    assert.equal(sw.waitMs, waitMs);
    assert.equal(SWAP_WAIT_MS[kind], waitMs);
  });

  test(`${kind}: asleep and awake are the swap and back`, () => {
    const map = sw.route(mapOf(base)).map;
    assert.deepEqual(sw.asleep(map), withSwap(map, 'app', waker));
    const swapped = withSwap(map, 'app', waker).map;
    assert.deepEqual(sw.awake(swapped), withoutSwap(swapped, 'app', waker));
    assert.deepEqual(sw.awake(swapped).map, map);
  });

  test(`${kind}: the route is the waker's and the hold, in one update; nothing written when they are there`, () => {
    const { map, paths } = sw.route(mapOf(base));
    assert.deepEqual(map.pathMatchers[0].pathRules.map((rule) => [rule.paths[0], rule.service]).sort(), [['/_dormeto/*', waker], ['/_dormeto/backend/*', app]]);
    assert.equal(paths.length, 2);
    assert.deepEqual(sw.route(map).paths, []);
  });

  test(`${kind}: on a swapped map that lost them, the route writes both, the hold naming the application`, () => {
    const swapped = withSwap(sw.route(mapOf(base)).map, 'app', waker).map;
    delete swapped.pathMatchers[0].pathRules;
    const { map, paths } = sw.route(swapped);
    assert.equal(paths.length, 2);
    assert.deepEqual(map.pathMatchers[0].pathRules.map((rule) => [rule.paths[0], rule.service]).sort(), [['/_dormeto/*', waker], ['/_dormeto/backend/*', app]]);
    assert.equal(map.pathMatchers[0].defaultService, waker);
  });

  test(`${kind}: with route rules, the route on a map that lost it keeps the hold at priority 0, the waker's at 1`, () => {
    const map = mapOf(base);
    map.pathMatchers[0] = { name: 'm', defaultService: app, routeRules: [{ priority: 5, matchRules: [{ prefixMatch: '/x/' }], service: app }] };
    const routed = sw.route(map).map;
    const rule = (prefix) => routed.pathMatchers[0].routeRules.find((r) => r.matchRules[0].prefixMatch === prefix);
    assert.equal(rule('/_dormeto/backend/').priority, 0);
    assert.equal(rule('/_dormeto/').priority, 1);
  });

  test(`${kind}: a map's default alone: the route gives it a matcher with the two routes, also when swapped`, () => {
    const only = { name: 'lb', defaultService: app };
    const routed = sw.route(only).map;
    assert.deepEqual(routed.pathMatchers[0].pathRules.map((rule) => rule.paths[0]).sort(), ['/_dormeto/*', '/_dormeto/backend/*']);
    const swapped = { name: 'lb', defaultService: waker };
    const again = sw.route(swapped).map;
    assert.deepEqual(again.pathMatchers[0].pathRules.map((rule) => rule.paths[0]).sort(), ['/_dormeto/*', '/_dormeto/backend/*']);
  });
}

test('a regional workload elsewhere than the router\'s region is refused: the adapter reads only its own', () => {
  assert.throws(() => switchOf(cfgOf({ kind: 'regional', region: 'us-east1' }), place), /regional load balancer of us-east1 on the router of europe-west1/);
  assert.throws(() => switchOf(cfgOf({ kind: 'regional' }), place), /regional load balancer of undefined on the router of europe-west1/);
});

test('a kind nobody knows is refused, not taken for a global one', () => {
  assert.throws(() => switchOf(cfgOf({ kind: 'internal' }), place), /unknown load balancer kind internal/);
});

test('inOneUpdate: each step on the map of the one before, the places in order', () => {
  const step = (name) => (map) => ({ map: { ...map, [name]: Object.keys(map).length }, paths: [name] });
  assert.deepEqual(inOneUpdate({ x: 1 }, [step('a'), step('b')]), { map: { x: 1, a: 1, b: 2 }, paths: ['a', 'b'] });
});
