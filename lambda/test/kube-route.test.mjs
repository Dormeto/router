// Switching the waker in through the objects the AWS Load Balancer Controller reads (vision
// docs/specs/2026-10-11-kubernetes-design.md, section 6; the spike, docs/research/2026-10-11-eks-spike.md): Dormeto's
// Ingress in the customer's IngressGroup, or the customer's lone Ingress patched; applied once DescribeRules says so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyIngressRoute, dormetoIngress, dormetoTargetGroup, patchCustomerIngress, restoreCustomerIngress } from '../src/lib/kube-route.mjs';
import { fakeClock, fakeElbv2, fakeKubernetes, k8sConfig, k8sCustomerIngress as customerIngress, k8sGroupedConfig as groupedConfig } from './fakes.mjs';

const ALB = 'alb.ingress.kubernetes.io/';
const DORMETO_TG = 'arn:aws:elasticloadbalancing:eu-west-1:111122223333:targetgroup/k8s-demo-web-1da7898e9b/333';
const host = (h) => ({ Field: 'host-header', HostHeaderConfig: { Values: [h] } });
const path = (p) => ({ Field: 'path-pattern', PathPatternConfig: { Values: [p] } });
const forward = (groups) => [{ Type: 'forward', Order: 1, ForwardConfig: { TargetGroups: groups.map(([TargetGroupArn, Weight]) => ({ TargetGroupArn, Weight })) } }];

const action = (cfg, app, waker) => JSON.stringify({ type: 'forward', forwardConfig: { targetGroups: [{ serviceName: 'web', servicePort: '80', weight: app }, { targetGroupARN: cfg.wakerTargetGroupArn, weight: waker }] } });

test('Dormeto\'s Ingress: in the customer\'s group before it, the customer rule\'s host and path, the weighted forward, the target group annotations copied', () => {
  const cfg = groupedConfig();
  const expected = (app, waker) => ({
    apiVersion: 'networking.k8s.io/v1', kind: 'Ingress',
    metadata: {
      name: 'dormeto-demo', namespace: 'demo', labels: { 'dormeto.com/managed': 'true', 'dormeto.com/workload': 'demo' },
      annotations: {
        [`${ALB}group.name`]: 'eks-demo-group',
        [`${ALB}group.order`]: '-100',
        [`${ALB}listen-ports`]: '[{"HTTP": 80}, {"HTTPS": 443}]',
        [`${ALB}target-type`]: 'ip',
        [`${ALB}healthcheck-path`]: '/health',
        [`${ALB}healthcheck-interval-seconds`]: '10',
        [`${ALB}success-codes`]: '200-299',
        [`${ALB}healthy-threshold-count`]: '2',
        [`${ALB}unhealthy-threshold-count`]: '3',
        [`${ALB}backend-protocol`]: 'HTTP',
        [`${ALB}backend-protocol-version`]: 'HTTP1',
        [`${ALB}target-group-attributes`]: 'deregistration_delay.timeout_seconds=30',
        // The customer rule's own conditions, so that Dormeto's rule matches exactly the same requests.
        [`${ALB}conditions.dormeto`]: '[{"field":"http-header","httpHeaderConfig":{"httpHeaderName":"X-Env","values":["prod"]}}]',
        [`${ALB}actions.dormeto`]: action(cfg, app, waker),
      },
    },
    spec: {
      ingressClassName: 'alb',
      rules: [{ host: 'web.example.com', http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'dormeto', port: { name: 'use-annotation' } } } }] } }],
    },
  });
  assert.deepEqual(dormetoIngress(cfg, { app: 0, waker: 1 }, customerIngress()), expected(0, 1));
  assert.deepEqual(dormetoIngress(cfg, { app: 1, waker: 0 }, customerIngress()), expected(1, 0));
  // Never an annotation the controller applies to the whole group (spike rulings 1 and 4).
  const annotations = Object.keys(dormetoIngress(cfg, { app: 1, waker: 0 }, customerIngress()).metadata.annotations);
  for (const name of ['tags', 'scheme', 'certificate-arn', 'ssl-redirect', 'load-balancer-attributes', 'security-groups', 'subnets', 'wafv2-acl-arn']) {
    assert.ok(!annotations.includes(`${ALB}${name}`), name);
  }
});

test('Dormeto\'s Ingress ranks before the customer\'s when no order was recorded; refused when the rule no longer leads to the Service or the Ingress left its group', () => {
  const cfg = groupedConfig();
  delete cfg.kubernetes.ingress.groupOrder;
  const ordered = customerIngress();
  ordered.metadata.annotations[`${ALB}group.order`] = '10';
  assert.equal(dormetoIngress(cfg, { app: 1, waker: 0 }, ordered).metadata.annotations[`${ALB}group.order`], '9');
  assert.equal(dormetoIngress(cfg, { app: 1, waker: 0 }, customerIngress()).metadata.annotations[`${ALB}group.order`], '-1');

  const moved = customerIngress();
  moved.spec.rules[1].http.paths[0].backend.service.name = 'web-v2';
  assert.throws(() => dormetoIngress(groupedConfig(), { app: 1, waker: 0 }, moved), { kind: 'configuration', message: /rule 1 of Ingress demo\/web no longer leads to Service web/ });
  const alone = customerIngress();
  delete alone.metadata.annotations[`${ALB}group.name`];
  assert.throws(() => dormetoIngress(groupedConfig(), { app: 1, waker: 0 }, alone), { kind: 'configuration', message: /Ingress demo\/web is not in an IngressGroup/ });
});

// The load balancer as the controller leaves it: the customer's rule, and Dormeto's rule once its Ingress exists, its
// weights those of the actions annotation (stuck: the controller does not apply them).
function grouped({ stuck = false, events = [] } = {}) {
  const cfg = groupedConfig();
  const k8s = fakeKubernetes({ ingresses: [customerIngress()], events });
  const elbv2 = fakeElbv2(cfg);
  elbv2.state.rules.clear();
  const conditions = [host('web.example.com'), path('/*')];
  elbv2.state.rules.set('arn:rule/customer', { actions: forward([[cfg.appTargetGroupArn, 1]]), conditions, priority: '2', tags: {} });
  k8s.state.onIngress = (ingress) => {
    if (stuck || ingress?.metadata.name !== 'dormeto-demo') return;
    const { targetGroups } = JSON.parse(ingress.metadata.annotations[`${ALB}actions.dormeto`]).forwardConfig;
    elbv2.state.rules.set('arn:rule/dormeto', { actions: forward([[DORMETO_TG, targetGroups[0].weight], [cfg.wakerTargetGroupArn, targetGroups[1].weight]]), conditions: [path('/*'), host('web.example.com')], priority: '1', tags: {} });
  };
  const clock = fakeClock();
  return { cfg, k8s, elbv2, clock, ports: { elbv2, kubernetesOf: async () => k8s }, timing: { sleep: clock.sleep, now: clock.now } };
}
const writes = (k8s) => k8s.state.calls.filter(([method]) => method === 'POST' || method === 'PATCH' || method === 'DELETE');
const weightsOn = (elbv2, arn) => elbv2.state.rules.get(arn)?.actions[0].ForwardConfig.TargetGroups.map((tg) => tg.Weight);

test('applyIngressRoute creates Dormeto\'s Ingress, then changes it only when the target differs, and returns once the load balancer has the weights', async () => {
  const g = grouped();
  assert.deepEqual(await applyIngressRoute(g.ports, g.cfg, 'app', g.timing), ['dormeto-demo']);
  assert.deepEqual(weightsOn(g.elbv2, 'arn:rule/dormeto'), [1, 0]);
  assert.deepEqual(writes(g.k8s).map(([method]) => method), ['POST']);
  assert.deepEqual(await applyIngressRoute(g.ports, g.cfg, 'app', g.timing), [], 'idempotent');
  assert.equal(writes(g.k8s).length, 1);
  assert.deepEqual(await applyIngressRoute(g.ports, g.cfg, 'waker', g.timing), ['dormeto-demo']);
  assert.deepEqual(weightsOn(g.elbv2, 'arn:rule/dormeto'), [0, 1]);
  assert.equal(writes(g.k8s).length, 2);
  assert.equal(g.k8s.state.ingresses.find((i) => i.metadata.name === 'dormeto-demo').metadata.annotations[`${ALB}actions.dormeto`], action(g.cfg, 0, 1));
});

test('a switch the load balancer does not show within 120 s fails as configuration, quoting the controller\'s Events on the Ingress', async () => {
  const events = [
    { involvedObject: { kind: 'Ingress', name: 'dormeto-demo' }, type: 'Normal', reason: 'SuccessfullyReconciled', message: 'Successfully reconciled', lastTimestamp: '2026-10-11T10:00:00Z' },
    { involvedObject: { kind: 'Ingress', name: 'dormeto-demo' }, type: 'Warning', reason: 'FailedBuildModel', message: 'Failed build model due to conflicting tag team: a | b', lastTimestamp: '2026-10-11T10:01:00Z' },
    { involvedObject: { kind: 'Ingress', name: 'other' }, type: 'Warning', reason: 'FailedDeployModel', message: 'not this one', lastTimestamp: '2026-10-11T10:02:00Z' },
  ];
  const g = grouped({ stuck: true, events });
  const started = g.clock.now();
  await assert.rejects(applyIngressRoute(g.ports, g.cfg, 'app', g.timing), (err) => err.kind === 'configuration'
    && /did not apply the switch to the app within 120 s/.test(err.message) && /FailedBuildModel: Failed build model due to conflicting tag team: a \| b/.test(err.message)
    && !/not this one/.test(err.message));
  assert.ok(g.clock.now() - started >= 120_000);
});

test('dormetoTargetGroup is the target group of Dormeto\'s rule (the rule forwarding to the waker), null before the rule exists', async () => {
  const g = grouped();
  assert.equal(await dormetoTargetGroup(g.elbv2, g.cfg), null);
  await applyIngressRoute(g.ports, g.cfg, 'app', g.timing);
  assert.equal(await dormetoTargetGroup(g.elbv2, g.cfg), DORMETO_TG);
});

// The customer's lone Ingress (its own ALB), as the spike found it.
const soloIngress = () => ({
  apiVersion: 'networking.k8s.io/v1', kind: 'Ingress',
  metadata: {
    name: 'solo', namespace: 'demo', resourceVersion: '7', labels: { 'app.kubernetes.io/managed-by': 'Helm' }, finalizers: ['ingress.k8s.aws/resources'],
    annotations: {
      [`${ALB}certificate-arn`]: 'arn:aws:acm:eu-west-1:111122223333:certificate/abc', [`${ALB}listen-ports`]: '[{"HTTP": 80}, {"HTTPS": 443}]',
      [`${ALB}scheme`]: 'internet-facing', [`${ALB}ssl-redirect`]: '443', [`${ALB}target-type`]: 'ip', 'meta.helm.sh/release-name': 'demos',
    },
  },
  spec: { ingressClassName: 'alb', rules: [{ host: 'solo.example.com', http: { paths: [{ backend: { service: { name: 'solo', port: { number: 80 } } }, path: '/', pathType: 'Prefix' }] } }] },
});
const soloConfig = () => k8sConfig({ switch: 'patched-ingress', owner: { kind: 'Deployment', name: 'solo' }, ingress: { name: 'solo', ruleIndex: 0, service: { name: 'solo', port: { number: 80 } } } });
const strip = (ingress) => { const { resourceVersion, ...metadata } = ingress.metadata; return { ...ingress, metadata }; };

test('the lone Ingress patched: its path to the Service becomes the weighted forward; the weights change alone; the restore gives it back exactly', async () => {
  const cfg = soloConfig();
  const k8s = fakeKubernetes({ ingresses: [soloIngress()] });
  const ports = { kubernetesOf: async () => k8s };
  const patched = await patchCustomerIngress(ports, cfg, { app: 0, waker: 1 });
  assert.equal(patched.changed, true);
  assert.deepEqual(patched.original, [{ rule: 0, path: 0, backend: { service: { name: 'solo', port: { number: 80 } } } }]);
  const [solo] = k8s.state.ingresses;
  assert.deepEqual(solo.spec.rules[0].http.paths[0].backend, { service: { name: 'dormeto', port: { name: 'use-annotation' } } });
  assert.equal(solo.metadata.annotations[`${ALB}actions.dormeto`], JSON.stringify({ type: 'forward', forwardConfig: { targetGroups: [{ serviceName: 'solo', servicePort: '80', weight: 0 }, { targetGroupARN: cfg.wakerTargetGroupArn, weight: 1 }] } }));
  // Only what Dormeto changes: the annotation and the path's backend.
  const expected = soloIngress();
  expected.metadata.annotations[`${ALB}actions.dormeto`] = solo.metadata.annotations[`${ALB}actions.dormeto`];
  expected.spec.rules[0].http.paths[0].backend = { service: { name: 'dormeto', port: { name: 'use-annotation' } } };
  assert.deepEqual(strip(solo), strip(expected));

  k8s.state.calls.length = 0;
  assert.equal((await patchCustomerIngress(ports, cfg, { app: 0, waker: 1 })).changed, false, 'nothing to change');
  assert.equal(writes(k8s).length, 0);
  const back = await patchCustomerIngress(ports, cfg, { app: 1, waker: 0 });
  assert.equal(back.changed, true);
  assert.deepEqual(back.original, [{ rule: 0, path: 0, backend: { service: { name: 'solo', port: { number: 80 } } } }], 'the Service, read from the annotation');
  assert.deepEqual(writes(k8s).map(([, , body]) => body.filter((op) => op.op !== 'test').map((op) => op.path)), [[`/metadata/annotations/alb.ingress.kubernetes.io~1actions.dormeto`]]);

  await restoreCustomerIngress(ports, cfg);
  assert.deepEqual(strip(k8s.state.ingresses[0]), strip(soloIngress()));
});

test('a patch never applies over a change made since it read the Ingress (its resourceVersion)', async () => {
  const k8s = fakeKubernetes({ ingresses: [soloIngress()] });
  const get = k8s.get.bind(k8s);
  k8s.get = async (p) => { const read = await get(p); k8s.state.version += 1; k8s.state.ingresses[0].metadata.resourceVersion = String(k8s.state.version); return read; };
  await assert.rejects(patchCustomerIngress({ kubernetesOf: async () => k8s }, soloConfig(), { app: 0, waker: 1 }), { status: 422 });
});
