import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentTarget, routeOf, setRoute, withWeights } from '../src/lib/route.mjs';
import { fakeElbv2, routeOf as routeOfFake, testConfig } from './fakes.mjs';

const cfg = { ruleArn: 'rule', appTargetGroupArn: 'app-tg', wakerTargetGroupArn: 'waker-tg' };

const forward = (app, waker) => ({
  Type: 'forward',
  Order: 2,
  TargetGroupArn: 'app-tg',
  ForwardConfig: {
    TargetGroups: [{ TargetGroupArn: 'app-tg', Weight: app }, { TargetGroupArn: 'waker-tg', Weight: waker }],
    TargetGroupStickinessConfig: { Enabled: true, DurationSeconds: 300 },
  },
});
const oidc = { Type: 'authenticate-oidc', Order: 1, AuthenticateOidcConfig: { Issuer: 'https://idp', ClientId: 'c' } };

test('withWeights changes only the managed weights and keeps other actions', () => {
  const actions = [oidc, forward(1, 0)];
  const next = withWeights(actions, { 'app-tg': 0, 'waker-tg': 1 });
  assert.deepEqual(next[1].ForwardConfig.TargetGroups, [{ TargetGroupArn: 'app-tg', Weight: 0 }, { TargetGroupArn: 'waker-tg', Weight: 1 }]);
  assert.deepEqual(next[1].ForwardConfig.TargetGroupStickinessConfig, { Enabled: true, DurationSeconds: 300 });
  assert.equal(next[1].Order, 2);
  assert.equal('TargetGroupArn' in next[1], false);
  assert.equal(next[0].AuthenticateOidcConfig.UseExistingClientSecret, true);
  assert.equal(actions[1].ForwardConfig.TargetGroups[0].Weight, 1, 'input is not mutated');
});

test('withWeights rejects rules without a managed forward action', () => {
  assert.throws(() => withWeights([oidc], { 'app-tg': 1 }), /no forward action/);
});

test('currentTarget reads the weights', () => {
  assert.equal(currentTarget([forward(1, 0)], cfg), 'app');
  assert.equal(currentTarget([forward(0, 1)], cfg), 'waker');
  assert.equal(currentTarget([forward(1, 1)], cfg), 'mixed');
  assert.equal(currentTarget([oidc], cfg), 'unknown');
});

const ruleOf = (arn, actions) => ({ RuleArn: arn, Actions: actions });

test('routeOf aggregates the instrumented rules: app, waker, mixed, unknown without any rule', () => {
  assert.equal(routeOf([ruleOf('r1', [forward(1, 0)]), ruleOf('r2', [forward(1, 0)])], cfg), 'app');
  assert.equal(routeOf([ruleOf('r1', [forward(0, 1)]), ruleOf('r2', [forward(0, 1)])], cfg), 'waker');
  assert.equal(routeOf([ruleOf('r1', [forward(0, 1)]), ruleOf('r2', [forward(1, 0)])], cfg), 'mixed');
  assert.equal(routeOf([], cfg), 'unknown');
  assert.equal(routeOf([ruleOf('r1', [forward(0, 1)]), ruleOf('r2', [oidc])], cfg), 'unknown');
});

// --- setRoute on the rules found from the target group ---------------------------------------------------------------

const multi = testConfig({ ruleArns: ['arn:rule/main', 'arn:rule/static'] });
const appOnly = (c) => [{ Type: 'forward', Order: 1, ForwardConfig: { TargetGroups: [{ TargetGroupArn: c.appTargetGroupArn, Weight: 1 }] } }];

test('setRoute switches every instrumented rule found from the target group, only those that differ', async () => {
  const elbv2 = fakeElbv2(multi);
  elbv2.state.rules.get('arn:rule/static').actions = elbv2.state.forward(0, 1);
  assert.deepEqual(await setRoute(elbv2, multi, 'waker'), ['arn:rule/main']);
  assert.equal(routeOfFake(elbv2, multi), 'waker');
  assert.deepEqual(await setRoute(elbv2, multi, 'app'), ['arn:rule/main', 'arn:rule/static']);
  assert.deepEqual(await setRoute(elbv2, multi, 'app'), []);
  await assert.rejects(setRoute(elbv2, multi, 'nowhere'), /invalid target/);
});

test('setRoute to the waker fails before any change when a rule forwarding to the target group cannot be switched', async () => {
  const elbv2 = fakeElbv2(multi);
  elbv2.state.rules.set('arn:rule/new', { actions: appOnly(multi), priority: '19', tags: {} });
  await assert.rejects(setRoute(elbv2, multi, 'waker'), /rule 19 forwards to the target group without the waker/);
  assert.equal(elbv2.state.modifyCount, 0);
});

test('setRoute to the application switches the instrumented rules and reports the issues', async () => {
  const elbv2 = fakeElbv2(multi, { target: 'waker' });
  elbv2.state.rules.set('arn:rule/new', { actions: appOnly(multi), priority: '19', tags: {} });
  const issues = [];
  assert.deepEqual(await setRoute(elbv2, multi, 'app', { onIssues: (found) => issues.push(...found.map((i) => i.reason)) }), ['arn:rule/main', 'arn:rule/static']);
  assert.deepEqual(issues, ['rule 19 forwards to the target group without the waker (not instrumented)']);
});
