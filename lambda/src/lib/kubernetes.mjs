// Kubernetes workloads (vision docs/specs/2026-10-11-kubernetes-design.md, sections 3, 7 and 9): a Deployment or a
// StatefulSet behind the workload's target group, read in the cluster its configuration names (Kubernetes objects carry
// no AWS tags), napped by its scale subresource with its KEDA ScaledObject paused. An HPA does nothing on a target at 0
// replicas: it is left alone.
const POLL_MS = 3000;
const RESOURCES = { Deployment: 'deployments', StatefulSet: 'statefulsets' };
export const KEDA_PAUSE = 'autoscaling.keda.sh/paused-replicas';
// Fargate adds 256 MB to each pod for the Kubernetes components, before rounding up to one of its sizes.
const FARGATE_EXTRA_GB = 0.25;
const GIB = 2 ** 30;
const UNPRICED = 'pods without CPU and memory requests: their share of the node is unknown';

const ownerPath = ({ namespace, owner }) => `/apis/apps/v1/namespaces/${namespace}/${RESOURCES[owner.kind]}/${owner.name}`;
const ownerText = ({ namespace, owner }) => `${owner.kind} ${namespace}/${owner.name}`;
const scaledObjects = (namespace) => `/apis/keda.sh/v1alpha1/namespaces/${namespace}/scaledobjects`;
export const k8sId = ({ cluster, namespace, owner }) => `${cluster}/${namespace}/${owner.kind}/${owner.name}`;

const OPERATORS = {
  In: (key, values) => `${key} in (${values.join(',')})`,
  NotIn: (key, values) => `${key} notin (${values.join(',')})`,
  Exists: (key) => key,
  DoesNotExist: (key) => `!${key}`,
};

// An owner's selector as the API's labelSelector parameter takes it.
export function labelSelector({ matchLabels = {}, matchExpressions = [] } = {}) {
  return [
    ...Object.entries(matchLabels).map(([key, value]) => `${key}=${value}`),
    ...matchExpressions.map((e) => OPERATORS[e.operator](e.key, e.values ?? [])),
  ].join(',');
}

const finished = (pod) => pod.status?.phase === 'Succeeded' || pod.status?.phase === 'Failed';
const ready = (pod) => !pod.metadata?.deletionTimestamp && pod.status?.phase === 'Running'
  && (pod.status.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True');

const controllerOf = (object) => (object.metadata?.ownerReferences ?? []).find((r) => r.controller);

// The owner's pods still there (finished ones are gone for good): those it controls, a Deployment through its ReplicaSets.
// Its selector may match another owner's pods (a canary selecting the same labels): never waited for, foreign behind
// the target group.
async function livePods(k8s, ref, object) {
  const query = { labelSelector: labelSelector(object.spec?.selector) };
  const [pods, sets] = await Promise.all([
    k8s.list(`/api/v1/namespaces/${ref.namespace}/pods`, query),
    ref.owner.kind === 'Deployment' ? k8s.list(`/apis/apps/v1/namespaces/${ref.namespace}/replicasets`, query) : [],
  ]);
  const parents = new Set(ref.owner.kind === 'Deployment'
    ? sets.filter((rs) => controllerOf(rs)?.kind === 'Deployment' && controllerOf(rs).name === ref.owner.name).map((rs) => `ReplicaSet/${rs.metadata.name}`)
    : [`${ref.owner.kind}/${ref.owner.name}`]);
  return pods.filter((pod) => !finished(pod) && parents.has(`${controllerOf(pod)?.kind}/${controllerOf(pod)?.name}`));
}

// The owner, or null when it does not exist.
async function ownerOf(k8s, ref) {
  try {
    return await k8s.get(ownerPath(ref));
  } catch (err) {
    if (err?.status === 404) return null;
    throw err;
  }
}

// The owner's pods still there; none when the owner is gone.
export async function ownerPods(k8s, ref) {
  const object = await ownerOf(k8s, ref);
  return object ? livePods(k8s, ref, object) : [];
}

// The owner's ScaledObject: its name and the customer's own pause, if any. A pause at 0 is Dormeto's (a nap in progress
// or interrupted): a wake never gives it back. Without KEDA's API, none.
async function scaledObjectOf(k8s, ref) {
  let objects;
  try {
    objects = await k8s.list(scaledObjects(ref.namespace));
  } catch (err) {
    if (err?.status === 404) return null;
    throw err;
  }
  const found = objects.find((s) => s.spec?.scaleTargetRef?.name === ref.owner.name && (s.spec.scaleTargetRef.kind ?? 'Deployment') === ref.owner.kind);
  if (!found) return null;
  const paused = found.metadata?.annotations?.[KEDA_PAUSE] ?? null;
  return { name: found.metadata.name, paused: paused === '0' ? null : paused };
}

// { backends, ignored }: the workload's owner, unless the target group's targets are pods of something else (never a
// scale of the wrong owner) or it is gone. Instance targets (a NodePort Service) are nodes, not compared with pods.
export async function k8sBackend({ elbv2, kubernetesOf }, cfg) {
  const ref = cfg.kubernetes;
  const id = k8sId(ref);
  const k8s = await kubernetesOf(ref.cluster);
  const object = await ownerOf(k8s, ref);
  if (!object) return { backends: [], ignored: [{ id, reason: `${ownerText(ref)} not found in cluster ${ref.cluster}` }] };
  const [pods, keda, health] = await Promise.all([
    livePods(k8s, ref, object),
    scaledObjectOf(k8s, ref),
    elbv2.describeTargetHealth({ TargetGroupArn: cfg.appTargetGroupArn }),
  ]);
  const ips = new Set(pods.map((p) => p.status?.podIP).filter(Boolean));
  const foreign = (health.TargetHealthDescriptions ?? [])
    .filter((d) => d.TargetHealth?.State !== 'draining')
    .map((d) => d.Target?.Id)
    .filter((target) => target && !target.startsWith('i-') && !ips.has(target));
  if (foreign.length) {
    return { backends: [], ignored: [{ id, reason: `targets ${foreign.slice(0, 5).join(', ')} of the target group are not pods of ${ownerText(ref)}` }] };
  }
  return {
    backends: [{
      kind: 'k8s', id, cluster: ref.cluster, namespace: ref.namespace, owner: { kind: ref.owner.kind, name: ref.owner.name },
      replicas: object.spec?.replicas ?? 1, keda, autoscaler: ref.autoscaler ?? null,
    }],
    ignored: [],
  };
}

export const k8sRecord = (b) => ({ kind: 'k8s', id: b.id, cluster: b.cluster, namespace: b.namespace, owner: b.owner, replicas: b.replicas, keda: b.keda });

const unpause = (k8s, record) => k8s.patch(`${scaledObjects(record.namespace)}/${record.keda.name}`, { metadata: { annotations: { [KEDA_PAUSE]: record.keda.paused ?? null } } });

// KEDA paused at 0 first (it would scale the owner back up), then the owner scaled to 0; asleep once its pods are gone.
export async function sleepK8s({ kubernetesOf }, backend, timing) {
  const k8s = await kubernetesOf(backend.cluster);
  const object = await k8s.get(ownerPath(backend));
  if (backend.keda) await k8s.patch(`${scaledObjects(backend.namespace)}/${backend.keda.name}`, { metadata: { annotations: { [KEDA_PAUSE]: '0' } } });
  await k8s.patch(`${ownerPath(backend)}/scale`, { spec: { replicas: 0 } });
  for (;;) {
    if (!(await livePods(k8s, backend, object)).length) return;
    if (timing.now() >= timing.deadline) throw new Error(`timeout waiting for the pods of ${ownerText(backend)} to stop`);
    await timing.sleep(POLL_MS);
  }
}

// The recorded replicas (at least 1), then KEDA unpaused (the customer's own pause given back).
export async function wakeK8s({ kubernetesOf }, record) {
  const k8s = await kubernetesOf(record.cluster);
  await k8s.patch(`${ownerPath(record)}/scale`, { spec: { replicas: Math.max(1, record.replicas ?? 0) } });
  if (record.keda) await unpause(k8s, record);
}

// After a wake outside Dormeto: KEDA unpaused, the replicas it chose kept.
export async function resumeK8s({ kubernetesOf }, record) {
  if (record.keda) await unpause(await kubernetesOf(record.cluster), record);
}

// stopped: no replica and no pod left; running: replicas and a ready pod; transitioning otherwise (or the owner gone).
export async function k8sStatus({ kubernetesOf }, record) {
  const k8s = await kubernetesOf(record.cluster);
  const object = await ownerOf(k8s, record);
  if (!object) return 'transitioning';
  const pods = await livePods(k8s, record, object);
  const replicas = object.spec?.replicas ?? 1;
  if (replicas === 0 && !pods.length) return 'stopped';
  if (replicas > 0 && pods.some(ready)) return 'running';
  return 'transitioning';
}

// A Kubernetes quantity ('250m', '512Mi', '1e9', '2') as a number.
const BINARY = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, Ei: 2 ** 60 };
const DECIMAL = { k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18 };
const FRACTION = { n: 1e9, u: 1e6, m: 1e3 };
function quantity(text) {
  const match = /^([0-9.]+(?:[eE][+-]?\d+)?)([a-zA-Z]*)$/.exec(String(text ?? '').trim());
  if (!match) return 0;
  const [, number, suffix] = match;
  if (FRACTION[suffix]) return Number(number) / FRACTION[suffix];
  return Number(number) * (BINARY[suffix] ?? DECIMAL[suffix] ?? 1);
}

// A pod's effective request: the larger of its containers' sum and its largest init container, plus its overhead.
function requestsOf(pod) {
  const { containers = [], initContainers = [], overhead } = pod.spec ?? {};
  const of = (key) => Math.max(
    containers.reduce((n, c) => n + quantity(c.resources?.requests?.[key]), 0),
    ...initContainers.map((c) => quantity(c.resources?.requests?.[key])),
  ) + quantity(overhead?.[key]);
  return { cpu: of('cpu'), memoryGb: of('memory') / GIB };
}

const steps = (from, to, by) => Array.from({ length: (to - from) / by + 1 }, (_, i) => from + i * by);
const FARGATE_SIZES = [[0.25, [0.5, 1, 2]], [0.5, [1, 2, 3, 4]], [1, steps(2, 8, 1)], [2, steps(4, 16, 1)], [4, steps(8, 30, 1)], [8, steps(16, 60, 4)], [16, steps(32, 120, 8)]];

// The size Fargate gave the pod (its CapacityProvisioned annotation), else its requests plus 256 MB rounded up to a
// Fargate size; null above the largest.
function fargateSize(pod) {
  const provisioned = /^([\d.]+)vCPU ([\d.]+)GB$/.exec(pod.metadata?.annotations?.CapacityProvisioned ?? '');
  if (provisioned) return { vcpu: Number(provisioned[1]), memoryGb: Number(provisioned[2]) };
  const { cpu, memoryGb } = requestsOf(pod);
  for (const [vcpu, sizes] of FARGATE_SIZES) {
    const fit = sizes.find((gb) => gb >= memoryGb + FARGATE_EXTRA_GB);
    if (vcpu >= cpu && fit !== undefined) return { vcpu, memoryGb: fit };
  }
  return null;
}

const isFargate = (pod) => pod.spec?.schedulerName === 'fargate-scheduler' || pod.metadata?.annotations?.CapacityProvisioned !== undefined;
const round = (n) => Math.round(n * 1000) / 1000;

// A pod on an EC2 node: its requests, the node's instance type, OS, allocatable and capacity type, and whether a node
// autoscaler removes the node it frees (Karpenter's nodes; a node group when discovery found the Cluster Autoscaler).
function nodeItem(pod, node, backend) {
  const labels = node.metadata?.labels ?? {};
  const { cpu, memoryGb } = requestsOf(pod);
  const spot = labels['karpenter.sh/capacity-type'] === 'spot' || labels['eks.amazonaws.com/capacityType'] === 'SPOT';
  return {
    kind: 'k8s-pods', cpu: round(cpu), memoryGb: round(memoryGb),
    nodeType: labels['node.kubernetes.io/instance-type'] ?? labels['beta.kubernetes.io/instance-type'] ?? null,
    os: labels['kubernetes.io/os'] === 'windows' ? 'Windows' : 'Linux',
    ...(spot ? { spot: true } : {}),
    autoscaled: Boolean(labels['karpenter.sh/nodepool'] ?? labels['karpenter.sh/provisioner-name']) || backend.autoscaler === 'cluster-autoscaler',
    allocatable: { cpu: round(quantity(node.status?.allocatable?.cpu)), memoryGb: round(quantity(node.status?.allocatable?.memory) / GIB) },
  };
}

// What a nap of the backend stops (R9): its running pods, Fargate pods by size, the others by node; alike pods counted.
export async function k8sItems({ kubernetesOf }, backend) {
  const k8s = await kubernetesOf(backend.cluster);
  const pods = (await livePods(k8s, backend, await k8s.get(ownerPath(backend)))).filter((p) => !p.metadata?.deletionTimestamp && p.spec?.nodeName);
  const nodes = new Map();
  const counted = new Map();
  const unknown = new Set();
  for (const pod of pods) {
    let item;
    if (isFargate(pod)) {
      const size = fargateSize(pod);
      if (!size) { unknown.add('pods larger than any Fargate size'); continue; }
      item = { kind: 'fargate', ...size, arch: 'x86_64', os: 'Linux' };
    } else {
      const { cpu, memoryGb } = requestsOf(pod);
      if (!cpu && !memoryGb) { unknown.add(UNPRICED); continue; }
      const name = pod.spec.nodeName;
      if (!nodes.has(name)) nodes.set(name, k8s.get(`/api/v1/nodes/${name}`));
      item = nodeItem(pod, await nodes.get(name), backend);
    }
    const key = JSON.stringify(item);
    counted.set(key, { ...item, count: (counted.get(key)?.count ?? 0) + 1 });
  }
  return [...counted.values(), ...[...unknown].map((reason) => ({ kind: 'unknown', backend: `k8s:${backend.id}`, reason }))];
}
