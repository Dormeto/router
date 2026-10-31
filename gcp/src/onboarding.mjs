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
import { nextEvents, normalizeSchedule, scheduleProblems } from '../../lambda/src/lib/schedule.mjs';
import { STATES } from '../../lambda/src/lib/state.mjs';
import { groupOf, PauseRefused } from './controller-core.mjs';
import { SWITCH_HEADER, WORKLOAD_HEADER, WORKLOAD_ID } from './names.mjs';
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
// What GKE writes in the NEGs it makes (the annotations, or the description), and the prefix of their names.
const GKE_NEG = /cluster-(uid|name)/i;
const GKE_NEG_PREFIX = 'k8s1-';
const MANAGED_GROUP_OWNER = /\/instanceGroupManagers\/([^/]+)$/;
const DEFAULTS = { idleMinutes: 15, failedRetrySeconds: 60, pollSeconds: 3 };
const VMS_WAKE_SECONDS = 600;
// What an explicit wake's timeout must leave, beyond its URL map's change, under a swap: for the VMs to start at all.
const SWAP_WAKE_ROOM_SECONDS = 60;
// What the CLI's flags set, with AWS's ranges (lambda/src/lib/onboarding.mjs); the wake's fits the controller's request.
const RANGES = { idleMinutes: [5, 1440], waitSeconds: [5, 120], wakeTimeoutSeconds: [60, 1700] };
// What a Workload shows of its configuration.
const SETTINGS = ['idleMinutes', 'waitSeconds', 'wakeTimeoutSeconds', 'hibernate'];

export class Refusal extends Error {
  constructor(status, reason, message) {
    super(message);
    this.name = 'Refusal';
    this.status = status;
    this.reason = reason;
  }
}

const bad = (message) => new Refusal(400, 'bad-request', message);
const nameOf = (url) => url.slice(url.lastIndexOf('/') + 1);
const zoneOf = (url) => /\/zones\/([^/]+)\//.exec(url)?.[1];
// A proxy's URL without what differs between Google's answers, as a forwarding rule's target names it.
const proxyOf = (url) => url.split('/').slice(-2).join('/');
const isoOf = (ms) => new Date(ms).toISOString();
const isSwapped = (lb) => Object.hasOwn(SWAP_WAIT_MS, lb.kind);
const isRegional = (lb) => lb.kind === 'regional';
// The map's change is included in the wake's time.
const defaultWakeSeconds = (lb) => Math.min(VMS_WAKE_SECONDS + (isSwapped(lb) ? SWAP_WAIT_MS[lb.kind] / 1000 : 0), RANGES.wakeTimeoutSeconds[1]);

// A read's 404, as `.catch(absent)`: null.
const absent = (err) => {
  if (err?.code !== 404) throw err;
  return null;
};

function checkedId(id) {
  if (typeof id !== 'string' || !WORKLOAD_ID.test(id)) throw bad(`workload ID ${JSON.stringify(id)} does not match ${WORKLOAD_ID.source}`);
  return id;
}

function settingsProblems(settings) {
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) return ['settings: must be an object'];
  return Object.entries(settings).flatMap(([key, value]) => {
    if (key === 'hibernate') return typeof value === 'boolean' ? [] : ['settings: hibernate must be true or false'];
    if (!Object.hasOwn(RANGES, key)) return [`settings: unknown setting ${key}`];
    const [min, max] = RANGES[key];
    return Number.isInteger(value) && value >= min && value <= max ? [] : [`settings: ${key} must be an integer from ${min} to ${max}`];
  });
}

// The map's change is included in the wake: a timeout that leaves it no room is a wake that always fails.
function swapTimeoutProblems({ wakeTimeoutSeconds: asked }, lb) {
  if (asked === undefined || !isSwapped(lb)) return [];
  const change = SWAP_WAIT_MS[lb.kind] / 1000;
  const lowest = change + SWAP_WAKE_ROOM_SECONDS;
  return asked > lowest ? [] : [`settings: wakeTimeoutSeconds ${asked} is too short for a ${lb.kind} load balancer: its wake includes the URL map's change, ${change} s: use more than ${lowest}`];
}

function failureOf(run) {
  if (!run?.failure) return null;
  try {
    const failure = JSON.parse(run.failure);
    return { ...failure, ...(failure.at === undefined ? {} : { at: isoOf(failure.at) }) };
  } catch {
    return null;
  }
}

// The API's Workload. `awakeSince` is a time the CLI prints, and left on the run by a nap. `paused`: its active pause.
function workloadOf(cfg, run, paused) {
  const failure = failureOf(run);
  return {
    id: cfg.workloadId,
    state: run?.state ?? 'UNKNOWN',
    urlMap: cfg.urlMap,
    backendService: cfg.backendService,
    wakerBackendService: cfg.wakerBackendService,
    hosts: cfg.hosts,
    lb: cfg.lb ?? GLOBAL_LB,
    settings: Object.fromEntries(SETTINGS.filter((name) => cfg[name] !== undefined).map((name) => [name, cfg[name]])),
    backends: cfg.backends,
    ...(run?.state === STATES.AWAKE && run.awakeSince !== undefined ? { awakeSince: isoOf(run.awakeSince) } : {}),
    ...(run?.lastWake ? { lastWake: run.lastWake } : {}),
    ...(failure ? { failure } : {}),
    ...(paused ? { paused } : {}),
  };
}

export function createOnboarding({ store, compute, urlmaps, regionalUrlmaps, core, config, now = Date.now, log }) {
  const wakerName = (id) => `dmtr-${config.region}-${id}`;
  const wakerUrl = (name, lb) => `${COMPUTE}/projects/${config.project}/${isRegional(lb) ? `regions/${lb.region}` : 'global'}/backendServices/${name}`;
  const wakerHeaders = (id, lb) => [`${WORKLOAD_HEADER}: ${id}`, ...(isSwapped(lb) ? [`${SWITCH_HEADER}: swap`] : [])];
  const mapsOf = (lb) => (isRegional(lb) ? regionalUrlmaps : urlmaps);
  const getService = (name, lb) => (isRegional(lb) ? compute.getRegionBackendService(lb.region, name) : compute.getBackendService(name));
  const deleteService = (name, lb) => (isRegional(lb) ? compute.deleteRegionBackendService(lb.region, name) : compute.deleteBackendService(name));
  const insertService = (body, lb) => (isRegional(lb) ? compute.insertRegionBackendService(lb.region, body) : compute.insertBackendService(body));

  // The request's fields, or a 400. Without an ID, the backend service's name, when it is one.
  function requested({ urlMap, backendService, id, settings = {}, loadBalancer }) {
    if (!urlMap || !backendService) throw bad('urlMap and backendService are needed');
    for (const [key, value] of Object.entries({ urlMap, backendService })) {
      if (typeof value !== 'string' || !NAME.test(value)) throw bad(`${key}: ${JSON.stringify(value)} is not a Compute Engine name`);
    }
    if (loadBalancer !== undefined && !['global', 'regional', 'classic'].includes(loadBalancer)) throw bad(`loadBalancer: ${JSON.stringify(loadBalancer)} is not global, regional or classic`);
    const workloadId = checkedId(id || backendService);
    const waker = wakerName(workloadId);
    if (waker.length > NAME_MAX) throw bad(`workload ID ${workloadId} would name the waker backend service ${waker}, longer than the ${NAME_MAX} characters of a Compute Engine name: use a shorter one`);
    const problems = settingsProblems(settings);
    if (problems.length) throw bad(problems.join('; '));
    return { id: workloadId, urlMap, backendService, settings, loadBalancer };
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

  // The URL map's load balancer: one target proxy, and forwarding rules whose scheme tells a global from a classic one.
  // `{ kind, reasons }`, `kind` null when there is nothing supported to tell it from.
  async function loadBalancerOf(urlMap, regional, asked) {
    const [https, http, rules] = await Promise.all(regional
      ? [compute.listRegionTargetHttpsProxies(config.region), compute.listRegionTargetHttpProxies(config.region), compute.listRegionForwardingRules(config.region)]
      : [compute.listTargetHttpsProxies(), compute.listTargetHttpProxies(), compute.listForwardingRules()]);
    const refused = (...reasons) => ({ kind: null, reasons });
    const proxies = [...https, ...http].filter((p) => nameOf(p.urlMap ?? '') === urlMap);
    if (!proxies.length) return refused(`URL map ${urlMap} is used by no target proxy: attach it to an external Application Load Balancer, then onboard again`);
    if (proxies.length > 1) return refused(`URL map ${urlMap} is used by ${proxies.length} target proxies (${proxies.map((p) => p.name).join(', ')}): give each load balancer its own URL map`);
    const fronts = rules.filter((r) => proxyOf(r.target ?? '') === proxyOf(proxies[0].selfLink));
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
  function mapProblems(map, backendService, waker, lb) {
    if (!references(map, backendService).length) return [];
    const problems = [];
    const tried = (write, on, advice) => {
      try {
        return write(on, backendService, waker).map;
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
    if (name.startsWith(GKE_NEG_PREFIX) || GKE_NEG.test(neg.description ?? '') || Object.keys(neg.annotations ?? {}).some((key) => GKE_NEG.test(key))) {
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
    return { reasons, members, ...(managed ? { group: { ...group, selfLink: managed.selfLink, id: String(managed.id) } } : {}) };
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
    for (const { url, zone, vm, problems } of read.filter(Boolean)) {
      reasons.push(...problems);
      const owner = negsOf.has(url) && MANAGED_GROUP_OWNER.exec(vm.metadata?.items?.find((item) => item.key === 'created-by')?.value ?? '')?.[1];
      if (owner) reasons.push(`VM ${vm.name} is a member of managed group ${owner}, which would repair it once stopped: put the managed group in the backend service instead of its VM in a network endpoint group`);
      if (!unmanaged.has(url)) continue;
      const holder = holderOf('vm', zone, vm.name);
      if (holder) reasons.push(`VM ${vm.name} belongs to workload ${holder.workloadId}`);
      vms.push({ zone, name: vm.name, selfLink: vm.selfLink, id: String(vm.id) });
      if (negsOf.has(url)) negs[vm.name] = negsOf.get(url);
    }
    return { reasons, vms, groups, negs };
  }

  // Section 7: why the workload cannot be onboarded, its load balancer (`lb`, none when it cannot be told), its VMs and groups. Reads only.
  async function inspect({ id, urlMap, backendService, loadBalancer, settings }) {
    const reasons = [];
    const configs = await store.listConfigs();
    const others = configs.filter((c) => c.workloadId !== id);
    if (others.length < configs.length) reasons.push(`workload ${id} is onboarded already`);
    const nothing = { vms: [], groups: [], negs: {} };
    const { map, regional, reason } = await findMap(urlMap, loadBalancer);
    if (!map) return { reasons: [...reasons, reason], ...nothing };
    const front = await loadBalancerOf(urlMap, regional, loadBalancer);
    reasons.push(...front.reasons);
    const kind = front.kind ?? (regional ? 'regional' : loadBalancer ?? 'global');
    const lb = regional ? { kind, region: config.region } : { kind };
    const told = front.kind ? { lb } : {};
    if (front.kind) reasons.push(...swapTimeoutProblems(settings, lb));

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
    reasons.push(...mapProblems(map, backendService, wakerUrl(waker, lb), lb));
    const existing = await getService(waker, lb).catch(absent);
    const headers = wakerHeaders(id, lb);
    if (existing && (existing.customRequestHeaders?.length !== headers.length || !headers.every((h) => existing.customRequestHeaders.includes(h)))) {
      reasons.push(`backend service ${waker} exists and is not the waker of ${id}: rename it, or onboard under another id`);
    }

    const backends = await backendsOf(service, others);
    reasons.push(...backends.reasons);
    return { reasons, ...told, vms: backends.vms, groups: backends.groups, negs: backends.negs, hosts: hostsOf(map, backendService), wakerExists: Boolean(existing) };
  }

  async function dryRun(input) {
    const { reasons, vms, groups, lb } = await inspect(requested(input));
    return { eligible: reasons.length === 0, reasons, vms, groups, ...(lb ? { lb } : {}) };
  }

  // In one update, then the waker backend service: the route and the policy; under a swap, the application back wherever the map
  // is still swapped, the hold route and the route. What is gone already is no failure.
  async function removeFromGoogle({ urlMap, backendService, wakerBackendService: name, lb = GLOBAL_LB }) {
    const waker = wakerUrl(name, lb);
    await mapsOf(lb).modify(urlMap, (map) => {
      const steps = isSwapped(lb)
        ? [(m) => withoutSwap(m, backendService, waker), (m) => withoutHoldRoute(m, backendService, waker), (m) => withoutWakerRoute(m, waker)]
        : [(m) => withoutErrorPolicy(m, waker), (m) => withoutWakerRoute(m, waker)];
      return inOneUpdate(map, steps);
    }).catch(absent);
    await deleteService(name, lb).catch(absent);
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
    const { id, urlMap, backendService, settings, loadBalancer } = requested(input);
    if (await store.getConfig(id)) throw new Refusal(409, 'exists', `workload ${id} is onboarded already`);
    const { reasons, vms, groups, negs, hosts, wakerExists, lb } = await inspect({ id, urlMap, backendService, loadBalancer, settings });
    if (reasons.length) throw new Refusal(400, 'not-eligible', `cannot onboard ${id}: ${reasons.join('; ')}`);
    const name = wakerName(id);
    const waker = wakerUrl(name, lb);
    const cfg = {
      workloadId: id,
      urlMap,
      backendService,
      wakerBackendService: name,
      hosts,
      ...(lb.kind === 'global' ? {} : { lb }),
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
      ],
      ...DEFAULTS,
      wakeTimeoutSeconds: defaultWakeSeconds(lb),
      ...settings,
      onboardedAt: isoOf(now()),
    };
    try {
      if (!wakerExists) {
        // M4 (the coverage design's section 10) has not been measured: a classic backend service with EXTERNAL and a regional one, on
        // the router's serverless NEG, with two custom request headers, are as the design has them, unconfirmed by Google.
        await insertService({
          name,
          loadBalancingScheme: SCHEME_OF[lb.kind],
          protocol: 'HTTPS',
          backends: [{ group: `${COMPUTE}/projects/${config.project}/regions/${config.region}/networkEndpointGroups/${config.wakerNeg}` }],
          customRequestHeaders: wakerHeaders(id, lb),
        }, lb);
      }
      await mapsOf(lb).modify(urlMap, (map) => inOneUpdate(map, isSwapped(lb)
        ? [(m) => withWakerRoute(m, backendService, waker), (m) => withHoldRoute(m, backendService, waker)]
        : [(m) => withWakerRoute(m, backendService, waker)]));
      await store.putConfig(id, cfg);
      await store.initRun(id, now());
    } catch (err) {
      await undo(cfg, err);
      if (err instanceof UrlMapRefused) throw new Refusal(400, 'not-eligible', `cannot onboard ${id}: ${err.message}`);
      throw err;
    }
    log.info('Onboarded', { workloadId: id, urlMap, backendService });
    return workloadOf(cfg, await store.getRun(id));
  }

  // The configuration, or a 400 or a 404.
  async function find(id) {
    const cfg = await store.getConfig(checkedId(id));
    if (!cfg) throw new Refusal(404, 'not-found', `no workload ${id}`);
    return cfg;
  }

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
      const statuses = backend.kind === 'mig'
        ? (await compute.listManagedInstances(groupOf(backend))).map((m) => m.instanceStatus)
        : [(await compute.getInstance(backend.location, backend.name)).status];
      return statuses.length > 0 && statuses.every((status) => status === 'RUNNING');
    } catch (err) {
      log.warn('BackendUnread', { workloadId, backend: backend.name, error: err.message });
      return false;
    }
  }

  // A workload that cannot wake, or whose state is stuck: no wake, and all of Dormeto's goes. The backends stay as they are,
  // and those not up are named. A nap in flight finds its waker backend service gone before it would stop anything, unless
  // it is already stopping them.
  async function forceOff(cfg, run) {
    const { workloadId } = cfg;
    const up = await Promise.all(cfg.backends.map((backend) => isUp(backend, workloadId)));
    const left = cfg.backends.filter((_, i) => !up[i]);
    await Promise.all((run?.autoscalers ?? []).map((a) => compute.setAutoscalerMode(a, a.mode).catch((err) => {
      log.warn('AutoscalerNotGivenBack', { workloadId, autoscaler: a.name, mode: a.mode, error: err.message });
    })));
    await removeFromGoogle(cfg);
    await store.deleteWorkload(workloadId);
    log.warn('Offboarded', { workloadId, force: true, left: left.map((backend) => backend.name) });
    return { id: workloadId, left };
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
    await Promise.all((run?.autoscalers ?? []).map((a) => compute.setAutoscalerMode(a, a.mode)));
    await removeFromGoogle(cfg);
    await store.deleteWorkload(id);
    log.info('Offboarded', { workloadId: id });
    return {};
  }

  // The Workload as it is now.
  async function current(cfg) {
    const [run, [paused]] = await Promise.all([store.getRun(cfg.workloadId), core.pausesFor(cfg.workloadId)]);
    return workloadOf(cfg, run, paused);
  }

  const show = async (id) => current(await find(id));

  async function list() {
    const workloads = await Promise.all((await store.listConfigs()).map(current));
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
    try {
      return { schedule: shown, nextEvents: nextEvents(schedule, now()) };
    } catch (err) {
      log.warn('ScheduleSkipped', { workloadId: id, error: err.message });
      return { schedule: shown, nextEvents: [] };
    }
  }

  async function showSchedule(id) {
    await find(id);
    return scheduleView(id, await store.getSchedule(id));
  }

  // The body is the schedule, as on AWS; `by` says who sets it.
  async function setSchedule(id, schedule) {
    await find(id);
    const problems = scheduleProblems(schedule);
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

  return { dryRun, onboard, offboard, find, show, list, nap, wake, showSchedule, setSchedule, clearSchedule, pause, resume };
}
