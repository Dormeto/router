import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PLACEHOLDERS, blueprint, routerBoundary } from '../../install/blueprint.mjs';

const IAM_TF = new URL('../../terraform/modules/router/iam.tf', import.meta.url);

// Replace every ${key} in the string values, as the installer does.
const fill = (value, values) => (typeof value === 'string'
  ? value.replace(/\$\{(\w+)\}/g, (_, key) => values[key])
  : Array.isArray(value) ? value.map((v) => fill(v, values))
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, values)])) : value);

const VALUES = {
  name: 'dmtr-dev', region: 'eu-west-3', account: '121014831971', partition: 'aws', build: 'abc123def456',
  checkSchedule: 'rate(5 minutes)', ipLists: '[]', noWakeRules: '[]', metrics: 'false',
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
  assert.deepEqual(b.queues.map((q) => q.name), ['dmtr-dev-check-failures', 'dmtr-dev-controller-failures']);
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
  const resources = routerBoundary().Statement.filter((s) => s.Sid !== 'Workloads').flatMap((s) => [].concat(s.Resource));
  assert.ok(resources.length > 0);
  for (const r of resources) assert.match(r, /:(table\/|function:|log-group:\/aws\/lambda\/|)dmtr-/, r);
  const permissions = routerBoundary().Statement.find((s) => [].concat(s.Action).includes('lambda:RemovePermission'));
  assert.deepEqual([].concat(permissions.Resource), ['arn:${partition}:lambda:*:${account}:function:dmtr-*-waker']);
});

test('the blueprint routes drift events to the onboarder, ignoring the router\'s own calls', () => {
  const b = fill(blueprint({ version: '0.19.0' }), VALUES);
  assert.equal(b.eventRule.name, 'dmtr-dev-drift');
  assert.equal(b.eventRule.target, 'arn:aws:lambda:eu-west-3:121014831971:function:dmtr-dev-onboarder');
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
    function: 'dmtr-dev-waker', statementId: 'alb-waker', principal: 'elasticloadbalancing.amazonaws.com',
    sourceArn: 'arn:aws:elasticloadbalancing:eu-west-3:121014831971:targetgroup/dmtr-dev-*/*',
  });
  // Onboarding no longer adds one per workload; it still removes one left by an older router.
  const onboarder = blueprint({ version: 'x' }).roles.find((r) => r.key === 'onboarder').policy.Statement.flatMap((s) => [].concat(s.Action));
  assert.ok(!onboarder.includes('lambda:AddPermission'));
  assert.ok(onboarder.includes('lambda:RemovePermission'));
  assert.ok(!routerBoundary().Statement.flatMap((s) => [].concat(s.Action)).includes('lambda:AddPermission'));
});
