import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROUTER_PERMISSION, createOnboarding, workloadIdOf } from '../src/lib/onboarding.mjs';
import { LB, WAKER_ARN, fakeAccount } from './account-fake.mjs';

const NOW = 1_791_158_400_000;
const WORKLOAD = 'dormeto:workload';
const MARKER = 'dormeto:tagged';

// A customer's shop: an instance behind a target group, two rules forwarding to it (host and path), as Terraform wrote them.
function setup({ backend = 'instance' } = {}) {
  const a = fakeAccount();
  const shopTargets = backend === 'instance' ? [{ Id: 'i-0aaa' }] : backend === 'asg' ? [{ Id: 'i-0bbb' }] : [];
  const tg = a.customer.targetGroup('shop-app', { type: backend === 'ecs' ? 'ip' : 'instance', targets: shopTargets });
  if (backend === 'instance') a.customer.instance('i-0aaa', { tags: { Name: 'shop' } });
  if (backend === 'asg') {
    a.customer.instance('i-0bbb', { tags: { 'aws:autoscaling:groupName': 'shop-asg' } });
    a.customer.group('shop-asg', { targetGroups: [tg], instances: ['i-0bbb'] });
  }
  if (backend === 'ecs') a.customer.service('shop-svc', { targetGroups: [tg], tags: { team: 'shop' } });
  const main = a.customer.rule(10, tg, { host: 'shop.example.com' });
  const statics = a.customer.rule(11, tg, { host: 'static.example.com' });
  const logs = [];
  const onboarding = createOnboarding({
    elbv2: a.elbv2, ec2: a.ec2, autoscaling: a.autoscaling, ecs: a.ecs, rds: a.rds, lambda: a.lambda, store: a.store,
    router: { name: 'dmt-dev', wakerFunctionName: 'dmt-dev-waker', wakerFunctionArn: WAKER_ARN },
    now: () => NOW, sleep: async () => {}, log: { info: (e, d) => logs.push([e, d]), warn: (e, d) => logs.push([e, d]), error: (e, d) => logs.push([e, d]) },
  });
  return { a, tg, main, statics, onboarding, logs };
}

const weights = (a, rule) => a.state.rules.get(rule).actions[0].ForwardConfig.TargetGroups.map((g) => [a.state.targetGroups.get(g.TargetGroupArn)?.name, g.Weight]);
// Shadow rules of the account: [priority, shadowed rule, tags, weights].
const shadowsOf = (a) => [...a.state.rules].filter(([, r]) => r.tags['dormeto:shadows']).sort(([, x], [, y]) => Number(x.priority) - Number(y.priority))
  .map(([arn, r]) => ({ arn, priority: r.priority, shadows: r.tags['dormeto:shadows'], workload: r.tags[WORKLOAD], conditions: r.conditions, weights: weights(a, arn) }));

// --- preview ---------------------------------------------------------------------------------------------------------

test('preview lists the rules to instrument, the backends to tag and the waker target group, without any change', async () => {
  const s = setup();
  const preview = await s.onboarding.preview({ workloadId: 'shop', targetGroupArn: s.tg });
  assert.equal(preview.ok, true);
  assert.deepEqual(preview.problems, []);
  assert.equal(preview.wakerTargetGroupName, 'dmt-dev-shop');
  assert.equal(preview.loadBalancerArn, LB);
  assert.deepEqual(preview.rules.map((r) => [r.priority, r.conditions, r.action]), [['10', 'host shop.example.com', 'shadow at 9'], ['11', 'host static.example.com', 'shadow at 8']]);
  assert.deepEqual(preview.backends, [{ kind: 'instance', id: 'i-0aaa', tagged: null }]);
  assert.ok(s.a.state.calls.every((c) => c.startsWith('describe') || c.startsWith('list')), `no change: ${s.a.state.calls.join(', ')}`);
});

test('preview finds an Auto Scaling group from its attached target group, not its instances', async () => {
  const s = setup({ backend: 'asg' });
  assert.deepEqual((await s.onboarding.preview({ workloadId: 'shop', targetGroupArn: s.tg })).backends, [{ kind: 'asg', id: 'shop-asg', tagged: null }]);
});

test('preview finds an ECS service registered with the target group', async () => {
  const s = setup({ backend: 'ecs' });
  const [backend] = (await s.onboarding.preview({ workloadId: 'shop', targetGroupArn: s.tg })).backends;
  assert.deepEqual(backend, { kind: 'ecs', id: 'arn:aws:ecs:eu-west-1:111122223333:service/shop/shop-svc', tagged: null });
});

test('preview refuses what cannot be onboarded, with every reason', async () => {
  const cases = [
    [(s) => ({ workloadId: 'Shop_1' }), 'workload id: lowercase letters, digits and hyphens, not starting or ending with a hyphen'],
    [(s) => ({ workloadId: 'a-very-long-workload-identifier' }), 'workload id too long: dmt-dev-a-very-long-workload-identifier exceeds the 32 characters of a target group name'],
    [(s) => { s.a.customer.rule(20, s.tg, { isDefault: true }); return {}; }, 'the listener default action of HTTPS:443 forwards to the target group (not supported yet)'],
    [(s) => {
      const other = s.a.customer.targetGroup('other');
      s.a.state.rules.get(s.statics).actions[0].ForwardConfig.TargetGroups.push({ TargetGroupArn: other, Weight: 1 });
      return {};
    }, 'rule 11 also forwards to other target groups'],
    [(s) => { s.a.state.targetGroups.get(s.tg).targets = []; return {}; }, 'no backend: no instance, Auto Scaling group or ECS service feeds the target group'],
    [(s) => { s.a.state.instances.get('i-0aaa').tags[WORKLOAD] = 'blog'; return {}; }, 'instance i-0aaa belongs to workload blog'],
    [(s) => { s.a.state.targetGroups.get(s.tg).lbs = []; return {}; }, 'the target group is not attached to a load balancer'],
    [(s) => { s.a.state.rules.clear(); return {}; }, 'no rule forwards to the target group'],
  ];
  for (const [arrange, reason] of cases) {
    const s = setup();
    const input = { workloadId: 'shop', targetGroupArn: s.tg, ...arrange(s) };
    const preview = await s.onboarding.preview(input);
    assert.equal(preview.ok, false, reason);
    assert.ok(preview.problems.includes(reason), `${reason} in ${JSON.stringify(preview.problems)}`);
  }
});

test('preview refuses a workload id or a target group already onboarded as another workload', async () => {
  const s = setup();
  await s.onboarding.onboard({ workloadId: 'shop', targetGroupArn: s.tg, by: 'ops' });
  const blog = s.a.customer.targetGroup('blog-app', { targets: [{ Id: 'i-0ccc' }] });
  s.a.customer.instance('i-0ccc');
  s.a.customer.rule(30, blog, { host: 'blog.example.com' });
  assert.ok((await s.onboarding.preview({ workloadId: 'shop', targetGroupArn: blog })).problems.includes('workload shop already exists with another target group'));
  assert.ok((await s.onboarding.preview({ workloadId: 'shop2', targetGroupArn: s.tg })).problems.includes('the target group is already workload shop'));
  assert.equal((await s.onboarding.preview({ workloadId: 'shop', targetGroupArn: s.tg })).ok, true, 'the same onboarding again is fine');
});

// --- onboard ---------------------------------------------------------------------------------------------------------

test('onboard tags the backend, creates and registers the waker target group, writes the workload and shadows every rule with traffic unchanged', async () => {
  const s = setup();
  const result = await s.onboarding.onboard({ workloadId: 'shop', targetGroupArn: s.tg, settings: { idleMinutes: 30, wakeMode: 'browser' }, by: 'ops@example.com' });
  assert.deepEqual(result.steps.map((x) => [x.name, x.status]), [
    ['tag backends', 'done'], ['waker target group', 'done'], ['register waker', 'done'], ['workload configuration', 'done'], ['instrument rules', 'done'],
  ]);
  assert.deepEqual(s.a.state.instances.get('i-0aaa').tags, { Name: 'shop', [WORKLOAD]: 'shop', [MARKER]: 'onboarder' });
  const [wakerArn, waker] = [...s.a.state.targetGroups].find(([, g]) => g.name === 'dmt-dev-shop');
  assert.equal(result.workload.wakerTargetGroupArn, wakerArn);
  assert.deepEqual([waker.type, waker.tags, waker.attributes, waker.targets.map((t) => t.Id)], [
    'lambda', { [WORKLOAD]: 'shop', 'dormeto:router': 'dmt-dev' }, { 'lambda.multi_value_headers.enabled': 'true' }, [WAKER_ARN],
  ]);
  // The router's own permission covers its waker target groups: the waker's policy does not grow with the workloads.
  assert.equal(s.a.state.permissions.size, 0);
  // The customer's rules stay as their infrastructure as code wrote them; a Dormeto rule just before each.
  for (const rule of [s.main, s.statics]) {
    assert.deepEqual(weights(s.a, rule), [['shop-app', 1]]);
    assert.deepEqual(s.a.state.rules.get(rule).tags, {});
  }
  assert.deepEqual(shadowsOf(s.a).map((x) => [x.priority, x.shadows, x.workload, x.weights]), [
    ['8', s.statics, 'shop', [['shop-app', 1], ['dmt-dev-shop', 0]]], ['9', s.main, 'shop', [['shop-app', 1], ['dmt-dev-shop', 0]]],
  ]);
  assert.deepEqual(shadowsOf(s.a)[1].conditions, [{ Field: 'host-header', HostHeaderConfig: { Values: ['shop.example.com'] } }]);
  const cfg = await s.a.store.getConfig('shop');
  assert.deepEqual({ ...cfg, onboardedAt: 'x' }, {
    workloadId: 'shop', name: 'shop-app', appTargetGroupArn: s.tg, wakerTargetGroupArn: wakerArn,
    loadBalancerDimension: 'app/shop/50dc6c495c0c9188', appTargetGroupDimension: s.tg.split(':').at(-1),
    instanceIds: [], waitSeconds: 60, idleMinutes: 30, drainSeconds: 30, wakeTimeoutSeconds: 600, failedRetrySeconds: 60, maxHolders: 50, pollSeconds: 3,
    noWakeRules: [], wakeMode: 'browser', wakeRules: [], admin: { enabled: false, secretHash: '', secretParameter: '' },
    source: 'manager', onboardedBy: 'ops@example.com', onboardedAt: 'x', databases: [], tagged: [{ kind: 'instance', id: 'i-0aaa' }],
  });
  assert.equal(cfg.onboardedAt, new Date(NOW).toISOString());
  assert.deepEqual(await s.a.store.getRun('shop'), { state: 'AWAKE', version: 0, awakeSince: NOW, holders: 0, wakeCount: 0 });
});

test('onboard again finds everything in place and changes nothing', async () => {
  const s = setup();
  await s.onboarding.onboard({ workloadId: 'shop', targetGroupArn: s.tg, by: 'ops' });
  s.a.state.calls.length = 0;
  const again = await s.onboarding.onboard({ workloadId: 'shop', targetGroupArn: s.tg, by: 'ops' });
  assert.deepEqual(again.steps.map((x) => x.status), ['skipped', 'skipped', 'skipped', 'skipped', 'skipped']);
  assert.ok(!s.a.state.calls.some((c) => ['createTargetGroup', 'createTags', 'modifyRule', 'putConfig', 'addTags'].includes(c)), s.a.state.calls.join(', '));
});

test('an undo that fails part-way goes on with the other steps, and the next onboard finishes from what is left', async () => {
  const s = setup();
  s.a.state.fail.registerTargets = new Error('Rate exceeded');
  s.a.state.fail.deleteTargetGroup = new Error('Throttling');
  await assert.rejects(s.onboarding.onboard({ workloadId: 'shop', targetGroupArn: s.tg, by: 'ops' }),
    /cannot onboard shop: Rate exceeded \(undo incomplete: waker target group: Throttling\)/);
  assert.deepEqual(s.a.state.instances.get('i-0aaa').tags, { Name: 'shop' }, 'the undo went on after the failed step');
  const second = await s.onboarding.onboard({ workloadId: 'shop', targetGroupArn: s.tg, by: 'ops' });
  assert.deepEqual(second.steps.map((x) => x.status), ['done', 'skipped', 'done', 'done', 'done']);
});

test('onboard tags the listed databases as companions and waits longer for them', async () => {
  const s = setup();
  const db = s.a.customer.database('rds-instance', 'shop-db');
  await s.onboarding.onboard({ workloadId: 'shop', targetGroupArn: s.tg, databases: [{ kind: 'rds-instance', id: 'shop-db' }], by: 'ops' });
  assert.deepEqual(s.a.state.databases.get(db).tags, { [WORKLOAD]: 'shop', [MARKER]: 'onboarder' });
  const cfg = await s.a.store.getConfig('shop');
  assert.deepEqual([cfg.databases, cfg.wakeTimeoutSeconds], [[{ kind: 'rds-instance', id: 'shop-db' }], 1800]);
});

test('a failure after tagging undoes the onboarding: no waker target group, permission, tag, configuration or rule change left', async () => {
  const s = setup();
  s.a.state.fail.createRule = new Error('Rate exceeded');
  await assert.rejects(s.onboarding.onboard({ workloadId: 'shop', targetGroupArn: s.tg, by: 'ops' }), /cannot onboard shop: Rate exceeded \(undone\)/);
  assert.deepEqual(s.a.state.instances.get('i-0aaa').tags, { Name: 'shop' });
  assert.ok(![...s.a.state.targetGroups.values()].some((g) => g.name === 'dmt-dev-shop'));
  assert.equal(s.a.state.permissions.size, 0);
  assert.equal(await s.a.store.getConfig('shop'), null);
  for (const rule of [s.main, s.statics]) assert.deepEqual(weights(s.a, rule), [['shop-app', 1]]);
  assert.deepEqual(shadowsOf(s.a), []);
  assert.ok(s.logs.some(([e]) => e === 'OnboardUndone'));
});

test('onboard refuses with the preview problems and changes nothing', async () => {
  const s = setup();
  s.a.state.targetGroups.get(s.tg).targets = [];
  await assert.rejects(s.onboarding.onboard({ workloadId: 'shop', targetGroupArn: s.tg, by: 'ops' }), /cannot onboard shop: no backend/);
  assert.ok(!s.a.state.calls.some((c) => c.startsWith('create') || c === 'modifyRule'));
});

// --- offboard --------------------------------------------------------------------------------------------------------

test('offboard restores every rule, removes the waker target group, the permission, the tags it added and the workload', async () => {
  const s = setup();
  s.a.state.instances.get('i-0aaa').tags.team = 'shop';
  await s.onboarding.onboard({ workloadId: 'shop', targetGroupArn: s.tg, by: 'ops' });
  // A per-workload permission left by a router older than 0.20.0.
  await s.a.lambda.addPermission({ FunctionName: 'dmt-dev-waker', StatementId: 'alb-shop', Action: 'lambda:InvokeFunction', Principal: 'elasticloadbalancing.amazonaws.com', SourceArn: 'arn:x' });
  const result = await s.onboarding.offboard({ workloadId: 'shop', by: 'ops' });
  assert.deepEqual(result.steps.map((x) => [x.name, x.status]), [
    ['restore rules', 'done'], ['waker target group', 'done'], ['invoke permission', 'done'], ['untag backends', 'done'], ['workload configuration', 'done'],
  ]);
  for (const rule of [s.main, s.statics]) {
    assert.deepEqual(weights(s.a, rule), [['shop-app', 1]]);
    assert.equal(s.a.state.rules.get(rule).tags[WORKLOAD], undefined);
  }
  assert.deepEqual(shadowsOf(s.a), [], 'the shadows are deleted');
  assert.ok(![...s.a.state.targetGroups.values()].some((g) => g.name === 'dmt-dev-shop'));
  assert.equal(s.a.state.permissions.size, 0);
  assert.deepEqual(s.a.state.instances.get('i-0aaa').tags, { Name: 'shop', team: 'shop' });
  assert.equal(await s.a.store.getConfig('shop'), null);
  assert.equal(await s.a.store.getRun('shop'), null);
});

test('offboard keeps a dormeto:workload tag the customer set (without the onboarder marker)', async () => {
  const s = setup();
  s.a.state.instances.get('i-0aaa').tags[WORKLOAD] = 'shop';
  await s.onboarding.onboard({ workloadId: 'shop', targetGroupArn: s.tg, by: 'ops' });
  assert.equal(s.a.state.instances.get('i-0aaa').tags[MARKER], undefined, 'already tagged by the customer: no marker');
  await s.onboarding.offboard({ workloadId: 'shop', by: 'ops' });
  assert.equal(s.a.state.instances.get('i-0aaa').tags[WORKLOAD], 'shop');
});

test('offboard refuses a workload that is not awake, and a workload written by Terraform', async () => {
  const s = setup();
  await s.onboarding.onboard({ workloadId: 'shop', targetGroupArn: s.tg, by: 'ops' });
  s.a.items.get('shop/RUN').state = 'ASLEEP';
  await assert.rejects(s.onboarding.offboard({ workloadId: 'shop', by: 'ops' }), /cannot offboard shop: it is ASLEEP, wake it first/);
  s.a.items.get('shop/RUN').state = 'AWAKE';
  delete s.a.items.get('shop/CFG').source;
  await assert.rejects(s.onboarding.offboard({ workloadId: 'shop', by: 'ops' }), /cannot offboard shop: written by Terraform, remove its workload module instead/);
});

test('offboard again, or of an unknown workload, finds nothing to do', async () => {
  const s = setup();
  await s.onboarding.onboard({ workloadId: 'shop', targetGroupArn: s.tg, by: 'ops' });
  await s.onboarding.offboard({ workloadId: 'shop', by: 'ops' });
  const again = await s.onboarding.offboard({ workloadId: 'shop', by: 'ops' });
  assert.deepEqual(again.steps.map((x) => x.status), ['skipped', 'skipped', 'skipped', 'skipped', 'skipped']);
});

test('a failing onboard of a workload that already existed is not undone: the workload stays', async () => {
  const s = setup();
  await s.onboarding.onboard({ workloadId: 'shop', targetGroupArn: s.tg, by: 'ops' });
  s.a.state.rules.delete(shadowsOf(s.a)[0].arn);
  s.a.state.fail.createRule = new Error('Rate exceeded');
  await assert.rejects(s.onboarding.onboard({ workloadId: 'shop', targetGroupArn: s.tg, by: 'ops' }), /^Error: Rate exceeded$/);
  assert.notEqual(await s.a.store.getConfig('shop'), null);
  assert.equal(shadowsOf(s.a).length, 1);
});

test('a failure while tagging the second backend undoes the first tag', async () => {
  const s = setup();
  const db = s.a.customer.database('rds-instance', 'shop-db');
  s.a.state.fail.addTagsToResource = new Error('Rate exceeded');
  await assert.rejects(s.onboarding.onboard({ workloadId: 'shop', targetGroupArn: s.tg, databases: [{ kind: 'rds-instance', id: 'shop-db' }], by: 'ops' }), /undone/);
  assert.deepEqual(s.a.state.instances.get('i-0aaa').tags, { Name: 'shop' });
  assert.deepEqual(s.a.state.databases.get(db).tags, {});
});

test('offboarding never deletes a target group named like the waker but not tagged for the workload', async () => {
  const s = setup();
  const lookalike = s.a.customer.targetGroup('dmt-dev-shop');
  await s.onboarding.offboard({ workloadId: 'shop', by: 'ops' });
  assert.ok(s.a.state.targetGroups.has(lookalike));
  await assert.rejects(s.onboarding.onboard({ workloadId: 'shop', targetGroupArn: s.tg, by: 'ops' }), /target group dmt-dev-shop exists and is not the waker of shop/);
});

// --- Review fixes -------------------------------------------------------------------------------------------------

test('offboard pauses the workload before anything else, so that no nap starts or commits while it runs', async () => {
  const s = setup();
  await s.onboarding.onboard({ workloadId: 'shop', targetGroupArn: s.tg, by: 'ops' });
  let pausedFirst = null;
  const remove = s.a.elbv2.deleteRule;
  s.a.elbv2.deleteRule = async (input) => {
    pausedFirst ??= s.a.items.has('shop/PAUSE');
    return remove(input);
  };
  await s.onboarding.offboard({ workloadId: 'shop', by: 'ops@example.com' });
  assert.equal(pausedFirst, true);
});

test('offboard of a workload that is not awake leaves it paused for offboarding (the workflow wakes it and tries again)', async () => {
  const s = setup();
  await s.onboarding.onboard({ workloadId: 'shop', targetGroupArn: s.tg, by: 'ops' });
  s.a.items.get('shop/RUN').state = 'NAPPING';
  await assert.rejects(s.onboarding.offboard({ workloadId: 'shop', by: 'ops' }), /it is NAPPING, wake it first/);
  assert.equal(s.a.items.get('shop/PAUSE').reason, 'offboarding');
  assert.notEqual(await s.a.store.getConfig('shop'), null);
});

test('a failed offboard keeps the configuration, so that running it again finishes it', async () => {
  const s = setup();
  const db = s.a.customer.database('rds-instance', 'shop-db');
  await s.onboarding.onboard({ workloadId: 'shop', targetGroupArn: s.tg, databases: [{ kind: 'rds-instance', id: 'shop-db' }], by: 'ops' });
  s.a.state.fail.deleteTargetGroup = new Error('Throttling');
  await assert.rejects(s.onboarding.offboard({ workloadId: 'shop', by: 'ops' }), /offboard of shop incomplete: waker target group: Throttling/);
  assert.notEqual(await s.a.store.getConfig('shop'), null);
  const again = await s.onboarding.offboard({ workloadId: 'shop', by: 'ops' });
  assert.equal(again.steps.find((x) => x.name === 'waker target group').status, 'done');
  assert.deepEqual(s.a.state.databases.get(db).tags, {});
  assert.equal(await s.a.store.getConfig('shop'), null);
});

test('offboard untags what onboarding tagged even when a companion database was deleted since', async () => {
  const s = setup();
  const db = s.a.customer.database('rds-instance', 'shop-db');
  await s.onboarding.onboard({ workloadId: 'shop', targetGroupArn: s.tg, databases: [{ kind: 'rds-instance', id: 'shop-db' }], by: 'ops' });
  assert.deepEqual((await s.a.store.getConfig('shop')).tagged.map((t) => [t.kind, t.id]), [['instance', 'i-0aaa'], ['rds-instance', 'shop-db']]);
  s.a.state.databases.delete(db);
  const result = await s.onboarding.offboard({ workloadId: 'shop', by: 'ops' });
  assert.equal(result.steps.find((x) => x.name === 'untag backends').status, 'done');
  assert.deepEqual(s.a.state.instances.get('i-0aaa').tags, { Name: 'shop' });
});

// --- Shadow rules (R4c) -------------------------------------------------------------------------------------------

test('a foreign rule right before a customer rule leaves no slot for its shadow: that rule is instrumented in place', async () => {
  const s = setup();
  const other = s.a.customer.targetGroup('blog-app');
  // Any host: it can take requests of rules 10 and 11.
  s.a.customer.rule(9, other, { path: '/blog/*' });
  const preview = await s.onboarding.preview({ workloadId: 'shop', targetGroupArn: s.tg });
  assert.deepEqual(preview.rules.map((r) => [r.priority, r.action]), [['10', 'instrument in place (no free priority before it)'], ['11', 'instrument in place (no free priority before it)']]);
  await s.onboarding.onboard({ workloadId: 'shop', targetGroupArn: s.tg, by: 'ops' });
  assert.deepEqual(shadowsOf(s.a), []);
  assert.deepEqual(weights(s.a, s.main), [['shop-app', 1], ['dmt-dev-shop', 0]]);
  assert.equal(s.a.state.rules.get(s.main).tags[WORKLOAD], 'shop');
  await s.onboarding.offboard({ workloadId: 'shop', by: 'ops' });
  assert.deepEqual(weights(s.a, s.main), [['shop-app', 1]]);
});

test('a rule with an action before its forward (authentication) is instrumented in place: a shadow could not copy it', async () => {
  const s = setup();
  const auth = { Type: 'authenticate-oidc', Order: 1, AuthenticateOidcConfig: { Issuer: 'https://idp', ClientId: 'x' } };
  const forward = { Type: 'forward', Order: 2, TargetGroupArn: s.tg, ForwardConfig: { TargetGroups: [{ TargetGroupArn: s.tg, Weight: 1 }] } };
  s.a.state.rules.get(s.main).actions = [auth, forward];
  s.a.state.rules.get(s.statics).conditions = [{ Field: 'path-pattern', PathPatternConfig: { Values: ['/static/*'] } }];
  const preview = await s.onboarding.preview({ workloadId: 'shop', targetGroupArn: s.tg });
  // Rule 11 takes any host: its shadow must never jump before the authenticated rule 10 (requests would skip authentication).
  assert.deepEqual(preview.rules.map((r) => [r.priority, r.action]), [['10', 'instrument in place (actions before the forward)'], ['11', 'instrument in place (no free priority before it)']]);
});

test('a shadow passes over a foreign rule no request of its rule can match (another host)', async () => {
  const s = setup();
  const other = s.a.customer.targetGroup('blog-app');
  s.a.customer.rule(9, other, { host: 'blog.example.com' });
  const preview = await s.onboarding.preview({ workloadId: 'shop', targetGroupArn: s.tg });
  assert.deepEqual(preview.rules.map((r) => [r.priority, r.action]), [['10', 'shadow at 8'], ['11', 'shadow at 7']]);
});

test('shadows are found again by onboard, and a shadow placed after its rule since is not counted', async () => {
  const s = setup();
  await s.onboarding.onboard({ workloadId: 'shop', targetGroupArn: s.tg, by: 'ops' });
  assert.equal((await s.onboarding.preview({ workloadId: 'shop', targetGroupArn: s.tg })).rules.every((r) => r.action === 'shadowed'), true);
});

// --- Repair (R4c) -------------------------------------------------------------------------------------------------

const onboarded = async () => {
  const s = setup();
  await s.onboarding.onboard({ workloadId: 'shop', targetGroupArn: s.tg, by: 'ops' });
  s.a.state.calls.length = 0;
  return s;
};
const kinds = (result) => result.repaired.map((e) => e.kind);

test('repair finds nothing to do on an intact workload', async () => {
  const s = await onboarded();
  assert.deepEqual((await s.onboarding.repair({ workloadId: 'shop', by: 'check' })).repaired, []);
  assert.ok(!s.a.state.calls.some((c) => /^(create|modify|delete|set|add|remove)/.test(c)), s.a.state.calls.join(', '));
});

test('repair recreates a shadow deleted by hand, and records the drift', async () => {
  const s = await onboarded();
  const [shadow] = shadowsOf(s.a).filter((x) => x.shadows === s.main);
  s.a.state.rules.delete(shadow.arn);
  const result = await s.onboarding.repair({ workloadId: 'shop', by: 'event' });
  assert.deepEqual(kinds(result), ['shadow created']);
  assert.equal(shadowsOf(s.a).filter((x) => x.shadows === s.main).length, 1);
  assert.deepEqual((await s.a.store.listDrift('shop')).map((e) => [e.kind, e.by]), [['shadow created', 'event']]);
});

test('repair mirrors conditions the customer changed, and moves a shadow placed after its rule', async () => {
  const s = await onboarded();
  await s.a.elbv2.modifyRuleConditions(s.main, [{ Field: 'host-header', Values: ['www.example.com'], HostHeaderConfig: { Values: ['www.example.com'] } }]);
  const statics = shadowsOf(s.a).find((x) => x.shadows === s.statics);
  s.a.state.rules.get(statics.arn).priority = '12';
  const result = await s.onboarding.repair({ workloadId: 'shop', by: 'event' });
  assert.deepEqual(kinds(result).sort(), ['shadow conditions mirrored', 'shadow moved']);
  const main = shadowsOf(s.a).find((x) => x.shadows === s.main);
  assert.deepEqual(main.conditions, [{ Field: 'host-header', HostHeaderConfig: { Values: ['www.example.com'] } }]);
  assert.ok(Number(shadowsOf(s.a).find((x) => x.shadows === s.statics).priority) < 11);
});

test('repair deletes the shadow of a customer rule deleted since, and shadows a new customer rule', async () => {
  const s = await onboarded();
  s.a.state.rules.delete(s.statics);
  const added = s.a.customer.rule(20, s.tg, { host: 'api.example.com' });
  const result = await s.onboarding.repair({ workloadId: 'shop', by: 'event' });
  assert.deepEqual(kinds(result).sort(), ['shadow created', 'shadow removed']);
  assert.deepEqual(shadowsOf(s.a).map((x) => x.shadows).sort(), [added, s.main].sort());
});

test('a shadow created while the workload sleeps sends to the waker', async () => {
  const s = await onboarded();
  s.a.items.get('shop/RUN').state = 'ASLEEP';
  const added = s.a.customer.rule(20, s.tg, { host: 'api.example.com' });
  await s.onboarding.repair({ workloadId: 'shop', by: 'check' });
  assert.deepEqual(shadowsOf(s.a).find((x) => x.shadows === added).weights, [['shop-app', 0], ['dmt-dev-shop', 1]]);
});

test('repair restores a backend tag the customer removed', async () => {
  const s = await onboarded();
  delete s.a.state.instances.get('i-0aaa').tags[WORKLOAD];
  const result = await s.onboarding.repair({ workloadId: 'shop', by: 'event' });
  assert.deepEqual(kinds(result), ['backend tag restored']);
  assert.equal(s.a.state.instances.get('i-0aaa').tags[WORKLOAD], 'shop');
});

test('repair leaves alone a workload written in Terraform', async () => {
  const s = await onboarded();
  delete s.a.items.get('shop/CFG').source;
  s.a.state.rules.clear();
  assert.deepEqual(await s.onboarding.repair({ workloadId: 'shop', by: 'check' }), { repaired: [], skipped: 'not onboarded by the manager' });
});

test('a CloudTrail event repairs every workload the manager onboarded, never one written in Terraform', async () => {
  const s = await onboarded();
  s.a.items.set('legacy/CFG', { workloadId: 'legacy', appTargetGroupArn: 'arn:tg/legacy' });
  const [shadow] = shadowsOf(s.a);
  s.a.state.rules.delete(shadow.arn);
  const result = await s.onboarding.repairAll({ by: 'event:DeleteRule' });
  assert.deepEqual(result, { workloads: [{ workloadId: 'shop', repaired: ['shadow created'] }] });
  assert.deepEqual((await s.a.store.listDrift('shop')).map((e) => e.by), ['event:DeleteRule']);
});

test('repair leaves alone a workload being offboarded (its tag removals must not be undone)', async () => {
  const s = await onboarded();
  await s.a.store.putPause('shop', { by: 'ops', at: 1, reason: 'offboarding', keepAsleep: true });
  delete s.a.state.instances.get('i-0aaa').tags[WORKLOAD];
  assert.deepEqual(await s.onboarding.repair({ workloadId: 'shop', by: 'event' }), { repaired: [], skipped: 'being offboarded' });
  assert.equal(s.a.state.instances.get('i-0aaa').tags[WORKLOAD], undefined);
});

test('registering the waker is retried while the new invoke permission propagates', async () => {
  const s = setup();
  const register = s.a.elbv2.registerTargets;
  let refusals = 2;
  s.a.elbv2.registerTargets = async (input) => {
    if (refusals-- > 0) throw Object.assign(new Error('elasticloadbalancing principal does not have permission to invoke arn:aws:lambda:eu-west-1:111122223333:function:dmt-dev-waker from target group arn:x'), { name: 'AccessDenied' });
    return register(input);
  };
  const result = await s.onboarding.onboard({ workloadId: 'shop', targetGroupArn: s.tg, by: 'ops' });
  assert.equal(result.steps.find((x) => x.name === 'register waker').status, 'done');
});

// --- R4c review fixes -----------------------------------------------------------------------------------------------

test('a shadow never jumps an authentication rule placed before its customer rule', async () => {
  const s = setup();
  const auth = { Type: 'authenticate-oidc', Order: 1, AuthenticateOidcConfig: { Issuer: 'https://idp', ClientId: 'x' } };
  s.a.customer.rule(9, s.tg, { host: 'shop.example.com', actions: [auth, { Type: 'forward', Order: 2, TargetGroupArn: s.tg, ForwardConfig: { TargetGroups: [{ TargetGroupArn: s.tg, Weight: 1 }] } }] });
  const preview = await s.onboarding.preview({ workloadId: 'shop', targetGroupArn: s.tg });
  // Rule 11 (another host) may pass over both: no request of it matches them.
  assert.deepEqual(preview.rules.map((r) => [r.priority, r.action]), [
    ['9', 'instrument in place (actions before the forward)'], ['10', 'instrument in place (no free priority before it)'], ['11', 'shadow at 8'],
  ]);
});

test('shadow slots are searched per listener: a rule of another listener at the same priority does not hide a foreign rule', async () => {
  const s = setup();
  s.a.state.rules.clear();
  const admin = s.a.customer.targetGroup('admin-app');
  s.a.customer.rule(49, admin, { path: '/admin/*' });
  const https = s.a.customer.rule(50, s.tg, { host: 'shop.example.com' });
  const http = s.a.customer.rule(49, s.tg, { host: 'shop.example.com', listener: 'http' });
  const plans = (await s.onboarding.preview({ workloadId: 'shop', targetGroupArn: s.tg })).rules;
  assert.deepEqual(plans.map((r) => [r.arn === https ? 'https 50' : r.arn === http ? 'http 49' : r.arn, r.action]).sort(), [
    ['http 49', 'shadow at 48'], ['https 50', 'instrument in place (no free priority before it)'],
  ]);
});

test('a foreign rule placed between a shadow and its rule since makes repair move the shadow after it', async () => {
  const s = await onboarded();
  s.a.state.rules.get(s.main).priority = '30';
  const api = s.a.customer.targetGroup('api-app');
  s.a.customer.rule(20, api, { host: 'shop.example.com' });
  const result = await s.onboarding.repair({ workloadId: 'shop', by: 'event' });
  assert.deepEqual(kinds(result), ['shadow moved']);
  assert.equal(shadowsOf(s.a).find((x) => x.shadows === s.main).priority, '29');
});

test('a move with no free slot falls back to instrumenting the rule in place', async () => {
  const s = await onboarded();
  s.a.state.rules.get(s.main).priority = '2';
  const other = s.a.customer.targetGroup('other-app');
  s.a.customer.rule(1, other, { host: 'other.example.com' });
  const result = await s.onboarding.repair({ workloadId: 'shop', by: 'check' });
  // The rule is instrumented while its shadow still hides it: requests never reach it uninstrumented.
  assert.deepEqual(kinds(result), ['rule instrumented in place', 'shadow removed']);
  assert.deepEqual(weights(s.a, s.main), [['shop-app', 1], ['dmt-dev-shop', 0]]);
});

test('a customer rule now forwarding to other target groups too (blue/green) loses its shadow and is never changed', async () => {
  const s = await onboarded();
  const v2 = s.a.customer.targetGroup('shop-v2');
  s.a.state.rules.get(s.main).actions = [{ Type: 'forward', Order: 1, ForwardConfig: { TargetGroups: [{ TargetGroupArn: s.tg, Weight: 0 }, { TargetGroupArn: v2, Weight: 100 }] } }];
  const result = await s.onboarding.repair({ workloadId: 'shop', by: 'event' });
  assert.deepEqual(kinds(result), ['shadow removed']);
  assert.equal(shadowsOf(s.a).some((x) => x.shadows === s.main), false);
  assert.deepEqual(weights(s.a, s.main), [['shop-app', 0], ['shop-v2', 100]]);
});

test('a rule with transforms (URL or host rewrite) is instrumented in place: a shadow would not rewrite', async () => {
  const s = setup();
  s.a.state.rules.get(s.main).transforms = [{ Type: 'url-rewrite', UrlRewriteConfig: { Rewrites: [{ Regex: '^/api/(.*)$', Replace: '/$1' }] } }];
  const preview = await s.onboarding.preview({ workloadId: 'shop', targetGroupArn: s.tg });
  assert.equal(preview.rules.find((r) => r.arn === s.main).action, 'instrument in place (transforms)');
});

test('repairAll repairs only the workloads the event concerns, and one failing workload does not stop the others', async () => {
  const s = await onboarded();
  s.a.items.set('blog/CFG', { workloadId: 'blog', source: 'manager', appTargetGroupArn: 'arn:tg/blog', loadBalancerDimension: 'app/blog/1', tagged: [] });
  const shadow = shadowsOf(s.a)[0];
  s.a.state.rules.delete(shadow.arn);
  const other = await s.onboarding.repairAll({ by: 'event:DeleteRule', detail: { requestParameters: { ruleArn: 'arn:aws:elasticloadbalancing:eu-west-1:111122223333:listener-rule/app/elsewhere/1/2/3' } } });
  assert.deepEqual(other, { workloads: [] });
  const ours = await s.onboarding.repairAll({ by: 'event:DeleteRule', detail: { requestParameters: { ruleArn: shadow.arn } } });
  assert.deepEqual(ours, { workloads: [{ workloadId: 'shop', repaired: ['shadow created'] }] });
  s.a.items.set('broken/CFG', { workloadId: 'broken', source: 'manager', appTargetGroupArn: 'arn:tg/missing', loadBalancerDimension: 'app/shop/50dc6c495c0c9188', tagged: [{ kind: 'asg', id: 'broken-asg' }] });
  s.a.state.fail.describeAutoScalingGroups = new Error('Throttling');
  const all = await s.onboarding.repairAll({ by: 'check' });
  assert.deepEqual(all.workloads.map((w) => [w.workloadId, w.error ?? 'ok']).sort(), [['blog', 'ok'], ['broken', 'Throttling'], ['shop', 'ok']]);
});

test('drift events read in one batch repair each workload they concern once; a workload offboarded since is left alone', async () => {
  const s = await onboarded();
  const shadow = shadowsOf(s.a)[0];
  s.a.state.rules.delete(shadow.arn);
  const deleted = { eventName: 'DeleteRule', requestParameters: { ruleArn: shadow.arn } };
  // Several events about the same load balancer within the batch window.
  const result = await s.onboarding.repairEvents([deleted, deleted, { eventName: 'ModifyRule', requestParameters: { ruleArn: s.main } }]);
  assert.deepEqual(result, { workloads: [{ workloadId: 'shop', repaired: ['shadow created'] }] });
  // Offboarded since the events: its configuration is gone, nothing to repair.
  s.a.items.delete('shop/CFG');
  assert.deepEqual(await s.onboarding.repairEvents([deleted]), { workloads: [] });
});

test('the preview refuses an onboarding its load balancer or region has no room for, with the reason', async () => {
  // A load balancer at its 100 target groups (not adjustable): no room for the waker target group.
  const full = setup();
  for (let i = 0; i < 99; i += 1) full.a.customer.targetGroup(`other-${i}`);
  assert.ok((await full.onboarding.preview({ targetGroupArn: full.tg })).problems.includes('the load balancer has 100 target groups, its maximum (not adjustable): no room for the waker target group'));
  // Its rules at their quota: the 2 shadow rules do not fit.
  const rules = setup();
  rules.a.state.limits = { 'rules-per-application-load-balancer': 3 };
  assert.ok((await rules.onboarding.preview({ targetGroupArn: rules.tg })).problems.includes('the load balancer has 2 rules of the 3 it may have: no room for 2 shadow rules (rules per Application Load Balancer, adjustable in Service Quotas)'));
  // The region at its target groups quota.
  const region = setup();
  region.a.state.limits = { 'target-groups': 1 };
  assert.ok((await region.onboarding.preview({ targetGroupArn: region.tg })).problems.includes('the region has 1 target groups of the 1 it may have: no room for the waker target group (target groups per region, adjustable in Service Quotas)'));
  // Room everywhere.
  const room = setup();
  assert.deepEqual((await room.onboarding.preview({ targetGroupArn: room.tg })).problems, []);
});

test('onboarding lists the backends of the target group once', async () => {
  const s = setup({ backend: 'asg' });
  const before = s.a.state.calls.length;
  await s.onboarding.onboard({ targetGroupArn: s.tg, by: 'ops' });
  assert.equal(s.a.state.calls.slice(before).filter((c) => c === 'describeAutoScalingGroups').length, 1);
});

test('ECS services are listed 100 per page', async () => {
  const s = setup({ backend: 'ecs' });
  for (let i = 0; i < 249; i += 1) s.a.customer.service(`svc-${i}`, { targetGroups: [] });
  await s.onboarding.preview({ targetGroupArn: s.tg });
  assert.equal(s.a.state.calls.filter((c) => c === 'listServices').length, 3);
});

test('a second shadow of one rule (two repairs at once) is removed, the first one stays', async () => {
  const s = await onboarded();
  const first = shadowsOf(s.a).find((x) => x.shadows === s.main);
  await s.a.elbv2.createRule({
    ListenerArn: s.a.state.rules.get(first.arn).listener, Priority: 5, Conditions: first.conditions,
    Actions: s.a.state.rules.get(first.arn).actions, Tags: [{ Key: 'dormeto:workload', Value: 'shop' }, { Key: 'dormeto:shadows', Value: s.main }],
  });
  const result = await s.onboarding.repair({ workloadId: 'shop', by: 'event' });
  assert.deepEqual(kinds(result), ['shadow removed']);
  assert.deepEqual(shadowsOf(s.a).filter((x) => x.shadows === s.main).map((x) => x.arn), [first.arn]);
});

// --- R4d: workload identity and names --------------------------------------------------------------------------------

test('a workload id is 16 hexadecimal characters of the SHA-256 of its target group ARN', () => {
  // printf %s <arn> | shasum -a 256 | cut -c1-16
  assert.equal(workloadIdOf('arn:aws:elasticloadbalancing:eu-west-1:121014831971:targetgroup/dmt-dev-onb-app/f371b534e0105480'), '7010ea54b5c02245');
  // Same target group id in another account: another workload id.
  assert.notEqual(workloadIdOf('arn:aws:elasticloadbalancing:eu-west-1:038606077307:targetgroup/dmt-dev-onb-app/f371b534e0105480'), '7010ea54b5c02245');
});

test('without an id, preview and onboard derive it from the target group and name the workload after it', async () => {
  const s = setup();
  const id = workloadIdOf(s.tg);
  const preview = await s.onboarding.preview({ targetGroupArn: s.tg });
  assert.deepEqual([preview.ok, preview.workloadId, preview.name, preview.wakerTargetGroupName], [true, id, 'shop-app', `dmt-dev-${id}`]);
  const result = await s.onboarding.onboard({ targetGroupArn: s.tg, by: 'ops' });
  assert.deepEqual([result.workload.workloadId, result.workload.name], [id, 'shop-app']);
  const cfg = await s.a.store.getConfig(id);
  assert.deepEqual([cfg.workloadId, cfg.name], [id, 'shop-app']);
  assert.equal(s.a.state.instances.get('i-0aaa').tags[WORKLOAD], id);
  // Run again: the same id finds what it created.
  assert.ok((await s.onboarding.onboard({ targetGroupArn: s.tg, by: 'ops' })).steps.every((x) => x.status === 'skipped'));
});

test('a name given at onboarding is trimmed and checked: at most 64 characters, no control character', async () => {
  const s = setup();
  assert.equal((await s.onboarding.preview({ targetGroupArn: s.tg, name: '  Shop (front)  ' })).name, 'Shop (front)');
  assert.equal((await s.onboarding.preview({ targetGroupArn: s.tg, name: '   ' })).name, 'shop-app');
  assert.deepEqual((await s.onboarding.preview({ targetGroupArn: s.tg, name: 'x'.repeat(65) })).problems, ['name: at most 64 characters']);
  assert.deepEqual((await s.onboarding.preview({ targetGroupArn: s.tg, name: 'a\nb' })).problems, ['name: no control characters']);
});

test('a derived id already used by another target group is refused', async () => {
  const s = setup();
  const id = workloadIdOf(s.tg);
  s.a.items.set(`${id}/CFG`, { workloadId: id, appTargetGroupArn: 'arn:tg/other', source: 'manager' });
  assert.deepEqual((await s.onboarding.preview({ targetGroupArn: s.tg })).problems, [`workload ${id} already exists with another target group`]);
});

test('offboarding never removes the router permission, whatever the workload id (a workload named waker)', async () => {
  const s = setup();
  await s.a.lambda.addPermission({ FunctionName: 'dmt-dev-waker', StatementId: ROUTER_PERMISSION, Action: 'lambda:InvokeFunction', Principal: 'elasticloadbalancing.amazonaws.com', SourceArn: 'arn:x/dmt-dev-*/*' });
  await s.onboarding.onboard({ workloadId: 'waker', targetGroupArn: s.tg, by: 'ops' });
  await s.onboarding.offboard({ workloadId: 'waker', by: 'ops' });
  assert.deepEqual([...s.a.state.permissions.keys()], [ROUTER_PERMISSION]);
});
