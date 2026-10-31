// How a workload's load balancer sends visitors to the waker, and back (vision docs/specs/2026-10-30-google-cloud-coverage-design.md,
// section 7): the policy of a global one (G1) or the swap of a regional or classic one, which have no custom error response.
//
// switchOf(cfg, { urlmaps, regionalUrlmaps, project, region }): `{ kind: 'policy' | 'swap', urlmaps (the adapter of its scope), waker
// (the waker's URL of its kind), asleep(map), awake(map), route(map), waitMs }`, the three functions as urlmaps.mjs's, returning
// `{ map, paths }`. `route` is what stays for good: the waker's route and, under a swap, the hold route. `waitMs`: a change reaching
// the load balancer, and the application's drain at a nap.
import { withErrorPolicy, withHoldRoute, withoutErrorPolicy, withoutSwap, withSwap, withWakerRoute } from './urlmaps.mjs';

const COMPUTE = 'https://compute.googleapis.com/compute/v1';
// The nap's policy reaching the load balancer (G0: 163 to 215 s), which is also the application's drain.
const POLICY_WAIT_MS = 300_000;
// SWAP_WAIT, by the load balancer's kind: a map's change reaching the load balancer. Regional: G0's worst 89 s, M3 35 s;
// classic: M2's worst 226 s and 10 %.
export const SWAP_WAIT_MS = { regional: 100_000, classic: 250_000 };

// The map's changes as one: `{ map, paths }`, each step on the map of the one before.
export const inOneUpdate = (map, steps) => steps.reduce(({ map: on, paths }, step) => {
  const done = step(on);
  return { map: done.map, paths: [...paths, ...done.paths] };
}, { map, paths: [] });

export function switchOf({ backendService: app, wakerBackendService: name, lb }, { urlmaps, regionalUrlmaps, project, region }) {
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
  const regional = kind === 'regional';
  // The regional adapter is the router's region's: anything else would read and write another map, or none.
  if (regional && lb.region !== region) throw new Error(`a regional load balancer of ${lb.region} on the router of ${region}`);
  const waker = url(regional ? `regions/${region}` : 'global');
  return {
    kind: 'swap',
    urlmaps: regional ? regionalUrlmaps : urlmaps,
    waker,
    waitMs: SWAP_WAIT_MS[kind],
    asleep: (map) => withSwap(map, app, waker),
    awake: (map) => withoutSwap(map, app, waker),
    // The hold first: on a swapped map that lost both, it is what names the application where the waker's route must go.
    route: (map) => inOneUpdate(map, [(m) => withHoldRoute(m, app, waker), (m) => withWakerRoute(m, app, waker)]),
  };
}
