// A workload's onboarding and offboarding on the router, its list, show, and nap and wake now (vision
// docs/specs/2026-10-29-google-cloud-design.md, sections 5 and 7). The tags are the CLI's, as the operator: the router holds
// no tag permission, so it neither binds them nor can see them.
//
// A refusal is a `Refusal`: its status and short reason are the API's, its message is what is wrong and what to change.
// Anything else thrown is a failure, a 500 for the caller.
import { STATES } from '../../lambda/src/lib/state.mjs';
import { WORKLOAD_HEADER, WORKLOAD_ID } from './names.mjs';
import { hostsOf, references, UrlMapRefused, withErrorPolicy, withoutErrorPolicy, withWakerRoute, withoutWakerRoute } from './urlmaps.mjs';

const COMPUTE = 'https://compute.googleapis.com/compute/v1';
const SCHEME = 'EXTERNAL_MANAGED';
const CLASSIC = 'EXTERNAL';
const NOT_MANAGED = `only the global external Application Load Balancer (${SCHEME}) is supported, migrate it first`;
const NAME = /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/;
const NAME_MAX = 63;
const LOCAL_SSD = 'SCRATCH';
const INSTANCE_GROUP = /\/(zones|regions)\/([^/]+)\/instanceGroups\/([^/]+)$/;
const DEFAULTS = { idleMinutes: 15, wakeTimeoutSeconds: 600, failedRetrySeconds: 60, pollSeconds: 3 };
// What the CLI's flags set, with AWS's ranges (lambda/src/lib/onboarding.mjs).
const RANGES = { idleMinutes: [5, 1440], waitSeconds: [5, 120] };
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
    if (!RANGES[key]) return [`settings: unknown setting ${key}`];
    const [min, max] = RANGES[key];
    return Number.isInteger(value) && value >= min && value <= max ? [] : [`settings: ${key} must be an integer from ${min} to ${max}`];
  });
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

// The API's Workload. `awakeSince` is a time the CLI prints, and left on the run by a nap.
function workloadOf(cfg, run) {
  const failure = failureOf(run);
  return {
    id: cfg.workloadId,
    state: run?.state ?? 'UNKNOWN',
    urlMap: cfg.urlMap,
    backendService: cfg.backendService,
    wakerBackendService: cfg.wakerBackendService,
    hosts: cfg.hosts,
    settings: Object.fromEntries(SETTINGS.filter((name) => cfg[name] !== undefined).map((name) => [name, cfg[name]])),
    backends: cfg.backends,
    ...(run?.state === STATES.AWAKE && run.awakeSince !== undefined ? { awakeSince: isoOf(run.awakeSince) } : {}),
    ...(run?.lastWake ? { lastWake: run.lastWake } : {}),
    ...(failure ? { failure } : {}),
  };
}

export function createOnboarding({ store, compute, urlmaps, core, config, now = Date.now, log }) {
  const wakerName = (id) => `dmtr-${config.region}-${id}`;
  const wakerUrl = (name) => `${COMPUTE}/projects/${config.project}/global/backendServices/${name}`;
  const wakerHeader = (id) => `${WORKLOAD_HEADER}: ${id}`;

  // The request's fields, or a 400. Without an ID, the backend service's name, when it is one.
  function requested({ urlMap, backendService, id, settings = {} }) {
    if (!urlMap || !backendService) throw bad('urlMap and backendService are needed');
    for (const [key, value] of Object.entries({ urlMap, backendService })) {
      if (typeof value !== 'string' || !NAME.test(value)) throw bad(`${key}: ${JSON.stringify(value)} is not a Compute Engine name`);
    }
    const workloadId = checkedId(id || backendService);
    const waker = wakerName(workloadId);
    if (waker.length > NAME_MAX) throw bad(`workload ID ${workloadId} would name the waker backend service ${waker}, longer than the ${NAME_MAX} characters of a Compute Engine name: use a shorter one`);
    const problems = settingsProblems(settings);
    if (problems.length) throw bad(problems.join('; '));
    return { id: workloadId, urlMap, backendService, settings };
  }

  // The URL map's load balancer: one target proxy, and forwarding rules of the right scheme.
  async function loadBalancerProblems(urlMap) {
    const [https, http, rules] = await Promise.all([compute.listTargetHttpsProxies(), compute.listTargetHttpProxies(), compute.listForwardingRules()]);
    const proxies = [...https, ...http].filter((p) => nameOf(p.urlMap ?? '') === urlMap);
    if (!proxies.length) return [`URL map ${urlMap} is used by no target proxy: attach it to a global external Application Load Balancer, then onboard again`];
    if (proxies.length > 1) return [`URL map ${urlMap} is used by ${proxies.length} target proxies (${proxies.map((p) => p.name).join(', ')}): give each load balancer its own URL map`];
    const fronts = rules.filter((r) => proxyOf(r.target ?? '') === proxyOf(proxies[0].selfLink));
    if (!fronts.length) return [`no forwarding rule sends to the target proxy of URL map ${urlMap}: add one, then onboard again`];
    return fronts.filter((r) => r.loadBalancingScheme !== SCHEME).map((r) => {
      const classic = r.loadBalancingScheme === CLASSIC ? ', a classic load balancer' : '';
      return `forwarding rule ${r.name} has the scheme ${r.loadBalancingScheme}${classic}: ${NOT_MANAGED}`;
    });
  }

  // What the nap and the route would write, tried on the map as it is.
  function mapProblems(map, backendService, waker) {
    const attempts = [
      [withErrorPolicy, 'a nap would replace it, remove it first'],
      [withWakerRoute, 'change that, then onboard again'],
    ];
    return attempts.flatMap(([write, advice]) => {
      try {
        write(map, backendService, waker);
        return [];
      } catch (err) {
        if (!(err instanceof UrlMapRefused)) throw err;
        return [`${err.message}: ${advice}`];
      }
    });
  }

  // A backend of the service: `{ reasons, members (its VMs' URLs), group? }`, `group` when it is a managed one.
  async function backendOf({ group: url }, service) {
    const place = INSTANCE_GROUP.exec(url ?? '');
    if (!place) return { reasons: [`backend ${nameOf(url ?? '')} of backend service ${service} is a network endpoint group: only instance groups are supported (unmanaged, managed zonal or regional)`], members: [] };
    const [, scope, location, name] = place;
    const group = { kind: scope === 'regions' ? 'regional' : 'zonal', location, name };
    const managed = await compute.getManagedGroup(group).catch(absent);
    const members = managed
      ? (await compute.listManagedInstances(group)).map((m) => m.instance)
      : (await compute.listGroupInstances(location, name)).map((m) => m.instance);
    const reasons = [];
    if (!members.length) reasons.push(`instance group ${name} has no VM: add one, then onboard again`);
    if (managed?.status?.stateful?.hasStatefulConfig) reasons.push(`managed group ${name} has a stateful configuration: a nap might not keep it, take the group out of the backend service`);
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
    const machineTypes = new Map();
    // One read per VM, a VM in two groups of the service being one VM. A group lists a VM it is still creating.
    const read = await Promise.all([...new Set(backends.flatMap((b) => b.members))].map(async (url) => {
      const zone = zoneOf(url);
      const vm = await compute.getInstance(zone, nameOf(url)).catch(absent);
      return vm && { url, zone, vm, problems: await vmProblems(vm, zone, machineTypes) };
    }));
    const vms = [];
    for (const { url, zone, vm, problems } of read.filter(Boolean)) {
      reasons.push(...problems);
      if (!unmanaged.has(url)) continue;
      const holder = holderOf('vm', zone, vm.name);
      if (holder) reasons.push(`VM ${vm.name} belongs to workload ${holder.workloadId}`);
      vms.push({ zone, name: vm.name, selfLink: vm.selfLink, id: String(vm.id) });
    }
    return { reasons, vms, groups };
  }

  // Section 7: why the workload cannot be onboarded, and its VMs and groups. Reads only.
  async function inspect({ id, urlMap, backendService }) {
    const reasons = [];
    const configs = await store.listConfigs();
    const others = configs.filter((c) => c.workloadId !== id);
    if (others.length < configs.length) reasons.push(`workload ${id} is onboarded already`);
    const owner = others.find((c) => c.backendService === backendService);
    if (owner) reasons.push(`backend service ${backendService} is already workload ${owner.workloadId}`);
    const [map, service] = await Promise.all([urlmaps.get(urlMap).catch(absent), compute.getBackendService(backendService).catch(absent)]);
    if (!map) reasons.push(`URL map ${urlMap} not found: name a global URL map of this project`);
    else reasons.push(...await loadBalancerProblems(urlMap));
    if (!service) reasons.push(`backend service ${backendService} not found: name a global backend service of this project`);
    if (!map || !service) return { reasons, vms: [], groups: [] };

    if (service.loadBalancingScheme !== SCHEME) reasons.push(`backend service ${backendService} has the scheme ${service.loadBalancingScheme}: ${NOT_MANAGED}`);
    if (!references(map, backendService).length) reasons.push(`backend service ${backendService} is not named in URL map ${urlMap}: route to it there, or name the URL map that does`);
    for (const other of await urlmaps.list()) {
      if (other.name !== urlMap && references(other, backendService).length) {
        reasons.push(`backend service ${backendService} is also named in URL map ${other.name}: that load balancer would lose its backends during a nap; give it a backend service of its own`);
      }
    }
    if (!service.healthChecks?.length) reasons.push(`backend service ${backendService} has no health check: a wake waits for a healthy instance, add one`);
    if (!service.backends?.length) reasons.push(`backend service ${backendService} has no backend: add an instance group, then onboard again`);

    const waker = wakerName(id);
    reasons.push(...mapProblems(map, backendService, wakerUrl(waker)));
    const existing = await compute.getBackendService(waker).catch(absent);
    if (existing && !existing.customRequestHeaders?.includes(wakerHeader(id))) reasons.push(`backend service ${waker} exists and is not the waker of ${id}: rename it, or onboard under another id`);

    const backends = await backendsOf(service, others);
    reasons.push(...backends.reasons);
    return { reasons, vms: backends.vms, groups: backends.groups, hosts: hostsOf(map, backendService), wakerExists: Boolean(existing) };
  }

  async function dryRun(input) {
    const { reasons, vms, groups } = await inspect(requested(input));
    return { eligible: reasons.length === 0, reasons, vms, groups };
  }

  // The route and the policy in one update, then the waker backend service. What is gone already is no failure.
  async function removeFromGoogle({ urlMap, wakerBackendService: name }) {
    const waker = wakerUrl(name);
    await urlmaps.modify(urlMap, (map) => {
      const policy = withoutErrorPolicy(map, waker);
      const route = withoutWakerRoute(policy.map, waker);
      return { map: route.map, paths: [...policy.paths, ...route.paths] };
    }).catch(absent);
    await compute.deleteBackendService(name).catch(absent);
  }

  // Nothing of a failed onboarding stays: a waker backend service left would keep the NEG from being uninstalled.
  async function undo(id, urlMap, wakerBackendService, cause) {
    try {
      await removeFromGoogle({ urlMap, wakerBackendService });
      await store.deleteWorkload(id);
      log.warn('OnboardUndone', { workloadId: id, error: cause.message });
    } catch (err) {
      log.error('OnboardNotUndone', { workloadId: id, error: err.message, cause: cause.message });
    }
  }

  async function onboard(input) {
    const { id, urlMap, backendService, settings } = requested(input);
    if (await store.getConfig(id)) throw new Refusal(409, 'exists', `workload ${id} is onboarded already`);
    const { reasons, vms, groups, hosts, wakerExists } = await inspect({ id, urlMap, backendService });
    if (reasons.length) throw new Refusal(400, 'not-eligible', `cannot onboard ${id}: ${reasons.join('; ')}`);
    const name = wakerName(id);
    const cfg = {
      workloadId: id,
      urlMap,
      backendService,
      wakerBackendService: name,
      hosts,
      backends: [
        ...vms.map((vm) => ({ kind: 'vm', location: vm.zone, name: vm.name, id: vm.id })),
        ...groups.map((g) => ({ kind: 'mig', location: g.location, name: g.name, id: g.id })),
      ],
      ...DEFAULTS,
      ...settings,
      onboardedAt: isoOf(now()),
    };
    try {
      if (!wakerExists) {
        await compute.insertBackendService({
          name,
          loadBalancingScheme: SCHEME,
          protocol: 'HTTPS',
          backends: [{ group: `${COMPUTE}/projects/${config.project}/regions/${config.region}/networkEndpointGroups/${config.wakerNeg}` }],
          customRequestHeaders: [wakerHeader(id)],
        });
      }
      await urlmaps.modify(urlMap, (map) => withWakerRoute(map, backendService, wakerUrl(name)));
      await store.putConfig(id, cfg);
      await store.initRun(id, now());
    } catch (err) {
      await undo(id, urlMap, name, err);
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
    if (state !== STATES.AWAKE) throw new Refusal(409, 'wake-failed', `cannot offboard ${id}: its wake failed: ${error ?? state}; fix that, or try again`);
  }

  // An offboarding that stops keeps the documents: they name what is left to remove when it runs again.
  async function offboard(id) {
    const cfg = await find(id);
    let run = await store.getRun(id);
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
  }

  async function show(id) {
    const cfg = await find(id);
    return workloadOf(cfg, await store.getRun(id));
  }

  async function list() {
    const configs = await store.listConfigs();
    const workloads = await Promise.all(configs.map(async (cfg) => workloadOf(cfg, await store.getRun(cfg.workloadId))));
    return workloads.sort((a, b) => a.id.localeCompare(b.id));
  }

  // Nap and wake now: `act` when the state allows it, nothing when it is there already, else a 409.
  async function move(id, { acts, there, act }) {
    const cfg = await find(id);
    const { state } = (await store.getRun(id)) ?? {};
    if (acts.includes(state)) await act(id);
    else if (state !== there) throw new Refusal(409, 'busy', `workload ${id} is ${state ?? 'UNKNOWN'}`);
    return workloadOf(cfg, await store.getRun(id));
  }

  const nap = (id) => move(id, { acts: [STATES.AWAKE], there: STATES.ASLEEP, act: core.napNow });
  const wake = (id) => move(id, { acts: [STATES.ASLEEP, STATES.FAILED, STATES.NAPPING], there: STATES.AWAKE, act: core.wakeNow });

  return { dryRun, onboard, offboard, find, show, list, nap, wake };
}
