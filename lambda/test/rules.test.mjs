import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRules } from '../src/lib/rules.mjs';
import { fakeElbv2, k8sConfig, k8sGroupedConfig, testConfig } from './fakes.mjs';

const cfg = testConfig({ ruleArns: ['arn:rule/main', 'arn:rule/static'] });
const host = (h) => ({ Field: 'host-header', HostHeaderConfig: { Values: [h] } });
const appOnly = (c) => [{ Type: 'forward', Order: 1, ForwardConfig: { TargetGroups: [{ TargetGroupArn: c.appTargetGroupArn, Weight: 1 }] } }];

test('finds every rule of the load balancer that forwards to the target group, across pages', async () => {
  const elbv2 = fakeElbv2(cfg);
  elbv2.state.rules.set('arn:rule/admin', { actions: [{ Type: 'forward', Order: 1, TargetGroupArn: cfg.wakerTargetGroupArn }], priority: '5', tags: { 'dormeto:workload': 'demo', 'dormeto:role': 'admin' } });
  elbv2.state.rules.set('arn:rule/other', { actions: [{ Type: 'forward', Order: 1, TargetGroupArn: 'arn:tg/other' }], priority: '50', tags: {} });
  elbv2.state.rules.set('arn:rule/redirect', { actions: [{ Type: 'redirect', Order: 1 }], priority: '60', tags: {} });
  const found = (await resolveRules(elbv2, [cfg])).get('demo');
  assert.deepEqual(found.rules.map((r) => r.RuleArn), ['arn:rule/main', 'arn:rule/static']);
  assert.deepEqual(found.instrumented.map((r) => r.RuleArn), ['arn:rule/main', 'arn:rule/static']);
  assert.deepEqual(found.issues, []);
});

test('reports each rule it cannot switch, and never counts it as instrumented', async () => {
  const elbv2 = fakeElbv2(cfg);
  elbv2.state.rules.set('arn:rule/new', { actions: appOnly(cfg), priority: '19', tags: { 'dormeto:workload': 'demo' } });
  elbv2.state.rules.set('arn:rule/canary', {
    actions: [{ Type: 'forward', Order: 1, ForwardConfig: { TargetGroups: [{ TargetGroupArn: cfg.appTargetGroupArn, Weight: 1 }, { TargetGroupArn: cfg.wakerTargetGroupArn, Weight: 0 }, { TargetGroupArn: 'arn:tg/green', Weight: 1 }] } }],
    priority: '20', tags: { 'dormeto:workload': 'demo' },
  });
  elbv2.state.rules.set('arn:rule/foreign', { actions: elbv2.state.forward(1, 0), priority: '30', tags: { 'dormeto:workload': 'another' } });
  elbv2.state.rules.set('arn:rule/default', { actions: appOnly(cfg), isDefault: true, tags: {} });
  const found = (await resolveRules(elbv2, [cfg])).get('demo');
  assert.deepEqual(found.instrumented.map((r) => r.RuleArn), ['arn:rule/main', 'arn:rule/static']);
  assert.deepEqual(found.issues.map((i) => [i.arn, i.reason]), [
    ['arn:rule/new', 'rule 19 forwards to the target group without the waker (not instrumented)'],
    ['arn:rule/canary', 'rule 20 also forwards to other target groups'],
    ['arn:rule/foreign', 'rule 30 is not tagged dormeto:workload = demo'],
    ['arn:rule/default', 'default rule of HTTPS:443 forwards to the target group (not supported yet)'],
  ]);
});

test('resolves several workloads of one load balancer with one listing', async () => {
  const other = testConfig({ workloadId: 'shop', ruleArn: 'arn:rule/shop', appTargetGroupArn: 'arn:tg/shop-app', wakerTargetGroupArn: 'arn:tg/shop-waker' });
  const elbv2 = fakeElbv2(cfg);
  elbv2.state.rules.set('arn:rule/shop', { actions: [{ Type: 'forward', Order: 1, ForwardConfig: { TargetGroups: [{ TargetGroupArn: other.appTargetGroupArn, Weight: 1 }, { TargetGroupArn: other.wakerTargetGroupArn, Weight: 0 }] } }], priority: '40', conditions: [host('shop.example.com')], tags: { 'dormeto:workload': 'shop' } });
  const found = await resolveRules(elbv2, [cfg, other]);
  assert.deepEqual(found.get('shop').instrumented.map((r) => r.RuleArn), ['arn:rule/shop']);
  assert.deepEqual(found.get('demo').instrumented.length, 2);
  assert.deepEqual([elbv2.state.calls.targetGroups, elbv2.state.calls.listeners], [1, 1]);
});

test('reports a target group without any rule, or not attached to a load balancer', async () => {
  const elbv2 = fakeElbv2(cfg);
  elbv2.state.rules.clear();
  assert.deepEqual((await resolveRules(elbv2, [cfg])).get('demo').issues.map((i) => i.reason), ['no rule forwards to the target group']);
  elbv2.state.detached = true;
  assert.deepEqual((await resolveRules(elbv2, [cfg])).get('demo').issues.map((i) => i.reason), ['target group not attached to a load balancer']);
});

test('never asks the tags of a listener default rule', async () => {
  const elbv2 = fakeElbv2(cfg);
  const asked = [];
  const describeTags = elbv2.describeTags;
  elbv2.describeTags = async (input) => { asked.push(...input.ResourceArns); return describeTags(input); };
  elbv2.state.rules.set('arn:rule/default', { actions: appOnly(cfg), isDefault: true, tags: {} });
  const found = (await resolveRules(elbv2, [cfg])).get('demo');
  assert.equal(asked.includes('arn:rule/default'), false);
  assert.match(found.issues[0].reason, /default rule/);
});

// --- Shadow rules (R4c) -------------------------------------------------------------------------------------------

test('a customer rule covered by a shadow with its conditions just before it is covered, not an issue', async () => {
  const elbv2 = fakeElbv2(cfg);
  elbv2.state.rules.set('arn:rule/customer', { actions: appOnly(cfg), conditions: [{ ...host('shop.example.com'), Values: ['shop.example.com'] }], priority: '40', tags: {} });
  elbv2.state.rules.set('arn:rule/shadow', { actions: elbv2.state.forward(1, 0), conditions: [host('shop.example.com')], priority: '39', tags: { 'dormeto:workload': 'demo', 'dormeto:shadows': 'arn:rule/customer' } });
  const found = (await resolveRules(elbv2, [cfg])).get('demo');
  assert.deepEqual(found.issues, []);
  assert.ok(found.instrumented.some((r) => r.RuleArn === 'arn:rule/shadow'));
  assert.ok(!found.instrumented.some((r) => r.RuleArn === 'arn:rule/customer'));
  assert.deepEqual(found.covered, [{ arn: 'arn:rule/customer', by: 'arn:rule/shadow' }]);
});

test('a shadow covers its rule whatever the order ELB lists their conditions in, or the values of a condition', async () => {
  // As ELB answered for a shadow created with its rule's conditions (2026-10-07): a rule matches when all its conditions do.
  const path = (...values) => ({ Field: 'path-pattern', PathPatternConfig: { Values: values } });
  const query = (key) => ({ Field: 'query-string', QueryStringConfig: { Values: [{ Key: key, Value: '*' }] } });
  for (const [customer, shadow] of [
    [[path('/themes/*', '/dist/*'), host('shop.example.com')], [host('shop.example.com'), path('/themes/*', '/dist/*')]],
    [[query('api-key'), host('shop.example.com'), query('api-user')], [host('shop.example.com'), query('api-key'), query('api-user')]],
    [[path('/themes/*', '/dist/*')], [path('/dist/*', '/themes/*')]],
  ]) {
    const elbv2 = fakeElbv2(cfg);
    elbv2.state.rules.set('arn:rule/customer', { actions: appOnly(cfg), conditions: customer, priority: '40', tags: {} });
    elbv2.state.rules.set('arn:rule/shadow', { actions: elbv2.state.forward(1, 0), conditions: shadow, priority: '39', tags: { 'dormeto:workload': 'demo', 'dormeto:shadows': 'arn:rule/customer' } });
    const found = (await resolveRules(elbv2, [cfg])).get('demo');
    assert.deepEqual(found.issues, [], JSON.stringify(shadow));
    assert.deepEqual(found.covered, [{ arn: 'arn:rule/customer', by: 'arn:rule/shadow' }]);
  }
});

test('a shadow with other conditions than its rule, or after it, leaves the rule an issue (to repair)', async () => {
  for (const [conditions, priority, reason] of [
    [[host('old.example.com')], '39', 'rule 40 is shadowed by rule 39 with other conditions'],
    [[host('shop.example.com')], '41', 'rule 40 is shadowed by rule 41 placed after it'],
  ]) {
    const elbv2 = fakeElbv2(cfg);
    elbv2.state.rules.set('arn:rule/customer', { actions: appOnly(cfg), conditions: [host('shop.example.com')], priority: '40', tags: {} });
    elbv2.state.rules.set('arn:rule/shadow', { actions: elbv2.state.forward(1, 0), conditions, priority, tags: { 'dormeto:workload': 'demo', 'dormeto:shadows': 'arn:rule/customer' } });
    const found = (await resolveRules(elbv2, [cfg])).get('demo');
    assert.deepEqual(found.issues.map((i) => [i.arn, i.reason, i.repairable]), [['arn:rule/customer', reason, true]]);
  }
});

test('a rule forwarding to the target group without any shadow is an issue the onboarder can repair', async () => {
  const elbv2 = fakeElbv2(cfg);
  elbv2.state.rules.set('arn:rule/new', { actions: appOnly(cfg), priority: '19', tags: {} });
  const [issue] = (await resolveRules(elbv2, [cfg])).get('demo').issues;
  assert.deepEqual([issue.reason, issue.repairable], ['rule 19 forwards to the target group without the waker (not instrumented)', true]);
});

// A rule between a shadow and its customer rule takes the requests of both: only plain forwards to the workload, its other
// shadows, and rules no request of the customer rule can match (literal host headers with no host in common) may sit there.
test('a shadow is no cover when a rule that can take its requests sits between them, or when it is on another listener', async () => {
  const shadowed = (elbv2, priority, conditions = [host('shop.example.com')], extra = {}) => {
    elbv2.state.rules.set('arn:rule/customer', { actions: appOnly(cfg), conditions: [host('shop.example.com')], priority: '40', tags: {} });
    elbv2.state.rules.set('arn:rule/shadow', { actions: elbv2.state.forward(1, 0), conditions, priority, tags: { 'dormeto:workload': 'demo', 'dormeto:shadows': 'arn:rule/customer' }, ...extra });
  };
  const foreign = (conditions) => ({ actions: [{ Type: 'forward', Order: 1, TargetGroupArn: 'arn:tg/api' }], conditions, priority: '35', tags: {} });
  for (const [name, conditions] of [['same host', [host('shop.example.com')]], ['any host', [{ Field: 'path-pattern', PathPatternConfig: { Values: ['/api/*'] } }]], ['host pattern', [host('*.example.com')]]]) {
    const elbv2 = fakeElbv2(cfg);
    shadowed(elbv2, '30');
    elbv2.state.rules.set('arn:rule/api', foreign(conditions));
    const found = (await resolveRules(elbv2, [cfg])).get('demo');
    assert.deepEqual(found.issues.map((i) => [i.arn, i.reason, i.repairable]), [['arn:rule/customer', 'rule 40 is shadowed by rule 30 with rule 35 between them', true]], name);
  }
  const disjoint = fakeElbv2(cfg);
  shadowed(disjoint, '30');
  disjoint.state.rules.set('arn:rule/api', foreign([host('API.example.com')]));
  assert.deepEqual((await resolveRules(disjoint, [cfg])).get('demo').covered, [{ arn: 'arn:rule/customer', by: 'arn:rule/shadow' }]);
  const listener = fakeElbv2(cfg);
  shadowed(listener, '39', [host('shop.example.com')], { listener: 'http' });
  assert.deepEqual((await resolveRules(listener, [cfg])).get('demo').issues.map((i) => i.reason), ['rule 40 is shadowed by rule 39 on another listener']);
});

test('a shadow whose rule is gone, takes other target groups or acts before its forward is an orphan to remove, not a reason to stay awake', async () => {
  const shadow = { conditions: [host('shop.example.com')], priority: '39', tags: { 'dormeto:workload': 'demo', 'dormeto:shadows': 'arn:rule/customer' } };
  const gone = fakeElbv2(cfg);
  gone.state.rules.set('arn:rule/shadow', { ...shadow, actions: gone.state.forward(1, 0) });
  const found = (await resolveRules(gone, [cfg])).get('demo');
  assert.deepEqual(found.issues, []);
  assert.deepEqual(found.orphans, [{ arn: 'arn:rule/shadow', priority: '39', reason: 'rule 39 shadows a rule gone' }]);
  assert.ok(found.instrumented.some((r) => r.RuleArn === 'arn:rule/shadow'));
  const auth = fakeElbv2(cfg);
  auth.state.rules.set('arn:rule/shadow', { ...shadow, actions: auth.state.forward(1, 0) });
  auth.state.rules.set('arn:rule/customer', { actions: [{ Type: 'authenticate-oidc', Order: 1 }, { ...appOnly(cfg)[0], Order: 2 }], conditions: [host('shop.example.com')], priority: '40', tags: {} });
  const authFound = (await resolveRules(auth, [cfg])).get('demo');
  assert.deepEqual(authFound.orphans.map((o) => o.reason), ['rule 39 shadows rule 40, which acts before its forward']);
  assert.deepEqual(authFound.issues.map((i) => [i.arn, i.repairable]), [['arn:rule/customer', true]]);
  const split = fakeElbv2(cfg);
  split.state.rules.set('arn:rule/shadow', { ...shadow, actions: split.state.forward(1, 0) });
  split.state.rules.set('arn:rule/customer', { actions: [{ Type: 'forward', Order: 1, ForwardConfig: { TargetGroups: [{ TargetGroupArn: cfg.appTargetGroupArn, Weight: 1 }, { TargetGroupArn: 'arn:tg/v2', Weight: 1 }] } }], conditions: [host('shop.example.com')], priority: '40', tags: {} });
  const splitFound = (await resolveRules(split, [cfg])).get('demo');
  assert.deepEqual(splitFound.orphans.map((o) => o.reason), ['rule 39 shadows rule 40, which forwards to other target groups']);
  assert.deepEqual(splitFound.issues.map((i) => [i.reason, i.repairable]), [['rule 40 also forwards to other target groups', false]]);
});

test('a target group deleted since the workload was onboarded fails no other workload: its batch is described one by one', async () => {
  const other = testConfig({ workloadId: 'shop', ruleArn: 'arn:rule/shop', appTargetGroupArn: 'arn:tg/shop-app', wakerTargetGroupArn: 'arn:tg/shop-waker' });
  const elbv2 = fakeElbv2(cfg);
  elbv2.state.rules.set('arn:rule/shop', { actions: [{ Type: 'forward', Order: 1, ForwardConfig: { TargetGroups: [{ TargetGroupArn: other.appTargetGroupArn, Weight: 1 }, { TargetGroupArn: other.wakerTargetGroupArn, Weight: 0 }] } }], priority: '40', conditions: [host('shop.example.com')], tags: { 'dormeto:workload': 'shop' } });
  // AWS fails the whole call when one of the target groups is gone.
  const describe = elbv2.describeTargetGroups.bind(elbv2);
  elbv2.describeTargetGroups = async (input) => {
    if (input.TargetGroupArns.includes(cfg.appTargetGroupArn)) throw Object.assign(new Error(`One or more target groups not found`), { name: 'TargetGroupNotFoundException' });
    return describe(input);
  };
  const found = await resolveRules(elbv2, [cfg, other]);
  assert.deepEqual(found.get('shop').instrumented.map((r) => r.RuleArn), ['arn:rule/shop']);
  assert.deepEqual(found.get('demo').issues.map((i) => i.reason), ['target group not attached to a load balancer']);
});

// Kubernetes workloads (vision docs/specs/2026-10-11-kubernetes-design.md, section 6): Dormeto's rule is the controller's,
// untagged, found by its forward to the waker target group; its own target group is where the requests go.
const DORMETO_TG = 'arn:aws:elasticloadbalancing:eu-west-1:111122223333:targetgroup/k8s-demo-web-1da7898e9b/333';
const path = (p) => ({ Field: 'path-pattern', PathPatternConfig: { Values: [p] } });
const fwd = (groups) => [{ Type: 'forward', Order: 1, ForwardConfig: { TargetGroups: groups.map(([TargetGroupArn, Weight]) => ({ TargetGroupArn, Weight })) } }];

function groupRules(rules) {
  const k = k8sGroupedConfig();
  const elbv2 = fakeElbv2(k);
  elbv2.state.rules.clear();
  for (const [arn, rule] of Object.entries(rules(k))) elbv2.state.rules.set(arn, { tags: {}, ...rule });
  return { k, elbv2 };
}

test('a grouped Ingress: Dormeto\'s rule (untagged, its own target group and the waker) is instrumented and covers the customer\'s rule', async () => {
  const { k, elbv2 } = groupRules((c) => ({
    'arn:rule/dormeto': { actions: fwd([[DORMETO_TG, 1], [c.wakerTargetGroupArn, 0]]), conditions: [path('/*'), host('web.example.com')], priority: '1' },
    'arn:rule/docs': { actions: fwd([['arn:tg/docs', 1]]), conditions: [host('docs.example.com'), path('/*')], priority: '2' },
    'arn:rule/customer': { actions: fwd([[c.appTargetGroupArn, 1]]), conditions: [host('web.example.com'), path('/*')], priority: '3' },
  }));
  const found = (await resolveRules(elbv2, [k])).get('demo');
  assert.deepEqual(found.instrumented.map((r) => r.RuleArn), ['arn:rule/dormeto']);
  assert.deepEqual(found.covered, [{ arn: 'arn:rule/customer', by: 'arn:rule/dormeto' }]);
  assert.deepEqual([found.issues, found.orphans], [[], []]);
  assert.equal(found.switchTargetGroup, DORMETO_TG);
});

test('a grouped Ingress: an uncovered customer rule is a repairable issue, a Dormeto rule covering nothing an orphan, no Dormeto rule no switch', async () => {
  const extra = groupRules((c) => ({
    'arn:rule/dormeto': { actions: fwd([[DORMETO_TG, 1], [c.wakerTargetGroupArn, 0]]), conditions: [host('web.example.com'), path('/*')], priority: '1' },
    'arn:rule/customer': { actions: fwd([[c.appTargetGroupArn, 1]]), conditions: [host('web.example.com'), path('/*')], priority: '2' },
    'arn:rule/api': { actions: fwd([[c.appTargetGroupArn, 1]]), conditions: [host('api.example.com'), path('/*')], priority: '3' },
  }));
  const found = (await resolveRules(extra.elbv2, [extra.k])).get('demo');
  assert.deepEqual(found.issues.map((i) => [i.arn, i.reason, i.repairable]), [['arn:rule/api', 'rule 3 forwards to the target group without the waker (not instrumented)', true]]);

  const moved = groupRules((c) => ({
    'arn:rule/dormeto': { actions: fwd([[DORMETO_TG, 1], [c.wakerTargetGroupArn, 0]]), conditions: [host('old.example.com'), path('/*')], priority: '1' },
    'arn:rule/customer': { actions: fwd([[c.appTargetGroupArn, 1]]), conditions: [host('web.example.com'), path('/*')], priority: '2' },
  }));
  const stale = (await resolveRules(moved.elbv2, [moved.k])).get('demo');
  assert.deepEqual(stale.instrumented, []);
  assert.deepEqual(stale.orphans.map((o) => [o.arn, o.reason]), [['arn:rule/dormeto', 'rule 1 of Dormeto\'s Ingress covers no rule of the target group']]);
  assert.deepEqual(stale.issues.map((i) => i.arn), ['arn:rule/customer']);

  const none = groupRules((c) => ({ 'arn:rule/customer': { actions: fwd([[c.appTargetGroupArn, 1]]), conditions: [host('web.example.com')], priority: '2' } }));
  const missing = (await resolveRules(none.elbv2, [none.k])).get('demo');
  assert.deepEqual(missing.issues.map((i) => [i.reason, i.repairable]), [['rule 2 forwards to the target group without the waker (not instrumented)', true]]);
  assert.equal(missing.switchTargetGroup, null);
});

test('a patched lone Ingress: its rule forwarding to its target group and the waker is instrumented without the workload tag (the controller owns its tags)', async () => {
  const k = k8sConfig({ switch: 'patched-ingress', ingress: { name: 'solo', ruleIndex: 0, service: { name: 'solo', port: { number: 80 } } } });
  const elbv2 = fakeElbv2(k);
  elbv2.state.rules.get(k.ruleArn).tags = {};
  const found = (await resolveRules(elbv2, [k])).get('demo');
  assert.deepEqual(found.instrumented.map((r) => r.RuleArn), [k.ruleArn]);
  assert.deepEqual(found.issues, []);
  assert.equal(found.switchTargetGroup, k.appTargetGroupArn);
  // The other workloads keep the tag rule; their requests stay on their target group.
  const plain = fakeElbv2(cfg);
  assert.equal((await resolveRules(plain, [cfg])).get('demo').switchTargetGroup, cfg.appTargetGroupArn);
});
