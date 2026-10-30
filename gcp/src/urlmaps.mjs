// URL maps (vision docs/specs/2026-10-29-google-cloud-design.md, section 2 and ruling 25 to 27 of the plan): the pure
// functions that add and remove what Dormeto writes in a map, and the adapter that reads and updates it.
//
// What Dormeto writes, and nothing else:
// - at the nap, an error response policy (`defaultCustomErrorResponsePolicy`) on the map and on each path matcher that
//   names the application's backend service: the load balancer's 502 and 503 are served by the workload's waker
//   backend service, from `/_dormeto/waiting`, as a 503. Removed at the wake;
// - for good, the route `/_dormeto/*` to the waker backend service, in each of those matchers (a path rule, or a route
//   rule where the matcher uses route rules); the map's default alone gets a host rule `*` and a matcher
//   `dormeto-default` to hold it.
// A customer's own policy or `/_dormeto/` route is refused (UrlMapRefused), never overwritten.
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
const DEFAULT_MATCHER = 'dormeto-default';
const RETRIES = 3;
const WAIT_MS = 120_000;

const nameOf = (url) => (typeof url === 'string' ? url.slice(url.lastIndexOf('/') + 1) : null);

// Every place a holder (the map, a matcher, a rule) names a backend service: its service, its weighted services.
const namesOf = (holder, serviceKey, actionKey) => [
  holder[serviceKey],
  ...(holder[actionKey]?.weightedBackendServices ?? []).map((w) => w.backendService),
].map(nameOf);

const holds = (holder, serviceKey, actionKey, service) => namesOf(holder, serviceKey, actionKey).includes(service);
const matcherHolds = (matcher, service) => holds(matcher, 'defaultService', 'defaultRouteAction', service)
  || (matcher.pathRules ?? []).some((r) => holds(r, 'service', 'routeAction', service))
  || (matcher.routeRules ?? []).some((r) => holds(r, 'service', 'routeAction', service));

// The matchers naming the service, with their index; `named` is whether the map's own default names it.
function holders(map, service) {
  const matchers = (map.pathMatchers ?? []).flatMap((matcher, i) => (matcherHolds(matcher, service) ? [{ matcher, i }] : []));
  return { named: holds(map, 'defaultService', 'defaultRouteAction', service), matchers };
}

// Where the error policy goes: the map's default when it names the service, then each matcher naming it.
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
  const { named, matchers } = holders(copy, service);
  if (named) put(copy, POLICY);
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

function checkNoOwnRoute(matcher, path, waker) {
  (matcher.pathRules ?? []).forEach((rule, j) => {
    if ((rule.paths ?? []).some(inNamespace) && !pathRuleOurs(rule, waker)) {
      throw new UrlMapRefused(`the URL map has its own /_dormeto/ route at ${path}.pathRules[${j}]`);
    }
  });
  (matcher.routeRules ?? []).forEach((rule, j) => {
    if ((rule.matchRules ?? []).some((m) => [m.prefixMatch, m.fullPathMatch].some(inNamespace)) && !routeRuleOurs(rule, waker)) {
      throw new UrlMapRefused(`the URL map has its own /_dormeto/ route at ${path}.routeRules[${j}]`);
    }
  });
}

// The route in one matcher: a route rule where the matcher uses route rules (priority 0 must be free: nothing
// can come before it), else a path rule. Returns where it wrote, or null if it was there already.
function addRoute(matcher, path, waker) {
  checkNoOwnRoute(matcher, path, waker);
  if ((matcher.routeRules ?? []).length > 0) {
    if (matcher.routeRules.some((r) => routeRuleOurs(r, waker))) return null;
    if (matcher.routeRules.some((r) => r.priority === 0)) {
      throw new UrlMapRefused(`the URL map uses priority 0 for a route rule at ${path}.routeRules: the /_dormeto/ route needs it`);
    }
    matcher.routeRules.push({ priority: 0, matchRules: [{ prefixMatch: ROUTE_PREFIX }], service: waker });
    return `${path}.routeRules`;
  }
  if ((matcher.pathRules ?? []).some((r) => pathRuleOurs(r, waker))) return null;
  matcher.pathRules = [...(matcher.pathRules ?? []), { paths: [ROUTE_PATH], service: waker }];
  return `${path}.pathRules`;
}

export function withWakerRoute(map, service, waker) {
  const copy = structuredClone(map);
  const paths = [];
  const { named, matchers } = holders(copy, service);
  for (const { matcher, i } of matchers) {
    const written = addRoute(matcher, `pathMatchers[${i}]`, waker);
    if (written) paths.push(written);
  }
  // The map's default has no matcher to hold the route: a host rule `*` sends it to one (ruling 25), unless there is
  // one already, which means the default is unreachable.
  const hostRules = copy.hostRules ?? [];
  const reachable = !hostRules.some((h) => (h.hosts ?? []).includes('*'));
  if (named && reachable) {
    if ((copy.pathMatchers ?? []).some((m) => m.name === DEFAULT_MATCHER)) {
      throw new UrlMapRefused(`the URL map has its own path matcher ${DEFAULT_MATCHER}`);
    }
    const held = { name: DEFAULT_MATCHER };
    if (copy.defaultService !== undefined) held.defaultService = copy.defaultService;
    if (copy.defaultRouteAction !== undefined) held.defaultRouteAction = copy.defaultRouteAction;
    copy.pathMatchers = [...(copy.pathMatchers ?? []), held];
    copy.hostRules = [...hostRules, { hosts: ['*'], pathMatcher: DEFAULT_MATCHER }];
    paths.push(`pathMatchers[${copy.pathMatchers.length - 1}]`);
    addRoute(held, `pathMatchers[${copy.pathMatchers.length - 1}]`, waker);
  }
  return { map: copy, paths };
}

export function withoutWakerRoute(map, waker) {
  const copy = structuredClone(map);
  const paths = [];
  const kept = [];
  let held = false;
  (copy.pathMatchers ?? []).forEach((matcher, i) => {
    // Another workload's, when it is that workload's service in the map's default.
    if (matcher.name === DEFAULT_MATCHER && (matcher.pathRules ?? []).some((r) => pathRuleOurs(r, waker))) {
      held = true;
      paths.push(`pathMatchers[${i}]`);
      return;
    }
    for (const [kind, ours] of [['pathRules', pathRuleOurs], ['routeRules', routeRuleOurs]]) {
      if (!matcher[kind]?.some((r) => ours(r, waker))) continue;
      matcher[kind] = matcher[kind].filter((r) => !ours(r, waker));
      if (matcher[kind].length === 0) delete matcher[kind];
      paths.push(`pathMatchers[${i}].${kind}`);
    }
    kept.push(matcher);
  });
  if (copy.pathMatchers) {
    copy.pathMatchers = kept;
    if (kept.length === 0) delete copy.pathMatchers;
    if (held && copy.hostRules) {
      copy.hostRules = copy.hostRules.filter((h) => h.pathMatcher !== DEFAULT_MATCHER);
      if (copy.hostRules.length === 0) delete copy.hostRules;
    }
  }
  return { map: copy, paths };
}

export const CALLS = {
  get: ['compute.urlMaps.get'],
  list: ['compute.urlMaps.list'],
  modify: ['compute.urlMaps.get', 'compute.urlMaps.update', 'compute.backendServices.use', 'compute.globalOperations.get'],
};

export function createUrlMaps({ google, project, now = Date.now }) {
  const maps = `${COMPUTE}/projects/${project}/global/urlMaps`;
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
  // changes nothing if `change` wrote nothing. A 412 (another change got there first) reads the map again and applies
  // the change to it, three times at most.
  async function modify(name, change) {
    for (let retry = 0; ; retry += 1) {
      const result = change(await get(name));
      if (result.paths.length === 0) return result;
      try {
        await google.waitCompute(await google.request('PUT', url(name), result.map), now() + WAIT_MS);
        return result;
      } catch (e) {
        if (e.code !== 412 || retry >= RETRIES) throw e;
      }
    }
  }

  return { get, list, modify };
}
