// The pure parts of G0's measuring tool (measure.mjs; vision docs/specs/2026-10-29-google-cloud-design.md, section 12):
// the arguments, the timeline's lines, the load balancer's answers and their summary, the health and status
// transitions, the URL map's switch (plain, weighted or with the hold route), the token cache and Cloud Monitoring's points. No I/O here:
// measure.mjs calls Google and the load balancer.
import { parseArgs as parse } from 'node:util';

export class UsageError extends Error {}

export const USAGE = `Usage: node gcp/tools/measure.mjs <command> [options]

  switch --from <service> --to <service>   switch a URL map from one backend service to another, then probe the
                                            load balancer and read both services' health
         [--url-map dmt-dev] [--url https://gcp.dev.dormeto.com/] [--region <region>] [--baseline 5]
         [--weighted] (--to at weight 1000 and --from at 0 in a weighted route, instead of --to as the default
         service; without it, a weighted route is cleared)
         [--hold] [--instance dmt-demo] [--zone europe-west1-b] (M3: a path rule /_dormeto/backend/* to --from written
         beside the plain swap; once settled, the VM stopped and started under both services' getHealth, then the map
         restored to what it was)
         [--suspend] (with --hold: the VM suspended and resumed instead)
  health                                    a backend service's health every 2 s, each change printed
         [--backend-service dmt-demo-app] [--region <region>] [--for 120] (seconds)
  vm stop|start|suspend|resume              the demo VM, through Compute Engine
         [--instance dmt-demo] [--group dmt-demo] [--zone europe-west1-b]
         [--backend-service dmt-demo-app] [--region <region>] [--url https://gcp.dev.dormeto.com/]
  mig stop|start|suspend|resume             the managed group's VMs, through the group (its autoscaler off, back on)
         [--group dmt-demo-mig] [--autoscaler dmt-demo-mig] [--autoscaler-mode ON] [--zone europe-west1-b]
         [--backend-service dmt-demo-mig-app] [--region <region>] [--url https://mig.gcp.dev.dormeto.com/]
  neg stop|start|suspend|resume --url <address of the NEG's load balancer>
                                            the VM of the zonal NEG, through Compute Engine: the NEG's endpoints,
                                            the backend service's health, the answers
         [--instance dmt-demo-neg] [--group dmt-demo-neg] [--backend-service dmt-demo-neg] [--zone europe-west1-b]
  sql stop|start                            the Cloud SQL instance, by its activation policy (NEVER | ALWAYS), until
         [--instance dmt-demo-sql]          the PATCH's operation is done: state, policy and operation read every 10 s
  gke scale --replicas <n> --url <address of the GKE load balancer>
                                            the Deployment's scale through the cluster's DNS endpoint, with the
                                            caller's token: the pods, the NEG's endpoints, the backend service's
                                            health, the answers
         [--cluster dmt-demo-gke] [--namespace default] [--deployment dmt-demo-gke] [--backend-service dmt-demo-gke]
         [--zone europe-west1-b]
  tag bind|unbind                           the tag dormeto=managed on a Cloud SQL instance, as the owner, at its region's
         [--instance dmt-demo-sql]          tag endpoint (M7); unbound before any uninstall, or the tag strands
  metric                                    send requests, then wait for Cloud Monitoring to count them: the URL
                                            map's series, over the points published before the requests
         [--url-map dmt-dev] [--url https://gcp.dev.dormeto.com/] [--count 20]
         [--metric loadbalancing.googleapis.com/https/request_count] [--filter <extra filter>]
         (--url-map as the metric labels it: a regional URL map's is URL_MAP/<project number>_<name>)

  Every command: [--project dormeto-dev] [--configuration dormeto-dev] (gcloud's); all but health:
  [--timeout <seconds>]; switch, vm, mig, neg, gke: [--settle 20] (answers in a row from the new backend). --region: a
  regional load balancer's URL map or backend service (none: global; a classic load balancer's is global too).`;

const ACTIONS = ['stop', 'start', 'suspend', 'resume'];
const AUTOSCALER_MODES = ['ON', 'OFF', 'ONLY_SCALE_OUT'];

const NAME = /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/;
// A regional URL map as Cloud Monitoring labels it (G0).
const URL_MAP_LABEL = /^URL_MAP\/[0-9]+_[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/;
const PROJECT = /^[a-z][-a-z0-9]{4,28}[a-z0-9]$/;
const REGION = /^[a-z]+-[a-z]+[0-9]+$/;
const ZONE = /^[a-z]+-[a-z]+[0-9]+-[a-z]$/;
const CONFIGURATION = /^[a-z][-a-z0-9]*$/;

// Each option: its flag, its kind, its default; per command, the options it takes.
const OPTIONS = {
  project: { flag: 'project', kind: 'project', default: 'dormeto-dev' },
  configuration: { flag: 'configuration', kind: 'configuration', default: 'dormeto-dev' },
  timeout: { flag: 'timeout', kind: 'positive' },
  settle: { flag: 'settle', kind: 'positive', default: 20 },
  region: { flag: 'region', kind: 'region', default: null },
  urlMap: { flag: 'url-map', kind: 'name', default: 'dmt-dev' },
  from: { flag: 'from', kind: 'name', required: true },
  to: { flag: 'to', kind: 'name', required: true },
  url: { flag: 'url', kind: 'url', default: 'https://gcp.dev.dormeto.com/' },
  baseline: { flag: 'baseline', kind: 'count', default: 5 },
  zone: { flag: 'zone', kind: 'zone', default: 'europe-west1-b' },
  instance: { flag: 'instance', kind: 'name', default: 'dmt-demo' },
  group: { flag: 'group', kind: 'name', default: 'dmt-demo' },
  backendService: { flag: 'backend-service', kind: 'name', default: 'dmt-demo-app' },
  autoscaler: { flag: 'autoscaler', kind: 'name', default: 'dmt-demo-mig' },
  autoscalerMode: { flag: 'autoscaler-mode', kind: 'autoscalerMode', default: 'ON' },
  count: { flag: 'count', kind: 'positive', default: 20 },
  metric: { flag: 'metric', kind: 'metric', default: 'loadbalancing.googleapis.com/https/request_count' },
  filter: { flag: 'filter', kind: 'text', default: null },
  weighted: { flag: 'weighted', kind: 'boolean', default: false },
  duration: { flag: 'for', kind: 'positive', default: 120 },
  hold: { flag: 'hold', kind: 'boolean', default: false },
  suspend: { flag: 'suspend', kind: 'boolean', default: false },
  replicas: { flag: 'replicas', kind: 'count', required: true },
  cluster: { flag: 'cluster', kind: 'name', default: 'dmt-demo-gke' },
  namespace: { flag: 'namespace', kind: 'name', default: 'default' },
  deployment: { flag: 'deployment', kind: 'name', default: 'dmt-demo-gke' },
};

const COMMANDS = {
  switch: { actions: null, timeout: 300, options: ['project', 'configuration', 'timeout', 'settle', 'region', 'urlMap', 'from', 'to', 'url', 'baseline', 'weighted', 'hold', 'suspend', 'instance', 'zone'] },
  vm: { actions: ACTIONS, timeout: 600, options: ['project', 'configuration', 'timeout', 'settle', 'region', 'zone', 'instance', 'group', 'backendService', 'url'] },
  mig: {
    actions: ACTIONS,
    timeout: 600,
    options: ['project', 'configuration', 'timeout', 'settle', 'region', 'zone', 'group', 'autoscaler', 'autoscalerMode', 'backendService', 'url'],
    defaults: { group: 'dmt-demo-mig', backendService: 'dmt-demo-mig-app', url: 'https://mig.gcp.dev.dormeto.com/' },
  },
  metric: { actions: null, timeout: 900, options: ['project', 'configuration', 'timeout', 'urlMap', 'url', 'count', 'metric', 'filter'], kinds: { urlMap: 'urlMapLabel' } },
  health: { actions: null, options: ['project', 'configuration', 'region', 'backendService', 'duration'] },
  // The NEG's VM and the GKE demo have no domain name: the address of their load balancer (the README reads it with gcloud).
  neg: {
    actions: ACTIONS,
    timeout: 600,
    options: ['project', 'configuration', 'timeout', 'settle', 'region', 'zone', 'instance', 'group', 'backendService', 'url'],
    defaults: { instance: 'dmt-demo-neg', group: 'dmt-demo-neg', backendService: 'dmt-demo-neg' },
    required: ['url'],
  },
  sql: { actions: ['stop', 'start'], timeout: 1800, options: ['project', 'configuration', 'timeout', 'instance'], defaults: { instance: 'dmt-demo-sql' } },
  tag: { actions: ['bind', 'unbind'], timeout: 120, options: ['project', 'configuration', 'timeout', 'instance'], defaults: { instance: 'dmt-demo-sql' } },
  gke: {
    actions: ['scale'],
    timeout: 900,
    options: ['project', 'configuration', 'timeout', 'settle', 'region', 'zone', 'cluster', 'namespace', 'deployment', 'replicas', 'backendService', 'url'],
    defaults: { backendService: 'dmt-demo-gke' },
    required: ['url'],
  },
};
const NAMES = Object.keys(COMMANDS).join(', ');

function value(key, kind, raw) {
  const fail = (what) => { throw new UsageError(`--${OPTIONS[key].flag}: ${what}, not ${JSON.stringify(raw)}`); };
  switch (kind) {
    case 'positive':
    case 'count': {
      if (!/^[0-9]+$/.test(raw)) fail('a whole number');
      const n = Number(raw);
      if (kind === 'positive' && n < 1) fail('at least 1');
      return n;
    }
    case 'url': {
      let url;
      try { url = new URL(raw); } catch { fail('a URL'); }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') fail('an http or https URL');
      return url.href;
    }
    case 'name': return NAME.test(raw) ? raw : fail('a Compute Engine name');
    case 'urlMapLabel': return NAME.test(raw) || URL_MAP_LABEL.test(raw) ? raw : fail('a URL map\'s name, or a regional one\'s label, URL_MAP/<project number>_<name>');
    case 'project': return PROJECT.test(raw) ? raw : fail('a project ID');
    case 'region': return REGION.test(raw) ? raw : fail('a region such as europe-west1');
    case 'zone': return ZONE.test(raw) ? raw : fail('a zone such as europe-west1-b');
    case 'configuration': return CONFIGURATION.test(raw) ? raw : fail('a gcloud configuration name');
    case 'autoscalerMode': return AUTOSCALER_MODES.includes(raw) ? raw : fail(AUTOSCALER_MODES.join(', '));
    case 'metric': return /^[a-z0-9.]+\/[a-z0-9_/]+$/.test(raw) ? raw : fail('a metric type');
    case 'boolean': return raw === true;
    default: return raw;
  }
}

// argv (without node and the script) → { command, action, options } or { help: true }; a UsageError otherwise.
export function parseArgs(argv) {
  if (argv.some((a) => a === '--help' || a === '-h') || argv[0] === 'help') return { help: true };
  const [command, ...rest] = argv;
  if (!command) throw new UsageError(`a command: ${NAMES}`);
  const spec = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : null;
  if (!spec) throw new UsageError(`unknown command ${JSON.stringify(command)}: ${NAMES}`);

  let action = null;
  let args = rest;
  if (spec.actions) {
    action = rest[0];
    if (!spec.actions.includes(action)) throw new UsageError(`${command}: an action, ${spec.actions.join(', ')}`);
    args = rest.slice(1);
  }

  const options = Object.fromEntries(spec.options.map((key) => [OPTIONS[key].flag, { type: OPTIONS[key].kind === 'boolean' ? 'boolean' : 'string' }]));
  let parsed;
  try {
    parsed = parse({ args, options, strict: true, allowPositionals: false });
  } catch (e) {
    throw new UsageError(`${command}: ${e.message}`);
  }

  const result = {};
  for (const key of spec.options) {
    const raw = parsed.values[OPTIONS[key].flag];
    if (raw === undefined) {
      if (OPTIONS[key].required || spec.required?.includes(key)) throw new UsageError(`${command}: --${OPTIONS[key].flag} is required`);
      result[key] = key === 'timeout' ? spec.timeout : (spec.defaults?.[key] ?? OPTIONS[key].default ?? null);
    } else {
      result[key] = value(key, spec.kinds?.[key] ?? OPTIONS[key].kind, raw);
    }
  }
  if (command === 'switch') {
    if (result.from === result.to) throw new UsageError('switch: --from and --to are the same backend service');
    if (result.hold && result.weighted) throw new UsageError('switch: --hold writes a plain swap, not --weighted');
    if (!result.hold && (parsed.values.instance !== undefined || parsed.values.zone !== undefined)) throw new UsageError('switch: --instance and --zone go with --hold');
    if (!result.hold && result.suspend) throw new UsageError('switch: --suspend goes with --hold');
  }
  return { command, action, options: result };
}

// One timeline line: the seconds since the start to one decimal, what, its value.
export const line = (ms, what, value) => `${(ms / 1000).toFixed(1)}s  ${what}  ${value}`;

// A duration relative to a reference: +6.7s, -0.3s.
export const delta = (ms) => `${ms < 0 ? '-' : '+'}${(Math.abs(ms) / 1000).toFixed(1)}s`;

// A load balancer's answer: the demo's app or stand-in page (instance, boot time), else its HTTP status.
export function pageOf(status, body) {
  // The GKE demo's pods run Google's hello-app, which says "Hello, world!" and its pod's name.
  if (status === 200 && body.includes('Hello, world!')) return { kind: 'app', instance: body.match(/Hostname: (\S+)/)?.[1] ?? null, boot: null };
  const kind = status !== 200 ? null
    : body.includes('Dormeto demo: stand-in') ? 'stand-in'
      : body.includes('Dormeto demo: app') ? 'app' : null;
  if (!kind) return { kind: `http ${status}`, instance: null, boot: null };
  return {
    kind,
    instance: body.match(/id="instance">([^<]*)</)?.[1] ?? null,
    boot: body.match(/id="boot">([^<]*)</)?.[1] ?? null,
  };
}

// The page a backend service of terraform/gcp-dev serves, by its named port: `app` (80) or `standin` (8080).
export const kindOfPort = (portName) => (portName === 'app' ? 'app' : portName === 'standin' ? 'stand-in' : null);

const matcher = (m) =>(typeof m === 'function' ? m : (kind) => kind === m);

// Answers [{ t, kind }] (t: when sent, ms) → the first answer from the new backend, the last from the old one, and
// when it settled: the first of `settle` new answers in a row after the last old one (an answer from neither breaks
// the run). `old` and `fresh` are kinds or predicates on a kind.
export function summarize(answers, { old, fresh, settle = 20 }) {
  const isOld = matcher(old);
  const isNew = matcher(fresh);
  const sorted = [...answers].sort((a, b) => a.t - b.t);
  const firstNew = sorted.find((a) => isNew(a.kind))?.t ?? null;
  const lastOldIndex = sorted.findLastIndex((a) => isOld(a.kind));
  const lastOld = lastOldIndex < 0 ? null : sorted[lastOldIndex].t;
  let settled = null;
  let run = 0;
  for (const a of sorted.slice(lastOldIndex + 1)) {
    run = isNew(a.kind) ? run + 1 : 0;
    if (run === 1) settled = a.t;
    if (run === settle) return { firstNew, lastOld, settled };
  }
  return { firstNew, lastOld, settled: null };
}

// Two { name: state } samples → what changed, by name: [{ name, from, to }] (null: absent).
export function changes(before, after) {
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return names
    .map((name) => ({ name, from: before[name] ?? null, to: after[name] ?? null }))
    .filter((c) => c.from !== c.to);
}

const lastSegment = (url) => url.slice(url.lastIndexOf('/') + 1);

// backendServices.getHealth's answer → { instance name: healthState }.
export function healthStates(response) {
  return Object.fromEntries((response.healthStatus ?? []).map((h) => [lastSegment(h.instance), h.healthState]));
}

// { instance: healthState } → the backend service's health: 'no status' (no instance has one: Google health checks
// only a backend service that a forwarding rule references through a URL map), 'healthy' (one instance at least),
// else 'unhealthy'.
export function healthLevel(states) {
  const values = Object.values(states);
  if (values.length === 0) return 'no status';
  return values.includes('HEALTHY') ? 'healthy' : 'unhealthy';
}

// Poller samples [{ t, states: { name: state } }] → each name's state in the last sample before `since`, and what
// changed from `since` on: { before: { name: state }, after: [{ t, name, from, to }] }.
export function changesSince(samples, since) {
  const sorted = [...samples].sort((a, b) => a.t - b.t);
  let previous = {};
  let before = {};
  const after = [];
  for (const { t, states } of sorted) {
    if (t < since) before = states;
    else after.push(...changes(previous, states).map((c) => ({ t, ...c })));
    previous = states;
  }
  return { before, after };
}

// Poller samples → one name's runs of one state: [{ state, from, to, samples }] (from, to: its first and last sample).
export function periods(samples, name) {
  const runs = [];
  for (const { t, states } of [...samples].sort((a, b) => a.t - b.t)) {
    const state = states[name] ?? null;
    const last = runs.at(-1);
    if (last && last.state === state) {
      last.to = t;
      last.samples += 1;
    } else {
      runs.push({ state, from: t, to: t, samples: 1 });
    }
  }
  return runs;
}

// instanceGroupManagers.listManagedInstances's answer → each instance's status and the group's current action on it.
export function managedStates(response) {
  const list = response.managedInstances ?? [];
  return {
    status: Object.fromEntries(list.map((m) => [lastSegment(m.instance), m.instanceStatus ?? null])),
    action: Object.fromEntries(list.map((m) => [lastSegment(m.instance), m.currentAction ?? null])),
  };
}

// The statuses an action applies to, and those that end it (a managed group's instance may say STOPPED).
const FROM = { stop: ['RUNNING'], suspend: ['RUNNING'], start: ['TERMINATED', 'STOPPED'], resume: ['SUSPENDED'] };
const FINAL = { stop: ['TERMINATED', 'STOPPED'], suspend: ['SUSPENDED'], start: ['RUNNING'], resume: ['RUNNING'] };
const WAKES = ['start', 'resume'];

// { name: status } → the names the action applies to, sorted.
export const targets = (action, states) => Object.keys(states).filter((name) => FROM[action].includes(states[name])).sort();

// An action's run → when every instance reached its final status, when one became healthy (a start or resume) or
// none was healthy any more (a stop or suspend), the answers' summary (new: the app's answers after a wake, any
// other after a nap), and whether all of them happened. Samples before the action (`since`) do not count.
// `anyInstance`: the health's states are read whatever they are keyed by, as a NEG's pods, which `names` does not name.
// `noneHealthyFrom`: no "none healthy" before that time, null for none yet (default: the action).
export function actionSummary(action, { since, names, settle = 20, statuses, health, answers, anyInstance = false, noneHealthyFrom = since }) {
  const wake = WAKES.includes(action);
  const after = (samples) => samples.filter((s) => s.t >= since).sort((a, b) => a.t - b.t);
  const reached = after(statuses).find((s) => names.every((n) => FINAL[action].includes(s.states[n])))?.t ?? null;
  const someHealthy = (s) => (anyInstance ? Object.values(s.states) : names.map((n) => s.states[n])).includes('HEALTHY');
  const noneHealthy = (s) => noneHealthyFrom !== null && s.t >= noneHealthyFrom && !someHealthy(s);
  const healthAt = after(health).find((s) => (wake ? someHealthy(s) : noneHealthy(s)))?.t ?? null;
  const isApp = (kind) => kind === 'app';
  const notApp = (kind) => kind !== 'app';
  const answered = summarize(answers, wake ? { old: notApp, fresh: isApp, settle } : { old: isApp, fresh: notApp, settle });
  const done = reached !== null && healthAt !== null && answered.settled !== null;
  return { reached, [wake ? 'healthy' : 'unhealthy']: healthAt, ...answered, done };
}

const WEIGHT = 1000;

// One holder of a backend service (the map, a path matcher, a path rule): its service key and its route action's.
// It serves `from` when it names it as its service, or gives it a weight above 0 (Google leaves a 0 out) in its
// weighted route. Plain: `to` as its service, the weighted route cleared (only one of the two can be set). Weighted:
// `to` at 1000 and `from` at 0, the service cleared.
function servedRef(holder, serviceKey, actionKey, from) {
  const plain = holder?.[serviceKey];
  return typeof plain === 'string' && lastSegment(plain) === from ? plain
    : (holder?.[actionKey]?.weightedBackendServices ?? [])
      .find((w) => typeof w.backendService === 'string' && lastSegment(w.backendService) === from && (w.weight ?? 0) > 0)
      ?.backendService;
}

function switchHolder(holder, serviceKey, actionKey, path, { from, to, weighted }, paths) {
  const action = holder?.[actionKey];
  const ref = servedRef(holder, serviceKey, actionKey, from);
  if (!ref) return;
  const toRef = `${ref.slice(0, ref.lastIndexOf('/') + 1)}${to}`;
  if (weighted) {
    delete holder[serviceKey];
    holder[actionKey] = { ...action, weightedBackendServices: [{ backendService: toRef, weight: WEIGHT }, { backendService: ref, weight: 0 }] };
    paths.push(`${path}${actionKey}.weightedBackendServices`);
    return;
  }
  holder[serviceKey] = toRef;
  if (action) {
    const { weightedBackendServices, ...rest } = action;
    if (Object.keys(rest).length > 0) holder[actionKey] = rest;
    else delete holder[actionKey];
  }
  paths.push(`${path}${serviceKey}`);
}

// A URL map → a copy where every holder serving the backend service `from` (by name: the map's default, the path
// matchers' defaults, their path rules) serves `to` instead, in the same scope: as its service, or with `weighted`
// in a weighted route (`to` 1000, `from` 0); and the paths written.
export function switchService(map, from, to, { weighted = false } = {}) {
  const copy = structuredClone(map);
  const paths = [];
  const options = { from, to, weighted };
  switchHolder(copy, 'defaultService', 'defaultRouteAction', '', options, paths);
  (copy.pathMatchers ?? []).forEach((pm, i) => {
    switchHolder(pm, 'defaultService', 'defaultRouteAction', `pathMatchers[${i}].`, options, paths);
    (pm.pathRules ?? []).forEach((rule, j) => switchHolder(rule, 'service', 'routeAction', `pathMatchers[${i}].pathRules[${j}].`, options, paths));
  });
  return { map: copy, paths };
}

// M3's hold route (spec 2026-10-30, section 7): a backend service no forwarding rule reaches is not health checked, so a path
// rule keeps the application's in the map through a swap. Ours for the time of `switch --hold`, which restores the map.
const HOLD_PATH = '/_dormeto/backend/*';
const HOLD_MATCHER = 'dormeto-hold';

const matcherRef = (matcher, from) => servedRef(matcher, 'defaultService', 'defaultRouteAction', from)
  ?? (matcher.pathRules ?? []).map((rule) => servedRef(rule, 'service', 'routeAction', from)).find(Boolean);

// Why withHold can't write on the map, else null.
export function holdProblem(map, from) {
  for (const [i, matcher] of (map.pathMatchers ?? []).entries()) {
    if (matcher.name === HOLD_MATCHER) return `the URL map ${map.name} already has a path matcher ${HOLD_MATCHER}: a run that did not restore it?`;
    if ((matcher.pathRules ?? []).some((rule) => rule.paths?.includes(HOLD_PATH))) return `the URL map ${map.name} already has ${HOLD_PATH} at pathMatchers[${i}]: a run that did not restore it?`;
    const routed = (matcher.routeRules ?? []).some((rule) => servedRef(rule, 'service', 'routeAction', from));
    if ((matcher.routeRules ?? []).length > 0 && (routed || matcherRef(matcher, from))) {
      return `the URL map ${map.name}'s pathMatchers[${i}] has route rules: --hold writes path rules only`;
    }
  }
  return null;
}

// switchService's plain swap, with the hold route beside it: a path rule to `from` in each matcher naming it, and for the
// map's default a host rule `*` and a matcher of its own (unless a host rule `*` leaves it unreachable). `holds`: where.
export function withHold(map, from, to) {
  const { map: copy, paths } = switchService(map, from, to);
  const holds = [];
  (map.pathMatchers ?? []).forEach((matcher, i) => {
    const ref = matcherRef(matcher, from);
    if (!ref) return;
    copy.pathMatchers[i].pathRules = [...(copy.pathMatchers[i].pathRules ?? []), { paths: [HOLD_PATH], service: ref }];
    holds.push(`pathMatchers[${i}].pathRules`);
  });
  const ref = servedRef(map, 'defaultService', 'defaultRouteAction', from);
  if (ref && !(map.hostRules ?? []).some((rule) => rule.hosts?.includes('*'))) {
    copy.pathMatchers = [...(copy.pathMatchers ?? []), {
      name: HOLD_MATCHER,
      defaultService: copy.defaultService,
      ...(copy.defaultRouteAction ? { defaultRouteAction: copy.defaultRouteAction } : {}),
      pathRules: [{ paths: [HOLD_PATH], service: ref }],
    }];
    copy.hostRules = [...(copy.hostRules ?? []), { hosts: ['*'], pathMatcher: HOLD_MATCHER }];
    holds.push(`pathMatchers[${copy.pathMatchers.length - 1}].pathRules`);
  }
  return { map: copy, paths, holds };
}

// A backend service's level in the health's samples: when it was first read as `level` from `since` on (null: not yet).
export const levelAt = (samples, name, since, level) => [...samples].sort((a, b) => a.t - b.t).find((s) => s.t >= since && s.states[name] === level)?.t ?? null;

// How many reads of each level, from `since` on.
export function levelCounts(samples, name, since) {
  const counts = { healthy: 0, unhealthy: 0, 'no status': 0 };
  for (const s of samples) if (s.t >= since && s.states[name] in counts) counts[s.states[name]] += 1;
  return counts;
}

// gcloud's access token. `gcloud auth print-access-token` refreshes only a token within 5 minutes of its expiry, so
// it may return one with 5 minutes left; config-helper's --min-expiry refreshes one with less than that left, and
// gives the expiry. After a 401, a forced refresh (the two flags exclude each other).
export const TOKEN_MIN_EXPIRY_MS = 20 * 60_000;
export const TOKEN_MARGIN_MS = 5 * 60_000;

export const tokenArgs = (configuration, { force = false } = {}) => [
  'config', 'config-helper', '--format=json',
  force ? '--force-auth-refresh' : `--min-expiry=${TOKEN_MIN_EXPIRY_MS / 60_000}m`,
  '--configuration', configuration,
];

// config-helper's JSON → { token, expiresAt (ms) }; without an expiry (some credential types), the minimum asked for.
export function credentialOf(out, { askedAt, minExpiryMs = TOKEN_MIN_EXPIRY_MS }) {
  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch {
    throw new Error(`gcloud config config-helper: not JSON: ${String(out).trim().slice(0, 200)}`);
  }
  const token = parsed?.credential?.access_token;
  if (typeof token !== 'string' || !token) throw new Error('gcloud returned no access token');
  const expiry = Date.parse(parsed.credential.token_expiry ?? '');
  return { token, expiresAt: Number.isFinite(expiry) ? expiry : askedAt + minExpiryMs };
}

// The access token, asked of gcloud once and again `marginMs` before it expires; concurrent requests share one call.
// `drop(token)` after a 401: the next request asks for a forced refresh, unless the token was replaced already.
// `run({ force })` returns config-helper's output.
export function createTokens({ run, now = Date.now, marginMs = TOKEN_MARGIN_MS, minExpiryMs = TOKEN_MIN_EXPIRY_MS }) {
  let pending = null;
  let current = null;
  let force = false;
  const ask = () => {
    const askedAt = now();
    const forced = force;
    force = false;
    current = null;
    const asked = Promise.resolve().then(() => run({ force: forced })).then((out) => {
      const { token, expiresAt } = credentialOf(out, { askedAt, minExpiryMs });
      if (pending === asked) current = { token, refreshAt: expiresAt - marginMs };
      return token;
    });
    asked.catch(() => { if (pending === asked) pending = null; });
    pending = asked;
    return asked;
  };
  return {
    get() {
      if (!pending || (current && now() >= current.refreshAt)) return ask();
      return pending;
    },
    drop(token) {
      if (current?.token !== token) return;
      pending = null;
      current = null;
      force = true;
    },
  };
}

// A request with the token; refused with a 401 (the token expired or was revoked), sent once more with a new one.
// `send(token)` returns the answer, with its `status`.
export async function withToken(tokens, send) {
  const token = await tokens.get();
  const answer = await send(token);
  if (answer.status !== 401) return answer;
  tokens.drop(token);
  return send(await tokens.get());
}

// Cloud Monitoring's timeSeries.list answer → one entry per point, with its series' labels.
export function pointsOf(response) {
  return (response.timeSeries ?? []).flatMap(({ metric, resource, points = [] }) => {
    const series = JSON.stringify({ metric, resource });
    return points.map(({ interval, value }) => ({
      series,
      key: `${series} ${interval.endTime}`,
      metric,
      resource,
      start: interval.startTime ?? interval.endTime,
      end: interval.endTime,
      value: Number(value.int64Value ?? value.doubleValue ?? 0),
    }));
  });
}

// The metric's series: its type, the URL map's (each load balancer's resource has `url_map_name`, a regional one's reading
// URL_MAP/<project number>_<name>), and an extra filter.
export const metricFilter = ({ metric, urlMap, filter }) =>
  `metric.type = "${metric}" AND resource.labels.url_map_name = "${urlMap}"${filter ? ` AND ${filter}` : ''}`;

// The requests the points count between `from` and `to` (ms): the points whose interval meets that time, each for
// what it adds to the same point read before the requests were sent (`before`), so other traffic already published
// does not count.
export function counted(points, { from, to, before = [] }) {
  const base = new Map(before.map((p) => [p.key, p.value]));
  return points
    .filter((p) => Date.parse(p.end) > from && Date.parse(p.start) <= to)
    .reduce((sum, p) => sum + Math.max(0, p.value - (base.get(p.key) ?? 0)), 0);
}

// A NEG's listNetworkEndpoints answer → { instance name: 'address:port' }.
export function endpointStates(response) {
  return Object.fromEntries((response.items ?? []).map(({ networkEndpoint: e }) => [lastSegment(e.instance), `${e.ipAddress}:${e.port}`]));
}

// Cloud SQL's instance → what the timeline follows: its state and its activation policy.
export const sqlState = (instance) => `${instance.state ?? 'unknown'} ${instance.settings?.activationPolicy ?? 'none'}`;

// A Cloud SQL stop or start is the activation policy patched. No state tells that it ended: Google documents RUNNABLE as
// "running, or has been stopped by owner", and SUSPENDED as unavailable for billing and the like. The PATCH's operation does.
export const SQL_POLICY = { stop: 'NEVER', start: 'ALWAYS' };

// operations.get's answer → its status (PENDING, RUNNING, DONE), or FAILED with Google's words.
export function sqlOperationState(operation) {
  if (operation.status !== 'DONE' || !operation.error) return operation.status ?? 'UNKNOWN';
  const errors = (operation.error.errors ?? []).map((e) => `${e.code}: ${e.message}`).join('; ');
  return `FAILED ${errors || 'no reason given'}`;
}

// The seconds Google gives a finished operation, null without its times.
export function sqlOperationSeconds({ insertTime, endTime }) {
  const seconds = (Date.parse(endTime) - Date.parse(insertTime)) / 1000;
  return Number.isFinite(seconds) ? seconds : null;
}

// Poller samples [{ t, states: { instance: 'STATE POLICY', operation: sqlOperationState } }] → when the instance first read
// the new policy, when the operation was first read as ended, and its failure: { policy, ended, failure } (ms or null).
export function sqlSummary(action, samples) {
  const sorted = [...samples].sort((a, b) => a.t - b.t);
  const policy = sorted.find((s) => s.states.instance.split(' ')[1] === SQL_POLICY[action])?.t ?? null;
  const end = sorted.find((s) => s.states.operation === 'DONE' || s.states.operation.startsWith('FAILED '));
  return { policy, ended: end?.t ?? null, failure: end?.states.operation.match(/^FAILED (.*)$/)?.[1] ?? null };
}

// A Deployment (or its scale) → STOPPED at 0 replicas wanted and none left, RUNNING when all wanted are ready, else PENDING.
export function podsState(deployment) {
  const wanted = deployment.spec?.replicas ?? 0;
  const status = deployment.status ?? {};
  if (wanted === 0) return (status.replicas ?? 0) === 0 ? 'STOPPED' : 'PENDING';
  return (status.readyReplicas ?? 0) >= wanted && (status.replicas ?? 0) <= wanted ? 'RUNNING' : 'PENDING';
}

// A scale's summary is a VM action's: to 0 a stop, to more a start; the same number is nothing to do (null).
export const scaleAction = (current, wanted) => (current === wanted ? null : wanted === 0 ? 'stop' : 'start');

export const deploymentPath = (namespace, name) => `/apis/apps/v1/namespaces/${namespace}/deployments/${name}`;

// A GKE NEG's endpoints are pods: { 'address:port': node name }.
export function endpointAddresses(response) {
  return Object.fromEntries((response.items ?? []).map(({ networkEndpoint: e }) => [`${e.ipAddress}:${e.port}`, lastSegment(e.instance)]));
}

// getHealth's answer on a GKE NEG → { 'address:port': healthState }: its pods, several on a node (a pod's `instance` is its node).
export function endpointHealth(response) {
  return Object.fromEntries((response.healthStatus ?? []).map((h) => [`${h.ipAddress}:${h.port}`, h.healthState]));
}

// When a NEG lost an endpoint it held before an action, from `since` on (null: none yet; with none to lose, `since`): getHealth
// may read nothing while a pod still serves, and only then is that a scale to 0's "none healthy".
export function endpointGoneAt(samples, held, since) {
  const names = Object.keys(held);
  if (names.length === 0) return since;
  return [...samples].sort((a, b) => a.t - b.t).find((s) => s.t >= since && names.some((n) => !(n in s.states)))?.t ?? null;
}

// Poller samples [{ t, states }] of endpoints → how many there were from `since` on: the reads, the fewest, the most
// and the last (null when none was read).
export function endpointRange(samples, since) {
  const counts = [...samples].filter((s) => s.t >= since).sort((a, b) => a.t - b.t).map((s) => Object.keys(s.states).length);
  if (counts.length === 0) return { reads: 0, min: null, max: null, last: null };
  return { reads: counts.length, min: Math.min(...counts), max: Math.max(...counts), last: counts.at(-1) };
}
