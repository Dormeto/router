// URL maps (vision docs/specs/2026-10-29-google-cloud-design.md, section 2 and ruling 25 to 27 of the plan): the pure
// functions that add and remove what Dormeto writes in a map, and the adapter that reads and updates it.
//
// What Dormeto writes:
// - at the nap, an error response policy (`defaultCustomErrorResponsePolicy`) on each path matcher that names the
//   application's backend service: the load balancer's 502 and 503 are served by the workload's waker backend service,
//   from `/_dormeto/waiting`, as a 503. Removed at the wake. Never on the map itself, which would cover the whole load
//   balancer: the map's default reaches the service through the matcher below, or not at all;
// - for good, the route `/_dormeto/*` to the waker backend service, in each of those matchers (a path rule, or a route
//   rule where the matcher uses route rules); the map's default alone gets a host rule `*` and a matcher
//   `dormeto-default` to hold it.
// - for the regional and classic load balancers, which have no such policy, the swap (below) and, for good, the hold route
//   `/_dormeto/backend/*` to the application's service.
// A customer's own policy on such a matcher or `/_dormeto/` route is refused (UrlMapRefused), never overwritten.
//
// The functions take a map as Google returns it and return a copy: `{ map, paths }`, `paths` being what was written
// (removed): the policy's or the rules' place, as `pathMatchers[1].pathRules`. The backend services are matched by
// their name, the last segment of their URL, so v1, beta and relative URLs alike.

export class UrlMapRefused extends Error {
  constructor(message) {
    super(message);
    this.name = 'UrlMapRefused';
  }
}

const COMPUTE = 'https://compute.googleapis.com/compute/v1';
const POLICY = 'defaultCustomErrorResponsePolicy';
const WAITING_PATH = '/_dormeto/waiting';
const ROUTE_PATH = '/_dormeto/*';
const ROUTE_PREFIX = '/_dormeto/';
const ROUTE_NAMESPACE = '/_dormeto';
const HOLD_PATH = '/_dormeto/backend/*';
const HOLD_PREFIX = '/_dormeto/backend/';
const DEFAULT_MATCHER = 'dormeto-default';
// Between two tries of an update refused because of another one, which takes 14 to 25 s on a global map (G0): about 60 s in all.
const PAUSES_MS = [5000, 10_000, 15_000, 30_000];
// A regional map's update takes up to 85 s (M3): about 120 s of pauses in all, for two workloads writing one map.
const PAUSES_REGIONAL_MS = [5000, 10_000, 15_000, 30_000, 30_000, 30_000];
// Above M3's longest update, a regional map's 85 s (a global one's takes 14 to 25 s).
const WAIT_MS = 120_000;

// Another update got there first (412: the fingerprint), or is under way: at the request, or as its operation ended.
const NOT_READY = new Set(['resourceNotReady', 'RESOURCE_NOT_READY']);
export const mapBusy = (err) => err?.code === 412 || NOT_READY.has(err?.reason);

const nameOf = (url) => (typeof url === 'string' ? url.slice(url.lastIndexOf('/') + 1) : null);

// Every place a holder (the map, a matcher, a rule) names a backend service: its service, its weighted services.
const refsOf = (holder, serviceKey, actionKey) => [
  holder[serviceKey],
  ...(holder[actionKey]?.weightedBackendServices ?? []).map((w) => w.backendService),
];

const holds = (holder, serviceKey, actionKey, service) => refsOf(holder, serviceKey, actionKey).map(nameOf).includes(service);
const matcherHolds = (matcher, service) => holds(matcher, 'defaultService', 'defaultRouteAction', service)
  || (matcher.pathRules ?? []).some((r) => holds(r, 'service', 'routeAction', service))
  || (matcher.routeRules ?? []).some((r) => holds(r, 'service', 'routeAction', service));

// The matchers naming the service, with their index; `named` is whether the map's own default names it.
function holders(map, service) {
  const matchers = (map.pathMatchers ?? []).flatMap((matcher, i) => (matcherHolds(matcher, service) ? [{ matcher, i }] : []));
  return { named: holds(map, 'defaultService', 'defaultRouteAction', service), matchers };
}

// Where the map names the service, as the place of a policy there: the map's default, then each matcher naming it.
export function references(map, service) {
  const { named, matchers } = holders(map, service);
  return [...(named ? [POLICY] : []), ...matchers.map(({ i }) => `pathMatchers[${i}].${POLICY}`)];
}

// The hosts that reach the service: those of the matchers naming it, and `*` for the map's default when it is reachable.
export function hostsOf(map, service) {
  const { named, matchers } = holders(map, service);
  const names = new Set(matchers.map(({ matcher }) => matcher.name));
  const hostRules = map.hostRules ?? [];
  const hosts = hostRules.filter((h) => names.has(h.pathMatcher)).flatMap((h) => h.hosts ?? []);
  return named && !hostRules.some((h) => (h.hosts ?? []).includes('*')) ? [...hosts, '*'] : hosts;
}

const isOurs = (policy, waker) => nameOf(policy?.errorService) === nameOf(waker);

// Whether a matcher names the service: what the policy needs. The map's default gets one from withWakerRoute.
export const inMatcher = (map, service) => holders(map, service).matchers.length > 0;

// `paths` empty: the policy is there already. Nothing to hold it is a refusal: it would catch no request of the service.
export function withErrorPolicy(map, service, waker) {
  const copy = structuredClone(map);
  const paths = [];
  const policy = {
    errorResponseRules: [{ matchResponseCodes: ['502', '503'], path: WAITING_PATH, overrideResponseCode: 503 }],
    errorService: waker,
  };
  const put = (holder, path) => {
    if (holder[POLICY] !== undefined) {
      if (!isOurs(holder[POLICY], waker)) throw new UrlMapRefused(`the URL map has its own error response policy at ${path}`);
      return;
    }
    holder[POLICY] = policy;
    paths.push(path);
  };
  const { matchers } = holders(copy, service);
  if (!matchers.length) throw new UrlMapRefused(`backend service ${service} is named by no path matcher of URL map ${map.name}`);
  for (const { matcher, i } of matchers) {
    for (const [kind, rules] of [['pathRules', matcher.pathRules], ['routeRules', matcher.routeRules]]) {
      (rules ?? []).forEach((rule, j) => {
        if (rule.customErrorResponsePolicy !== undefined && holds(rule, 'service', 'routeAction', service)) {
          throw new UrlMapRefused(`the URL map has its own error response policy at pathMatchers[${i}].${kind}[${j}].customErrorResponsePolicy`);
        }
      });
    }
    put(matcher, `pathMatchers[${i}].${POLICY}`);
  }
  return { map: copy, paths };
}

export function withoutErrorPolicy(map, waker) {
  const copy = structuredClone(map);
  const paths = [];
  const drop = (holder, path) => {
    if (!isOurs(holder[POLICY], waker)) return;
    delete holder[POLICY];
    paths.push(path);
  };
  drop(copy, POLICY);
  (copy.pathMatchers ?? []).forEach((matcher, i) => drop(matcher, `pathMatchers[${i}].${POLICY}`));
  return { map: copy, paths };
}

const inNamespace = (path) => typeof path === 'string' && path.startsWith(ROUTE_NAMESPACE);
const pathRuleOurs = (rule, waker) => nameOf(rule.service) === nameOf(waker) && rule.paths?.includes(ROUTE_PATH);
const routeRuleOurs = (rule, waker) => nameOf(rule.service) === nameOf(waker)
  && (rule.matchRules ?? []).some((m) => m.prefixMatch === ROUTE_PREFIX);
// The hold route is Dormeto's when it is that alone, to the application: one path, or one match rule with the prefix and
// nothing else. A rule that merely contains it is the customer's (checkNoOwnRoute refuses it).
const holdPathRule = (rule, app) => nameOf(rule.service) === nameOf(app) && rule.paths?.length === 1 && rule.paths[0] === HOLD_PATH;
const holdRouteRule = (rule, app) => nameOf(rule.service) === nameOf(app) && (rule.matchRules ?? []).length === 1
  && Object.keys(rule.matchRules[0]).join() === 'prefixMatch' && rule.matchRules[0].prefixMatch === HOLD_PREFIX;

// The functions of the routes, the hold and the swap are given the application and the waker, or they refuse to guess: a missing
// waker would match every holder without a service.
function needWaker(waker) {
  if (typeof waker !== 'string' || !waker) throw new Error('URL map: the waker\'s backend service is required');
}
function need(app, waker) {
  if (typeof app !== 'string' || !app) throw new Error('URL map: the application\'s backend service is required');
  needWaker(waker);
}

// `waker` and `app`: what is Dormeto's is the /_dormeto/* route (to the waker) and the hold route (to the application).
function checkNoOwnRoute(matcher, path, waker, app) {
  (matcher.pathRules ?? []).forEach((rule, j) => {
    if ((rule.paths ?? []).some(inNamespace) && !pathRuleOurs(rule, waker) && !holdPathRule(rule, app)) {
      throw new UrlMapRefused(`the URL map has its own /_dormeto/ route at ${path}.pathRules[${j}]`);
    }
  });
  (matcher.routeRules ?? []).forEach((rule, j) => {
    if ((rule.matchRules ?? []).some((m) => [m.prefixMatch, m.fullPathMatch].some(inNamespace)) && !routeRuleOurs(rule, waker) && !holdRouteRule(rule, app)) {
      throw new UrlMapRefused(`the URL map has its own /_dormeto/ route at ${path}.routeRules[${j}]`);
    }
  });
}

// The route in one matcher: a route rule where the matcher uses route rules, else a path rule. Returns where it wrote, or
// null if it was there already. A route rule takes priority 0, as nothing can come before it, or 1 when the hold route
// has 0: a prefix `/_dormeto/` would win over `/_dormeto/backend/`. The priority must be free.
function addRoute(matcher, path, waker, app) {
  checkNoOwnRoute(matcher, path, waker, app);
  if ((matcher.routeRules ?? []).length > 0) {
    if (matcher.routeRules.some((r) => routeRuleOurs(r, waker))) return null;
    const priority = matcher.routeRules.some((r) => holdRouteRule(r, app)) ? 1 : 0;
    if (matcher.routeRules.some((r) => r.priority === priority)) {
      throw new UrlMapRefused(`the URL map uses priority ${priority} for a route rule at ${path}.routeRules: the /_dormeto/ route needs it`);
    }
    matcher.routeRules.push({ priority, matchRules: [{ prefixMatch: ROUTE_PREFIX }], service: waker });
    return `${path}.routeRules`;
  }
  if ((matcher.pathRules ?? []).some((r) => pathRuleOurs(r, waker))) return null;
  matcher.pathRules = [...(matcher.pathRules ?? []), { paths: [ROUTE_PATH], service: waker }];
  return `${path}.pathRules`;
}

// The map's default has no matcher to hold a route: a host rule `*` sends it to one (ruling 25), unless there is one
// already, which means the default is unreachable. `services`: the names the default may have (the application's, or the
// waker's under a swap). Returns the new matcher's path, or null.
function addDefaultMatcher(copy, services) {
  const hostRules = copy.hostRules ?? [];
  const named = services.some((service) => holds(copy, 'defaultService', 'defaultRouteAction', service));
  if (!named || hostRules.some((h) => (h.hosts ?? []).includes('*'))) return null;
  if ((copy.pathMatchers ?? []).some((m) => m.name === DEFAULT_MATCHER)) {
    throw new UrlMapRefused(`the URL map has its own path matcher ${DEFAULT_MATCHER}`);
  }
  const held = { name: DEFAULT_MATCHER };
  if (copy.defaultService !== undefined) held.defaultService = copy.defaultService;
  if (copy.defaultRouteAction !== undefined) held.defaultRouteAction = copy.defaultRouteAction;
  copy.pathMatchers = [...(copy.pathMatchers ?? []), held];
  copy.hostRules = [...hostRules, { hosts: ['*'], pathMatcher: DEFAULT_MATCHER }];
  return `pathMatchers[${copy.pathMatchers.length - 1}]`;
}

export function withWakerRoute(map, service, waker) {
  need(service, waker);
  const copy = structuredClone(map);
  const paths = [];
  const { matchers } = holders(copy, service);
  for (const { matcher, i } of matchers) {
    const written = addRoute(matcher, `pathMatchers[${i}]`, waker, service);
    if (written) paths.push(written);
  }
  const held = addDefaultMatcher(copy, [service]);
  if (held) {
    paths.push(held);
    addRoute(copy.pathMatchers.at(-1), held, waker, service);
  }
  return { map: copy, paths };
}

// The dormeto-default matcher is Dormeto's when its host rule is `*` alone, as addDefaultMatcher writes it.
const ownDefault = (copy) => (copy.hostRules ?? []).some((h) => h.pathMatcher === DEFAULT_MATCHER && h.hosts?.length === 1 && h.hosts[0] === '*');

// Removes from each matcher what `picks` (kind: 'pathRules' | 'routeRules' → test) picks. A dormeto-default matcher of
// Dormeto's left without rules goes with its host rule (another workload's, with none of ours in it, stays, and so does a
// customer's). Returns the places and, by index in the copy, the matchers that lost a rule.
function removeFromMatchers(copy, picks) {
  const paths = [];
  const touched = new Set();
  const kept = [];
  let dropped = false;
  (copy.pathMatchers ?? []).forEach((matcher, i) => {
    const mine = [];
    for (const [kind, ours] of Object.entries(picks)) {
      if (!matcher[kind]?.some(ours)) continue;
      matcher[kind] = matcher[kind].filter((r) => !ours(r));
      if (matcher[kind].length === 0) delete matcher[kind];
      mine.push(`pathMatchers[${i}].${kind}`);
    }
    if (mine.length === 0) {
      kept.push(matcher);
      return;
    }
    if (matcher.name === DEFAULT_MATCHER && !matcher.pathRules && !matcher.routeRules && ownDefault(copy)) {
      paths.push(`pathMatchers[${i}]`);
      dropped = true;
      return;
    }
    paths.push(...mine);
    touched.add(matcher);
    kept.push(matcher);
  });
  if (copy.pathMatchers) {
    copy.pathMatchers = kept;
    if (dropped) {
      if (kept.length === 0) delete copy.pathMatchers;
      copy.hostRules = copy.hostRules.filter((h) => h.pathMatcher !== DEFAULT_MATCHER);
      if (copy.hostRules.length === 0) delete copy.hostRules;
    }
  }
  return { paths, touched };
}

export function withoutWakerRoute(map, waker) {
  needWaker(waker);
  const copy = structuredClone(map);
  const { paths } = removeFromMatchers(copy, {
    pathRules: (r) => pathRuleOurs(r, waker),
    routeRules: (r) => routeRuleOurs(r, waker),
  });
  return { map: copy, paths };
}

// ---- The hold route (design section 7, M3) ----
// A backend service no forwarding rule reaches is not health checked, and the wake waits for health: `/_dormeto/backend/*`
// to the application's service, for good, keeps it in the map through a swap. A request there reaches the application, or
// Google's 503 while it sleeps. Where only the map's default names the application, it is in dormeto-default.

// How a holder names the service (its URL as the map writes it), else undefined.
const refIn = (holder, serviceKey, actionKey, service) => refsOf(holder, serviceKey, actionKey).find((u) => nameOf(u) === service);
const matcherRef = (matcher, service) => [
  refIn(matcher, 'defaultService', 'defaultRouteAction', service),
  ...(matcher.pathRules ?? []).map((r) => refIn(r, 'service', 'routeAction', service)),
  ...(matcher.routeRules ?? []).map((r) => refIn(r, 'service', 'routeAction', service)),
].find((u) => u !== undefined);

// Whether a matcher names the waker anywhere but in its /_dormeto/* route: under a swap, that is where the application was.
const matcherNamesWaker = (matcher, waker) => holds(matcher, 'defaultService', 'defaultRouteAction', nameOf(waker))
  || (matcher.pathRules ?? []).some((r) => !pathRuleOurs(r, waker) && holds(r, 'service', 'routeAction', nameOf(waker)))
  || (matcher.routeRules ?? []).some((r) => !routeRuleOurs(r, waker) && holds(r, 'service', 'routeAction', nameOf(waker)));

// The application's URL as the map writes it: from its own hold route, or from a reference, else the waker's prefix.
function appUrl(map, app, waker) {
  if (app.includes('/')) return app;
  for (const matcher of map.pathMatchers ?? []) {
    const found = [...(matcher.pathRules ?? []).filter((r) => holdPathRule(r, app)), ...(matcher.routeRules ?? []).filter((r) => holdRouteRule(r, app))][0]
      ?? matcherRef(matcher, app);
    if (found) return typeof found === 'string' ? found : found.service;
  }
  return `${waker.slice(0, waker.lastIndexOf('/') + 1)}${app}`;
}

// In one matcher: where it wrote, or null if the hold was there already. With route rules, priority 0 must be free (or
// the waker's route is there, which moves to 1), and 1 must be free for the waker's route.
function addHold(matcher, path, app, waker, ref) {
  checkNoOwnRoute(matcher, path, waker, app);
  if ((matcher.routeRules ?? []).length > 0) {
    const rules = matcher.routeRules;
    if (rules.some((r) => holdRouteRule(r, app))) return null;
    const at0 = rules.find((r) => r.priority === 0);
    const at1 = rules.find((r) => r.priority === 1);
    if (at0 && !routeRuleOurs(at0, waker)) throw new UrlMapRefused(`the URL map uses priority 0 for a route rule at ${path}.routeRules: the /_dormeto/backend/ route needs it`);
    if (at1 && !routeRuleOurs(at1, waker)) throw new UrlMapRefused(`the URL map uses priority 1 for a route rule at ${path}.routeRules: the /_dormeto/ route needs it`);
    if (at0) at0.priority = 1;
    rules.push({ priority: 0, matchRules: [{ prefixMatch: HOLD_PREFIX }], service: ref });
    return `${path}.routeRules`;
  }
  if ((matcher.pathRules ?? []).some((r) => holdPathRule(r, app))) return null;
  matcher.pathRules = [...(matcher.pathRules ?? []), { paths: [HOLD_PATH], service: ref }];
  return `${path}.pathRules`;
}

// In each matcher naming the application, or the waker beyond its route (a swapped map).
export function withHoldRoute(map, app, waker) {
  need(app, waker);
  const copy = structuredClone(map);
  const name = nameOf(app);
  const ref = appUrl(copy, app, waker);
  const paths = [];
  (copy.pathMatchers ?? []).forEach((matcher, i) => {
    if (!matcherHolds(matcher, name) && !matcherNamesWaker(matcher, waker)) return;
    const written = addHold(matcher, `pathMatchers[${i}]`, name, waker, ref);
    if (written) paths.push(written);
  });
  const held = addDefaultMatcher(copy, [name, nameOf(waker)]);
  if (held) {
    paths.push(held);
    addHold(copy.pathMatchers.at(-1), held, name, waker, ref);
  }
  return { map: copy, paths };
}

export function withoutHoldRoute(map, app, waker) {
  need(app, waker);
  const copy = structuredClone(map);
  const name = nameOf(app);
  const { paths, touched } = removeFromMatchers(copy, {
    pathRules: (r) => holdPathRule(r, name),
    routeRules: (r) => holdRouteRule(r, name),
  });
  // The waker's route, no longer under the hold, goes back to priority 0.
  for (const matcher of touched) {
    const rules = matcher.routeRules ?? [];
    const route = rules.find((r) => r.priority === 1 && routeRuleOurs(r, waker));
    if (route && !rules.some((r) => r.priority === 0)) route.priority = 0;
  }
  return { map: copy, paths };
}

// ---- The swap (design section 7): regional and classic load balancers have no custom error response ----
// The application's references become the waker's, at the nap, and back at the wake. Nothing is recorded: the waker backend
// service is the workload's alone, so what names it outside the /_dormeto/* route was the application. The application's
// URL, back, is the one its hold route kept in the map (else the waker's prefix: both are in one scope, regional or global).

// Every holder of a service and of route actions in the map: map, matchers, rules. `at(key)` is the place of one of its keys,
// `kind` the rules' ('pathRules' | 'routeRules').
function placesOf(map) {
  const at = (prefix, key) => (prefix ? `${prefix}.${key}` : key);
  const places = [{ holder: map, serviceKey: 'defaultService', actionKey: 'defaultRouteAction', path: '' }];
  (map.pathMatchers ?? []).forEach((matcher, i) => {
    const mp = `pathMatchers[${i}]`;
    places.push({ holder: matcher, serviceKey: 'defaultService', actionKey: 'defaultRouteAction', path: mp });
    for (const kind of ['pathRules', 'routeRules']) {
      (matcher[kind] ?? []).forEach((rule, j) => {
        places.push({ holder: rule, serviceKey: 'service', actionKey: 'routeAction', path: `${mp}.${kind}[${j}]`, kind });
      });
    }
  });
  return places.map((p) => ({ ...p, at: (key) => at(p.path, key) }));
}

function checkSwappable(map, name) {
  if ((map.tests ?? []).some((t) => nameOf(t.service) === name)) {
    throw new UrlMapRefused(`the URL map ${map.name} has tests naming backend service ${name}: a swap would fail them`);
  }
  for (const { holder, actionKey, at } of placesOf(map)) {
    const action = holder[actionKey];
    if (nameOf(action?.requestMirrorPolicy?.backendService) === name) {
      throw new UrlMapRefused(`the URL map ${map.name} mirrors requests to backend service ${name} at ${at(actionKey)}: a swap would leave the mirror`);
    }
    const weighted = (action?.weightedBackendServices ?? []).map((w) => nameOf(w.backendService));
    if (weighted.includes(name) && weighted.some((n) => n !== name)) {
      throw new UrlMapRefused(`the URL map ${map.name} has weights naming backend service ${name} beside another service at ${at(actionKey)}: a swap would change their shares`);
    }
  }
}

// `from` (a name) becomes `to` (a URL) where `skip(place)` is false.
function replaceService(map, from, to, skip) {
  const copy = structuredClone(map);
  const paths = [];
  for (const place of placesOf(copy)) {
    if (skip(place)) continue;
    const { holder, serviceKey, actionKey, at } = place;
    if (nameOf(holder[serviceKey]) === from) {
      holder[serviceKey] = to;
      paths.push(at(serviceKey));
    }
    const weighted = holder[actionKey]?.weightedBackendServices ?? [];
    if (weighted.some((w) => nameOf(w.backendService) === from)) {
      for (const w of weighted) if (nameOf(w.backendService) === from) w.backendService = to;
      paths.push(at(actionKey));
    }
  }
  return { map: copy, paths };
}

export function withSwap(map, app, waker) {
  need(app, waker);
  const name = nameOf(app);
  checkSwappable(map, name);
  return replaceService(map, name, waker, ({ holder, kind }) => (kind === 'pathRules' && holdPathRule(holder, name))
    || (kind === 'routeRules' && holdRouteRule(holder, name)));
}

export function withoutSwap(map, app, waker) {
  need(app, waker);
  return replaceService(map, nameOf(waker), appUrl(map, app, waker), ({ holder, kind }) => (kind === 'pathRules' && pathRuleOurs(holder, waker))
    || (kind === 'routeRules' && routeRuleOurs(holder, waker)));
}

export const CALLS = {
  get: ['compute.urlMaps.get'],
  list: ['compute.urlMaps.list'],
  modify: ['compute.urlMaps.get', 'compute.urlMaps.update', 'compute.backendServices.use', 'compute.globalOperations.get'],
};

export const CALLS_REGIONAL = {
  get: ['compute.regionUrlMaps.get'],
  list: ['compute.regionUrlMaps.list'],
  modify: ['compute.regionUrlMaps.get', 'compute.regionUrlMaps.update', 'compute.regionBackendServices.use', 'compute.regionOperations.get'],
};

const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// `scope` omitted is global. A regional map is `regions/<region>/urlMaps`, and its update's operation a regional one, which
// `waitCompute` follows by the operation's own URL.
export function createUrlMaps({ google, project, region, scope = 'global', now = Date.now, sleep = pause }) {
  if (scope !== 'global' && scope !== 'regional') throw new Error(`URL maps: scope ${scope} is neither global nor regional`);
  if (scope === 'regional' && !region) throw new Error('URL maps: a regional scope needs a region');
  const maps = `${COMPUTE}/projects/${project}/${scope === 'regional' ? `regions/${region}` : 'global'}/urlMaps`;
  const url = (name) => `${maps}/${name}`;
  const get = (name) => google.request('GET', url(name));

  async function list() {
    const items = [];
    let page = '';
    do {
      const answer = await google.request('GET', page ? `${maps}?pageToken=${encodeURIComponent(page)}` : maps);
      items.push(...(answer.items ?? []));
      page = answer.nextPageToken ?? '';
    } while (page);
    return items;
  }

  // Reads the map, applies `change(map)` (one of the functions above), and updates it with the map's fingerprint;
  // changes nothing if `change` wrote nothing. Refused for another update (mapBusy): a pause, then the map read again and
  // the change applied to it, up to about 60 s.
  async function modify(name, change) {
    for (const wait of [...(scope === 'regional' ? PAUSES_REGIONAL_MS : PAUSES_MS), null]) {
      const result = change(await get(name));
      if (result.paths.length === 0) return result;
      try {
        await google.waitCompute(await google.request('PUT', url(name), result.map), now() + WAIT_MS);
        return result;
      } catch (e) {
        if (!mapBusy(e) || wait === null) throw e;
      }
      await sleep(wait);
    }
  }

  return { get, list, modify };
}
