// A project as the controller sees it, for the onboarding's and the API's tests: the real adapters and the real core over
// a fake of Compute Engine's REST API and a store of several workloads. `changes`: what was changed at Google, in order.
import { matches, STATES } from '../../lambda/src/lib/state.mjs';
import { fakeClock } from '../../lambda/test/fakes.mjs';
import { createCloudSql } from '../src/cloudsql.mjs';
import { createCompute } from '../src/compute.mjs';
import { createController } from '../src/controller-core.mjs';
import { createGke } from '../src/gke.mjs';
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
export const regionalUrl = (name, region = REGION) => `${V1}/regions/${region}/backendServices/${name}`;
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
  // By region: `{ urlMaps, httpsProxies, httpProxies, forwardingRules, services }`.
  regions: {},
  // Zonal NEGs by name: `{ zone?, type?, endpoints: [instance name | {ipAddress}], ...fields of the NEG }`.
  negs: {},
  vms: { 'vm-a': { id: '1001', status: 'RUNNING' } },
  machineTypes: { 'e2-small': { name: 'e2-small', memoryMb: 2048 } },
  autoscalers: {},
  // Cloud SQL instances by name: fields over a running primary. What the fake does is ruling 2 of task R10, not Google yet (M6).
  sql: {},
  // How long an operation runs, by the policy asked for.
  sqlTakes: { ALWAYS: 300_000, NEVER: 120_000 },
  // What the next operations end in, one each: an operation's `error`.
  sqlOperationErrors: [],
  // What M6 has not told yet, where a test's verdict depends on it: when the policy reads as asked ('at-once', 'at-end'), what an
  // operation in error leaves ('kept', 'changed'), what `state` reads during an operation, and how long an operation stays out of the list.
  sqlReading: { policy: 'at-once', failedPolicy: 'kept', stateDuring: 'RUNNABLE', listLagMs: 0 },
  // GKE clusters by `<location>/<name>`: what clusters.get answers (M11).
  clusters: {},
  // A cluster's Kubernetes API, as task R11 assumes it before M9, M11 and M12. `owners`: by `<kind> <namespace>/<name>`, `{ replicas }`, its pods
  // following them; `pods`: others, as the API shows them. `denied`: rights the Role lacks here, as `<verb> <resource>`. `calls`: each one, `<METHOD> <path>`.
  // `unschedulable`: pods stay Pending, with no address. `leaving`: lists of pods during which those scaled away are still there.
  kube: { owners: {}, pods: [], scaledObjects: [], events: [], denied: [], calls: [], answers: {}, keda: true, down: false, unschedulable: false, leaving: 0 },
  // What M9 and M12 have not told yet, where a test's verdict depends on it: what `getHealth` says of a NEG with no endpoint ('none', 'unhealthy'),
  // and whether a pod's endpoint names its node ('node', 'none').
  gkeReading: { healthAtZero: 'none', endpointNames: 'node' },
});

// The defaults' load balancer as a classic one: `EXTERNAL` on its forwarding rule and its backend services.
export function classic(w) {
  w.forwardingRules[0].loadBalancingScheme = 'EXTERNAL';
  for (const service of Object.values(w.services)) service.loadBalancingScheme = 'EXTERNAL';
}

// The same load balancer, regional: its map, proxy, rule and services in the region, nothing of it global.
export const regionOf = (region = REGION) => {
  const url = `${V1}/regions/${region}`;
  const service = (name, backends) => ({ name, loadBalancingScheme: 'EXTERNAL_MANAGED', healthChecks: [`${url}/healthChecks/hc`], backends });
  return {
    urlMaps: {
      lb: {
        name: 'lb',
        fingerprint: 'f1',
        defaultService: regionalUrl('other', region),
        hostRules: [{ hosts: ['demo.example.com'], pathMatcher: 'm' }],
        pathMatchers: [{ name: 'm', defaultService: regionalUrl('app', region) }],
      },
    },
    httpsProxies: [{ name: 'lb-https', selfLink: `${url}/targetHttpsProxies/lb-https`, urlMap: `${url}/urlMaps/lb` }],
    httpProxies: [],
    forwardingRules: [{ name: 'lb-fr', target: `${url}/targetHttpsProxies/lb-https`, loadBalancingScheme: 'EXTERNAL_MANAGED' }],
    services: { app: service('app', [{ group: unmanagedUrl('ig') }]), other: service('other', []) },
  };
};
export function regional(w) {
  w.urlMaps = {};
  w.httpsProxies = [];
  w.forwardingRules = [];
  w.services = {};
  w.regions[REGION] = regionOf();
}

const SQLADMIN = 'https://sqladmin.googleapis.com/v1/projects/p/';
const CONTAINER = 'https://container.googleapis.com/v1/projects/p/';
const notFound = (what) => new GoogleError(`Google: ${what}: 404 not found`, { code: 404, status: 'NOT_FOUND', reason: 'notFound' });

// Every backend service a URL map names, wherever it does: its defaults, its rules, their weights, its policies and tests.
const SERVICE_KEYS = new Set(['defaultService', 'service', 'backendService', 'errorService']);
const servicesNamed = (value) => {
  if (Array.isArray(value)) return value.flatMap(servicesNamed);
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, field]) => (SERVICE_KEYS.has(key) && typeof field === 'string' ? [field] : servicesNamed(field)));
};

// --- A GKE cluster's API, over `fetch` -------------------------------------------------------------------------------------

// The Role the CLI applies (cli/internal/gcponboard/rbac.go), a copy of its own: `<group> <resource>`: verbs. Anything else is a 403, as RBAC
// answers: a call outside the namespace, such as a node's, fails the code here as it would there.
const ROLE = {
  'apps deployments': ['get'],
  'apps statefulsets': ['get'],
  'apps replicasets': ['list'],
  'apps deployments/scale': ['patch'],
  'apps statefulsets/scale': ['patch'],
  ' pods': ['list'],
  ' events': ['list'],
  'keda.sh scaledobjects': ['list', 'patch'],
};
const KINDS = { deployments: 'Deployment', statefulsets: 'StatefulSet' };
const answered = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const kubeStatus = (status, reason, message) => answered(status, { kind: 'Status', status: 'Failure', reason, message, code: status });

const selects = (selector, labels = {}) => !selector || selector.split(',').every((term) => {
  const [key, value] = term.split('=');
  return labels[key] === value;
});

// The owner's pods as the API lists them, named and addressed by their index.
const podsOfOwner = (kube, key) => {
  const owner = kube.owners[key];
  const [kind, ref] = key.split(' ');
  const [namespace, name] = ref.split('/');
  const count = Math.max(owner.replicas, owner.leavingFrom ?? 0);
  return Array.from({ length: count }, (_, i) => {
    const leaving = i >= owner.replicas;
    return {
      metadata: {
        name: `${name}-${i}`,
        namespace,
        labels: { app: name },
        ownerReferences: [{ kind: kind === 'Deployment' ? 'ReplicaSet' : kind, name: kind === 'Deployment' ? `${name}-5d4f8` : name, controller: true }],
        ...(leaving ? { deletionTimestamp: '2026-11-02T00:00:00Z' } : {}),
      },
      status: kube.unschedulable
        ? { phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'False' }] }
        : { phase: 'Running', podIP: `10.8.0.${i + 1}`, conditions: [{ type: 'Ready', status: 'True' }] },
    };
  });
};
const allPods = (kube) => [...Object.keys(kube.owners).flatMap((key) => podsOfOwner(kube, key)), ...kube.pods];
const readyPods = (kube, key) => podsOfOwner(kube, key).filter((pod) => !pod.metadata.deletionTimestamp && pod.status.phase === 'Running');

// What the NEG of an owner holds: its ready pods, and `foreign` addresses.
const endpointsOfNeg = (w, { gkeOwner, foreign = [], empty }) => [...(empty ? [] : readyPods(w.kube, gkeOwner).map((pod) => pod.status.podIP)), ...foreign].map((ipAddress) => ({
  ...(w.gkeReading.endpointNames === 'node' ? { instance: 'gke-shop-node-1' } : {}), ipAddress, port: 8080,
}));

function kubeFetch(w) {
  return async (url, { method = 'GET', headers = {}, body } = {}) => {
    const { hostname, pathname, searchParams } = new URL(url);
    const { kube } = w;
    kube.calls.push(`${method} ${pathname}`);
    if (w.kubeThrows) throw w.kubeThrows;
    if (kube.down) throw new TypeError('fetch failed');
    if (!Object.values(w.clusters).some((c) => c.controlPlaneEndpointsConfig?.dnsEndpointConfig?.endpoint === hostname)) throw new Error(`no cluster at ${hostname}`);
    if (headers.authorization !== `Bearer ${w.routerToken}`) return answered(401, { message: 'no token' });
    const canned = kube.answers[`${method} ${pathname}`];
    if (canned) return answered(canned.status, canned.body);
    if (pathname === '/apis/authorization.k8s.io/v1/selfsubjectaccessreviews') {
      const { namespace, verb, group, resource, subresource } = JSON.parse(body).spec.resourceAttributes;
      const full = subresource ? `${resource}/${subresource}` : resource;
      return answered(201, { status: { allowed: Boolean(namespace) && (ROLE[`${group} ${full}`] ?? []).includes(verb) && !kube.denied.includes(`${verb} ${full}`) } });
    }
    const allowed = (group, resource, verb, words) => {
      if ((ROLE[`${group} ${resource}`] ?? []).includes(verb) && !kube.denied.includes(`${verb} ${resource}`)) return null;
      return kubeStatus(403, 'Forbidden', `${words} is forbidden: User cannot ${verb} resource ${resource}`);
    };
    const owner = /^\/apis\/apps\/v1\/namespaces\/([^/]+)\/(deployments|statefulsets)\/([^/]+)(\/scale)?$/.exec(pathname);
    if (owner) {
      const [, namespace, resource, name, scale] = owner;
      const refused = allowed('apps', `${resource}${scale ?? ''}`, method === 'PATCH' ? 'patch' : 'get', `${resource}.apps "${name}"`);
      if (refused) return refused;
      const found = kube.owners[`${KINDS[resource]} ${namespace}/${name}`];
      if (!found) return kubeStatus(404, 'NotFound', `${resource}.apps "${name}" not found`);
      if (method === 'PATCH') {
        const next = JSON.parse(body).spec.replicas;
        if (next < found.replicas && kube.leaving) Object.assign(found, { leavingFrom: found.replicas, leavingReads: kube.leaving });
        found.replicas = next;
        w.changes.push(`scale ${namespace}/${name} ${next}`);
      }
      return answered(200, { metadata: { name, namespace }, spec: { replicas: found.replicas, selector: { matchLabels: { app: name } } } });
    }
    const sets = /^\/apis\/apps\/v1\/namespaces\/([^/]+)\/replicasets$/.exec(pathname);
    if (sets) {
      const refused = allowed('apps', 'replicasets', 'list', 'replicasets.apps');
      if (refused) return refused;
      const items = Object.keys(kube.owners).filter((key) => key.startsWith(`Deployment ${sets[1]}/`)).map((key) => {
        const name = key.slice(key.indexOf('/') + 1);
        return { metadata: { name: `${name}-5d4f8`, ownerReferences: [{ kind: 'Deployment', name, controller: true }] } };
      });
      return answered(200, { items });
    }
    const pods = /^\/api\/v1\/namespaces\/([^/]+)\/pods$/.exec(pathname);
    if (pods) {
      const refused = allowed('', 'pods', 'list', 'pods');
      if (refused) return refused;
      const items = allPods(kube).filter((pod) => pod.metadata.namespace === pods[1] && selects(searchParams.get('labelSelector'), pod.metadata.labels));
      for (const found of Object.values(kube.owners).filter((o) => o.leavingFrom !== undefined)) {
        found.leavingReads -= 1;
        if (found.leavingReads < 0) delete found.leavingFrom;
      }
      return answered(200, { items });
    }
    if (/^\/api\/v1\/namespaces\/[^/]+\/events$/.test(pathname)) {
      const refused = allowed('', 'events', 'list', 'events');
      return refused ?? answered(200, { items: kube.events });
    }
    const scaled = /^\/apis\/keda\.sh\/v1alpha1\/namespaces\/([^/]+)\/scaledobjects(?:\/([^/]+))?$/.exec(pathname);
    if (scaled) {
      const [, namespace, name] = scaled;
      const refused = allowed('keda.sh', 'scaledobjects', name ? 'patch' : 'list', 'scaledobjects.keda.sh');
      if (refused) return refused;
      if (!kube.keda) return answered(404, { message: 'the server could not find the requested resource' });
      if (!name) return answered(200, { items: kube.scaledObjects.filter((o) => o.metadata.namespace === namespace) });
      const found = kube.scaledObjects.find((o) => o.metadata.namespace === namespace && o.metadata.name === name);
      if (!found) return kubeStatus(404, 'NotFound', `scaledobjects.keda.sh "${name}" not found`);
      const asked = JSON.parse(body).metadata.annotations;
      const annotations = { ...found.metadata.annotations, ...asked };
      for (const [key, value] of Object.entries(asked)) if (value === null) delete annotations[key];
      found.metadata.annotations = annotations;
      w.changes.push(`keda ${name} ${JSON.stringify(asked)}`);
      return answered(200, found);
    }
    return kubeStatus(403, 'Forbidden', `${method} ${pathname} is forbidden: no rule of the Role allows it`);
  };
}

// `change(world)`: what differs from the defaults. `fail['<method> <path>']` refuses that call, `on[...]` runs before it.
// `world.store`: another store than the one here, such as the real one over a fake Firestore.
export function setup(change = () => {}) {
  const clock = fakeClock();
  const w = { ...defaults(), changes: [], tasks: [], healthGroups: [], fail: {}, on: {}, logs: [], used: new Set(), routerToken: 'router-token' };
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
  const inRegion = (region) => w.regions[region] ?? { urlMaps: {}, httpsProxies: [], httpProxies: [], forwardingRules: [], services: {} };
  // As Google: on the fingerprint read, every service named there in the map's scope, and a new fingerprint.
  let writes = 0;
  const putMap = (maps, services, scope, name, body) => {
    if (!maps[name]) throw notFound(`URL map ${name}`);
    if (body.fingerprint !== maps[name].fingerprint) throw new GoogleError(`Google: URL map ${name}: 412 the fingerprint is stale`, { code: 412, status: 'FAILED_PRECONDITION', reason: 'conditionNotMet' });
    for (const url of servicesNamed(body)) {
      const [, where, service] = /\/(global|regions\/[^/]+)\/backendServices\/([^/]+)$/.exec(url) ?? [];
      if (where !== scope || !services[service]) throw new GoogleError(`Google: URL map ${name}: 400 ${url} is no backend service of ${scope}`, { code: 400, status: 'INVALID_ARGUMENT', reason: 'invalid' });
    }
    writes += 1;
    maps[name] = { ...body, fingerprint: `written-${writes}` };
    return done(`map ${name}`);
  };
  // Healthy when a VM of the asked group runs: a NEG's endpoints, else any VM. A classic service reads no status while none runs (M3).
  const healthOf = (service, { group }) => {
    w.healthGroups.push(group);
    const neg = /\/networkEndpointGroups\/([^/]+)$/.exec(group)?.[1];
    if (w.negs[neg]?.gkeOwner) {
      if (readyPods(w.kube, w.negs[neg].gkeOwner).length && !w.negs[neg].empty && !w.kube.unhealthy) return { healthStatus: [{ healthState: 'HEALTHY' }] };
      return w.gkeReading.healthAtZero === 'none' || service?.loadBalancingScheme === 'EXTERNAL' ? { kind: 'compute#backendServiceGroupHealth' } : { healthStatus: [{ healthState: 'UNHEALTHY' }] };
    }
    const vms = neg ? (w.negs[neg]?.endpoints ?? []).map((e) => w.vms[typeof e === 'string' ? e : e.instance]).filter(Boolean) : Object.values(w.vms);
    const running = vms.some((vm) => vm.status === 'RUNNING');
    if (!running && service?.loadBalancingScheme === 'EXTERNAL') return { kind: 'compute#backendServiceGroupHealth' };
    return { healthStatus: [{ healthState: running ? 'HEALTHY' : 'UNHEALTHY' }] };
  };
  // Cloud SQL as task R10 assumes it before M6, under `sqlReading`: another PATCH during an operation is a 409, and the list is newest first.
  const sqlOperations = [];
  const sqlRunning = (name) => sqlOperations.find((op) => op.instance === name && clock.now() < op.doneAt);
  const applyPolicy = (name, { policy, error }) => {
    if (!error || w.sqlReading.failedPolicy === 'changed') w.sql[name].settings = { ...w.sql[name].settings, activationPolicy: policy };
  };
  const sqlInstance = (name) => {
    if (!w.sql[name]) throw notFound(`Cloud SQL instance ${name}`);
    for (const op of sqlOperations.filter((o) => o.instance === name && !o.applied && clock.now() >= o.doneAt)) {
      op.applied = true;
      applyPolicy(name, op);
    }
    const running = sqlRunning(name);
    return {
      name,
      selfLink: `${SQLADMIN}instances/${name}`,
      instanceType: 'CLOUD_SQL_INSTANCE',
      ...w.sql[name],
      state: running ? w.sqlReading.stateDuring : w.sql[name].state ?? 'RUNNABLE',
      settings: { activationPolicy: 'ALWAYS', ...w.sql[name].settings },
    };
  };
  const sqlOperationView = ({ name, error, doneAt }) => ({ name, operationType: 'UPDATE', status: clock.now() >= doneAt ? 'DONE' : 'RUNNING', ...(error && clock.now() >= doneAt ? { error } : {}) });
  const setActivation = (name, policy) => {
    sqlInstance(name);
    if (sqlRunning(name)) throw new GoogleError(`Google: PATCH instances/${name}: 409 Operation failed because another operation was already in progress.`, { code: 409, status: 'CONFLICT', reason: 'operationInProgress' });
    const op = { name: `sql-op-${sqlOperations.length + 1}`, instance: name, policy, startedAt: clock.now(), doneAt: clock.now() + w.sqlTakes[policy] };
    const error = w.sqlOperationErrors.shift();
    if (error) op.error = error;
    sqlOperations.unshift(op);
    if (w.sqlReading.policy === 'at-once') {
      op.applied = true;
      applyPolicy(name, op);
    }
    w.changes.push(`sql ${name} ${policy}`);
    return { name: op.name, status: 'PENDING' };
  };
  const ROUTES = [
    ['GET', /^gke\/locations\/([^/]+)\/clusters\/([^/]+)$/, ([location, name]) => {
      if (!w.clusters[`${location}/${name}`]) throw notFound(`cluster ${name}`);
      return { name, location, ...w.clusters[`${location}/${name}`] };
    }],
    ['GET', /^sql\/instances\/([^/]+)$/, ([name]) => sqlInstance(name)],
    ['PATCH', /^sql\/instances\/([^/]+)$/, ([name], body) => setActivation(name, body.settings.activationPolicy)],
    ['GET', /^sql\/operations\/([^/?]+)$/, ([name]) => sqlOperationView(sqlOperations.find((op) => op.name === name))],
    ['GET', /^sql\/operations\?instance=([^&]+)&maxResults=10$/, ([name]) => ({
      kind: 'sql#operationsList',
      items: sqlOperations.filter((op) => op.instance === name && clock.now() >= op.startedAt + w.sqlReading.listLagMs).slice(0, 10).map(sqlOperationView),
    })],
    ['GET', /^regions\/([^/]+)\/urlMaps$/, ([region]) => ({ items: Object.values(inRegion(region).urlMaps) })],
    ['GET', /^regions\/([^/]+)\/urlMaps\/([^/]+)$/, ([region, name]) => {
      if (!inRegion(region).urlMaps[name]) throw notFound(`URL map ${name}`);
      return inRegion(region).urlMaps[name];
    }],
    ['PUT', /^regions\/([^/]+)\/urlMaps\/([^/]+)$/, ([region, name], body) => putMap(inRegion(region).urlMaps, inRegion(region).services, `regions/${region}`, name, body)],
    ['GET', /^regions\/([^/]+)\/targetHttpsProxies$/, ([region]) => ({ items: inRegion(region).httpsProxies })],
    ['GET', /^regions\/([^/]+)\/targetHttpProxies$/, ([region]) => ({ items: inRegion(region).httpProxies })],
    ['GET', /^regions\/([^/]+)\/forwardingRules$/, ([region]) => ({ items: inRegion(region).forwardingRules })],
    ['GET', /^regions\/([^/]+)\/backendServices\/([^/]+)$/, ([region, name]) => {
      if (!inRegion(region).services[name]) throw notFound(`backend service ${name}`);
      return inRegion(region).services[name];
    }],
    ['POST', /^regions\/([^/]+)\/backendServices\/([^/]+)\/getHealth$/, ([region, name], body) => healthOf(inRegion(region).services[name], body)],
    ['POST', /^regions\/([^/]+)\/backendServices$/, ([region], body) => {
      inRegion(region).services[body.name] = body;
      return done(`create ${body.name}`);
    }],
    ['DELETE', /^regions\/([^/]+)\/backendServices\/([^/]+)$/, ([region, name]) => {
      if (!inRegion(region).services[name]) throw notFound(`backend service ${name}`);
      delete inRegion(region).services[name];
      return done(`delete ${name}`);
    }],
    ['GET', /^global\/urlMaps$/, () => ({ items: Object.values(w.urlMaps) })],
    ['GET', /^global\/urlMaps\/([^/]+)$/, ([name]) => {
      if (!w.urlMaps[name]) throw notFound(`URL map ${name}`);
      return w.urlMaps[name];
    }],
    ['PUT', /^global\/urlMaps\/([^/]+)$/, ([name], body) => putMap(w.urlMaps, w.services, 'global', name, body)],
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
    ['POST', /^global\/backendServices\/([^/]+)\/getHealth$/, ([name], body) => healthOf(w.services[name], body)],
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
    ['GET', /^zones\/([^/]+)\/networkEndpointGroups\/([^/]+)$/, ([zone, name]) => {
      const { endpoints, zone: own = ZONE, type = 'GCE_VM_IP_PORT', gkeOwner, foreign, empty, ...fields } = w.negs[name] ?? {};
      if (!w.negs[name] || own !== zone) throw notFound(`network endpoint group ${name}`);
      return { name, networkEndpointType: type, selfLink: `${V1}/zones/${zone}/networkEndpointGroups/${name}`, ...fields };
    }],
    ['POST', /^zones\/([^/]+)\/networkEndpointGroups\/([^/]+)\/listNetworkEndpoints(\?pageToken=.*)?$/, ([zone, name, page]) => {
      if (!w.negs[name] || (w.negs[name].zone ?? ZONE) !== zone) throw notFound(`network endpoint group ${name}`);
      if (w.negs[name].gkeOwner) return { items: endpointsOfNeg(w, w.negs[name]).map((networkEndpoint) => ({ networkEndpoint })) };
      const items = w.negs[name].endpoints.map((e) => ({ networkEndpoint: typeof e === 'string' ? { instance: e, ipAddress: '10.0.0.2', port: 80 } : e }));
      // Two pages, to show that the adapter follows the token.
      return page ? { items: items.slice(1) } : { items: items.slice(0, 1), ...(items.length > 1 ? { nextPageToken: 'second' } : {}) };
    }],
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
      const path = url.startsWith(SQLADMIN) ? `sql/${url.slice(SQLADMIN.length)}` : url.startsWith(CONTAINER) ? `gke/${url.slice(CONTAINER.length)}` : url.slice(`${V1}/`.length);
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
    token: async () => w.routerToken,
  };
  const configs = new Map();
  const runs = new Map();
  const schedules = new Map();
  const pauses = new Map();
  const store = w.store ?? {
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
  const urlmaps = recorded('urlmaps', createUrlMaps({ google, project: 'p', now: clock.now, sleep: clock.sleep }));
  const regionalUrlmaps = recorded('regionalUrlmaps', createUrlMaps({ google, project: 'p', region: config.region, scope: 'regional', now: clock.now, sleep: clock.sleep }));
  const tasks = {
    enqueue: async (task) => {
      if (w.fail.enqueue) throw w.fail.enqueue;
      w.tasks.push(task);
    },
  };
  const cloudsql = recorded('cloudsql', createCloudSql({ google, project: 'p', now: clock.now, sleep: clock.sleep }));
  const gke = recorded('gke', createGke({ google, project: 'p', fetch: kubeFetch(w), now: clock.now }));
  const core = createController({
    store, compute, cloudsql, gke, urlmaps, regionalUrlmaps, monitoring: { requestCount: async () => 0 }, tasks, config, now: clock.now, sleep: clock.sleep, newId: () => 'wake-1', log,
  });
  const onboarding = createOnboarding({ store, compute, cloudsql, gke, urlmaps, regionalUrlmaps, core, config, now: clock.now, log });
  return { w, clock, store, core, onboarding, config, log, compute, cloudsql, gke, urlmaps, regionalUrlmaps, google };
}

// The input of an onboarding of `app` as `demo`.
export const INPUT = { urlMap: 'lb', backendService: 'app', id: 'demo' };

// --- A GKE workload ----------------------------------------------------------------------------------------------------------

export const CLUSTER = { location: ZONE, name: 'shop' };
export const GKE_NEG = 'k8s1-0a1b2c3d-shop-web-80-e4f5a6b7';
export const OWNER = 'Deployment shop/web';
export const GKE_ENDPOINT = 'shop-abcd.europe-west1-b.gke.goog';
// The CLI's dry run names the cluster alone, its onboarding all of it.
export const GKE_DRY = { ...INPUT, gke: { cluster: CLUSTER } };
export const GKE_INPUT = { ...INPUT, gke: { cluster: CLUSTER, namespace: 'shop', service: 'web', owner: { kind: 'Deployment', name: 'web' } } };
export const K8S_BACKEND = { kind: 'k8s', cluster: CLUSTER, namespace: 'shop', service: 'web', owner: { kind: 'Deployment', name: 'web' } };

// What M12 assumes a GKE NEG carries, by where it says so: its description, its annotations, or nothing the router can read.
export const NEG_READINGS = {
  description: (namespace, service) => ({ description: JSON.stringify({ 'cluster-uid': 'c0ffee', namespace, 'service-name': service, port: '80' }) }),
  annotations: (namespace, service) => ({ annotations: { 'cluster-uid': 'c0ffee', namespace, 'service-name': service, port: '80' } }),
  none: () => ({}),
};

// The service's one backend is the standalone NEG of Deployment shop/web, 2 replicas, on an Autopilot cluster with its DNS endpoint open.
export function onGke(w, { reading = 'description', namespace = 'shop', service = 'web', neg = GKE_NEG, replicas = 2 } = {}) {
  w.negs[neg] = { gkeOwner: OWNER, ...NEG_READINGS[reading](namespace, service) };
  w.services.app.backends = [{ group: `${V1}/zones/${ZONE}/networkEndpointGroups/${neg}` }];
  w.kube.owners[OWNER] = { replicas };
  w.clusters[`${CLUSTER.location}/${CLUSTER.name}`] = {
    id: 'cluster-id',
    autopilot: { enabled: true },
    controlPlaneEndpointsConfig: { dnsEndpointConfig: { endpoint: GKE_ENDPOINT, allowExternalTraffic: true } },
  };
  delete w.vms['vm-a'];
}
