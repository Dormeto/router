import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRules } from '../src/lib/rules.mjs';
import { fakeElbv2, testConfig } from './fakes.mjs';

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
