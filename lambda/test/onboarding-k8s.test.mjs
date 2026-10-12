// Onboarding a Kubernetes workload (vision docs/specs/2026-10-11-kubernetes-design.md, sections 3 to 8): its owner behind
// the target group, the router's rights in the cluster, and the switch — Dormeto's Ingress in the customer's group, the
// customer's lone Ingress patched, or today's rules (TargetGroupBinding).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOnboarding, workloadIdOf } from '../src/lib/onboarding.mjs';
import { ROUTER_RULES } from '../src/lib/kube-access.mjs';
import { LB, LISTENER, WAKER_ARN, fakeAccount, tgArn } from './account-fake.mjs';
import { fakeClock, fakeKubernetes, k8sCustomerIngress, k8sOwner, k8sPod } from './fakes.mjs';

const ALB = 'alb.ingress.kubernetes.io/';
const host = (h) => ({ Field: 'host-header', Values: [h], HostHeaderConfig: { Values: [h] } });
const path = (p) => ({ Field: 'path-pattern', Values: [p], PathPatternConfig: { Values: [p] } });
const forward = (groups) => [{ Type: 'forward', Order: 1, ForwardConfig: { TargetGroups: groups.map(([TargetGroupArn, Weight]) => ({ TargetGroupArn, Weight })) } }];

const grouped = () => ({ cluster: 'eks-demo', namespace: 'demo', owner: { kind: 'Deployment', name: 'web' }, switch: 'ingress', ingress: { name: 'web', ruleIndex: 1, groupOrder: -100, service: { name: 'web', port: { number: 80 } } }, autoscaler: 'karpenter' });

// The customer's cluster and load balancer: the Ingress web in its group (rule 2 on the ALB), its target group with the
// pod; the controller makes Dormeto's rule (priority 1, its own target group) from Dormeto's Ingress.
function setup({ ingress = k8sCustomerIngress(), stuck = false } = {}) {
  const a = fakeAccount();
  const tg = a.customer.targetGroup('k8s-demo-web', { type: 'ip', targets: [{ Id: '10.0.1.1' }] });
  const ours = a.customer.targetGroup('k8s-demo-dormeto', { type: 'ip' });
  const customerRule = a.customer.rule(2, tg, { host: 'web.example.com', path: '/*' });
  const k8s = fakeKubernetes({ owners: [k8sOwner('web', { replicas: 2 })], pods: [k8sPod('web-1', { ip: '10.0.1.1' })], ingresses: [ingress] });
  k8s.state.review = { resourceRules: ROUTER_RULES.map((r) => ({ apiGroups: [r.group], resources: r.resources, verbs: r.verbs })), incomplete: false };
  k8s.state.onIngress = (object) => {
    if (stuck || !object) return;
    const action = object.metadata.annotations?.[`${ALB}actions.dormeto`];
    if (!action) return;
    const [app, waker] = JSON.parse(action).forwardConfig.targetGroups;
    const wakerTg = a.state.targetGroups.get(waker.targetGroupARN);
    if (wakerTg && !wakerTg.lbs.includes(LB)) wakerTg.lbs.push(LB);
    if (object.metadata.name.startsWith('dormeto-')) {
      a.state.rules.set(`${LISTENER.replace(':listener/', ':listener-rule/')}/dormeto`, { priority: '1', isDefault: false, conditions: [path('/*'), host('web.example.com')], actions: forward([[ours, app.weight], [waker.targetGroupARN, waker.weight]]), tags: {}, listener: LISTENER });
    } else {
      a.state.rules.get(customerRule).actions = forward([[tg, app.weight], [waker.targetGroupARN, waker.weight]]);
    }
  };
  const clock = fakeClock();
  const onboarding = createOnboarding({
    elbv2: a.elbv2, ec2: a.ec2, autoscaling: a.autoscaling, ecs: a.ecs, rds: a.rds, lambda: a.lambda, store: a.store, kubernetesOf: async () => k8s,
    router: { name: 'dmt-dev', wakerFunctionName: 'dmt-dev-waker', wakerFunctionArn: WAKER_ARN },
    now: clock.now, sleep: clock.sleep, log: { info() {}, warn() {}, error() {} },
  });
  return { a, tg, ours, customerRule, k8s, onboarding, id: workloadIdOf(tg) };
}
const k8sWrites = (k8s) => k8s.state.calls.filter(([method]) => ['POST', 'PATCH', 'DELETE'].includes(method));

test('preview of a grouped Ingress workload: its owner, the customer rule covered by Dormeto\'s Ingress, nothing changed', async () => {
  const s = setup();
  const preview = await s.onboarding.preview({ targetGroupArn: s.tg, kubernetes: grouped() });
  assert.deepEqual(preview.problems, []);
  assert.equal(preview.ok, true);
  assert.deepEqual(preview.backends, [{ kind: 'k8s', id: 'eks-demo/demo/Deployment/web', tagged: null }]);
  assert.deepEqual(preview.rules.map((r) => [r.priority, r.action]), [['2', `covered by Dormeto's Ingress demo/dormeto-${s.id}`]]);
  assert.ok(s.a.state.calls.every((c) => c.startsWith('describe') || c.startsWith('list')), s.a.state.calls.join(', '));
  assert.deepEqual(k8sWrites(s.k8s), []);
});

test('preview refuses a Kubernetes workload that cannot be onboarded, with every reason', async () => {
  const cases = [
    [() => ({ kubernetes: { ...grouped(), switch: 'sidecar' } }), 'kubernetes: switch must be rule, ingress or patched-ingress'],
    [() => ({ kubernetes: { ...grouped(), owner: { kind: 'DaemonSet', name: 'web' } } }), 'kubernetes: cluster, namespace and an owner (Deployment or StatefulSet) are required'],
    [(s) => { s.k8s.state.owners = []; return {}; }, 'Deployment demo/web not found in cluster eks-demo'],
    [(s) => { s.a.state.targetGroups.get(s.tg).targets = [{ Id: '10.0.9.9' }]; return {}; }, 'targets 10.0.9.9 of the target group are not pods of Deployment demo/web'],
    [(s) => { s.k8s.state.review.resourceRules = s.k8s.state.review.resourceRules.filter((r) => !r.resources.includes('nodes')); return {}; },
      'the router may not get nodes in namespace demo: apply the ClusterRole Dormeto publishes (kubernetes/dormeto-router.yaml) and its binding to the group dormeto:router'],
    [(s) => { delete s.k8s.state.ingresses[0].metadata.annotations[`${ALB}group.name`]; return {}; }, 'Ingress demo/web is not in an IngressGroup'],
    [() => ({ kubernetes: { ...grouped(), switch: 'patched-ingress' } }), 'Ingress demo/web is in IngressGroup eks-demo-group: Dormeto adds its own Ingress to the group (switch ingress)'],
    [(s) => { s.k8s.state.ingresses = []; return {}; }, 'Ingress demo/web not found in cluster eks-demo'],
    [(s) => { s.k8s.state.reviewError = Object.assign(new Error('connect ETIMEDOUT'), { name: 'KubernetesError', status: 0, reason: 'ETIMEDOUT' }); return {}; }, 'cluster eks-demo: connect ETIMEDOUT'],
  ];
  for (const [arrange, reason] of cases) {
    const s = setup();
    const preview = await s.onboarding.preview({ targetGroupArn: s.tg, kubernetes: grouped(), ...arrange(s) });
    assert.equal(preview.ok, false, reason);
    assert.ok(preview.problems.includes(reason), `${reason} in ${JSON.stringify(preview.problems)}`);
  }
});

test('preview refuses a waker target group already on another load balancer (a Lambda target group serves one, spike ruling 3)', async () => {
  const s = setup();
  const waker = tgArn('dmt-dev-' + s.id, 'aaaaaaaaaaaaaaaa');
  s.a.state.targetGroups.set(waker, { name: `dmt-dev-${s.id}`, type: 'lambda', lbs: ['arn:aws:elasticloadbalancing:eu-west-1:111122223333:loadbalancer/app/other/1'], targets: [], tags: { 'dormeto:workload': s.id }, attributes: {} });
  const preview = await s.onboarding.preview({ targetGroupArn: s.tg, kubernetes: grouped() });
  assert.ok(preview.problems.includes(`the waker target group dmt-dev-${s.id} is attached to another load balancer: a Lambda target group serves one load balancer`), JSON.stringify(preview.problems));
});

test('onboarding a grouped Ingress workload writes its configuration and Dormeto\'s Ingress, never a rule of the controller', async () => {
  const s = setup();
  const { steps } = await s.onboarding.onboard({ targetGroupArn: s.tg, kubernetes: grouped(), by: 'alice' });
  assert.deepEqual(steps.filter((x) => x.status === 'done').map((x) => x.name), ['waker target group', 'register waker', 'workload configuration', 'Dormeto Ingress']);
  const cfg = await s.a.store.getConfig(s.id);
  assert.deepEqual(cfg.kubernetes, grouped());
  assert.equal(cfg.wakeTimeoutSeconds, 300, 'a Kubernetes workload waits 5 minutes for its pods (Karpenter launches nodes)');
  assert.deepEqual(cfg.instanceIds, []);
  const ours = s.k8s.state.ingresses.find((i) => i.metadata.name === `dormeto-${s.id}`);
  assert.equal(ours.metadata.annotations[`${ALB}group.order`], '-100');
  assert.equal(JSON.parse(ours.metadata.annotations[`${ALB}actions.dormeto`]).forwardConfig.targetGroups[1].targetGroupARN, cfg.wakerTargetGroupArn);
  assert.ok(!s.a.state.calls.some((c) => ['modifyRule', 'createRule', 'addTags'].includes(c)), s.a.state.calls.join(', '));
});

test('onboarding a lone Ingress workload patches it and keeps what it replaced, to give it back', async () => {
  const lone = k8sCustomerIngress();
  delete lone.metadata.annotations[`${ALB}group.name`];
  const s = setup({ ingress: lone });
  const kube = { ...grouped(), switch: 'patched-ingress', ingress: { name: 'web', ruleIndex: 1, service: { name: 'web', port: { number: 80 } } } };
  const { steps } = await s.onboarding.onboard({ targetGroupArn: s.tg, kubernetes: kube, by: 'alice' });
  assert.ok(steps.some((x) => x.name === 'patch Ingress' && x.status === 'done'));
  const cfg = await s.a.store.getConfig(s.id);
  assert.deepEqual(cfg.kubernetes.ingress.original, [{ rule: 1, path: 0, backend: { service: { name: 'web', port: { number: 80 } } } }]);
  const web = s.k8s.state.ingresses[0];
  assert.deepEqual(web.spec.rules[1].http.paths[0].backend, { service: { name: 'dormeto', port: { name: 'use-annotation' } } });
});

test('onboarding a workload behind a TargetGroupBinding instruments its rules as today; nothing is tagged in AWS for its owner', async () => {
  const s = setup();
  const kube = { cluster: 'eks-demo', namespace: 'demo', owner: { kind: 'Deployment', name: 'web' }, switch: 'rule' };
  const { steps } = await s.onboarding.onboard({ targetGroupArn: s.tg, kubernetes: kube, by: 'alice' });
  assert.ok(steps.some((x) => x.name === 'instrument rules' && x.status === 'done'));
  assert.ok(steps.some((x) => x.name === 'tag backends' && x.status === 'skipped'));
  assert.deepEqual((await s.a.store.getConfig(s.id)).kubernetes, kube);
  assert.deepEqual(k8sWrites(s.k8s), [], 'no Kubernetes object changed');
});

test('a grouped Ingress the controller does not apply undoes the onboarding', async () => {
  const s = setup({ stuck: true });
  await assert.rejects(s.onboarding.onboard({ targetGroupArn: s.tg, kubernetes: grouped(), by: 'alice' }), /did not apply the switch to the app within 120 s.*undone/);
  assert.equal(await s.a.store.getConfig(s.id), null);
  assert.ok(!s.k8s.state.ingresses.some((i) => i.metadata.name.startsWith('dormeto-')), 'Dormeto\'s Ingress removed');
});
