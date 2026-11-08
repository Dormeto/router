// How a workload's load balancer sends visitors to the waker, and back (vision docs/specs/2026-10-30-google-cloud-coverage-design.md,
// section 7): the policy of a global one (G1) or the swap of a regional, classic or internal one, which have no custom error response.
// The internal kinds (vision docs/specs/2026-11-08-google-cloud-router-features-design.md, section 7): `internal`, a regional map whose
// forwarding rules are INTERNAL_MANAGED, and `cross-region-internal`, a global map whose rules are.
//
// switchOf(cfg, { urlmaps, regionalUrlmaps, project, region }): `{ kind: 'policy' | 'swap', urlmaps (the adapter of its scope), waker
// (the waker's URL of its kind), asleep(map), awake(map), route(map), waitMs }`, the three functions as urlmaps.mjs's, returning
// `{ map, paths }`. `route` is what stays for good: the waker's route and, under a swap, the hold route. `waitMs`: a change reaching
// the load balancer, and the application's drain at a nap.
import { swapHeaders } from './names.mjs';
import { withErrorPolicy, withHoldRoute, withoutErrorPolicy, withoutSwap, withSwap, withWakerRoute } from './urlmaps.mjs';

const COMPUTE = 'https://compute.googleapis.com/compute/v1';
// The nap's policy reaching the load balancer (G0: 163 to 215 s), which is also the application's drain.
const POLICY_WAIT_MS = 300_000;
// SWAP_WAIT, by the load balancer's kind: a map's change reaching the load balancer. Regional: G0's worst 89 s, M3 35 s;
// classic: M2's worst 226 s and 10 %. The internal kinds: regional's until G5's M3 measures them (Envoy-based, as regional).
export const SWAP_WAIT_MS = { regional: 100_000, classic: 250_000, internal: 100_000, 'cross-region-internal': 100_000 };

// The kinds whose map, backend services and waker are in the router's region; the others' are global.
const REGIONAL_KINDS = new Set(['regional', 'internal']);
export const isRegionalLb = (lb) => REGIONAL_KINDS.has(lb?.kind);
// The kinds whose backend services take no custom request header (M4 on regional; Google's page on the internal ones, regional and
// cross-region): the map carries the waker's headers instead, and its description says whose waker it is.
const MAP_HEADER_KINDS = new Set(['regional', 'internal', 'cross-region-internal']);
export const headersInMap = (lb) => MAP_HEADER_KINDS.has(lb?.kind);
// A kind in a sentence: a regional, an internal.
export const aKind = (kind) => `${/^[aeiou]/.test(kind) ? 'an' : 'a'} ${kind}`;

// The map's changes as one: `{ map, paths }`, each step on the map of the one before.
export const inOneUpdate = (map, steps) => steps.reduce(({ map: on, paths }, step) => {
  const done = step(on);
  return { map: done.map, paths: [...paths, ...done.paths] };
}, { map, paths: [] });

export function switchOf({ workloadId, backendService: app, wakerBackendService: name, lb }, { urlmaps, regionalUrlmaps, project, region }) {
  const kind = lb?.kind ?? 'global';
  const url = (scope) => `${COMPUTE}/projects/${project}/${scope}/backendServices/${name}`;
  if (kind === 'global') {
    const waker = url('global');
    return {
      kind: 'policy',
      urlmaps,
      waker,
      waitMs: POLICY_WAIT_MS,
      asleep: (map) => withErrorPolicy(map, app, waker),
      awake: (map) => withoutErrorPolicy(map, waker),
      route: (map) => withWakerRoute(map, app, waker),
    };
  }
  if (!Object.hasOwn(SWAP_WAIT_MS, kind)) throw new Error(`unknown load balancer kind ${kind}`);
  const regional = isRegionalLb(lb);
  // The regional adapter is the router's region's: anything else would read and write another map, or none.
  if (regional && lb.region !== region) throw new Error(`${aKind(kind)} load balancer of ${lb.region} on the router of ${region}`);
  const waker = url(regional ? `regions/${region}` : 'global');
  // A regional or internal backend service takes no custom request header: its waker's are written in the map, global or regional.
  if (headersInMap(lb) && !workloadId) throw new Error(`${aKind(kind)} workload needs its ID: its waker's headers are in the map`);
  const headers = headersInMap(lb) ? swapHeaders(workloadId) : undefined;
  return {
    kind: 'swap',
    urlmaps: regional ? regionalUrlmaps : urlmaps,
    waker,
    waitMs: SWAP_WAIT_MS[kind],
    asleep: (map) => withSwap(map, app, waker, { headers }),
    awake: (map) => withoutSwap(map, app, waker),
    // The hold first: on a swapped map that lost both, it is what names the application where the waker's route must go.
    route: (map) => inOneUpdate(map, [(m) => withHoldRoute(m, app, waker), (m) => withWakerRoute(m, app, waker, { headers })]),
  };
}
