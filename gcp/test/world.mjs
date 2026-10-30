// A project as the controller sees it, for the onboarding's and the API's tests: the real adapters and the real core over
// a fake of Compute Engine's REST API and a store of several workloads. `changes`: what was changed at Google, in order.
import { matches, STATES } from '../../lambda/src/lib/state.mjs';
import { fakeClock } from '../../lambda/test/fakes.mjs';
import { createCompute } from '../src/compute.mjs';
import { createController } from '../src/controller-core.mjs';
import { GoogleError } from '../src/google.mjs';
import { createOnboarding } from '../src/onboarding.mjs';
import { createUrlMaps } from '../src/urlmaps.mjs';

export const V1 = 'https://compute.googleapis.com/compute/v1/projects/p';
export const ZONE = 'europe-west1-b';
export const REGION = 'europe-west1';
export const NEG = 'dmtr-europe-west1-waker';
export const WAKER = 'dmtr-europe-west1-demo';
export const WAKER_URL = `${V1}/global/backendServices/${WAKER}`;
export const CONTROLLER = 'https://dmtr-europe-west1-controller-123.europe-west1.run.app';

export const serviceUrl = (name) => `${V1}/global/backendServices/${name}`;
export const unmanagedUrl = (name) => `${V1}/zones/${ZONE}/instanceGroups/${name}`;
const vmUrl = (name, zone = ZONE) => `${V1}/zones/${zone}/instances/${name}`;

// One URL map `lb` with a host and a matcher naming `app`, whose backend is the unmanaged group `ig` of the VM `vm-a`.
export const defaults = () => ({
  urlMaps: {
    lb: {
      name: 'lb',
      fingerprint: 'f1',
      defaultService: serviceUrl('other'),
      hostRules: [{ hosts: ['demo.example.com'], pathMatcher: 'm' }],
      pathMatchers: [{ name: 'm', defaultService: serviceUrl('app') }],
    },
  },
  httpsProxies: [{ name: 'lb-https', selfLink: `${V1}/global/targetHttpsProxies/lb-https`, urlMap: `${V1}/global/urlMaps/lb` }],
  httpProxies: [],
  forwardingRules: [{ name: 'lb-fr', target: `${V1}/global/targetHttpsProxies/lb-https`, loadBalancingScheme: 'EXTERNAL_MANAGED' }],
  services: {
    app: { name: 'app', loadBalancingScheme: 'EXTERNAL_MANAGED', healthChecks: [`${V1}/global/healthChecks/hc`], backends: [{ group: unmanagedUrl('ig') }] },
    other: { name: 'other', loadBalancingScheme: 'EXTERNAL_MANAGED', healthChecks: [`${V1}/global/healthChecks/hc`], backends: [] },
  },
  unmanaged: { ig: ['vm-a'] },
  managed: {},
  vms: { 'vm-a': { id: '1001', status: 'RUNNING' } },
  machineTypes: { 'e2-small': { name: 'e2-small', memoryMb: 2048 } },
  autoscalers: {},
});

const notFound = (what) => new GoogleError(`Google: ${what}: 404 not found`, { code: 404, status: 'NOT_FOUND', reason: 'notFound' });

// `change(world)`: what differs from the defaults. `fail['<method> <path>']` refuses that call, `on[...]` runs before it.
export function setup(change = () => {}) {
  const clock = fakeClock();
  const w = { ...defaults(), changes: [], tasks: [], fail: {}, on: {}, logs: [], used: new Set() };
  change(w);
  const instance = (name) => {
    const vm = w.vms[name];
    if (!vm) throw notFound(`instance ${name}`);
    const zone = vm.zone ?? ZONE;
    return { name, zone: `${V1}/zones/${zone}`, selfLink: vmUrl(name, zone), machineType: `${V1}/zones/${zone}/machineTypes/e2-small`, disks: [{ type: 'PERSISTENT' }], ...vm };
  };
  const STATUS = { start: 'RUNNING', stop: 'TERMINATED', suspend: 'SUSPENDED', resume: 'RUNNING' };
  const done = (line) => {
    if (line) w.changes.push(line);
    return { status: 'DONE' };
  };
  const managed = (kind, location, name) => {
    const group = w.managed[name];
    if (!group || group.location !== location || (kind === 'regions') !== (group.kind === 'regional')) throw notFound(`group ${name}`);
    return group;
  };
  const ROUTES = [
    ['GET', /^global\/urlMaps$/, () => ({ items: Object.values(w.urlMaps) })],
    ['GET', /^global\/urlMaps\/([^/]+)$/, ([name]) => {
      if (!w.urlMaps[name]) throw notFound(`URL map ${name}`);
      return w.urlMaps[name];
    }],
    ['PUT', /^global\/urlMaps\/([^/]+)$/, ([name], body) => {
      w.urlMaps[name] = body;
      return done(`map ${name}`);
    }],
    ['GET', /^global\/targetHttpsProxies$/, () => ({ items: w.httpsProxies })],
    ['GET', /^global\/targetHttpProxies$/, () => ({ items: w.httpProxies })],
    ['GET', /^global\/forwardingRules$/, () => ({ items: w.forwardingRules })],
    ['GET', /^global\/backendServices\/([^/]+)$/, ([name]) => {
      if (!w.services[name]) throw notFound(`backend service ${name}`);
      return w.services[name];
    }],
    ['POST', /^global\/backendServices$/, (_, body) => {
      w.services[body.name] = body;
      return done(`create ${body.name}`);
    }],
    ['DELETE', /^global\/backendServices\/([^/]+)$/, ([name]) => {
      if (!w.services[name]) throw notFound(`backend service ${name}`);
      delete w.services[name];
      return done(`delete ${name}`);
    }],
    ['POST', /^global\/backendServices\/([^/]+)\/getHealth$/, () => ({
      healthStatus: [{ healthState: Object.values(w.vms).some((vm) => vm.status === 'RUNNING') ? 'HEALTHY' : 'UNHEALTHY' }],
    })],
    ['GET', /^zones\/[^/]+\/instances\/([^/]+)$/, ([name]) => instance(name)],
    ['POST', /^zones\/[^/]+\/instances\/([^/]+)\/(start|stop|suspend|resume)$/, ([name, action]) => {
      w.vms[name].status = STATUS[action];
      return done(`${action} ${name}`);
    }],
    ['GET', /^zones\/[^/]+\/machineTypes\/([^/]+)$/, ([name]) => {
      if (!w.machineTypes[name]) throw notFound(`machine type ${name}`);
      return w.machineTypes[name];
    }],
    ['POST', /^zones\/[^/]+\/instanceGroups\/([^/]+)\/listInstances$/, ([name]) => ({
      items: w.unmanaged[name].map((vm) => ({ instance: vmUrl(vm, w.vms[vm]?.zone), status: w.vms[vm]?.status })),
    })],
    ['GET', /^(zones|regions)\/([^/]+)\/instanceGroupManagers\/([^/]+)$/, ([kind, location, name]) => {
      const { members, ...group } = managed(kind, location, name);
      return { name, selfLink: `${V1}/${kind}/${location}/instanceGroupManagers/${name}`, ...group };
    }],
    ['POST', /^(zones|regions)\/([^/]+)\/instanceGroupManagers\/([^/]+)\/listManagedInstances$/, ([kind, location, name]) => ({
      managedInstances: managed(kind, location, name).members.map((vm) => ({ instance: vmUrl(vm, w.vms[vm].zone), instanceStatus: w.vms[vm].status, currentAction: 'NONE' })),
    })],
    ['PATCH', /^zones\/[^/]+\/autoscalers\?autoscaler=([^/]+)$/, ([name], body) => {
      w.autoscalers[name] = body.autoscalingPolicy.mode;
      return done(`autoscaler ${name} ${body.autoscalingPolicy.mode}`);
    }],
  ];
  const google = {
    request: async (method, url, body) => {
      const path = url.slice(`${V1}/`.length);
      const failure = w.fail[`${method} ${path}`];
      if (failure) throw failure;
      w.on[`${method} ${path}`]?.();
      for (const [verb, pattern, answer] of ROUTES) {
        const found = verb === method && pattern.exec(path);
        if (found) return structuredClone(answer(found.slice(1), body));
      }
      throw new Error(`no route in the fake for ${method} ${url}`);
    },
    waitCompute: async () => {},
  };
  const configs = new Map();
  const runs = new Map();
  const schedules = new Map();
  const pauses = new Map();
  const store = {
    configs,
    runs,
    schedules,
    pauses,
    getConfig: async (id) => structuredClone(configs.get(id) ?? null),
    listConfigs: async () => [...configs.values()].map((c) => structuredClone(c)),
    listWorkloads: async () => ({ configs: [...configs.values()].map((c) => structuredClone(c)), schedules: structuredClone(schedules) }),
    getSchedule: async (id) => structuredClone(schedules.get(id) ?? null),
    putSchedule: async (id, schedule) => {
      schedules.set(id, structuredClone(schedule));
    },
    deleteSchedule: async (id) => schedules.delete(id),
    getPauses: async (id) => (pauses.has(id) ? [{ workloadId: id, ...structuredClone(pauses.get(id)) }] : []),
    listPauses: async () => [...pauses].map(([workloadId, pause]) => ({ workloadId, ...structuredClone(pause) })),
    addPause: async (id, pause) => {
      pauses.set(id, structuredClone(pause));
    },
    removePauses: async (id) => pauses.delete(id),
    count: async () => {},
    getRun: async (id) => structuredClone(runs.get(id) ?? null),
    putConfig: async (id, config) => {
      configs.set(id, structuredClone(config));
      return true;
    },
    initRun: async (id, at) => {
      if (runs.has(id)) return false;
      runs.set(id, { state: STATES.AWAKE, version: 0, awakeSince: at, holders: 0, wakeCount: 0 });
      return true;
    },
    deleteWorkload: async (id) => {
      for (const kind of [configs, runs, schedules, pauses]) kind.delete(id);
    },
    transition: async (id, { cond, set = {}, remove = [], increment = [] }) => {
      const run = runs.get(id);
      if (!run || !matches(run, cond)) return null;
      Object.assign(run, set);
      for (const name of remove) delete run[name];
      for (const name of increment) run[name] = (run[name] ?? 0) + 1;
      return structuredClone(run);
    },
    setPendingWake: async (id) => {
      const run = runs.get(id);
      if (run?.state !== STATES.NAPPING || run.pendingWake === true) return false;
      run.pendingWake = true;
      return true;
    },
  };
  const log = Object.fromEntries(['info', 'warn', 'error'].map((level) => [level, (event, fields = {}) => { w.logs.push({ level, event, ...fields }); }]));
  const config = { project: 'p', region: w.region ?? REGION, wakerNeg: NEG, controllerUrl: CONTROLLER };
  // `used`: each adapter function called, as `compute.getInstance`.
  const recorded = (adapter, calls) => Object.fromEntries(Object.entries(calls).map(([name, call]) => [name, (...args) => {
    w.used.add(`${adapter}.${name}`);
    return call(...args);
  }]));
  const compute = recorded('compute', createCompute({ google, project: 'p', now: clock.now }));
  const urlmaps = recorded('urlmaps', createUrlMaps({ google, project: 'p', now: clock.now }));
  const tasks = {
    enqueue: async (task) => {
      if (w.fail.enqueue) throw w.fail.enqueue;
      w.tasks.push(task);
    },
  };
  const core = createController({
    store, compute, urlmaps, monitoring: { requestCount: async () => 0 }, tasks, config, now: clock.now, sleep: clock.sleep, newId: () => 'wake-1', log,
  });
  const onboarding = createOnboarding({ store, compute, urlmaps, core, config, now: clock.now, log });
  return { w, clock, store, core, onboarding, config, log };
}

// The input of an onboarding of `app` as `demo`.
export const INPUT = { urlMap: 'lb', backendService: 'app', id: 'demo' };
