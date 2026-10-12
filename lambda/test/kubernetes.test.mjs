// Kubernetes workloads (vision docs/specs/2026-10-11-kubernetes-design.md, sections 3, 7 and 9): a Deployment or a
// StatefulSet napped by its scale subresource, KEDA paused, an HPA left alone, the pods behind the target group checked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { k8sBackend, k8sItems, k8sStatus, labelSelector, sleepK8s, wakeK8s } from '../src/lib/kubernetes.mjs';
import { backendStatuses, resolveBackends, resumeBackends, sleepBackends, toRecord, wakeBackends } from '../src/lib/backends.mjs';
import { describeStopped } from '../src/lib/stopped.mjs';
import { fakeClock, fakeElbv2, fakeKubernetes, k8sConfig, k8sNode, k8sOwner, k8sPod } from './fakes.mjs';

const ID = 'eks-demo/demo/Deployment/web';
const PAUSE = 'autoscaling.keda.sh/paused-replicas';
const scaledObject = (name, target, annotations = {}) => ({ metadata: { name, namespace: 'demo', annotations }, spec: { scaleTargetRef: target } });

// The workload's ports: its target group's targets (pod IPs by default) and the cluster named in its configuration.
function setup({ cfg = k8sConfig(), owners = [k8sOwner('web', { replicas: 2 })], pods, targets, ...cluster } = {}) {
  const thePods = pods ?? [k8sPod('web-1', { ip: '10.0.1.1' }), k8sPod('web-2', { ip: '10.0.1.2' })];
  const k8s = fakeKubernetes({ owners, pods: thePods, ...cluster });
  const elbv2 = fakeElbv2(cfg);
  elbv2.state.targets = targets ?? thePods.filter((p) => p.status.podIP).map((p) => ({ Id: p.status.podIP, State: 'healthy' }));
  const clusters = [];
  const ports = { elbv2, kubernetesOf: async (name) => { clusters.push(name); return k8s; } };
  return { cfg, k8s, elbv2, ports, clusters };
}
const timing = (clock = fakeClock(), ms = 300_000) => ({ sleep: clock.sleep, now: clock.now, deadline: clock.now() + ms });
const writes = (k8s) => k8s.state.calls.filter(([method]) => method === 'PATCH').map(([, path, body]) => [path, body]);

test('the backend of a Kubernetes workload: its owner and replicas, read in the cluster its configuration names', async () => {
  const { cfg, ports, clusters } = setup();
  assert.deepEqual(await k8sBackend(ports, cfg), {
    backends: [{ kind: 'k8s', id: ID, cluster: 'eks-demo', namespace: 'demo', owner: { kind: 'Deployment', name: 'web' }, replicas: 2, keda: null, autoscaler: null }],
    ignored: [],
  });
  assert.deepEqual(clusters, ['eks-demo']);
});

test('a StatefulSet is read under its own resource, and the node autoscaler found by discovery is kept for the savings', async () => {
  const cfg = k8sConfig({ owner: { kind: 'StatefulSet', name: 'cache' }, autoscaler: 'cluster-autoscaler' });
  const { ports } = setup({ cfg, owners: [k8sOwner('cache', { kind: 'StatefulSet', replicas: 1 })], pods: [k8sPod('cache-0', { ip: '10.0.2.1', owner: { kind: 'StatefulSet', name: 'cache' } })] });
  const { backends: [backend] } = await k8sBackend(ports, cfg);
  assert.equal(backend.id, 'eks-demo/demo/StatefulSet/cache');
  assert.equal(backend.replicas, 1);
  assert.equal(backend.autoscaler, 'cluster-autoscaler');
});

test('the KEDA ScaledObject of the owner is found, a customer\'s own pause kept to be restored; KEDA missing is no ScaledObject', async () => {
  const objects = [
    scaledObject('other', { name: 'api' }),
    scaledObject('web-scaler', { name: 'web', kind: 'Deployment' }),
  ];
  assert.deepEqual((await k8sBackend(setup({ scaledObjects: objects }).ports, k8sConfig())).backends[0].keda, { name: 'web-scaler', paused: null });
  const paused = [scaledObject('web-scaler', { name: 'web' }, { [PAUSE]: '3' })];
  assert.deepEqual((await k8sBackend(setup({ scaledObjects: paused }).ports, k8sConfig())).backends[0].keda, { name: 'web-scaler', paused: '3' });
  // A pause at 0 is Dormeto's own (a nap in progress or interrupted): a wake must not leave KEDA paused at 0.
  const ours = [scaledObject('web-scaler', { name: 'web' }, { [PAUSE]: '0' })];
  assert.deepEqual((await k8sBackend(setup({ scaledObjects: ours }).ports, k8sConfig())).backends[0].keda, { name: 'web-scaler', paused: null });
  const sts = [scaledObject('web-scaler', { name: 'web', kind: 'StatefulSet' })];
  assert.equal((await k8sBackend(setup({ scaledObjects: sts }).ports, k8sConfig())).backends[0].keda, null, 'a ScaledObject of another kind of owner');
  assert.equal((await k8sBackend(setup({ keda: false }).ports, k8sConfig())).backends[0].keda, null);
});

test('refused when the target group\'s pods are not the owner\'s: never a scale of the wrong owner (review focus 1)', async () => {
  const { ports, cfg } = setup({ targets: [{ Id: '10.0.1.1', State: 'healthy' }, { Id: '10.0.7.7', State: 'healthy' }] });
  assert.deepEqual(await k8sBackend(ports, cfg), {
    backends: [],
    ignored: [{ id: ID, reason: 'targets 10.0.7.7 of the target group are not pods of Deployment demo/web' }],
  });
  // Targets still draining after a rollout are not counted.
  const draining = setup({ targets: [{ Id: '10.0.1.1', State: 'healthy' }, { Id: '10.0.7.7', State: 'draining' }] });
  assert.equal((await k8sBackend(draining.ports, draining.cfg)).backends.length, 1);
});

// Selectors are not ownership: a canary Deployment selecting app=web too, created after onboarding.
test('pods of another owner whose selector matches them are not the owner\'s: foreign behind the target group, never waited for at a nap (review focus 1)', async () => {
  const owners = [k8sOwner('web', { replicas: 2 }), k8sOwner('web-canary', { labels: { app: 'web' } })];
  const pods = [k8sPod('web-1', { ip: '10.0.1.1' }), k8sPod('web-canary-1', { ip: '10.0.1.9', labels: { app: 'web' } })];
  const both = setup({ owners, pods });
  assert.deepEqual(await k8sBackend(both.ports, both.cfg), { backends: [], ignored: [{ id: ID, reason: 'targets 10.0.1.9 of the target group are not pods of Deployment demo/web' }] });
  const one = setup({ owners, pods, targets: [{ Id: '10.0.1.1', State: 'healthy' }] });
  const [backend] = (await k8sBackend(one.ports, one.cfg)).backends;
  await sleepK8s(one.ports, backend, timing(fakeClock(), 30_000));
  assert.deepEqual(one.k8s.state.pods.map((p) => p.metadata.name), ['web-canary-1']);
  assert.equal(await k8sStatus(one.ports, backend), 'stopped');
});

test('an owner that no longer exists is ignored with the reason; instance targets (a NodePort Service) are not compared with pods', async () => {
  const gone = setup({ owners: [] });
  assert.deepEqual(await k8sBackend(gone.ports, gone.cfg), { backends: [], ignored: [{ id: ID, reason: 'Deployment demo/web not found in cluster eks-demo' }] });
  const nodes = setup({ targets: [{ Id: 'i-0abc', State: 'healthy' }] });
  assert.equal((await k8sBackend(nodes.ports, nodes.cfg)).backends.length, 1);
});

test('a cluster error is not a reason to ignore the backend: it fails the caller (permission, cluster)', async () => {
  const { cfg, elbv2 } = setup();
  const refused = Object.assign(new Error('forbidden'), { name: 'KubernetesError', status: 403, reason: 'Forbidden' });
  await assert.rejects(k8sBackend({ elbv2, kubernetesOf: async () => ({ get: async () => { throw refused; } }) }, cfg), { status: 403 });
});

test('labelSelector writes an owner\'s selector as the API takes it', () => {
  assert.equal(labelSelector({ matchLabels: { app: 'web', tier: 'front' } }), 'app=web,tier=front');
  assert.equal(labelSelector({
    matchLabels: { app: 'web' },
    matchExpressions: [
      { key: 'env', operator: 'In', values: ['a', 'b'] }, { key: 'canary', operator: 'NotIn', values: ['true'] },
      { key: 'ready', operator: 'Exists' }, { key: 'legacy', operator: 'DoesNotExist' },
    ],
  }), 'app=web,env in (a,b),canary notin (true),ready,!legacy');
});

test('a nap pauses the ScaledObject, scales the owner to 0 through its scale subresource and waits for its pods to go; the HPA is left alone', async () => {
  const { cfg, k8s, ports } = setup({ scaledObjects: [scaledObject('web-scaler', { name: 'web' })], stopAfter: 2 });
  const [backend] = (await k8sBackend(ports, cfg)).backends;
  const clock = fakeClock();
  await sleepK8s(ports, backend, timing(clock));
  assert.deepEqual(writes(k8s), [
    ['/apis/keda.sh/v1alpha1/namespaces/demo/scaledobjects/web-scaler', { metadata: { annotations: { [PAUSE]: '0' } } }],
    ['/apis/apps/v1/namespaces/demo/deployments/web/scale', { spec: { replicas: 0 } }],
  ]);
  assert.equal(k8s.state.pods.length, 0);
  assert.ok(clock.now() > fakeClock().now(), 'it waited for the pods');
  assert.ok(!k8s.state.calls.some(([, path]) => /horizontalpodautoscalers/.test(path)));
  assert.deepEqual(toRecord(backend), { kind: 'k8s', id: ID, cluster: 'eks-demo', namespace: 'demo', owner: { kind: 'Deployment', name: 'web' }, replicas: 2, keda: { name: 'web-scaler', paused: null } });
});

test('a nap whose pods do not go fails at its deadline', async () => {
  const { cfg, ports } = setup({ stopAfter: 1_000 });
  const [backend] = (await k8sBackend(ports, cfg)).backends;
  await assert.rejects(sleepK8s(ports, backend, timing(fakeClock(), 30_000)), /timeout waiting for the pods of Deployment demo\/web to stop/);
});

test('a wake scales back to the recorded replicas, at least 1, then removes the KEDA pause or gives the customer\'s own back', async () => {
  const { k8s, ports } = setup({ owners: [k8sOwner('web', { replicas: 0 })], pods: [], scaledObjects: [scaledObject('web-scaler', { name: 'web' }, { [PAUSE]: '0' })] });
  const record = { kind: 'k8s', id: ID, cluster: 'eks-demo', namespace: 'demo', owner: { kind: 'Deployment', name: 'web' }, replicas: 2, keda: { name: 'web-scaler', paused: null } };
  await wakeK8s(ports, record, timing());
  assert.deepEqual(writes(k8s), [
    ['/apis/apps/v1/namespaces/demo/deployments/web/scale', { spec: { replicas: 2 } }],
    ['/apis/keda.sh/v1alpha1/namespaces/demo/scaledobjects/web-scaler', { metadata: { annotations: { [PAUSE]: null } } }],
  ]);
  assert.deepEqual(k8s.state.scaledObjects[0].metadata.annotations, {});

  const again = setup({ owners: [k8sOwner('web', { replicas: 0 })], pods: [], scaledObjects: [scaledObject('web-scaler', { name: 'web' }, { [PAUSE]: '0' })] });
  await wakeK8s(again.ports, { ...record, replicas: 0, keda: { name: 'web-scaler', paused: '3' } }, timing());
  assert.deepEqual(writes(again.k8s), [
    ['/apis/apps/v1/namespaces/demo/deployments/web/scale', { spec: { replicas: 1 } }],
    ['/apis/keda.sh/v1alpha1/namespaces/demo/scaledobjects/web-scaler', { metadata: { annotations: { [PAUSE]: '3' } } }],
  ]);
});

test('the status of a Kubernetes backend, from its replicas and its pods\' phases', async () => {
  const status = async (replicas, pods) => k8sStatus(setup({ owners: [k8sOwner('web', { replicas })], pods }).ports, { cluster: 'eks-demo', namespace: 'demo', owner: { kind: 'Deployment', name: 'web' } });
  assert.equal(await status(0, []), 'stopped');
  assert.equal(await status(0, [k8sPod('web-1', { phase: 'Failed', ready: false }), k8sPod('web-2', { phase: 'Succeeded', ready: false })]), 'stopped', 'finished pods are gone');
  assert.equal(await status(2, [k8sPod('web-1'), k8sPod('web-2', { phase: 'Pending', ready: false })]), 'running', 'one ready pod serves');
  assert.equal(await status(1, [k8sPod('web-1', { phase: 'Pending', ready: false })]), 'transitioning');
  assert.equal(await status(1, [k8sPod('web-1', { ready: false })]), 'transitioning', 'running but not ready');
  assert.equal(await status(1, []), 'transitioning');
  const terminating = k8sPod('web-1');
  terminating.metadata.deletionTimestamp = '2026-10-11T10:00:00Z';
  assert.equal(await status(0, [terminating]), 'transitioning');
  assert.equal(await k8sStatus(setup({ owners: [] }).ports, { cluster: 'eks-demo', namespace: 'demo', owner: { kind: 'Deployment', name: 'web' } }), 'transitioning');
});

test('backends.mjs: a workload with a kubernetes configuration resolves, naps, wakes and resumes its k8s backend', async () => {
  const { cfg, k8s, ports } = setup({ scaledObjects: [scaledObject('web-scaler', { name: 'web' })] });
  const resolved = await resolveBackends(ports, cfg);
  assert.equal(resolved.mode, 'kubernetes');
  assert.deepEqual(resolved.backends.map((b) => b.id), [ID]);
  assert.deepEqual(await backendStatuses(ports, resolved.backends), { [`k8s:${ID}`]: 'running' });
  const records = await sleepBackends(ports, resolved.backends, timing());
  assert.deepEqual(records, [{ kind: 'k8s', id: ID, cluster: 'eks-demo', namespace: 'demo', owner: { kind: 'Deployment', name: 'web' }, replicas: 2, keda: { name: 'web-scaler', paused: null } }]);
  assert.deepEqual(await backendStatuses(ports, resolved.backends), { [`k8s:${ID}`]: 'stopped' });
  await wakeBackends(ports, records, timing());
  assert.equal(k8s.state.owners[0].spec.replicas, 2);

  // After a wake outside Dormeto (GitOps set 3 replicas): KEDA unpaused, the replicas kept.
  k8s.state.owners[0].spec.replicas = 3;
  k8s.state.scaledObjects[0].metadata.annotations = { [PAUSE]: '0' };
  k8s.state.calls.length = 0;
  await resumeBackends(ports, records);
  assert.deepEqual(writes(k8s), [['/apis/keda.sh/v1alpha1/namespaces/demo/scaledobjects/web-scaler', { metadata: { annotations: { [PAUSE]: null } } }]]);
  assert.equal(k8s.state.owners[0].spec.replicas, 3);
});

test('a wake that the cluster refuses names the k8s backend that failed (R7a)', async () => {
  const record = { kind: 'k8s', id: ID, cluster: 'eks-demo', namespace: 'demo', owner: { kind: 'Deployment', name: 'web' }, replicas: 1, keda: null };
  const ports = { kubernetesOf: async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { name: 'KubernetesError', status: 0, reason: 'ECONNREFUSED' }); } };
  await assert.rejects(wakeBackends(ports, [record], timing()), (err) => err.backend === `k8s:${ID}`);
});

// What a nap stops (R9), for the savings.
const fargateNode = 'fargate-ip-10-0-3-1.eu-west-1.compute.internal';

test('a Fargate pod is the Fargate size it was given (its CapacityProvisioned), or its requests plus 256 MB rounded up to a Fargate size', async () => {
  const { ports } = setup({
    pods: [
      k8sPod('web-1', { ip: '10.0.3.1', node: fargateNode, fargate: true, annotations: { CapacityProvisioned: '0.25vCPU 0.5GB' }, requests: { cpu: '100m', memory: '128Mi' } }),
      k8sPod('web-2', { ip: '10.0.3.2', node: fargateNode, fargate: true, annotations: { CapacityProvisioned: '0.25vCPU 0.5GB' }, requests: { cpu: '100m', memory: '128Mi' } }),
      k8sPod('web-3', { ip: '10.0.3.3', node: fargateNode, fargate: true, requests: { cpu: '300m', memory: '700Mi' } }),
      k8sPod('web-4', { ip: '10.0.3.4', node: fargateNode, fargate: true, requests: { cpu: '250m', memory: '256Mi' }, init: { cpu: '1', memory: '1Gi' } }),
    ],
  });
  const backend = (await k8sBackend(ports, k8sConfig())).backends[0];
  assert.deepEqual(await k8sItems(ports, backend), [
    { kind: 'fargate', vcpu: 0.25, memoryGb: 0.5, count: 2, arch: 'x86_64', os: 'Linux' },
    { kind: 'fargate', vcpu: 0.5, memoryGb: 1, count: 1, arch: 'x86_64', os: 'Linux' },
    // The larger of the containers' sum and the largest init container (1 vCPU, 1 GiB + 256 MB → 2 GB).
    { kind: 'fargate', vcpu: 1, memoryGb: 2, count: 1, arch: 'x86_64', os: 'Linux' },
  ]);
});

test('pods on EC2 nodes: their requests, the node\'s type, allocatable and capacity type, and whether an autoscaler frees the node', async () => {
  const spot = 'ip-10-0-1-1.eu-west-1.compute.internal';
  const group = 'ip-10-0-1-2.eu-west-1.compute.internal';
  const { ports } = setup({
    pods: [
      k8sPod('web-1', { ip: '10.0.1.1', node: spot }), k8sPod('web-2', { ip: '10.0.1.2', node: spot }),
      k8sPod('web-3', { ip: '10.0.1.3', node: group, requests: { cpu: '500m', memory: '1Gi' } }),
    ],
    nodes: [
      k8sNode(spot, { labels: { 'karpenter.sh/nodepool': 'default', 'karpenter.sh/capacity-type': 'spot' } }),
      k8sNode(group, { type: 't4g.medium', labels: { 'eks.amazonaws.com/nodegroup': 'system', 'eks.amazonaws.com/capacityType': 'ON_DEMAND' }, allocatable: { cpu: '1930m', memory: '3366880Ki' } }),
    ],
  });
  const backend = (await k8sBackend(ports, k8sConfig())).backends[0];
  assert.deepEqual(await k8sItems(ports, backend), [
    { kind: 'k8s-pods', count: 2, cpu: 0.25, memoryGb: 0.5, nodeType: 'm5.large', os: 'Linux', spot: true, autoscaled: true, allocatable: { cpu: 1.93, memoryGb: 6.886 } },
    { kind: 'k8s-pods', count: 1, cpu: 0.5, memoryGb: 1, nodeType: 't4g.medium', os: 'Linux', autoscaled: false, allocatable: { cpu: 1.93, memoryGb: 3.211 } },
  ]);
  // A managed node group under the Cluster Autoscaler (found by discovery) frees its nodes too.
  const autoscaled = await k8sItems(ports, { ...backend, autoscaler: 'cluster-autoscaler' });
  assert.equal(autoscaled[1].autoscaled, true);
});

test('pods without CPU and memory requests are said, not priced', async () => {
  const { ports } = setup({ pods: [k8sPod('web-1', { ip: '10.0.1.1', requests: null })], nodes: [k8sNode('ip-10-0-1-1.eu-west-1.compute.internal')] });
  const backend = (await k8sBackend(ports, k8sConfig())).backends[0];
  assert.deepEqual(await k8sItems(ports, backend), [
    { kind: 'unknown', backend: `k8s:${ID}`, reason: 'pods without CPU and memory requests: their share of the node is unknown' },
  ]);
});

test('describeStopped describes a k8s backend through the cluster; a cluster error is an unknown item, never a failed nap', async () => {
  const { ports } = setup({ nodes: [k8sNode('ip-10-0-1-1.eu-west-1.compute.internal')] });
  const backend = (await k8sBackend(ports, k8sConfig())).backends[0];
  assert.deepEqual(await describeStopped(ports, [backend]), [
    { kind: 'k8s-pods', count: 2, cpu: 0.25, memoryGb: 0.5, nodeType: 'm5.large', os: 'Linux', autoscaled: false, allocatable: { cpu: 1.93, memoryGb: 6.886 } },
  ]);
  const broken = await describeStopped({ kubernetesOf: async () => { throw new Error('cluster unreachable'); } }, [backend]);
  assert.deepEqual(broken, [{ kind: 'unknown', backend: `k8s:${ID}`, reason: 'cluster unreachable' }]);
});
