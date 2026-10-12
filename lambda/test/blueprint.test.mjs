import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PLACEHOLDERS, blueprint, routerBoundary } from '../../install/blueprint.mjs';
import { ROUTER_PERMISSION } from '../src/lib/onboarding.mjs';

const IAM_TF = new URL('../../terraform/modules/router/iam.tf', import.meta.url);

// Replace every ${key} in the string values, as the installer does.
const fill = (value, values) => (typeof value === 'string'
  ? value.replace(/\$\{(\w+)\}/g, (_, key) => values[key])
  : Array.isArray(value) ? value.map((v) => fill(v, values))
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, values)])) : value);

const VALUES = {
  name: 'dmtr-dev', region: 'eu-west-3', account: '121014831971', partition: 'aws', build: 'abc123def456',
  checkSchedule: 'rate(5 minutes)', ipLists: '[]', noWakeRules: '[]', metrics: 'false',
  managerBus: 'arn:aws:events:eu-west-1:121014831971:event-bus/dmt-dev-manager',
  commandRole: 'DmtCommandRole',
};

// Actions of each aws_iam_policy_document of the module, without its optional (dynamic) statements.
async function terraformActions() {
  const text = await readFile(IAM_TF, 'utf8');
  const out = {};
  for (const match of text.matchAll(/data "aws_iam_policy_document" "(\w+)" \{/g)) {
    let depth = 0;
    let end = match.index + match[0].length - 1;
    do {
      if (text[end] === '{') depth += 1;
      if (text[end] === '}') depth -= 1;
      end += 1;
    } while (depth > 0);
    let body = text.slice(match.index, end);
    for (let at = body.indexOf('dynamic "statement"'); at >= 0; at = body.indexOf('dynamic "statement"')) {
      let d = 0;
      let e = body.indexOf('{', at);
      do {
        if (body[e] === '{') d += 1;
        if (body[e] === '}') d -= 1;
        e += 1;
      } while (d > 0);
      body = body.slice(0, at) + body.slice(e);
    }
    out[match[1]] = [...body.matchAll(/actions\s*=\s*\[([^\]]*)\]/g)].flatMap((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((a) => a[1])).sort();
  }
  return out;
}

const actionsOf = (policy) => policy.Statement.flatMap((s) => [].concat(s.Action)).sort();

test('the blueprint names every resource after the router, with IAM roles per region, all tagged', () => {
  const b = fill(blueprint({ version: '0.18.0' }), VALUES);
  assert.deepEqual(b.router, { name: 'dmtr-dev', region: 'eu-west-3', account: '121014831971', version: '0.18.0', build: 'abc123def456' });
  assert.deepEqual(b.roles.map((r) => [r.path, r.name]), [
    ['/dormeto/router/', 'dmtr-dev-eu-west-3-controller'], ['/dormeto/router/', 'dmtr-dev-eu-west-3-waker'],
    ['/dormeto/router/', 'dmtr-dev-eu-west-3-scheduler'], ['/dormeto/router/', 'dmtr-dev-eu-west-3-onboarder'],
  ]);
  assert.deepEqual(b.functions.map((f) => [f.name, f.handler, f.roleArn]), [
    ['dmtr-dev-controller', 'controller.handler', 'arn:aws:iam::121014831971:role/dormeto/router/dmtr-dev-eu-west-3-controller'],
    ['dmtr-dev-waker', 'waker.handler', 'arn:aws:iam::121014831971:role/dormeto/router/dmtr-dev-eu-west-3-waker'],
    ['dmtr-dev-onboarder', 'onboarder.handler', 'arn:aws:iam::121014831971:role/dormeto/router/dmtr-dev-eu-west-3-onboarder'],
  ]);
  assert.equal(b.schedule.roleArn, 'arn:aws:iam::121014831971:role/dormeto/router/dmtr-dev-eu-west-3-scheduler');
  assert.equal(b.table.name, 'dmtr-dev-router');
  assert.deepEqual(b.queues.map((q) => q.name), ['dmtr-dev-check-failures', 'dmtr-dev-controller-failures', 'dmtr-dev-work', 'dmtr-dev-drift']);
  assert.deepEqual(b.logGroups.map((l) => l.name), ['/aws/lambda/dmtr-dev-controller', '/aws/lambda/dmtr-dev-waker', '/aws/lambda/dmtr-dev-onboarder']);
  assert.equal(b.schedule.target, 'arn:aws:lambda:eu-west-3:121014831971:function:dmtr-dev-controller');
  assert.deepEqual(b.tags, { 'dormeto:router': 'dmtr-dev' });
  const controller = b.functions[0].environment;
  assert.equal(controller.DMT_FAILURE_QUEUES, '{"check":"https://sqs.eu-west-3.amazonaws.com/121014831971/dmtr-dev-check-failures","controller":"https://sqs.eu-west-3.amazonaws.com/121014831971/dmtr-dev-controller-failures"}');
  assert.equal(b.functions[2].environment.DMT_WAKER_FUNCTION_ARN, 'arn:aws:lambda:eu-west-3:121014831971:function:dmtr-dev-waker');
});

test('the published blueprint has placeholders only, and filling them leaves none', () => {
  const text = JSON.stringify(blueprint({ version: '0.18.0' }));
  for (const placeholder of Object.values(PLACEHOLDERS)) assert.ok(text.includes(placeholder), placeholder);
  assert.ok(!JSON.stringify(fill(JSON.parse(text), VALUES)).includes('${'));
});

test('each router role has exactly the IAM actions of the Terraform module (optional statements aside)', async () => {
  const terraform = await terraformActions();
  const b = blueprint({ version: '0.18.0' });
  for (const role of b.roles) assert.deepEqual(actionsOf(role.policy), terraform[role.key], role.key);
});

test('every action of every router role is allowed by the permissions boundary', () => {
  const allowed = routerBoundary().Statement.flatMap((s) => [].concat(s.Action));
  const covers = (pattern, action) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(action);
  for (const role of blueprint({ version: '0.18.0' }).roles) {
    for (const action of actionsOf(role.policy)) assert.ok(allowed.some((p) => covers(p, action)), `${role.key}: ${action}`);
  }
  assert.ok(!allowed.some((a) => a.startsWith('iam:') || a.startsWith('organizations:') || a === '*'), 'no IAM, Organizations or wildcard');
});

test('the boundary covers the resources of installed routers only (dmtr-*), never a router written in Terraform or the manager', () => {
  // Workloads are the customer's resources; the manager's bus is the manager's.
  const resources = routerBoundary().Statement.filter((s) => s.Sid !== 'Workloads' && s.Sid !== 'ManagerBus').flatMap((s) => [].concat(s.Resource));
  assert.ok(resources.length > 0);
  for (const r of resources) assert.match(r, /:(table\/|function:|log-group:\/aws\/lambda\/|)dmtr-/, r);
  const permissions = routerBoundary().Statement.find((s) => [].concat(s.Action).includes('lambda:RemovePermission'));
  assert.deepEqual([].concat(permissions.Resource), ['arn:${partition}:lambda:*:${account}:function:dmtr-*-waker']);
});

test('the blueprint routes drift events to the onboarder\'s queue, ignoring the router\'s own calls', () => {
  const b = fill(blueprint({ version: '0.22.0' }), VALUES);
  assert.equal(b.eventRule.name, 'dmtr-dev-drift');
  assert.equal(b.eventRule.target, 'arn:aws:sqs:eu-west-3:121014831971:dmtr-dev-drift');
  const pattern = JSON.parse(b.eventRule.pattern);
  assert.deepEqual(pattern['detail-type'], ['AWS API Call via CloudTrail']);
  // Every caller has an ARN (IAM users and root have no session issuer); failed calls changed nothing.
  for (const branch of pattern.$or) {
    assert.deepEqual(branch.detail.userIdentity, { arn: [{ 'anything-but': { prefix: 'arn:aws:sts::121014831971:assumed-role/dmtr-dev-' } }] });
    assert.deepEqual(branch.detail.errorCode, [{ exists: false }]);
  }
  assert.equal(b.functions[0].environment.DMT_ONBOARDER, 'dmtr-dev-onboarder');
});

test('every tag key the onboarder writes is allowed by its tag condition, in the module and the blueprint', async () => {
  const code = await readFile(new URL('../src/lib/onboarding.mjs', import.meta.url), 'utf8');
  const written = [...new Set([...code.matchAll(/'(dormeto:[a-z]+)'/g)].map((m) => m[1]))].sort();
  assert.ok(written.includes('dormeto:shadows'), written.join(', '));
  const terraform = (await readFile(IAM_TF, 'utf8')).match(/onboarder_tag_keys = \[([^\]]*)\]/)[1].match(/"([^"]+)"/g).map((k) => k.slice(1, -1)).sort();
  const onboarder = blueprint({ version: 'x' }).roles.find((r) => r.key === 'onboarder').policy.Statement;
  const blueprintKeys = onboarder.find((s) => s.Condition?.['ForAllValues:StringEquals']).Condition['ForAllValues:StringEquals']['aws:TagKeys'].slice().sort();
  for (const key of written) {
    assert.ok(terraform.includes(key), `module: ${key}`);
    assert.ok(blueprintKeys.includes(key), `blueprint: ${key}`);
  }
});

test('one permission lets the load balancers invoke the waker from every waker target group of the router', () => {
  const b = fill(blueprint({ version: '0.20.0' }), VALUES);
  assert.deepEqual(b.wakerPermission, {
    // Outside the alb-<workload id> statements of routers before 0.20.0: no workload id can name it.
    function: 'dmtr-dev-waker', statementId: ROUTER_PERMISSION, principal: 'elasticloadbalancing.amazonaws.com',
    sourceArn: 'arn:aws:elasticloadbalancing:eu-west-3:121014831971:targetgroup/dmtr-dev-*/*',
  });
  // Onboarding no longer adds one per workload; it still removes one left by an older router.
  const onboarder = blueprint({ version: 'x' }).roles.find((r) => r.key === 'onboarder').policy.Statement.flatMap((s) => [].concat(s.Action));
  assert.ok(!onboarder.includes('lambda:AddPermission'));
  assert.ok(onboarder.includes('lambda:RemovePermission'));
  assert.ok(!routerBoundary().Statement.flatMap((s) => [].concat(s.Action)).includes('lambda:AddPermission'));
});

test('the router permission is named outside the per-workload statements, in the module and the blueprint', async () => {
  assert.equal(ROUTER_PERMISSION, 'dormeto-alb');
  const module = await readFile(new URL('../../terraform/modules/router/main.tf', import.meta.url), 'utf8');
  assert.match(module, /statement_id\s+= "dormeto-alb"/);
});

test('the controller and the waker publish to the manager\'s event bus, within the boundary', () => {
  const b = fill(blueprint({ version: '0.21.0' }), VALUES);
  for (const key of ['controller', 'waker']) {
    assert.equal(b.functions.find((f) => f.key === key).environment.DMT_MANAGER_BUS, VALUES.managerBus, key);
    const statement = b.roles.find((r) => r.key === key).policy.Statement.find((st) => [].concat(st.Action).includes('events:PutEvents'));
    assert.deepEqual([].concat(statement.Resource), [VALUES.managerBus], key);
  }
  const bus = routerBoundary().Statement.find((st) => [].concat(st.Action).includes('events:PutEvents'));
  assert.deepEqual([].concat(bus.Resource), ['arn:${partition}:events:*:*:event-bus/dmt-*-manager']);
  assert.ok(PLACEHOLDERS.managerBus);
});

test('naps and router-pause wakes go to a queue the controller reads 10 at a time; drift events to one the onboarder reads in 60 s batches, 2 at a time', async () => {
  const b = fill(blueprint({ version: '0.22.0' }), VALUES);
  const sqs = (name) => `arn:aws:sqs:eu-west-3:121014831971:${name}`;
  const queue = (key) => b.queues.find((q) => q.key === key);
  const failures = { queue: sqs('dmtr-dev-controller-failures'), maxReceiveCount: 3 };
  // Kept 4 days: the wakes of a router pause wait their turn however many there are.
  assert.deepEqual(queue('work'), { key: 'work', name: 'dmtr-dev-work', retentionSeconds: 345_600, managedEncryption: true, visibilityTimeoutSeconds: 960, deadLetter: failures });
  const drift = queue('drift');
  assert.deepEqual({ ...drift, policy: undefined }, { key: 'drift', name: 'dmtr-dev-drift', retentionSeconds: 86_400, managedEncryption: true, visibilityTimeoutSeconds: 360, deadLetter: failures, policy: undefined });
  // Only the router's drift rule sends to the drift queue.
  assert.deepEqual(drift.policy.Statement, [{
    Effect: 'Allow', Principal: { Service: 'events.amazonaws.com' }, Action: 'sqs:SendMessage', Resource: sqs('dmtr-dev-drift'),
    Condition: { ArnEquals: { 'aws:SourceArn': 'arn:aws:events:eu-west-3:121014831971:rule/dmtr-dev-drift' } },
  }]);
  assert.deepEqual(b.eventSourceMappings, [
    { key: 'work', function: 'dmtr-dev-controller', queue: sqs('dmtr-dev-work'), batchSize: 1, maximumBatchingWindowSeconds: 0, maximumConcurrency: 10, reportBatchItemFailures: true },
    { key: 'drift', function: 'dmtr-dev-onboarder', queue: sqs('dmtr-dev-drift'), batchSize: 100, maximumBatchingWindowSeconds: 60, maximumConcurrency: 2, reportBatchItemFailures: true },
  ]);
  const module = await readFile(new URL('../../terraform/modules/router/main.tf', import.meta.url), 'utf8');
  assert.match(module.match(/resource "aws_sqs_queue" "work" \{[\s\S]*?\n\}/)[0], /message_retention_seconds\s+=\s+345600/);
  assert.equal(b.functions.find((f) => f.key === 'controller').environment.DMT_WORK_QUEUE, 'https://sqs.eu-west-3.amazonaws.com/121014831971/dmtr-dev-work');
  const statements = (role) => b.roles.find((r) => r.key === role).policy.Statement;
  const allows = (role, action, resource) => statements(role).some((st) => [].concat(st.Action).includes(action) && [].concat(st.Resource).includes(resource));
  assert.ok(allows('controller', 'sqs:SendMessage', sqs('dmtr-dev-work')));
  // The idle check's repair requests go to the drift queue, read with the drift events.
  assert.equal(b.functions.find((f) => f.key === 'controller').environment.DMT_DRIFT_QUEUE, 'https://sqs.eu-west-3.amazonaws.com/121014831971/dmtr-dev-drift');
  assert.ok(allows('controller', 'sqs:SendMessage', sqs('dmtr-dev-drift')));
  assert.match(module, /DMT_DRIFT_QUEUE\s+=\s+aws_sqs_queue\.drift\.url/);
  assert.match(await readFile(IAM_TF, 'utf8'), /actions\s+=\s+\["sqs:SendMessage"\]\s+resources\s+=\s+\[aws_sqs_queue\.controller_failures\.arn, aws_sqs_queue\.work\.arn, aws_sqs_queue\.drift\.arn\]/);
  for (const [role, key] of [['controller', 'work'], ['onboarder', 'drift']]) {
    for (const action of ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes', 'sqs:ChangeMessageVisibility']) assert.ok(allows(role, action, sqs(`dmtr-dev-${key}`)), `${role} ${action} on ${key}`);
  }
});

test('the forwarder: a role of the account under the routers\' path, trusted by EventBridge of that account, sending to the manager\'s bus only; a rule per region to that bus', () => {
  const { role, rule } = fill(blueprint({ version: '0.23.0' }), VALUES).forwarder;
  assert.deepEqual([role.path, role.name], ['/dormeto/router/', 'dmtr-dev-forwarder']);
  assert.deepEqual(role.trust, { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'events.amazonaws.com' }, Action: 'sts:AssumeRole', Condition: { StringEquals: { 'aws:SourceAccount': '121014831971' } } }] });
  assert.deepEqual(role.policy.Statement, [{ Effect: 'Allow', Action: ['events:PutEvents'], Resource: [VALUES.managerBus] }]);
  assert.deepEqual(role.tags, { 'dormeto:router': 'dmtr-dev' });
  assert.equal(rule.name, 'dmtr-dev-discovery');
  assert.equal(rule.targetBus, VALUES.managerBus);
  assert.equal(rule.roleArn, 'arn:aws:iam::121014831971:role/dormeto/router/dmtr-dev-forwarder');
  // Within the boundary every role Dormeto creates carries.
  const allowed = routerBoundary().Statement.filter((st) => [].concat(st.Action).includes('events:PutEvents'));
  assert.deepEqual(allowed.map((st) => st.Resource), ['arn:${partition}:events:*:*:event-bus/dmt-*-manager']);
});

test('the forwarder\'s pattern: the ELB calls that change what discovery reads, never target registrations, failed calls nor Dormeto\'s own calls', () => {
  const pattern = JSON.parse(fill(blueprint({ version: '0.23.0' }), VALUES).forwarder.rule.pattern);
  assert.deepEqual(pattern.source, ['aws.elasticloadbalancing']);
  assert.deepEqual(pattern['detail-type'], ['AWS API Call via CloudTrail']);
  assert.deepEqual([...pattern.detail.eventName].sort(), [
    'AddTags', 'CreateListener', 'CreateLoadBalancer', 'CreateRule', 'CreateTargetGroup', 'DeleteListener', 'DeleteLoadBalancer',
    'DeleteRule', 'DeleteTargetGroup', 'ModifyListener', 'ModifyRule', 'ModifyTargetGroup', 'RemoveTags', 'SetRulePriorities',
  ]);
  // Auto Scaling and ECS register and deregister targets constantly.
  assert.ok(!pattern.detail.eventName.some((e) => /Targets$/.test(e)));
  assert.deepEqual(pattern.detail.errorCode, [{ exists: false }]);
  // Routers installed (dmtr-) or written in Terraform (dmt-), and the manager's operations through the command role.
  assert.deepEqual(pattern.detail.userIdentity, { arn: [{ 'anything-but': { prefix: [
    'arn:aws:sts::121014831971:assumed-role/dmtr-', 'arn:aws:sts::121014831971:assumed-role/dmt-', 'arn:aws:sts::121014831971:assumed-role/DmtCommandRole/',
  ] } }] });
});
