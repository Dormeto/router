// The router against a real Kubernetes API (npm run test:k8s: a kind cluster on podman, scripts/kind-up.sh; never in npm
// test). The router acts as the group dormeto:router (impersonated by kind's admin), whose rights come from the published
// manifest (kubernetes/dormeto-router.yaml): what EKS gives the router's roles through their access entries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createKubernetes } from '../src/lib/k8s.mjs';
import { checkRights } from '../src/lib/kube-access.mjs';
import { k8sBackend, k8sRecord, k8sStatus, sleepK8s, wakeK8s } from '../src/lib/kubernetes.mjs';
import { applyIngressRoute, ingressPath, patchCustomerIngress, restoreCustomerIngress } from '../src/lib/kube-route.mjs';

const NAMESPACE = 'dormeto-test';
const kubeconfig = readFileSync(new URL('../../.build/kind/kubeconfig', import.meta.url), 'utf8');
const value = (name) => Buffer.from(new RegExp(`${name}: (\\S+)`).exec(kubeconfig)[1], 'base64').toString();
const endpoint = /server: (\S+)/.exec(kubeconfig)[1];
const connection = { endpoint, ca: value('certificate-authority-data'), cert: value('client-certificate-data'), key: value('client-key-data') };
const admin = createKubernetes(connection);
const router = createKubernetes({ ...connection, impersonate: { user: 'dormeto-test', groups: ['dormeto:router', 'system:authenticated'] } });

// The router's ports: its cluster as dormeto:router, and a target group with no target (no load balancer in kind).
const ports = { kubernetesOf: async () => router, elbv2: { describeTargetHealth: async () => ({ TargetHealthDescriptions: [] }) } };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const timing = (ms = 120_000) => ({ sleep, now: Date.now, deadline: Date.now() + ms });
const config = (owner, extra = {}) => ({ workloadId: 'kindtest', appTargetGroupArn: 'arn:tg/none', wakerTargetGroupArn: 'arn:aws:elasticloadbalancing:eu-west-1:111122223333:targetgroup/dmt-dev-kindtest/1', kubernetes: { cluster: 'kind', namespace: NAMESPACE, owner: { kind: 'Deployment', name: owner }, ...extra } });
async function until(check, ms = 120_000) {
  for (const deadline = Date.now() + ms; ; await sleep(2000)) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error('timed out');
  }
}

test('the group dormeto:router has every right the router checks (the published manifest)', async () => {
  assert.deepEqual(await checkRights(router, NAMESPACE), []);
});

test('a nap scales the owner to 0 through its scale subresource and waits for its pods; a wake gives its replicas back', async () => {
  const [backend] = (await k8sBackend(ports, config('web'))).backends;
  assert.equal(backend.replicas, 2);
  await sleepK8s(ports, backend, timing());
  assert.equal(await k8sStatus(ports, backend), 'stopped');
  await wakeK8s(ports, k8sRecord(backend), timing());
  await until(async () => (await k8sStatus(ports, backend)) === 'running');
  assert.equal((await admin.get(`/apis/apps/v1/namespaces/${NAMESPACE}/deployments/web`)).spec.replicas, 2);
});

test('a ScaledObject paused at 0 keeps its owner at 0 though its trigger wants 1; the wake removes the pause', async () => {
  const [backend] = (await k8sBackend(ports, config('api'))).backends;
  assert.deepEqual(backend.keda, { name: 'api-scaler', paused: null });
  await sleepK8s(ports, backend, timing());
  await sleep(20_000);
  assert.equal((await admin.get(`/apis/apps/v1/namespaces/${NAMESPACE}/deployments/api`)).spec.replicas, 0, 'KEDA held 0');
  await wakeK8s(ports, k8sRecord(backend), timing());
  const scaler = await admin.get(`/apis/keda.sh/v1alpha1/namespaces/${NAMESPACE}/scaledobjects/api-scaler`);
  assert.equal(scaler.metadata.annotations?.['autoscaling.keda.sh/paused-replicas'], undefined);
  await until(async () => (await k8sStatus(ports, backend)) === 'running');
});

const grouped = () => config('web', { switch: 'ingress', ingress: { name: 'web', ruleIndex: 0, groupOrder: -100, service: { name: 'web', port: { number: 80 } } } });

test('Dormeto\'s Ingress is created, switched and removed by the group', async () => {
  const cfg = grouped();
  assert.deepEqual(await applyIngressRoute(ports, cfg, 'app', { wait: false }), ['dormeto-kindtest']);
  assert.deepEqual(await applyIngressRoute(ports, cfg, 'app', { wait: false }), [], 'unchanged');
  assert.deepEqual(await applyIngressRoute(ports, cfg, 'waker', { wait: false }), ['dormeto-kindtest']);
  const ours = await admin.get(ingressPath(NAMESPACE, 'dormeto-kindtest'));
  assert.equal(ours.metadata.labels['dormeto.com/managed'], 'true');
  assert.equal(ours.metadata.annotations['alb.ingress.kubernetes.io/healthcheck-path'], '/health');
  assert.equal(JSON.parse(ours.metadata.annotations['alb.ingress.kubernetes.io/actions.dormeto']).forwardConfig.targetGroups[1].weight, 1);
  await router.remove(ingressPath(NAMESPACE, 'dormeto-kindtest'));
  await until(async () => (await admin.get(ingressPath(NAMESPACE, 'dormeto-kindtest')).catch((err) => (err.status === 404 ? null : Promise.reject(err)))) === null, 30_000);
});

test('the admission policy refuses the group\'s create and delete of an Ingress without the label; a patch of a lone Ingress is allowed and restored exactly', async () => {
  const stranger = { apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: { name: 'stranger', namespace: NAMESPACE }, spec: { rules: [{ host: 'x.test', http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'web', port: { number: 80 } } } }] } }] } };
  await assert.rejects(router.create(ingressPath(NAMESPACE), stranger), /Dormeto creates and deletes only its own Ingresses/);
  await assert.rejects(router.remove(ingressPath(NAMESPACE, 'web')), /Dormeto creates and deletes only its own Ingresses/);

  const cfg = config('web', { switch: 'patched-ingress', ingress: { name: 'solo', ruleIndex: 0, service: { name: 'web', port: { number: 80 } } } });
  const before = await admin.get(ingressPath(NAMESPACE, 'solo'));
  assert.equal((await patchCustomerIngress(ports, cfg, { app: 0, waker: 1 })).changed, true);
  assert.equal((await admin.get(ingressPath(NAMESPACE, 'solo'))).spec.rules[0].http.paths[0].backend.service.name, 'dormeto');
  await restoreCustomerIngress(ports, cfg);
  const after = await admin.get(ingressPath(NAMESPACE, 'solo'));
  const strip = ({ metadata: { resourceVersion, generation, managedFields, ...metadata }, ...rest }) => ({ ...rest, metadata });
  assert.deepEqual(strip(after), strip(before));
});
