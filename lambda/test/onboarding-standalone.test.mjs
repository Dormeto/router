// Onboarding by resource (vision standalone workloads design §2, §5): preview, onboard and offboard a standalone workload, an EC2
// instance, an Auto Scaling group, an ECS service, an RDS instance or an Aurora cluster, with no load balancer change and no ELB
// call but the read that tells whether an instance feeds a target group; a resource is in one workload.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOnboarding, workloadIdOf } from '../src/lib/onboarding.mjs';
import { STANDALONE_KEYS } from '../src/lib/settings-levels.mjs';
import { WAKER_ARN, fakeAccount } from './account-fake.mjs';

const NOW = 1_791_158_400_000;
const WORKLOAD = 'dormeto:workload';
const MARKER = 'dormeto:tagged';
const ARN = {
  instance: (id) => `arn:aws:ec2:eu-west-1:111122223333:instance/${id}`,
  asg: (name) => `arn:aws:autoscaling:eu-west-1:111122223333:autoScalingGroup:0000:autoScalingGroupName/${name}`,
};
const ELB_CALLS = /^(describeTargetGroups|describeTargetHealth|describeListeners|describeRules|describeTags|describeAccountLimits|createTargetGroup|modifyTargetGroupAttributes|deleteTargetGroup|registerTargets|deregisterTargets|modifyRule|createRule|deleteRule|setRulePriorities|addTags|removeTags)$/;

function setup() {
  const a = fakeAccount();
  const logs = [];
  const onboarding = createOnboarding({
    elbv2: a.elbv2, ec2: a.ec2, autoscaling: a.autoscaling, ecs: a.ecs, rds: a.rds, lambda: a.lambda, store: a.store,
    router: { name: 'dmt-dev', wakerFunctionName: 'dmt-dev-waker', wakerFunctionArn: WAKER_ARN },
    now: () => NOW, sleep: async () => {}, log: { info: (e, d) => logs.push([e, d]), warn: (e, d) => logs.push([e, d]), error: (e, d) => logs.push([e, d]) },
  });
  const elb = () => a.state.calls.filter((c) => ELB_CALLS.test(c));
  return { a, onboarding, logs, elb };
}

// Each kind, its resource ARN once created in the account, and how to read its tags.
const KINDS = {
  instance: (a) => { a.customer.instance('i-0aaa', { tags: { Name: 'batch' } }); return { arn: ARN.instance('i-0aaa'), tags: () => a.state.instances.get('i-0aaa').tags, label: 'instance i-0aaa' }; },
  asg: (a) => { a.customer.group('workers'); return { arn: ARN.asg('workers'), tags: () => a.state.groups.get('workers').tags, label: 'Auto Scaling group workers' }; },
  ecs: (a) => { const arn = a.customer.service('worker', { cluster: 'jobs' }); return { arn, tags: () => a.state.services.get(arn).tags, label: 'ECS service jobs/worker' }; },
  'rds-instance': (a) => { const arn = a.customer.database('rds-instance', 'orders'); return { arn, tags: () => a.state.databases.get(arn).tags, label: 'RDS instance orders' }; },
  'rds-cluster': (a) => { const arn = a.customer.database('rds-cluster', 'ledger'); return { arn, tags: () => a.state.databases.get(arn).tags, label: 'RDS cluster ledger' }; },
};

for (const [kind, make] of Object.entries(KINDS)) {
  test(`a standalone ${kind}: previewed, onboarded (tagged, its record, its run) and offboarded (untagged, nothing left), with no ELB change`, async () => {
    const s = setup();
    const r = make(s.a);
    const workloadId = workloadIdOf(r.arn);
    const preview = await s.onboarding.preview({ resourceArn: r.arn, name: 'Batch', settings: { idleCpuPercent: 'off' } });
    assert.deepEqual([preview.ok, preview.problems, preview.workloadId, preview.kind, preview.resourceArn], [true, [], workloadId, 'standalone', r.arn]);
    assert.deepEqual(s.a.state.calls.filter((c) => !c.startsWith('describe') && !c.startsWith('list')), [], 'a preview changes nothing');
    const done = await s.onboarding.onboard({ resourceArn: r.arn, name: 'Batch', settings: { idleCpuPercent: 'off', hibernate: false }, tags: { team: 'data' }, by: 'ana' });
    assert.deepEqual(done.steps.map((x) => [x.name, x.status]), [['tag resource and databases', 'done'], ['workload configuration', 'done']]);
    assert.deepEqual(done.workload, { workloadId, name: 'Batch' });
    assert.deepEqual(r.tags(), { ...(kind === 'instance' ? { Name: 'batch' } : {}), [WORKLOAD]: workloadId, [MARKER]: 'onboarder' });
    const cfg = await s.a.store.getConfig(workloadId);
    assert.deepEqual({ ...cfg, tagged: undefined }, {
      workloadId, kind: 'standalone', resourceArn: r.arn, name: 'Batch', tags: { team: 'data' }, databases: [], idleCpuPercent: 'off', hibernate: false,
      inherits: STANDALONE_KEYS.filter((k) => k !== 'idleCpuPercent'), source: 'manager', onboardedBy: 'ana', onboardedAt: new Date(NOW).toISOString(), tagged: undefined,
    });
    assert.equal(cfg.tagged.length, 1);
    for (const key of ['appTargetGroupArn', 'wakerTargetGroupArn', 'ruleArns', 'wakeMode', 'waitSeconds', 'maxHolders', 'drainSeconds', 'noWakeRules', 'wakeRules']) assert.equal(key in cfg, false, key);
    assert.equal((await s.a.store.getRun(workloadId)).state, 'AWAKE');
    const off = await s.onboarding.offboard({ workloadId, by: 'ana' });
    assert.deepEqual(off.steps.map((x) => [x.name, x.status]), [['untag resource and databases', 'done'], ['workload configuration', 'done']]);
    assert.deepEqual(r.tags(), kind === 'instance' ? { Name: 'batch' } : {});
    assert.deepEqual([...s.a.items.keys()], [], 'nothing left in the table');
    // The instance's preview reads the target groups (whether it feeds one); nothing else touches ELB.
    assert.deepEqual([...new Set(s.elb())], kind === 'instance' ? ['describeTargetGroups'] : []);
  });
}

test('the instance\'s preview reads each instance target group\'s targets: one feeding it is an HTTP workload\'s', async () => {
  const s = setup();
  s.a.customer.instance('i-0aaa');
  s.a.customer.targetGroup('ips', { type: 'ip' });
  const tg = s.a.customer.targetGroup('shop-app', { targets: [{ Id: 'i-0aaa' }] });
  const preview = await s.onboarding.preview({ resourceArn: ARN.instance('i-0aaa') });
  assert.deepEqual(preview.problems, ['instance i-0aaa feeds target group shop-app: it belongs to an HTTP workload (onboard its target group)']);
  assert.deepEqual(s.elb(), ['describeTargetGroups', 'describeTargetHealth']);
  assert.ok(tg);
});

test('each eligibility reason, in plain words', async () => {
  const cases = [
    ['not an ARN', () => 'i-0aaa', 'the resource must be the ARN of an EC2 instance, an Auto Scaling group, an ECS service, an RDS instance or an Aurora cluster'],
    ['an instance gone', () => ARN.instance('i-0gone'), 'instance i-0gone not found'],
    ['an instance terminated', (a) => { a.customer.instance('i-0aaa', { state: 'terminated' }); return ARN.instance('i-0aaa'); }, 'instance i-0aaa is terminated'],
    ['an instance of a group', (a) => { a.customer.instance('i-0aaa', { tags: { 'aws:autoscaling:groupName': 'workers' } }); return ARN.instance('i-0aaa'); },
      'instance i-0aaa is in Auto Scaling group workers: onboard the group (it would replace a stopped instance)'],
    ['an instance store root', (a) => { a.customer.instance('i-0aaa', { root: 'instance-store' }); return ARN.instance('i-0aaa'); }, 'instance i-0aaa has an instance store root volume: it cannot be stopped'],
    ['a Spot instance', (a) => { a.customer.instance('i-0aaa', { spot: true }); return ARN.instance('i-0aaa'); }, 'instance i-0aaa is a Spot instance: Dormeto stops On-Demand instances only'],
    ['a group gone', () => ARN.asg('gone'), 'Auto Scaling group gone not found'],
    ['a group behind a target group', (a) => { a.customer.group('workers', { targetGroups: [a.customer.targetGroup('shop-app')] }); return ARN.asg('workers'); },
      'Auto Scaling group workers feeds target group shop-app: it belongs to an HTTP workload (onboard its target group)'],
    ['a group of EKS nodes', (a) => { a.customer.group('nodes', { tags: { 'eks:nodegroup-name': 'default' } }); return ARN.asg('nodes'); },
      'Auto Scaling group nodes holds EKS nodes: onboard the Kubernetes workloads that run on them'],
    ['a service gone', () => 'arn:aws:ecs:eu-west-1:111122223333:service/jobs/gone', 'ECS service jobs/gone not found'],
    ['a service behind a target group', (a) => a.customer.service('web', { cluster: 'jobs', targetGroups: [a.customer.targetGroup('web-app')] }),
      'ECS service jobs/web feeds target group web-app: it belongs to an HTTP workload (onboard its target group)'],
    ['a daemon service', (a) => a.customer.service('agent', { cluster: 'jobs', daemon: true }), 'ECS service jobs/agent uses the daemon scheduling strategy: it has no desired count to set to 0'],
    ['a database gone', () => 'arn:aws:rds:eu-west-1:111122223333:db:gone', 'RDS instance gone not found'],
    ['a cluster member', (a) => a.customer.database('rds-instance', 'ledger-1', { cluster: 'ledger' }), 'RDS instance ledger-1 is a member of Aurora cluster ledger: onboard the cluster'],
    ['a read replica', (a) => a.customer.database('rds-instance', 'orders-ro', { replicaOf: 'orders' }), 'RDS instance orders-ro is a read replica: it cannot be stopped'],
    ['Aurora Serverless v1', (a) => a.customer.database('rds-cluster', 'old', { engineMode: 'serverless' }), 'RDS cluster old is Aurora Serverless v1: it cannot be stopped'],
  ];
  for (const [what, make, text] of cases) {
    const s = setup();
    const resourceArn = make(s.a);
    const preview = await s.onboarding.preview({ resourceArn });
    assert.deepEqual([preview.ok, preview.problems], [false, [text]], what);
  }
});

test('a resource is in one workload: another workload\'s tag, a companion of one, one already onboarded', async () => {
  const s = setup();
  s.a.customer.instance('i-0aaa', { tags: { [WORKLOAD]: 'shop' } });
  await s.a.store.putConfig('shop', { workloadId: 'shop', name: 'Shop', appTargetGroupArn: 'tg', source: 'manager', databases: [{ kind: 'rds-instance', id: 'orders' }] });
  assert.deepEqual((await s.onboarding.preview({ resourceArn: ARN.instance('i-0aaa') })).problems, ['instance i-0aaa belongs to workload Shop (shop)']);
  const orders = s.a.customer.database('rds-instance', 'orders');
  assert.deepEqual((await s.onboarding.preview({ resourceArn: orders })).problems, ['RDS instance orders is a companion of workload Shop (shop)']);
  s.a.customer.group('workers');
  await s.onboarding.onboard({ resourceArn: ARN.asg('workers'), name: 'Workers' });
  const again = await s.onboarding.preview({ resourceArn: ARN.asg('workers') });
  assert.deepEqual(again.problems, [`Auto Scaling group workers is already onboarded: workload Workers (${workloadIdOf(ARN.asg('workers'))})`]);
  await assert.rejects(s.onboarding.onboard({ resourceArn: ARN.asg('workers') }), /already onboarded/);
});

test('companion databases: tagged with it, before or after; one of another workload or the resource itself refused', async () => {
  const s = setup();
  s.a.customer.instance('i-0aaa');
  const side = s.a.customer.database('rds-instance', 'side');
  const theirs = s.a.customer.database('rds-cluster', 'theirs', { tags: { [WORKLOAD]: 'shop' } });
  const refused = await s.onboarding.preview({ resourceArn: ARN.instance('i-0aaa'), databases: [{ kind: 'rds-instance', id: 'side' }, { kind: 'rds-cluster', id: 'theirs' }] });
  assert.deepEqual(refused.problems, ['RDS cluster theirs belongs to workload shop']);
  const own = s.a.customer.database('rds-instance', 'orders');
  assert.deepEqual((await s.onboarding.preview({ resourceArn: own, databases: [{ kind: 'rds-instance', id: 'orders' }] })).problems,
    ['RDS instance orders is the workload\'s resource, not its companion']);
  const done = await s.onboarding.onboard({ resourceArn: ARN.instance('i-0aaa'), databases: [{ kind: 'rds-instance', id: 'side' }] });
  const workloadId = done.workload.workloadId;
  assert.equal(s.a.state.databases.get(side).tags[WORKLOAD], workloadId);
  assert.deepEqual((await s.a.store.getConfig(workloadId)).databases, [{ kind: 'rds-instance', id: 'side' }]);
  await s.onboarding.offboard({ workloadId });
  assert.deepEqual(s.a.state.databases.get(side).tags, {});
  assert.ok(theirs);
});

test('the settings of a standalone workload: the waker\'s refused, the idle signals checked', async () => {
  const s = setup();
  s.a.customer.instance('i-0aaa');
  const preview = await s.onboarding.preview({ resourceArn: ARN.instance('i-0aaa'), settings: { waitSeconds: 30, idleCpuPercent: 200, hibernate: 'yes', idleMinutes: 60 } });
  assert.deepEqual(preview.problems, [
    'settings: waitSeconds: a standalone workload has no waker: waitSeconds is for an HTTP workload',
    'settings: idleCpuPercent: must be a number from 0 to 100, or off',
    'settings: hibernate must be true or false',
  ]);
});

test('an onboarding that fails is undone: nothing tagged, no record', async () => {
  const s = setup();
  s.a.customer.instance('i-0aaa');
  s.a.state.fail.putConfig = Object.assign(new Error('throttled'), { name: 'ThrottlingException' });
  await assert.rejects(s.onboarding.onboard({ resourceArn: ARN.instance('i-0aaa') }), /cannot onboard .*: throttled \(undone\)/);
  assert.deepEqual(s.a.state.instances.get('i-0aaa').tags, {});
  assert.deepEqual([...s.a.items.keys()], []);
});

test('an asleep standalone workload is woken before it is offboarded, as an HTTP one', async () => {
  const s = setup();
  s.a.customer.instance('i-0aaa');
  const { workload } = await s.onboarding.onboard({ resourceArn: ARN.instance('i-0aaa') });
  s.a.items.get(`${workload.workloadId}/RUN`).state = 'ASLEEP';
  await assert.rejects(s.onboarding.offboard({ workloadId: workload.workloadId }), /it is ASLEEP, wake it first/);
});

test('the HTTP onboarding refuses a target group whose backend is a standalone workload, naming it', async () => {
  const s = setup();
  s.a.customer.instance('i-0aaa');
  const { workload } = await s.onboarding.onboard({ resourceArn: ARN.instance('i-0aaa'), name: 'Batch' });
  const tg = s.a.customer.targetGroup('shop-app', { targets: [{ Id: 'i-0aaa' }] });
  s.a.customer.rule(10, tg, { host: 'shop.example.com' });
  const preview = await s.onboarding.preview({ targetGroupArn: tg });
  assert.deepEqual(preview.problems, [`instance i-0aaa is the standalone workload Batch (${workload.workloadId}): offboard it first`]);
  await assert.rejects(s.onboarding.onboard({ targetGroupArn: tg }), /is the standalone workload Batch/);
  // A companion of a standalone workload, named as such.
  const side = setup();
  side.a.customer.instance('i-0bbb');
  side.a.customer.database('rds-instance', 'side');
  const batch = await side.onboarding.onboard({ resourceArn: ARN.instance('i-0bbb'), name: 'Batch', databases: [{ kind: 'rds-instance', id: 'side' }] });
  side.a.customer.instance('i-0ccc');
  const web = side.a.customer.targetGroup('web-app', { targets: [{ Id: 'i-0ccc' }] });
  side.a.customer.rule(10, web, { host: 'web.example.com' });
  assert.deepEqual((await side.onboarding.preview({ targetGroupArn: web, databases: [{ kind: 'rds-instance', id: 'side' }] })).problems,
    [`RDS instance side is a companion of the standalone workload Batch (${batch.workload.workloadId}): offboard it first`]);
});

test('drift and repair skip a standalone workload without an error', async () => {
  const s = setup();
  s.a.customer.instance('i-0aaa');
  const { workload } = await s.onboarding.onboard({ resourceArn: ARN.instance('i-0aaa') });
  assert.deepEqual(await s.onboarding.repair({ workloadId: workload.workloadId }), { repaired: [], skipped: 'a standalone workload has no route to repair' });
  assert.deepEqual(await s.onboarding.repairAll({ by: 'manual' }), { workloads: [] });
  const detail = { eventName: 'DeleteTags', requestParameters: { resourcesSet: { items: [{ resourceId: 'i-0aaa' }] } } };
  assert.deepEqual(await s.onboarding.repairBatch([{ body: JSON.stringify({ detail }) }, { body: JSON.stringify({ action: 'repair', workloadId: workload.workloadId }) }]), { batchItemFailures: [], workloads: [] });
  assert.deepEqual(s.elb().filter((c) => c !== 'describeTargetGroups'), []);
});

// --- The final review's fix wave ---------------------------------------------------------------------------------------

test('final review, Minor 3: a resource already tagged with its own workload id is accepted, and its tag left as it was', async () => {
  const s = setup();
  const workloadId = workloadIdOf(ARN.instance('i-0bbb'));
  s.a.customer.instance('i-0bbb', { tags: { [WORKLOAD]: workloadId } });
  const preview = await s.onboarding.preview({ resourceArn: ARN.instance('i-0bbb') });
  assert.deepEqual([preview.ok, preview.problems], [true, []]);
  const done = await s.onboarding.onboard({ resourceArn: ARN.instance('i-0bbb') });
  assert.equal(done.steps[0].status, 'skipped');
});

test('final review, Minor 4: another onboarding that tags the same resource at once: undone, naming that workload, its tag kept', async () => {
  const s = setup();
  s.a.customer.instance('i-0aaa');
  await s.a.store.putConfig('shop', { workloadId: 'shop', name: 'Shop', appTargetGroupArn: 'tg', source: 'manager' });
  const create = s.a.ec2.createTags;
  // The other onboarding's tag lands just after ours.
  s.a.ec2.createTags = async (input) => {
    await create(input);
    s.a.state.instances.get('i-0aaa').tags[WORKLOAD] = 'shop';
  };
  const workloadId = workloadIdOf(ARN.instance('i-0aaa'));
  await assert.rejects(s.onboarding.onboard({ resourceArn: ARN.instance('i-0aaa') }), { message: `cannot onboard ${workloadId}: instance i-0aaa belongs to workload Shop (shop) (undone)` });
  assert.equal(s.a.state.instances.get('i-0aaa').tags[WORKLOAD], 'shop');
  assert.equal(await s.a.store.getConfig(workloadId), null);
});

test('final review, Minor 5: offboarding reads no target group', async () => {
  const s = setup();
  s.a.customer.instance('i-0aaa');
  s.a.customer.targetGroup('other', { targets: [{ Id: 'i-0fff' }] });
  const { workload } = await s.onboarding.onboard({ resourceArn: ARN.instance('i-0aaa') });
  const before = s.elb().length;
  await s.onboarding.offboard({ workloadId: workload.workloadId });
  assert.equal(s.elb().length, before);
  assert.deepEqual(s.a.state.instances.get('i-0aaa').tags, {});
});
