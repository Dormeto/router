// A workload's onboarding and offboarding on the router, its list, show, nap and wake now, its schedule and its pause (vision
// docs/specs/2026-10-29-google-cloud-design.md, sections 5 and 7). The tags are the CLI's, as the operator: the router holds
// no tag permission, so it neither binds them nor can see them.
//
// A refusal is a `Refusal`: its status and short reason are the API's, its message is what is wrong and what to change.
// Anything else thrown is a failure, a 500 for the caller.
//
// Global, classic and regional load balancers (the coverage design's section 7). A workload's `lb`: `{ kind: 'regional', region }`
// or `{ kind: 'classic' }`, under a swap, with a hold route and a second header on the waker; absent in the configuration for a
// global one, under the policy. The router reads only its own region's regional maps.
//
// Cloud SQL companions (section 9): named at the onboarding, `{ kind: 'cloudsql', name }` among the backends, never without an
// application. The router reads them at the project; the tag its update needs is the CLI's, bound before this.
//
// GKE pods (section 8): `gke` in the request, a `k8s` backend. The dry run reads Google only, as it comes before any right in the cluster: it answers the
// namespace and the Service its NEGs name, which the CLI reads the owner of and applies the Role in. The onboarding then checks each right and reads the owner.
//
// Settings by level (vision docs/specs/2026-11-08-google-cloud-router-features-design.md, section 4): AWS's keys in the configuration, with
// `inherits` (the keys that follow the levels) and `source: 'cli'`; the router level in `router/settings`. The routes that set them are
// AWS's `settings` action, with what Google Cloud fixes (levels.mjs); a Workload shows each setting resolved and where it comes from.
import { resolveHibernation, settingsProblems, workloadSettingsProblems } from '../../lambda/src/lib/hibernation.mjs';
import { nextEvents, normalizeSchedule, resolveJoin, scheduleProblems } from '../../lambda/src/lib/schedule.mjs';
import { describedRules, RULE_KEYS, SCALAR_KEYS } from '../../lambda/src/lib/settings-levels.mjs';
import { STATES } from '../../lambda/src/lib/state.mjs';
import { companionRead, INSTANCE_NAME, isCompanion, statusOf } from './cloudsql.mjs';
import { groupOf, PauseRefused } from './controller-core.mjs';
import {
  clusterProblems, clusterRead, giveBackOwner, gkeMapRefusal, gkeProblems, isGkeNeg, isPods, negsOfService, ownerAsVm, ownerText, pauseLeft,
} from './gke.mjs';
import { beatOf } from './heartbeat.mjs';
import { effectiveOf, inheritsOf, levelProblems } from './levels.mjs';
import { SWITCH_HEADER, WORKLOAD_HEADER, WORKLOAD_ID, swapHeaders } from './names.mjs';
import { inOneUpdate, SWAP_WAIT_MS } from './switch.mjs';
import {
  hostsOf, inMatcher, references, UrlMapRefused, withErrorPolicy, withHoldRoute, withoutErrorPolicy, withoutHoldRoute, withoutSwap, withoutWakerRoute, withSwap, withWakerRoute,
} from './urlmaps.mjs';

const COMPUTE = 'https://compute.googleapis.com/compute/v1';
// A load balancer's scheme by its kind: of its forwarding rules, of its backend services, of the waker's.
const SCHEME_OF = { global: 'EXTERNAL_MANAGED', classic: 'EXTERNAL', regional: 'EXTERNAL_MANAGED' };
const SUPPORTED = 'only external Application Load Balancers are supported: global (EXTERNAL_MANAGED), classic (EXTERNAL) and regional (EXTERNAL_MANAGED)';
const OTHER_ROUTERS = 'regional load balancers are onboarded on the router of their region';
const GLOBAL_LB = { kind: 'global' };
const NAME = /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/;
const NAME_MAX = 63;
const LOCAL_SSD = 'SCRATCH';
const INSTANCE_GROUP = /\/(zones|regions)\/([^/]+)\/instanceGroups\/([^/]+)$/;
const NEG_URL = /\/(zones|regions|global)\/(?:([^/]+)\/)?networkEndpointGroups\/([^/]+)$/;
const NEG_OF_VMS = 'GCE_VM_IP_PORT';
const MANAGED_GROUP_OWNER = /\/instanceGroupManagers\/([^/]+)$/;
// Not a setting of the levels.
const POLL_SECONDS = 3;
// The load balancer before it is read: neither the policy nor a swap, so what the settings ask of it waits until it is known.
const UNREAD_LB = { kind: 'unread' };

// `problems`: each problem of a refused body, as AWS's settings action answers them.
export class Refusal extends Error {
  constructor(status, reason, message, { problems } = {}) {
    super(message);
    this.name = 'Refusal';
    this.status = status;
    this.reason = reason;
    if (problems) this.problems = problems;
  }
}

const bad = (message) => new Refusal(400, 'bad-request', message);
const refusedSettings = (problems) => new Refusal(400, 'bad-request', problems.join('; '), { problems });
const notFound = (id) => new Refusal(404, 'not-found', `no workload ${id}`);
const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const nameOf = (url) => url.slice(url.lastIndexOf('/') + 1);
const zoneOf = (url) => /\/zones\/([^/]+)\//.exec(url)?.[1];
// A proxy's URL without what differs between Google's answers, as a forwarding rule's target names it.
// A URL from `projects/` on, whatever the API's host and version: the same proxy has one path, another proxy of the same name elsewhere another.
const fromProjects = (url) => url.slice(Math.max(url.indexOf('projects/'), 0));
const isoOf = (ms) => new Date(ms).toISOString();
const isSwapped = (lb) => Object.hasOwn(SWAP_WAIT_MS, lb.kind);
const isRegional = (lb) => lb.kind === 'regional';
// The CLI sends `requestLogs` when it turned the backend service's logging on: what the logging was before, kept for the offboarding.
function requestLogsProblems(asked) {
  if (typeof asked !== 'object' || asked === null || Array.isArray(asked)) return ['requestLogs: must be an object'];
  const { before } = asked;
  if (typeof before !== 'object' || before === null || Array.isArray(before)) return ['requestLogs: before must be an object with enable and sampleRate'];
  return [
    ...(typeof before.enable === 'boolean' ? [] : ['requestLogs: before.enable must be true or false']),
    ...(typeof before.sampleRate === 'number' && before.sampleRate >= 0 && before.sampleRate <= 1 ? [] : ['requestLogs: before.sampleRate must be a number from 0 to 1']),
  ];
}

const backendText = (backend) => (isPods(backend) ? ownerText(backend) : backend.name);
const sameCluster = (a, b) => a.location === b.location && a.name === b.name;

// A read's 404, as `.catch(absent)`: null.
const absent = (err) => {
  if (err?.code !== 404) throw err;
  return null;
};

// At the request or at its operation's end, as `.catch(refusedByGoogle(id, what))`. Google's words say what to change, as the
// operator can read them; anything else stays a failure.
const refusedByGoogle = (id, what) => (err) => {
  if (err?.code === 400 || err?.code === 403) throw new Refusal(400, 'not-eligible', `cannot onboard ${id}: Google refused ${what}: ${err.message}`);
  throw err;
};

function checkedId(id) {
  if (typeof id !== 'string' || !WORKLOAD_ID.test(id)) throw bad(`workload ID ${JSON.stringify(id)} does not match ${WORKLOAD_ID.source}`);
  return id;
}

// An onboarding's settings (ruling 1 of the plan's ledger): `hibernate`, true or false, and the settings of the levels, each a value or
// null (left to the levels), through levelProblems. What they ask of the load balancer is checked once it is read: an explicit wake
// timeout must leave room for a swap's map change, and the policy keeps the wake mode browser.
function onboardSettingsProblems(settings, lb = UNREAD_LB) {
  if (!isObject(settings)) return ['settings: must be an object'];
  const { hibernate, ...levels } = settings;
  return [
    ...(Object.hasOwn(settings, 'hibernate') && typeof hibernate !== 'boolean' ? ['settings: hibernate must be true or false'] : []),
    ...levelProblems(levels, { level: 'workload', cfg: { lb } }).map((problem) => `settings: ${problem}`),
  ];
}

// A workload's settings, as AWS's workloadSettingsProblems: `hibernate` and `joinMinutes` in its words, the settings of the levels with
// what Google Cloud refuses for the workload's load balancer.
function workloadProblems(settings, cfg) {
  if (!isObject(settings)) return ['settings must be an object'];
  const aws = (key) => key === 'hibernate' || key === 'joinMinutes';
  const entries = Object.entries(settings);
  return [
    ...workloadSettingsProblems(Object.fromEntries(entries.filter(([key]) => aws(key)))),
    ...levelProblems(Object.fromEntries(entries.filter(([key]) => !aws(key))), { level: 'workload', cfg }).map((problem) => `settings: ${problem}`),
  ];
}

// The router level's, as AWS's settingsProblems: its defaults with what Google Cloud refuses at the router.
function routerProblems(settings) {
  if (!isObject(settings)) return ['settings must be an object'];
  const { defaults, ...rest } = settings;
  return [
    ...settingsProblems(rest),
    ...(defaults === undefined || defaults === null ? [] : levelProblems(defaults, { level: 'router' }).map((problem) => `settings: defaults: ${problem}`)),
  ];
}

function cloudSqlProblems(cloudSql) {
  if (!Array.isArray(cloudSql)) return ['cloudSql: must be a list of Cloud SQL instance names'];
  return [
    ...cloudSql.filter((name) => typeof name !== 'string' || !INSTANCE_NAME.test(name)).map((name) => `cloudSql: ${JSON.stringify(name)} is not a Cloud SQL instance name`),
    ...[...new Set(cloudSql.filter((name, i) => cloudSql.indexOf(name) !== i))].map((name) => `cloudSql: ${name} is named twice`),
  ];
}

// What each key left to the levels resolves to without any level (the built-in value, with what Google Cloud fixes): the value a
// router before G5 reads, as AWS writes its built-in values for an older router.
const builtInsOf = (cfg) => effectiveOf({ ...cfg, inherits: SCALAR_KEYS });

// AWS's hibernation of a workload, as its status and its settings answer give it: the resolution (its own, none with fallback machine
// types, the router's, the built-in), each level's value, and the manager's, none until G2.
function hibernationOf(cfg, router) {
  return {
    ...resolveHibernation({ workload: cfg.hibernate, fallbackTypes: cfg.fallbackInstanceTypes, router: router?.hibernate }),
    workload: typeof cfg.hibernate === 'boolean' ? cfg.hibernate : null,
    router: typeof router?.hibernate === 'boolean' ? router.hibernate : null,
    manager: null,
  };
}

// Each setting resolved, where it comes from, and the type, as AWS's settings answer gives them.
const resolvedOf = (effective) => ({ settings: Object.fromEntries(SCALAR_KEYS.map((key) => [key, effective[key]])), settingsFrom: effective.settingsFrom, type: effective.type });

// The router's record as people read it (AWS's routerSettingsView): all null when unset, its time ISO.
const routerSettingsView = (record) => ({
  hibernate: record?.hibernate ?? null, joinMinutes: record?.joinMinutes ?? null, ...(record?.defaults ? { defaults: record.defaults } : {}),
  by: record?.by ?? null, at: record ? isoOf(record.at) : null,
});

function failureOf(run) {
  if (!run?.failure) return null;
  try {
    const failure = JSON.parse(run.failure);
    return { ...failure, ...(failure.at === undefined ? {} : { at: isoOf(failure.at) }) };
  } catch {
    return null;
  }
}

// The API's Workload. `awakeSince` is a time the CLI prints, and left on the run by a nap. `paused`: its active pause. `companionsGone`:
// the Cloud SQL instances named at its onboarding that no longer exist, as last read. `napAborted`: why the last nap was given up and
// when, until a nap commits. `beatAt`: the running wake's or nap's last heartbeat (heartbeat.mjs), WAKING or NAPPING only. `idleReads`:
// what the idle check read at the last check that read log entries or counted a request, `request logs` or `request count`
// (controller-core.mjs). With the router level (`router`): each setting resolved (`settings`), where it comes from, the type and the
// rules of every level, as AWS's status gives them, and its hibernation; its fallback machine types, and `instanceTypes` while a VM
// runs on one.
function workloadOf(cfg, run, paused, router) {
  const failure = failureOf(run);
  const beatAt = run ? beatOf(run) : undefined;
  const effective = effectiveOf(cfg, { run, router });
  const { settings, settingsFrom, type } = resolvedOf(effective);
  return {
    id: cfg.workloadId,
    state: run?.state ?? 'UNKNOWN',
    urlMap: cfg.urlMap,
    backendService: cfg.backendService,
    wakerBackendService: cfg.wakerBackendService,
    hosts: cfg.hosts,
    lb: cfg.lb ?? GLOBAL_LB,
    settings,
    settingsFrom,
    type,
    ...describedRules(effective),
    hibernation: hibernationOf(cfg, router),
    backends: cfg.backends,
    ...(Array.isArray(cfg.fallbackInstanceTypes) && cfg.fallbackInstanceTypes.length ? { fallbackInstanceTypes: cfg.fallbackInstanceTypes } : {}),
    ...(run?.instanceTypes && Object.keys(run.instanceTypes).length ? { instanceTypes: run.instanceTypes } : {}),
    ...(cfg.requestLogs ? { requestLogs: cfg.requestLogs } : {}),
    ...(run?.state === STATES.AWAKE && run.awakeSince !== undefined ? { awakeSince: isoOf(run.awakeSince) } : {}),
    ...(run?.lastWake ? { lastWake: run.lastWake } : {}),
    ...(failure ? { failure } : {}),
    ...(paused ? { paused } : {}),
    ...(run?.companionsGone?.length ? { companionsGone: run.companionsGone } : {}),
    ...(run?.napAborted ? { napAborted: { reason: run.napAborted.reason, at: isoOf(run.napAborted.at) } } : {}),
    ...(beatAt !== undefined ? { beatAt: isoOf(beatAt) } : {}),
    ...(run?.idleReads ? { idleReads: run.idleReads } : {}),
  };
}

export function createOnboarding({ store, compute, cloudsql, gke, urlmaps, regionalUrlmaps, core, config, now = Date.now, log }) {
  const clients = { compute, kubernetesOf: (cluster) => gke.kubernetesOf(cluster) };
  const wakerName = (id) => `dmtr-${config.region}-${id}`;
  const wakerUrl = (name, lb) => `${COMPUTE}/projects/${config.project}/${isRegional(lb) ? `regions/${lb.region}` : 'global'}/backendServices/${name}`;
  // A regional backend service takes no custom request header (M4: Google refuses them): its waker's are written in the map,
  // and the service says whose waker it is in its description, which a later onboarding of the same workload reads.
  const wakerHeaders = (id, lb) => [`${WORKLOAD_HEADER}: ${id}`, ...(isSwapped(lb) ? [`${SWITCH_HEADER}: swap`] : [])];
  const wakerDescription = (id) => `Dormeto: the waker of workload ${id}`;
  const mapHeaders = (id, lb) => ({ headers: isRegional(lb) ? swapHeaders(id) : undefined });
  const isWakerOf = (service, id, lb) => (isRegional(lb)
    ? service.description === wakerDescription(id) && !service.customRequestHeaders?.length
    : service.customRequestHeaders?.length === wakerHeaders(id, lb).length && wakerHeaders(id, lb).every((h) => service.customRequestHeaders.includes(h)));
  const mapsOf = (lb) => (isRegional(lb) ? regionalUrlmaps : urlmaps);
  const getService = (name, lb) => (isRegional(lb) ? compute.getRegionBackendService(lb.region, name) : compute.getBackendService(name));
  const deleteService = (name, lb) => (isRegional(lb) ? compute.deleteRegionBackendService(lb.region, name) : compute.deleteBackendService(name));
  const insertService = (body, lb) => (isRegional(lb) ? compute.insertRegionBackendService(lb.region, body) : compute.insertBackendService(body));

  // The request's fields, or a 400. Without an ID, the backend service's name, when it is one. `needsAll`: an onboarding's `gke` names all, a dry run's the cluster alone.
  function requested({ urlMap, backendService, id, settings = {}, loadBalancer, cloudSql = [], gke: gkeAsked, requestLogs }, { needsAll = false } = {}) {
    if (!urlMap || !backendService) throw bad('urlMap and backendService are needed');
    for (const [key, value] of Object.entries({ urlMap, backendService })) {
      if (typeof value !== 'string' || !NAME.test(value)) throw bad(`${key}: ${JSON.stringify(value)} is not a Compute Engine name`);
    }
    if (loadBalancer !== undefined && !['global', 'regional', 'classic'].includes(loadBalancer)) throw bad(`loadBalancer: ${JSON.stringify(loadBalancer)} is not global, regional or classic`);
    const workloadId = checkedId(id || backendService);
    const waker = wakerName(workloadId);
    if (waker.length > NAME_MAX) throw bad(`workload ID ${workloadId} would name the waker backend service ${waker}, longer than the ${NAME_MAX} characters of a Compute Engine name: use a shorter one`);
    const problems = [...onboardSettingsProblems(settings), ...cloudSqlProblems(cloudSql), ...(requestLogs === undefined ? [] : requestLogsProblems(requestLogs)), ...(gkeAsked === undefined ? [] : gkeProblems(gkeAsked, { needsAll }))];
    if (problems.length) throw bad(problems.join('; '));
    return { id: workloadId, urlMap, backendService, settings, loadBalancer, cloudSql, gkeAsked, requestLogs };
  }

  // The URL map, `{ map, regional }`, or why it is not one: `{ reason }`. A regional one elsewhere than the router's region reads as none.
  async function findMap(urlMap, asked) {
    const [inGlobal, inRegion] = await Promise.all([
      asked === 'regional' ? null : urlmaps.get(urlMap).catch(absent),
      asked && asked !== 'regional' ? null : regionalUrlmaps.get(urlMap).catch(absent),
    ]);
    if (inGlobal && inRegion) return { reason: `URL map ${urlMap} exists globally and in region ${config.region}: say which with --load-balancer global, classic or regional` };
    if (inGlobal || inRegion) return { map: inGlobal ?? inRegion, regional: Boolean(inRegion) };
    if (asked === 'regional') return { reason: `URL map ${urlMap} not found in region ${config.region}: ${OTHER_ROUTERS}` };
    if (asked) return { reason: `URL map ${urlMap} not found: name a global URL map of this project, or use --load-balancer regional` };
    return { reason: `URL map ${urlMap} not found: name a global URL map of this project, or a regional one of ${config.region}: ${OTHER_ROUTERS}` };
  }

  // A global map's forwarding rules: the global ones, and the regional ones that target a global proxy, which a classic load
  // balancer on the Standard network tier has (the aggregated list shows them; regional rules have a `region`, global ones none).
  async function globalRules() {
    const [global, aggregated] = await Promise.all([compute.listForwardingRules(), compute.listAggregatedForwardingRules()]);
    return [...global, ...aggregated.filter((r) => r.region)];
  }

  // The URL map's load balancer: one target proxy, and forwarding rules whose scheme tells a global from a classic one.
  // `{ kind, reasons }`, `kind` null when there is nothing supported to tell it from.
  async function loadBalancerOf(urlMap, regional, asked) {
    const [https, http, rules] = await Promise.all(regional
      ? [compute.listRegionTargetHttpsProxies(config.region), compute.listRegionTargetHttpProxies(config.region), compute.listRegionForwardingRules(config.region)]
      : [compute.listTargetHttpsProxies(), compute.listTargetHttpProxies(), globalRules()]);
    const refused = (...reasons) => ({ kind: null, reasons });
    const proxies = [...https, ...http].filter((p) => nameOf(p.urlMap ?? '') === urlMap);
    if (!proxies.length) return refused(`URL map ${urlMap} is used by no target proxy: attach it to an external Application Load Balancer, then onboard again`);
    if (proxies.length > 1) return refused(`URL map ${urlMap} is used by ${proxies.length} target proxies (${proxies.map((p) => p.name).join(', ')}): give each load balancer its own URL map`);
    const fronts = rules.filter((r) => fromProjects(r.target ?? '') === fromProjects(proxies[0].selfLink));
    if (!fronts.length) return refused(`no forwarding rule sends to the target proxy of URL map ${urlMap}: add one, then onboard again`);
    const kinds = regional ? ['regional'] : ['global', 'classic'];
    const kindsOf = (rule) => kinds.filter((kind) => SCHEME_OF[kind] === rule.loadBalancingScheme);
    const unsupported = fronts.filter((r) => !kindsOf(r).length);
    if (unsupported.length) return refused(...unsupported.map((r) => `forwarding rule ${r.name} has the scheme ${r.loadBalancingScheme}: ${SUPPORTED}`));
    const found = new Set(fronts.flatMap(kindsOf));
    if (found.size > 1) return refused(`URL map ${urlMap} has forwarding rules of a global and of a classic load balancer (${fronts.map((r) => `${r.name} ${r.loadBalancingScheme}`).join(', ')}): finish its migration, then onboard again`);
    const [kind] = found;
    return { kind, reasons: asked && asked !== kind ? [`URL map ${urlMap} belongs to a ${kind} load balancer, not a ${asked} one: onboard it with --load-balancer ${kind}`] : [] };
  }

  // What the route and the nap would write, tried on the map as it is, the nap's after the route: the route gives the map's
  // default its matcher. A map that does not name the service has its reason already. Under a swap, the nap's is the swap, after
  // the hold route too.
  function mapProblems(map, backendService, waker, lb, id) {
    if (!references(map, backendService).length) return [];
    const problems = [];
    const tried = (write, on, advice) => {
      try {
        return write(on, backendService, waker, mapHeaders(id, lb)).map;
      } catch (err) {
        if (!(err instanceof UrlMapRefused)) throw err;
        problems.push(`${err.message}: ${advice}`);
        return null;
      }
    };
    const change = 'change that, then onboard again';
    const routed = tried(withWakerRoute, map, change);
    if (!inMatcher(routed ?? map, backendService)) {
      if (routed) problems.push(`backend service ${backendService} is named in URL map ${map.name} only by its default, which a host rule * hides: route to it in a path matcher, then onboard again`);
    } else if (isSwapped(lb)) {
      const held = routed && tried(withHoldRoute, routed, change);
      tried(withSwap, held ?? routed ?? map, change);
    } else {
      tried(withErrorPolicy, routed ?? map, 'a nap would replace it, remove it first');
    }
    return problems;
  }

  // A zonal NEG of VMs: `{ reasons, members (its VMs' URLs), neg: true }`. Its VMs stay in it when stopped (measure M1).
  async function negOf(zone, name, service) {
    const neg = await compute.getZonalNetworkEndpointGroup(zone, name).catch(absent);
    const refused = (reason) => ({ reasons: [reason], members: [], neg: { zone, name } });
    if (!neg) return refused(`network endpoint group ${name} of backend service ${service} not found: it was deleted, take it out of the backend service`);
    if (neg.networkEndpointType !== NEG_OF_VMS) return refused(`network endpoint group ${name} of backend service ${service} has the type ${neg.networkEndpointType}: only ${NEG_OF_VMS} is supported, take it out of the backend service`);
    if (isGkeNeg({ ...neg, name })) {
      return refused(`network endpoint group ${name} of backend service ${service} was made by GKE, its endpoints are pods: it needs --gke-cluster`);
    }
    const endpoints = (await compute.listNetworkEndpoints(zone, name)).map((item) => item.networkEndpoint ?? {});
    if (!endpoints.length) return refused(`network endpoint group ${name} has no endpoint: add a VM to it, then onboard again`);
    const bare = endpoints.filter((endpoint) => !endpoint.instance);
    if (bare.length) return refused(`network endpoint group ${name} has an endpoint with no VM (${bare.map((endpoint) => endpoint.ipAddress).join(', ')}): only endpoints naming a VM are supported, replace it with one`);
    return { reasons: [], neg: { zone, name }, members: endpoints.map((endpoint) => `${COMPUTE}/projects/${config.project}/zones/${zone}/instances/${nameOf(endpoint.instance)}`) };
  }

  // A backend of the service: `{ reasons, members (its VMs' URLs), group?, neg? }`, `group` when it is a managed one, `neg` (`{ zone, name }`) when
  // it is a zonal NEG.
  async function backendOf({ group: url }, service) {
    const place = INSTANCE_GROUP.exec(url ?? '');
    if (!place) {
      const [, scope, zone, name] = NEG_URL.exec(url ?? '') ?? [];
      if (scope === 'zones') return negOf(zone, name, service);
      const where = scope === 'regions' ? 'regional network endpoint group (serverless, private service connect)' : scope === 'global' ? 'global network endpoint group (internet)' : 'network endpoint group';
      return { reasons: [`backend ${nameOf(url ?? '')} of backend service ${service} is a ${where}: only zonal network endpoint groups of VMs and instance groups are supported`], members: [] };
    }
    const [, scope, location, name] = place;
    const group = { kind: scope === 'regions' ? 'regional' : 'zonal', location, name };
    const managed = await compute.getManagedGroup(group).catch(absent);
    const members = managed
      ? (await compute.listManagedInstances(group)).map((m) => m.instance)
      : (await compute.listGroupInstances(location, name)).map((m) => m.instance);
    const reasons = [];
    if (!members.length) reasons.push(`instance group ${name} has no VM: add one, then onboard again`);
    if (managed?.status?.stateful?.hasStatefulConfig) reasons.push(`managed group ${name} has a stateful configuration: a nap might not keep it, take the group out of the backend service`);
    // Google's defaults for a regional group, when its answer says nothing.
    if (managed && group.kind === 'regional' && (managed.distributionPolicy?.targetShape ?? 'EVEN') === 'EVEN' && (managed.updatePolicy?.instanceRedistributionType ?? 'PROACTIVE') !== 'NONE') {
      reasons.push(`regional managed group ${name} has the target shape EVEN with instance redistribution on: Google cannot stop or suspend its VMs one by one, set its instance redistribution type to NONE or change its target shape, then onboard again`);
    }
    return { reasons, members, ...(managed ? {} : { source: url }), ...(managed ? { group: { ...group, selfLink: managed.selfLink, id: String(managed.id) } } : {}) };
  }

  async function vmProblems(vm, zone, machineTypes) {
    const reasons = [];
    const type = nameOf(vm.machineType ?? '');
    const key = `${zone}/${type}`;
    if (!machineTypes.has(key)) machineTypes.set(key, compute.getMachineType(zone, type).catch(absent));
    const machine = await machineTypes.get(key);
    if (vm.guestAccelerators?.length || machine?.accelerators?.length) reasons.push(`VM ${vm.name} has a GPU: GPU VMs are not supported, take it out of the backend service`);
    if (vm.disks?.some((d) => d.type === LOCAL_SSD)) reasons.push(`VM ${vm.name} has a local SSD: a stop would lose its data, take it out of the backend service`);
    return reasons;
  }

  // The service's backends: what refuses them, and what the CLI tags: the VMs of unmanaged groups and the managed groups.
  // A managed group's own VMs are the group's to tag and to act on, but they must qualify all the same.
  async function backendsOf(service, others) {
    const holderOf = (kind, location, name) => others.find((c) => c.backends?.some((b) => b.kind === kind && b.location === location && b.name === name));
    const backends = await Promise.all((service.backends ?? []).map((b) => backendOf(b, service.name)));
    const reasons = backends.flatMap((b) => b.reasons);
    const groups = backends.flatMap((b) => (b.group ? [b.group] : []));
    for (const { name, location } of groups) {
      const holder = holderOf('mig', location, name);
      if (holder) reasons.push(`managed group ${name} belongs to workload ${holder.workloadId}`);
    }
    const unmanaged = new Set(backends.filter((b) => !b.group).flatMap((b) => b.members));
    // The unmanaged instance group naming each of those VMs (the first, for a VM in two): a nap stops only what is still in it.
    const groupOf = new Map();
    for (const b of backends.filter((x) => x.source)) for (const url of b.members) if (!groupOf.has(url)) groupOf.set(url, b.source);
    // A NEG's VMs: URL -> the NEGs naming it, in the order of the service's backends.
    const negsOf = new Map();
    for (const b of backends.filter((x) => x.neg)) for (const url of b.members) negsOf.set(url, [...(negsOf.get(url) ?? []), b.neg]);
    const machineTypes = new Map();
    // One read per VM, a VM in two groups of the service being one VM. A group lists a VM it is still creating.
    const read = await Promise.all([...new Set(backends.flatMap((b) => b.members))].map(async (url) => {
      const zone = zoneOf(url);
      const vm = await compute.getInstance(zone, nameOf(url)).catch(absent);
      if (!vm && negsOf.has(url)) reasons.push(`network endpoint group ${negsOf.get(url)[0].name} names the VM ${nameOf(url)}, which does not exist: remove the endpoint, then onboard again`);
      return vm && { url, zone, vm, problems: await vmProblems(vm, zone, machineTypes) };
    }));
    const vms = [];
    // The NEGs of each VM that one names, by the VM's name: the nap checks them again.
    const negs = {};
    const memberOf = {};
    for (const { url, zone, vm, problems } of read.filter(Boolean)) {
      reasons.push(...problems);
      const owner = negsOf.has(url) && MANAGED_GROUP_OWNER.exec(vm.metadata?.items?.find((item) => item.key === 'created-by')?.value ?? '')?.[1];
      if (owner) reasons.push(`VM ${vm.name} is a member of managed group ${owner}, which would repair it once stopped: put the managed group in the backend service instead of its VM in a network endpoint group`);
      if (!unmanaged.has(url)) continue;
      const holder = holderOf('vm', zone, vm.name);
      if (holder) reasons.push(`VM ${vm.name} belongs to workload ${holder.workloadId}`);
      vms.push({ zone, name: vm.name, selfLink: vm.selfLink, id: String(vm.id) });
      if (negsOf.has(url)) negs[vm.name] = negsOf.get(url);
      else if (groupOf.has(url)) memberOf[vm.name] = groupOf.get(url);
    }
    return { reasons, vms, groups, negs, memberOf };
  }

  // The companions asked for: what refuses them, and what the CLI tags.
  async function databasesOf(names, others) {
    const found = await Promise.all(names.map(async (name) => {
      const holder = others.find((c) => c.backends?.some((b) => isCompanion(b) && b.name === name));
      const { database, problem } = await companionRead(cloudsql, name);
      return { database, reasons: [...(holder ? [`Cloud SQL instance ${name} belongs to workload ${holder.workloadId}`] : []), ...(problem ? [problem] : [])] };
    }));
    return { reasons: found.flatMap((f) => f.reasons), databases: found.flatMap((f) => (f.database ? [f.database] : [])) };
  }

  // Section 8: what --gke-cluster says of the service's NEGs and of the cluster, from Google alone: what refuses them, `gke` the dry run's answer (with the cluster read) and `podNegs`.
  async function podsOf(service, asked, others) {
    const { cluster, owner } = asked;
    const [{ view, problem }, { reasons, negs, named }] = await Promise.all([clusterRead(gke, cluster), negsOfService(compute, service, asked)]);
    const place = { namespace: named?.namespace ?? asked.namespace ?? null, service: named?.service ?? asked.service ?? null };
    const inCluster = others.flatMap((c) => (c.backends ?? []).filter((b) => isPods(b) && sameCluster(b.cluster, cluster)).map((b) => ({ holder: c.workloadId, ...b })));
    const where = `GKE cluster ${cluster.location}/${cluster.name}`;
    const holdsService = inCluster.find((b) => b.namespace === place.namespace && b.service === place.service);
    const holdsOwner = owner && inCluster.find((b) => b.namespace === place.namespace && b.owner.kind === owner.kind && b.owner.name === owner.name);
    return {
      reasons: [
        ...(problem ? [problem] : []),
        ...reasons,
        ...(holdsService ? [`Service ${place.namespace}/${place.service} of ${where} belongs to workload ${holdsService.holder}`] : []),
        ...(holdsOwner ? [`${owner.kind} ${place.namespace}/${owner.name} of ${where} belongs to workload ${holdsOwner.holder}`] : []),
      ],
      vms: [],
      groups: [],
      negs: {},
      podNegs: negs,
      ...(view ? { gke: { cluster, ...place, autopilot: view.autopilot } } : {}),
    };
  }

  // Section 7: why the workload cannot be onboarded, its load balancer (`lb`, none when it cannot be told), its VMs, groups and databases, and with `gkeAsked` the NEGs. Reads only.
  async function inspect({ id, urlMap, backendService, loadBalancer, settings, cloudSql, gkeAsked }) {
    const reasons = [];
    const configs = await store.listConfigs();
    const others = configs.filter((c) => c.workloadId !== id);
    if (others.length < configs.length) reasons.push(`workload ${id} is onboarded already`);
    const companions = await databasesOf(cloudSql, others);
    reasons.push(...companions.reasons);
    const { databases } = companions;
    const nothing = { vms: [], groups: [], negs: {}, memberOf: {}, databases };
    // Refused by its name, with nothing read or tried on it.
    const gkeMap = gkeMapRefusal(urlMap);
    if (gkeMap) return { reasons: [...reasons, gkeMap], ...nothing };
    const { map, regional, reason } = await findMap(urlMap, loadBalancer);
    if (!map) return { reasons: [...reasons, reason], ...nothing };
    const front = await loadBalancerOf(urlMap, regional, loadBalancer);
    reasons.push(...front.reasons);
    const kind = front.kind ?? (regional ? 'regional' : loadBalancer ?? 'global');
    const lb = regional ? { kind, region: config.region } : { kind };
    const told = front.kind ? { lb } : {};
    if (front.kind) reasons.push(...onboardSettingsProblems(settings, lb));

    // A backend service's name is unique in its scope.
    const owner = others.find((c) => c.backendService === backendService && isRegional(c.lb ?? GLOBAL_LB) === regional);
    if (owner) reasons.push(`backend service ${backendService} is already workload ${owner.workloadId}`);
    const service = await getService(backendService, lb).catch(absent);
    if (!service) {
      reasons.push(`backend service ${backendService} not found: name ${regional ? `a regional backend service of ${config.region}` : 'a global backend service of this project'}`);
      return { reasons, ...told, ...nothing };
    }

    if (front.kind && service.loadBalancingScheme !== SCHEME_OF[kind]) reasons.push(`backend service ${backendService} has the scheme ${service.loadBalancingScheme}: the backend services of a ${kind} load balancer have ${SCHEME_OF[kind]}`);
    if (!references(map, backendService).length) reasons.push(`backend service ${backendService} is not named in URL map ${urlMap}: route to it there, or name the URL map that does`);
    for (const other of await mapsOf(lb).list()) {
      if (other.name !== urlMap && references(other, backendService).length) {
        reasons.push(`backend service ${backendService} is also named in URL map ${other.name}: that load balancer would lose its backends during a nap; give it a backend service of its own`);
      }
    }
    if (!service.healthChecks?.length) reasons.push(`backend service ${backendService} has no health check: a wake waits for a healthy instance, add one`);
    if (!service.backends?.length) reasons.push(`backend service ${backendService} has no backend: add an instance group, then onboard again`);

    const waker = wakerName(id);
    reasons.push(...mapProblems(map, backendService, wakerUrl(waker, lb), lb, id));
    const existing = await getService(waker, lb).catch(absent);
    if (existing && !isWakerOf(existing, id, lb)) {
      reasons.push(`backend service ${waker} exists and is not the waker of ${id}: rename it, or onboard under another id`);
    }

    const backends = await (gkeAsked ? podsOf(service, gkeAsked, others) : backendsOf(service, others));
    reasons.push(...backends.reasons);
    return {
      reasons,
      ...told,
      vms: backends.vms,
      groups: backends.groups,
      negs: backends.negs,
      memberOf: backends.memberOf ?? {},
      serviceBackends: (service.backends ?? []).map((b) => b.group).filter(Boolean).sort(),
      podNegs: backends.podNegs,
      ...(backends.gke ? { gke: backends.gke } : {}),
      databases,
      hosts: hostsOf(map, backendService),
      wakerExists: Boolean(existing),
    };
  }

  // `warnings`: what does not refuse it, but its operator should know: spec section 8's limit of a Standard cluster, and a database's
  // replicas, which Google leaves running (M8).
  async function dryRun(input) {
    const { reasons, vms, groups, databases, lb, gke: pods } = await inspect(requested(input));
    const warnings = [
      ...(pods && !pods.autopilot ? [`GKE cluster ${pods.cluster.location}/${pods.cluster.name} is a Standard cluster: scaling pods saves money only on Autopilot, or with the node autoscaler freeing a node; its fixed nodes are paid all the same`] : []),
      ...databases.filter((d) => d.replicas).map((d) => `Cloud SQL instance ${d.name} has read replicas (${d.replicas.join(', ')}): Google stops only the primary, its replicas keep running, and billing, while the workload sleeps`),
    ];
    return {
      eligible: reasons.length === 0,
      reasons,
      vms,
      groups,
      databases,
      ...(lb ? { lb } : {}),
      ...(pods ? { gke: pods } : {}),
      ...(warnings.length ? { warnings } : {}),
    };
  }

  // In one update, then the waker backend service: the route and the policy; under a swap, the application back wherever the map
  // is still swapped, the hold route and the route. What is gone already is no failure.
  // A delete refused as in use means a check wrote the route back between the update and the delete (it read the workload
  // before the offboarding began): the route goes again, and the delete is tried once more.
  async function removeFromGoogle({ urlMap, backendService, wakerBackendService: name, lb = GLOBAL_LB }) {
    const waker = wakerUrl(name, lb);
    const removeRoute = () => mapsOf(lb).modify(urlMap, (map) => {
      const steps = isSwapped(lb)
        ? [(m) => withoutSwap(m, backendService, waker), (m) => withoutHoldRoute(m, backendService, waker), (m) => withoutWakerRoute(m, waker)]
        : [(m) => withoutErrorPolicy(m, waker), (m) => withoutWakerRoute(m, waker)];
      return inOneUpdate(map, steps);
    }).catch(absent);
    await removeRoute();
    await deleteService(name, lb).catch(async (err) => {
      if (err?.code !== 400 || err.reason !== 'resourceInUseByAnotherResource') return absent(err);
      await removeRoute();
      await deleteService(name, lb).catch(absent);
    });
  }

  // Nothing of a failed onboarding stays: a waker backend service left would keep the NEG from being uninstalled.
  async function undo(cfg, cause) {
    const { workloadId } = cfg;
    try {
      await removeFromGoogle(cfg);
      await store.deleteWorkload(workloadId);
      log.warn('OnboardUndone', { workloadId, error: cause.message });
    } catch (err) {
      log.error('OnboardNotUndone', { workloadId, error: err.message, cause: cause.message });
    }
  }

  async function onboard(input) {
    const { id, urlMap, backendService, settings, loadBalancer, cloudSql, gkeAsked, requestLogs } = requested(input, { needsAll: true });
    if (await store.getConfig(id)) throw new Refusal(409, 'exists', `workload ${id} is onboarded already`);
    const { reasons, vms, groups, negs, memberOf, serviceBackends, podNegs, databases, hosts, wakerExists, lb } = await inspect({ id, urlMap, backendService, loadBalancer, settings, cloudSql, gkeAsked });
    if (reasons.length) throw new Refusal(400, 'not-eligible', `cannot onboard ${id}: ${reasons.join('; ')}`);
    // Spec section 8's shape, whatever else the request carried. The cluster last, and before anything is written: refused, the CLI takes back its RBAC.
    const pods = gkeAsked && {
      kind: 'k8s',
      cluster: { location: gkeAsked.cluster.location, name: gkeAsked.cluster.name },
      namespace: gkeAsked.namespace,
      service: gkeAsked.service,
      owner: { kind: gkeAsked.owner.kind, name: gkeAsked.owner.name },
    };
    if (pods) {
      const problems = await clusterProblems(clients, pods, podNegs);
      if (problems.length) throw new Refusal(400, 'not-eligible', `cannot onboard ${id}: ${problems.join('; ')}`);
    }
    // The level the answer resolves with, read before anything is written.
    const router = await routerLevel();
    const name = wakerName(id);
    const waker = wakerUrl(name, lb);
    // A setting sent null is left to the levels, as one not sent.
    const { hibernate, ...asked } = settings;
    const levels = Object.fromEntries(Object.entries(asked).filter(([, value]) => value !== null));
    const written = {
      workloadId: id,
      urlMap,
      backendService,
      wakerBackendService: name,
      hosts,
      ...(lb.kind === 'global' ? {} : { lb }),
      // What a nap checks again before it stops anything: the unmanaged groups' VMs and the service's backends as read now.
      ...(Object.keys(memberOf).length ? { groups: memberOf } : {}),
      ...(pods ? {} : { serviceBackends }),
      ...(requestLogs ? { requestLogs: { before: { enable: requestLogs.before.enable, sampleRate: requestLogs.before.sampleRate } } } : {}),
      backends: [
        ...vms.map((vm) => ({
          kind: 'vm',
          location: vm.zone,
          name: vm.name,
          id: vm.id,
          // The NEGs naming it: a nap stops only what is still in them.
          ...(negs[vm.name] ? { neg: negs[vm.name][0], ...(negs[vm.name].length > 1 ? { moreNegs: negs[vm.name].slice(1) } : {}) } : {}),
        })),
        ...groups.map((g) => ({ kind: 'mig', location: g.location, name: g.name, id: g.id })),
        ...(pods ? [pods] : []),
        ...databases.map(({ name: database }) => ({ kind: 'cloudsql', name: database })),
      ],
      pollSeconds: POLL_SECONDS,
      noWakeRules: [],
      wakeRules: [],
      ...levels,
      ...(typeof hibernate === 'boolean' ? { hibernate } : {}),
      // What the onboarding is not given follows the levels (design section 4.1), G1's computed wake timeout included.
      inherits: SCALAR_KEYS.filter((key) => !Object.hasOwn(levels, key)),
      source: 'cli',
      onboardedAt: isoOf(now()),
    };
    const builtIn = builtInsOf(written);
    const cfg = { ...written, ...Object.fromEntries(written.inherits.map((key) => [key, builtIn[key]])) };
    try {
      if (!wakerExists) {
        // M4 (the coverage design's section 10): Google takes a classic backend service with EXTERNAL and its two custom request
        // headers on the router's serverless NEG, and refuses those headers on a regional one, whose map carries them instead.
        await insertService({
          name,
          ...(isRegional(lb) ? { description: wakerDescription(id) } : {}),
          loadBalancingScheme: SCHEME_OF[lb.kind],
          protocol: 'HTTPS',
          backends: [{ group: `${COMPUTE}/projects/${config.project}/regions/${config.region}/networkEndpointGroups/${config.wakerNeg}` }],
          ...(isRegional(lb) ? {} : { customRequestHeaders: wakerHeaders(id, lb) }),
        }, lb).catch(refusedByGoogle(id, `its waker backend service ${name}`));
      }
      await mapsOf(lb).modify(urlMap, (map) => inOneUpdate(map, isSwapped(lb)
        ? [(m) => withWakerRoute(m, backendService, waker, mapHeaders(id, lb)), (m) => withHoldRoute(m, backendService, waker)]
        : [(m) => withWakerRoute(m, backendService, waker)])).catch(refusedByGoogle(id, `the update of URL map ${urlMap}`));
      await store.putConfig(id, cfg);
      await store.initRun(id, now());
    } catch (err) {
      await undo(cfg, err);
      if (err instanceof UrlMapRefused) throw new Refusal(400, 'not-eligible', `cannot onboard ${id}: ${err.message}`);
      throw err;
    }
    log.info('Onboarded', { workloadId: id, urlMap, backendService });
    return workloadOf(cfg, await store.getRun(id), undefined, router);
  }

  // The configuration, or a 400 or a 404.
  async function find(id) {
    const cfg = await store.getConfig(checkedId(id));
    if (!cfg) throw notFound(id);
    return cfg;
  }

  // The router level (`router/settings`), null when unset. A read that fails fails the request, as any other read of it.
  const routerLevel = async () => (await store.getRouterSettings()) ?? null;

  // Back awake in this request, up to the wake's timeout: the VMs must be up once the policy goes and the CLI unbinds the tag.
  async function awaken(id, run) {
    const wakeId = await core.beginWake(id, run.state, 'offboarding');
    if (!wakeId) throw new Refusal(409, 'busy', `cannot offboard ${id}: its state just changed, try again`);
    const { state, error } = await core.wake(id, wakeId);
    if (state !== STATES.AWAKE) throw new Refusal(409, 'wake-failed', `cannot offboard ${id}: its wake failed: ${error ?? state}; fix that and try again, or offboard with --force, which leaves its backends down`);
  }

  // Running, as far as it can be read: anything else, a backend gone included, is not known to be up.
  async function isUp(backend, workloadId) {
    try {
      if (isCompanion(backend)) return statusOf(await cloudsql.get(backend.name)) === 'running';
      if (isPods(backend)) return (await ownerAsVm(clients, backend)).status === 'RUNNING';
      const statuses = backend.kind === 'mig'
        ? (await compute.listManagedInstances(groupOf(backend))).map((m) => m.instanceStatus)
        : [(await compute.getInstance(backend.location, backend.name)).status];
      return statuses.length > 0 && statuses.every((status) => status === 'RUNNING');
    } catch (err) {
      log.warn('BackendUnread', { workloadId, backend: backendText(backend), error: err.message });
      return false;
    }
  }

  // A workload that cannot wake, or whose state is stuck: no wake, and all of Dormeto's goes. The backends stay as they are,
  // and those not up are named. A nap in flight finds its waker backend service gone before it would stop anything, unless
  // it is already stopping them. What it cannot give back is named too, `notGivenBack`, in the operator's words: none, no field, and
  // the router will not try again. `left` stays what it was for a CLI below this version.
  async function forceOff(cfg, run) {
    const { workloadId } = cfg;
    const up = await Promise.all(cfg.backends.map((backend) => isUp(backend, workloadId)));
    const left = cfg.backends.filter((_, i) => !up[i]);
    const notGivenBack = [];
    await Promise.all((run?.autoscalers ?? []).map((a) => compute.setAutoscalerMode(a, a.mode).catch((err) => {
      log.warn('AutoscalerNotGivenBack', { workloadId, autoscaler: a.name, mode: a.mode, error: err.message });
      notGivenBack.push(`autoscaler ${a.name} (${a.location}) is still off: set its mode back to ${a.mode}`);
    })));
    // A give-back's failure needs a ScaledObject to give back.
    await Promise.all((run?.owners ?? []).map((record) => giveBackOwner(clients, record).catch((err) => {
      log.warn('AutoscalerNotGivenBack', { workloadId, autoscaler: record.keda?.name, error: err.message });
      notGivenBack.push(pauseLeft(record));
    })));
    await removeFromGoogle(cfg);
    await store.deleteWorkload(workloadId);
    // An owner left at 0: what it ran goes with the run, its record.
    const replicasBefore = (run?.owners ?? []).map((record) => ({ owner: ownerText(record), replicas: record.replicas }));
    log.warn('Offboarded', { workloadId, force: true, left: left.map(backendText), ...(replicasBefore.length ? { replicasBefore } : {}) });
    return { id: workloadId, left, ...(notGivenBack.length ? { notGivenBack } : {}) };
  }

  // An offboarding that stops keeps the documents: they name what is left to remove when it runs again.
  async function offboard(id, { force = false } = {}) {
    const cfg = await find(id);
    let run = await store.getRun(id);
    if (force) return forceOff(cfg, run);
    if ([STATES.WAKING, STATES.NAPPING].includes(run?.state)) throw new Refusal(409, 'busy', `cannot offboard ${id}: it is ${run.state}, try again once it is done`);
    if (run && run.state !== STATES.AWAKE) {
      await awaken(id, run);
      run = await store.getRun(id);
    }
    // A mode the checks could not give back yet: its record goes with the run.
    await Promise.all([...(run?.autoscalers ?? []).map((a) => compute.setAutoscalerMode(a, a.mode)), ...(run?.owners ?? []).map((record) => giveBackOwner(clients, record))]);
    await removeFromGoogle(cfg);
    await store.deleteWorkload(id);
    log.info('Offboarded', { workloadId: id });
    return {};
  }

  // The Workload as it is now. `router`: the router level, already read.
  async function current(cfg, { router } = {}) {
    const [run, [paused], level] = await Promise.all([store.getRun(cfg.workloadId), core.pausesFor(cfg.workloadId), router === undefined ? routerLevel() : router]);
    return workloadOf(cfg, run, paused, level);
  }

  const show = async (id) => current(await find(id));

  async function list() {
    const [configs, router] = await Promise.all([store.listConfigs(), routerLevel()]);
    const workloads = await Promise.all(configs.map((cfg) => current(cfg, { router })));
    return workloads.sort((a, b) => a.id.localeCompare(b.id));
  }

  // Nap and wake now: `act` when the state allows it, nothing when it is there already, else a 409.
  async function move(id, { acts, there, act }) {
    const cfg = await find(id);
    const { state } = (await store.getRun(id)) ?? {};
    if (acts.includes(state)) await act(id, cfg);
    else if (state !== there) throw new Refusal(409, 'busy', `workload ${id} is ${state ?? 'UNKNOWN'}`);
    return current(cfg);
  }

  // Refused at once with its reason, as its task would be.
  async function napUnlessPaused(id) {
    const [paused] = await core.pausesFor(id);
    if (paused) throw new Refusal(409, 'paused', `workload ${id} is paused by ${paused.by}: ${paused.reason}`);
    await core.napNow(id);
  }

  const nap = (id) => move(id, { acts: [STATES.AWAKE], there: STATES.ASLEEP, act: napUnlessPaused });
  const wake = (id) => move(id, { acts: [STATES.ASLEEP, STATES.FAILED, STATES.NAPPING], there: STATES.AWAKE, act: (workloadId) => core.wakeNow(workloadId) });

  // A schedule's answer. One the router cannot read (a time zone Intl refuses) is shown, with no next event.
  function scheduleView(id, schedule) {
    const shown = schedule && { ...schedule, at: isoOf(schedule.at) };
    // No manager here: the workload's value, then the default (design, section 11).
    const { joinMinutes, from } = resolveJoin({ workload: schedule?.joinMinutes });
    const inherited = resolveJoin();
    const join = { joinMinutes, joinFrom: from, joinInherited: { joinMinutes: inherited.joinMinutes, joinFrom: inherited.from } };
    try {
      return { schedule: shown, nextEvents: nextEvents(schedule, now()), ...join };
    } catch (err) {
      log.warn('ScheduleSkipped', { workloadId: id, error: err.message });
      return { schedule: shown, nextEvents: [], ...join };
    }
  }

  async function showSchedule(id) {
    await find(id);
    return scheduleView(id, await store.getSchedule(id));
  }

  // The body is the schedule, as on AWS; `by` says who sets it.
  async function setSchedule(id, schedule) {
    await find(id);
    const problems = scheduleProblems(schedule, { now: now() });
    if (problems.length) throw bad(problems.join('; '));
    const stored = { ...normalizeSchedule(schedule), by: schedule.by ?? 'unknown', at: now() };
    await store.putSchedule(id, stored);
    log.info('Scheduled', { workloadId: id, by: stored.by });
    return scheduleView(id, stored);
  }

  async function clearSchedule(id) {
    await find(id);
    log.info('ScheduleCleared', { workloadId: id, cleared: await store.deleteSchedule(id) });
    return scheduleView(id, null);
  }

  async function pause(id, input) {
    const cfg = await find(id);
    await core.pause(id, input).catch((err) => {
      if (err instanceof PauseRefused) throw bad(err.message);
      throw err;
    });
    return current(cfg);
  }

  async function resume(id, { by } = {}) {
    const cfg = await find(id);
    await core.resume(id, by ?? 'unknown');
    return current(cfg);
  }

  // AWS's settings action for a workload (lambda/src/lib/controller-core.mjs, `setSettings`): `hibernate` (null removes it), the
  // settings of the levels (null gives the key back to the levels, its value without any level written for a router before G5), the
  // rules (null: none) and the type (null: inherited). `by` says who sets them, as a schedule's. A refusal names every problem, with
  // nothing written; a workload offboarded meanwhile is a 404, never written back.
  async function setSettings(id, { by, ...settings }) {
    const cfg = await find(id);
    const problems = workloadProblems(settings, cfg);
    if (problems.length) throw refusedSettings(problems);
    const next = { ...cfg };
    if (Object.hasOwn(settings, 'hibernate')) {
      if (typeof settings.hibernate === 'boolean') next.hibernate = settings.hibernate;
      else delete next.hibernate;
    }
    const scalars = SCALAR_KEYS.filter((key) => Object.hasOwn(settings, key));
    if (scalars.length) {
      // A configuration from before `inherits` is read as effectiveOf reads it (design section 4.1).
      const inherits = new Set(inheritsOf(cfg));
      const builtIn = builtInsOf(cfg);
      for (const key of scalars) {
        if (settings[key] === null) {
          next[key] = builtIn[key];
          inherits.add(key);
        } else {
          next[key] = settings[key];
          inherits.delete(key);
        }
      }
      next.inherits = SCALAR_KEYS.filter((key) => inherits.has(key));
    }
    for (const key of RULE_KEYS) if (Object.hasOwn(settings, key)) next[key] = settings[key] ?? [];
    if (Object.hasOwn(settings, 'type')) {
      if (settings.type === null) delete next.type;
      else next.type = settings.type;
    }
    // The level the answer resolves with, read before the write: a failed read changes nothing.
    const router = await routerLevel();
    if (!(await store.putConfig(id, next, { mustExist: true }))) throw notFound(id);
    log.info('WorkloadSettings', { workloadId: id, keys: Object.keys(settings), hibernate: next.hibernate ?? null, previous: cfg.hibernate ?? null, by: by ?? 'unknown' });
    return { level: 'workload', settings: { ...settings }, hibernation: hibernationOf(next, router), resolved: resolvedOf(effectiveOf(next, { router })) };
  }

  const routerSettings = async () => ({ level: 'router', settings: routerSettingsView(await routerLevel()) });

  // AWS's settings action without a workload: `hibernate`, `joinMinutes` and the `defaults` of the router's workloads, merged with
  // what it holds (what is not sent stays, a key of the defaults sent null goes, `defaults: null` clears them); none left, no record.
  // An empty body reads. `by` says who sets them, as a schedule's. A refusal names every problem, with nothing written.
  async function setRouterSettings({ by, ...settings }) {
    const problems = routerProblems(settings);
    if (problems.length) throw refusedSettings(problems);
    // A record that cannot be read is not written over.
    const stored = await routerLevel();
    if (!Object.keys(settings).length) return { level: 'router', settings: routerSettingsView(stored) };
    const sent = (name) => (Object.hasOwn(settings, name) ? settings[name] : stored?.[name] ?? null);
    const merged = !Object.hasOwn(settings, 'defaults') ? stored?.defaults ?? null
      : settings.defaults === null ? null
        : Object.fromEntries(Object.entries({ ...stored?.defaults, ...settings.defaults }).filter(([, value]) => value !== null));
    const defaults = merged && Object.keys(merged).length ? merged : null;
    const record = { hibernate: sent('hibernate'), joinMinutes: sent('joinMinutes'), defaults, by: by ?? 'unknown', at: now() };
    await store.putRouterSettings(record);
    log.info('RouterSettings', { hibernate: record.hibernate, joinMinutes: record.joinMinutes, defaults: defaults ? Object.keys(defaults) : [], by: record.by });
    return { level: 'router', settings: routerSettingsView(record.hibernate === null && record.joinMinutes === null && !defaults ? null : record) };
  }

  return {
    dryRun, onboard, offboard, find, show, list, nap, wake, showSchedule, setSchedule, clearSchedule, pause, resume, setSettings, routerSettings, setRouterSettings,
  };
}
