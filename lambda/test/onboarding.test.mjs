import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOnboarding } from '../src/lib/onboarding.mjs';
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
    now: () => NOW, log: { info: (e, d) => logs.push([e, d]), warn: (e, d) => logs.push([e, d]), error: (e, d) => logs.push([e, d]) },
  });
  return { a, tg, main, statics, onboarding, logs };
}

const weights = (a, rule) => a.state.rules.get(rule).actions[0].ForwardConfig.TargetGroups.map((g) => [a.state.targetGroups.get(g.TargetGroupArn)?.name, g.Weight]);

// --- preview ---------------------------------------------------------------------------------------------------------

test('preview lists the rules to instrument, the backends to tag and the waker target group, without any change', async () => {
  const s = setup();
  const preview = await s.onboarding.preview({ workloadId: 'shop', targetGroupArn: s.tg });
  assert.equal(preview.ok, true);
  assert.deepEqual(preview.problems, []);
  assert.equal(preview.wakerTargetGroupName, 'dmt-dev-shop');
  assert.equal(preview.loadBalancerArn, LB);
  assert.deepEqual(preview.rules.map((r) => [r.priority, r.conditions, r.action]), [['10', 'host shop.example.com', 'instrument'], ['11', 'host static.example.com', 'instrument']]);
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

test('onboard tags the backend, creates and registers the waker target group, writes the workload and instruments every rule with traffic unchanged', async () => {
  const s = setup();
  const result = await s.onboarding.onboard({ workloadId: 'shop', targetGroupArn: s.tg, settings: { idleMinutes: 30, wakeMode: 'browser' }, by: 'ops@example.com' });
  assert.deepEqual(result.steps.map((x) => [x.name, x.status]), [
    ['tag backends', 'done'], ['waker target group', 'done'], ['invoke permission', 'done'], ['register waker', 'done'], ['workload configuration', 'done'], ['instrument rules', 'done'],
  ]);
  assert.deepEqual(s.a.state.instances.get('i-0aaa').tags, { Name: 'shop', [WORKLOAD]: 'shop', [MARKER]: 'onboarder' });
  const [wakerArn, waker] = [...s.a.state.targetGroups].find(([, g]) => g.name === 'dmt-dev-shop');
  assert.equal(result.workload.wakerTargetGroupArn, wakerArn);
  assert.deepEqual([waker.type, waker.tags, waker.attributes, waker.targets.map((t) => t.Id)], [
    'lambda', { [WORKLOAD]: 'shop', 'dormeto:router': 'dmt-dev' }, { 'lambda.multi_value_headers.enabled': 'true' }, [WAKER_ARN],
  ]);
  assert.deepEqual(s.a.state.permissions.get('alb-shop'), { SourceArn: wakerArn });
  for (const rule of [s.main, s.statics]) {
    assert.deepEqual(weights(s.a, rule), [['shop-app', 1], ['dmt-dev-shop', 0]]);
    assert.equal(s.a.state.rules.get(rule).actions[0].TargetGroupArn, undefined);
    assert.equal(s.a.state.rules.get(rule).tags[WORKLOAD], 'shop');
  }
  const cfg = await s.a.store.getConfig('shop');
  assert.deepEqual({ ...cfg, onboardedAt: 'x' }, {
    workloadId: 'shop', appTargetGroupArn: s.tg, wakerTargetGroupArn: wakerArn,
    loadBalancerDimension: 'app/shop/50dc6c495c0c9188', appTargetGroupDimension: s.tg.split(':').at(-1),
    instanceIds: [], waitSeconds: 60, idleMinutes: 30, drainSeconds: 30, wakeTimeoutSeconds: 600, failedRetrySeconds: 60, maxHolders: 50, pollSeconds: 3,
    noWakeRules: [], wakeMode: 'browser', wakeRules: [], admin: { enabled: false, secretHash: '', secretParameter: '' },
    source: 'manager', onboardedBy: 'ops@example.com', onboardedAt: 'x', databases: [],
  });
  assert.equal(cfg.onboardedAt, new Date(NOW).toISOString());
  assert.deepEqual(await s.a.store.getRun('shop'), { state: 'AWAKE', version: 0, awakeSince: NOW, holders: 0, wakeCount: 0 });
});

test('onboard again finds everything in place and changes nothing', async () => {
  const s = setup();
  await s.onboarding.onboard({ workloadId: 'shop', targetGroupArn: s.tg, by: 'ops' });
  s.a.state.calls.length = 0;
  const again = await s.onboarding.onboard({ workloadId: 'shop', targetGroupArn: s.tg, by: 'ops' });
  assert.deepEqual(again.steps.map((x) => x.status), ['skipped', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped']);
  assert.ok(!s.a.state.calls.some((c) => ['createTargetGroup', 'createTags', 'modifyRule', 'putConfig', 'addTags'].includes(c)), s.a.state.calls.join(', '));
});

test('an undo that fails part-way goes on with the other steps, and the next onboard finishes from what is left', async () => {
  const s = setup();
  s.a.state.fail.addPermission = new Error('Rate exceeded');
  s.a.state.fail.deleteTargetGroup = new Error('Throttling');
  await assert.rejects(s.onboarding.onboard({ workloadId: 'shop', targetGroupArn: s.tg, by: 'ops' }),
    /cannot onboard shop: Rate exceeded \(undo incomplete: waker target group: Throttling\)/);
  assert.deepEqual(s.a.state.instances.get('i-0aaa').tags, { Name: 'shop' }, 'the undo went on after the failed step');
  const second = await s.onboarding.onboard({ workloadId: 'shop', targetGroupArn: s.tg, by: 'ops' });
  assert.deepEqual(second.steps.map((x) => x.status), ['done', 'skipped', 'done', 'done', 'done', 'done']);
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
  s.a.state.fail.modifyRule = new Error('Rate exceeded');
  await assert.rejects(s.onboarding.onboard({ workloadId: 'shop', targetGroupArn: s.tg, by: 'ops' }), /cannot onboard shop: Rate exceeded \(undone\)/);
  assert.deepEqual(s.a.state.instances.get('i-0aaa').tags, { Name: 'shop' });
  assert.ok(![...s.a.state.targetGroups.values()].some((g) => g.name === 'dmt-dev-shop'));
  assert.equal(s.a.state.permissions.size, 0);
  assert.equal(await s.a.store.getConfig('shop'), null);
  for (const rule of [s.main, s.statics]) assert.deepEqual(weights(s.a, rule), [['shop-app', 1]]);
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
  const result = await s.onboarding.offboard({ workloadId: 'shop', by: 'ops' });
  assert.deepEqual(result.steps.map((x) => [x.name, x.status]), [
    ['restore rules', 'done'], ['waker target group', 'done'], ['invoke permission', 'done'], ['untag backends', 'done'], ['workload configuration', 'done'],
  ]);
  for (const rule of [s.main, s.statics]) {
    assert.deepEqual(weights(s.a, rule), [['shop-app', 1]]);
    assert.equal(s.a.state.rules.get(rule).tags[WORKLOAD], undefined);
  }
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
  s.a.state.permissions.clear();
  s.a.state.fail.addPermission = new Error('Rate exceeded');
  await assert.rejects(s.onboarding.onboard({ workloadId: 'shop', targetGroupArn: s.tg, by: 'ops' }), /^Error: Rate exceeded$/);
  assert.notEqual(await s.a.store.getConfig('shop'), null);
  assert.deepEqual(weights(s.a, s.main), [['shop-app', 1], ['dmt-dev-shop', 0]]);
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
