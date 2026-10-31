// GKE pods behind standalone NEGs (vision docs/specs/2026-10-30-google-cloud-coverage-design.md, section 8): the shared modules
// lambda/src/lib/k8s.mjs and kubernetes.mjs do the scale, the KEDA pause and the reads, through a Transport here that reaches a cluster by
// its DNS endpoint, with the public CAs and the router's access token. The router holds no cluster-wide right: nothing here, nor
// what it calls of the shared code, leaves the workload's namespace but a SelfSubjectAccessReview (k8sItems' read of nodes is AWS's).
//
// None of this has been run against Google yet: what it answers is read from its reference, and what the measures may change is one
// function here each: clusterView, clusterProblem and transportOf (M11), negServiceOf and isGkeNeg (M12), gkeMapRefusal (M10),
// foreignEndpoints (M9, M12).
//
// `CALLS` is each function's permissions (test/permissions.test.mjs): the feature `gke` of gcp/access.json. They grant nothing inside a
// cluster: that is the Role the CLI applies, kube-access.mjs's GKE_RULES.
//
// A backend: `{ kind: 'k8s', cluster: { location, name }, namespace, service, owner: { kind, name } }`. What a nap records of it on the
// run, in `owners`: k8sRecord's, its replicas and its KEDA ScaledObject, read at each nap.
import { failureError } from '../../lambda/src/lib/failures.mjs';
import { CLUSTER_TTL_MS, createKubernetes, KubernetesError, TIMEOUTS } from '../../lambda/src/lib/k8s.mjs';
import { askRights, GKE_RULES } from '../../lambda/src/lib/kube-access.mjs';
import { k8sId, k8sRecord, k8sStatus, livePods, ownerOf, resumeK8s, scaledObjectOf, sleepK8s, wakeK8s } from '../../lambda/src/lib/kubernetes.mjs';

const CONTAINER = 'https://container.googleapis.com/v1';
const REQUEST_MS = TIMEOUTS.connect + TIMEOUTS.idle;
// The CLI's patterns (cli/internal/gcponboard/rbac.go): these end up in URLs.
const LOCATION = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const CLUSTER_NAME = /^[a-z]([a-z0-9-]*[a-z0-9])?$/;
const KUBE_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
// An owner's name is a DNS subdomain.
const OWNER_NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;
const OWNER_KINDS = ['Deployment', 'StatefulSet'];
// M11: the token goes there, so nothing else may.
const DNS_ENDPOINT = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.gke\.goog$/;
// M10 only confirms why: GKE's controllers write these maps back at their next sync.
const GKE_MAP = /^(k8s2-|gkegw1-|gkemcg1-)/;
// M12: what GKE writes in the NEGs it makes (the annotations, or the description), and the prefix of their names.
const GKE_NEG_FIELD = /cluster-(uid|name)/i;
const GKE_NEG_PREFIX = 'k8s1-';
const NEG_OF_PODS = 'GCE_VM_IP_PORT';
const ZONAL_NEG = /\/zones\/([^/]+)\/networkEndpointGroups\/([^/]+)$/;
const OTHER_BACKENDS = [
  [/\/regions\/[^/]+\/networkEndpointGroups\//, 'a regional network endpoint group (serverless, private service connect)'],
  [/\/global\/networkEndpointGroups\//, 'a global network endpoint group (internet)'],
  [/\/instanceGroups\//, 'an instance group'],
];
// What the status of an owner reads as, for what reads a backend's VMs (controller-core.mjs): down once stopped, neither up nor down otherwise.
const VM_STATUS = { running: 'RUNNING', stopped: 'TERMINATED', transitioning: 'STAGING' };

// container.clusters.connect is what the DNS endpoint asks of each call of the cluster's API (M11).
export const CALLS = {
  getCluster: ['container.clusters.get'],
  kubernetesOf: ['container.clusters.get', 'container.clusters.connect'],
};

export const isPods = (backend) => backend.kind === 'k8s';

const nameOf = (url) => url.slice(url.lastIndexOf('/') + 1);
const clusterText = ({ location, name }) => `${location}/${name}`;
export const ownerText = ({ namespace, owner }) => `${owner.kind} ${namespace}/${owner.name}`;
const serviceText = ({ namespace, service }) => `${namespace}/${service}`;
const recordId = (backend) => k8sId({ ...backend, cluster: clusterText(backend.cluster) });
const isName = (value) => typeof value === 'string' && KUBE_NAME.test(value);

// M11: what clusters.get says of a cluster. `autopilot` is always a boolean.
export function clusterView(cluster) {
  const dns = cluster.controlPlaneEndpointsConfig?.dnsEndpointConfig ?? {};
  return { endpoint: dns.endpoint ?? null, open: dns.allowExternalTraffic === true, autopilot: cluster.autopilot?.enabled === true };
}

// Why the router cannot reach a cluster, what to turn on, else null: its DNS endpoint is the only way (no IP endpoint, no VPC connector).
export function clusterProblem({ location, name }, { endpoint, open }) {
  if (!endpoint || !open) return `GKE cluster ${location}/${name} has no DNS endpoint open to traffic from outside its network, and that is how Dormeto reaches a cluster: turn it on with gcloud container clusters update ${name} --location ${location} --enable-dns-access`;
  if (!DNS_ENDPOINT.test(endpoint)) return `GKE cluster ${location}/${name}: Google names ${endpoint} as its DNS endpoint, which is not a host under gke.goog, so the router's access token is not sent there`;
  return null;
}

// The onboarding's read of a cluster: `{ view?, problem? }`. A 403 for one absent too: Google may hide one the caller cannot see, and a router
// without the feature reads the same.
export async function clusterRead(gke, cluster) {
  try {
    const view = await gke.getCluster(cluster);
    const problem = clusterProblem(cluster, view);
    return { view, ...(problem ? { problem } : {}) };
  } catch (err) {
    if (err?.code === 404) return { problem: `GKE cluster ${clusterText(cluster)} not found: name a cluster of this project as <location>/<name>` };
    if (err?.code === 403) return { problem: `the router cannot read GKE cluster ${clusterText(cluster)}: it does not exist, or the router was installed without --with gke: ${err.message}` };
    throw err;
  }
}

// M10: a load balancer GKE owns (Gateway, Ingress), told by its URL map's name. Why, else null.
export function gkeMapRefusal(name) {
  if (!GKE_MAP.test(name)) return null;
  return `URL map ${name} belongs to a load balancer GKE owns (a Gateway or an Ingress): GKE writes it back at its next sync, so a nap's switch could not be trusted. Give the Service a standalone network endpoint group with the annotation cloud.google.com/neg, name it in a backend service of a load balancer of your own, and onboard that`;
}

// M12: a NEG that GKE made, its endpoints being pods.
export const isGkeNeg = ({ name, description, annotations }) => name.startsWith(GKE_NEG_PREFIX) || GKE_NEG_FIELD.test(description ?? '') || Object.keys(annotations ?? {}).some((key) => GKE_NEG_FIELD.test(key));

// M12: the Service a NEG belongs to, `{ namespace, service }`, else null: its description, JSON with `cluster-uid`, `namespace`, `service-name` and `port`,
// or the same in its annotations. A wrong guess would scale someone else's pods: what does not read so is null, and refused.
export function negServiceOf({ description, annotations }) {
  const read = (fields) => (isName(fields?.namespace) && isName(fields?.['service-name']) ? { namespace: fields.namespace, service: fields['service-name'] } : null);
  let described = null;
  try {
    described = JSON.parse(description ?? '');
  } catch { /* not GKE's form */ }
  return read(described) ?? read(annotations);
}

// What is wrong with the request's `gke`: the dry run's names the cluster alone, the onboarding's all of it (needsAll).
export function gkeProblems(gke, { needsAll = false } = {}) {
  if (typeof gke !== 'object' || gke === null || Array.isArray(gke)) return ['gke: must be an object'];
  const { cluster, namespace, service, owner } = gke;
  if (typeof cluster !== 'object' || cluster === null) return ['gke.cluster: must be { location, name }'];
  const problems = [];
  if (typeof cluster.location !== 'string' || !LOCATION.test(cluster.location)) problems.push(`gke.cluster.location: ${JSON.stringify(cluster.location)} is not a zone or a region`);
  if (typeof cluster.name !== 'string' || !CLUSTER_NAME.test(cluster.name)) problems.push(`gke.cluster.name: ${JSON.stringify(cluster.name)} is not a cluster's name`);
  if (needsAll && !(namespace && service && owner)) problems.push('gke: an onboarding names its namespace, service and owner');
  if (namespace !== undefined && !isName(namespace)) problems.push(`gke.namespace: ${JSON.stringify(namespace)} is not a Kubernetes namespace`);
  if (service !== undefined && !isName(service)) problems.push(`gke.service: ${JSON.stringify(service)} is not a Service's name`);
  if (owner !== undefined) {
    if (!OWNER_KINDS.includes(owner?.kind)) problems.push(`gke.owner.kind: must be ${OWNER_KINDS.join(' or ')}`);
    if (typeof owner?.name !== 'string' || !OWNER_NAME.test(owner.name)) problems.push(`gke.owner.name: ${JSON.stringify(owner?.name)} is not an object's name`);
  }
  return problems;
}

// The service's NEGs against `asked` (`{ namespace?, service? }`): `{ reasons, negs: [{ zone, name }], named }`, `named` the one Service they all belong to. No read
// of the cluster: the dry run comes before any right there. A VM or a group next to pods, or a serverless NEG, is refused; a NEG with no endpoint is not: 0 replicas.
export async function negsOfService(compute, { name: service, backends = [] }, asked = {}) {
  const found = await Promise.all(backends.map(async ({ group = '' }) => {
    const place = ZONAL_NEG.exec(group);
    if (!place) {
      const what = OTHER_BACKENDS.find(([pattern]) => pattern.test(group))?.[1] ?? 'not a network endpoint group';
      return { reason: `backend ${nameOf(group)} of backend service ${service} is ${what}: with --gke-cluster, each backend is a zonal network endpoint group of pods, with nothing else next to them` };
    }
    const [, zone, name] = place;
    const neg = await compute.getZonalNetworkEndpointGroup(zone, name).catch((err) => {
      if (err?.code !== 404) throw err;
      return null;
    });
    if (!neg) return { reason: `network endpoint group ${name} of backend service ${service} not found: it was deleted, take it out of the backend service` };
    if (neg.networkEndpointType !== NEG_OF_PODS) return { reason: `network endpoint group ${name} of backend service ${service} has the type ${neg.networkEndpointType}: only ${NEG_OF_PODS} is supported, take it out of the backend service` };
    if (!isGkeNeg({ ...neg, name })) return { reason: `network endpoint group ${name} of backend service ${service} was not made by GKE, its endpoints are VMs: with --gke-cluster, each backend is a zonal network endpoint group of pods, with nothing else next to them` };
    const named = negServiceOf(neg);
    if (!named) return { reason: `the router cannot read which namespace and Service network endpoint group ${name} belongs to, in its description or its annotations: a wrong guess would scale someone else's pods, so this is refused` };
    const other = (asked.namespace && asked.namespace !== named.namespace) || (asked.service && asked.service !== named.service);
    if (other) return { reason: `network endpoint group ${name} belongs to Service ${serviceText(named)}, not ${serviceText({ namespace: asked.namespace ?? named.namespace, service: asked.service ?? named.service })}` };
    return { neg: { zone, name }, named };
  }));
  const reasons = found.flatMap((f) => (f.reason ? [f.reason] : []));
  const services = [...new Set(found.filter((f) => f.named).map((f) => serviceText(f.named)))];
  if (services.length > 1) reasons.push(`the network endpoint groups of backend service ${service} belong to different Services (${services.join(', ')}): a workload is one Service`);
  return { reasons, negs: found.flatMap((f) => (f.neg ? [f.neg] : [])), named: services.length === 1 ? found.find((f) => f.named).named : null };
}

const ownerGone = (backend) => failureError('configuration', `${ownerText(backend)} not found in GKE cluster ${clusterText(backend.cluster)}: bring it back, or offboard this workload`);

// The owner's object in the cluster, or the failure of its being gone.
async function ownerObject(k8s, backend) {
  const object = await ownerOf(k8s, backend);
  if (!object) throw ownerGone(backend);
  return object;
}

// Why the NEGs' endpoints are not the owner's pods, else null. M9, M12: a pod's endpoint carries its address (`ipAddress`, whatever `instance` says of its node). An
// endpoint not shown to be a pod of the owner is foreign: no endpoint at all is 0 replicas, a normal thing.
async function foreignEndpoints(compute, k8s, backend, object, negs) {
  const [pods, lists] = await Promise.all([
    livePods(k8s, backend, object),
    Promise.all(negs.map(async (neg) => ({ neg, items: await compute.listNetworkEndpoints(neg.zone, neg.name) }))),
  ]);
  const addresses = new Set(pods.flatMap((pod) => [pod.status?.podIP, ...(pod.status?.podIPs ?? []).map((p) => p.ip)]).filter(Boolean));
  const foreign = lists.flatMap(({ neg, items }) => items.map((item) => item.networkEndpoint ?? {})
    .map((endpoint) => ({ neg: neg.name, address: endpoint.ipAddress ?? endpoint.ipv6Address ?? null }))
    .filter(({ address }) => !addresses.has(address)));
  if (!foreign.length) return null;
  const { neg, address } = foreign[0];
  return `network endpoint group ${neg} holds ${foreign.length} endpoint${foreign.length === 1 ? '' : 's'} (${address ?? 'with no address'}) that are not pods of ${ownerText(backend)}: nothing is scaled`;
}

// A nap acts only on what still is the workload (the plan's ruling 16): the service's NEGs read again, each still of its Service, and their endpoints against the
// owner's pods, which legitimately change. Why not, else null. An owner gone throws: the nap fails. readService() throwing a 404 is a change too.
export async function ownerChanged({ compute, kubernetesOf }, backend, readService) {
  const service = await readService().catch((err) => {
    if (err?.code !== 404) throw err;
    return null;
  });
  if (!service) return 'its backend service no longer exists: offboard and onboard again';
  const { reasons, negs } = await negsOfService(compute, service, backend);
  if (!reasons.length && !negs.length) reasons.push(`backend service ${service.name} no longer has a network endpoint group`);
  if (reasons.length) return `${reasons.join('; ')}: offboard and onboard again`;
  const k8s = await kubernetesOf(backend.cluster);
  const foreign = await foreignEndpoints(compute, k8s, backend, await ownerObject(k8s, backend), negs);
  return foreign && `${foreign}: offboard and onboard again, naming the owner behind them`;
}

// What the onboarding reads in the cluster, once the rights are the CLI's: why not, as reasons. A right per rule of the Role, the owner, the NEGs' endpoints against its
// pods. A cluster refusing or out of reach is a refusal in its own words: the CLI takes back the RBAC it just added.
export async function clusterProblems({ compute, kubernetesOf }, backend, negs) {
  try {
    const k8s = await kubernetesOf(backend.cluster);
    const missing = await askRights(k8s, backend.namespace, GKE_RULES);
    if (missing.length) return [`the router lacks ${missing.join('; ')} in namespace ${backend.namespace} of GKE cluster ${clusterText(backend.cluster)}: dormeto gcp workloads access grant applies them`];
    const object = await ownerOf(k8s, backend);
    if (!object) return [`${ownerText(backend)} not found in GKE cluster ${clusterText(backend.cluster)}`];
    const foreign = await foreignEndpoints(compute, k8s, backend, object, negs);
    return foreign ? [foreign] : [];
  } catch (err) {
    if (err?.name !== 'KubernetesError' && !err?.kind) throw err;
    return [`the router cannot read GKE cluster ${clusterText(backend.cluster)}: ${err.message}`];
  }
}

// A k8s backend as a VM, for what reads a backend's VMs.
export const ownerAsVm = async ({ kubernetesOf }, backend) => ({ name: ownerText(backend), status: VM_STATUS[await k8sStatus({ kubernetesOf }, backend)] });

// What a nap writes on the run before it scales: the replicas and the KEDA read now. One a nap that failed already scaled down keeps its record: read now, they would be
// 0 and Dormeto's own pause. An owner scaled up since has new replicas, and the customer's pause stays what was recorded.
export async function ownerRecord({ kubernetesOf }, backend, recorded) {
  const k8s = await kubernetesOf(backend.cluster);
  const [object, keda] = await Promise.all([ownerObject(k8s, backend), scaledObjectOf(k8s, backend)]);
  const replicas = object.spec?.replicas ?? 1;
  if (recorded && replicas === 0) return recorded;
  return k8sRecord({ ...backend, id: recordId(backend), replicas, keda: recorded?.keda ?? keda });
}

export const recordOf = (records, backend) => (records ?? []).find((record) => record.id === recordId(backend));

// What the wake watch (the shared code) reads of an owner.
export const watchRecord = (backend) => k8sRecord({ ...backend, id: recordId(backend) });

// KEDA paused at 0, the owner scaled to 0, its pods gone (the shared code). `timing`: `{ now, sleep, deadline }`.
export async function sleepOwner({ kubernetesOf }, backend, record, timing) {
  await sleepK8s({ kubernetesOf }, record, timing).catch((err) => {
    if (err?.status === 404) throw ownerGone(backend);
    throw err;
  });
}

// Read live, as a VM: replicas up since the nap are left as they are, by hand or by GitOps. At 0, what the nap recorded, at least 1. KEDA is given back with the autoscalers.
export async function wakeOwner({ kubernetesOf }, backend, record) {
  const k8s = await kubernetesOf(backend.cluster);
  const object = await ownerObject(k8s, backend);
  if ((object.spec?.replicas ?? 1) > 0) return;
  await wakeK8s({ kubernetesOf }, { ...backend, replicas: record?.replicas, keda: null });
}

// The customer's KEDA as it was. A ScaledObject deleted since holds nothing to give back.
export async function giveBackOwner({ kubernetesOf }, record) {
  await resumeK8s({ kubernetesOf }, record).catch((err) => {
    if (err?.status !== 404) throw err;
  });
}

// At the wake's deadline, with the Kubernetes events the wake watch last read (spec section 12).
export const podsUnhealthy = (backend, watch) => failureError('unhealthy', `no pod of ${ownerText(backend)} healthy when the wake timed out${watch.capacity ? `: ${watch.capacity.message}` : ''}`);

// M11: a Transport (lambda/src/lib/k8s.mjs) over `fetch`: HTTPS with the public CAs, as the DNS endpoint has them, with the token as of each call. A redirect is an
// answer, not followed: the token would go with it. No answer is a failure of kind `timeout` (spec section 12), where EKS's reads `cluster`.
function transportOf(endpoint, { token, fetch }) {
  return async ({ method, path, query = {}, headers, body }) => {
    const url = new URL(path, `https://${endpoint}`);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    const authorization = `Bearer ${await token()}`;
    try {
      const res = await fetch(url.href, { method, headers: { ...headers, authorization }, body, redirect: 'manual', signal: AbortSignal.timeout(REQUEST_MS) });
      return { status: res.status, contentType: res.headers.get('content-type'), body: await res.text() };
    } catch (err) {
      throw Object.assign(new KubernetesError(0, err?.code ?? err?.name ?? 'Network', `${method} ${url.pathname}: the GKE cluster's DNS endpoint did not answer: ${err?.message ?? err}`), { kind: 'timeout' });
    }
  };
}

export function createGke({ google, project, fetch = globalThis.fetch, now = Date.now }) {
  const url = ({ location, name }) => `${CONTAINER}/projects/${project}/locations/${encodeURIComponent(location)}/clusters/${encodeURIComponent(name)}`;
  const getCluster = async (cluster) => clusterView(await google.request('GET', url(cluster)));
  const kept = new Map();

  // A cluster's view, read once per CLUSTER_TTL_MS as k8s.mjs keeps EKS's. A failure is not kept, nor a cluster that cannot be reached: turned on, it is at once.
  function viewOf(cluster) {
    const key = clusterText(cluster);
    const entry = kept.get(key);
    if (entry && now() - entry.at < CLUSTER_TTL_MS) return entry.pending;
    const asked = { at: now(), pending: getCluster(cluster) };
    kept.set(key, asked);
    const forget = () => { if (kept.get(key) === asked) kept.delete(key); };
    asked.pending.then((view) => { if (clusterProblem(cluster, view)) forget(); }, forget);
    return asked.pending;
  }

  return {
    // Read now, for what must not be 15 minutes old: a dry run after what it said was turned on.
    getCluster,
    // The `kubernetes` client of a cluster (lambda/src/lib/k8s.mjs), as the shared modules take it from `kubernetesOf`.
    kubernetesOf: async (cluster) => {
      const view = await viewOf(cluster);
      const problem = clusterProblem(cluster, view);
      if (problem) throw failureError('configuration', problem);
      return createKubernetes({ transport: transportOf(view.endpoint, { token: google.token, fetch }) });
    },
  };
}
