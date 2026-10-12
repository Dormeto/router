import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentTarget, setRoute, withWeights } from '../src/lib/route.mjs';

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

function fakeElbv2(actions) {
  const state = { actions, modified: [] };
  return {
    state,
    async describeRules({ RuleArns }) { return { Rules: RuleArns[0] === 'rule' ? [{ RuleArn: 'rule', Actions: structuredClone(state.actions) }] : [] }; },
    async modifyRule(input) { state.modified.push(input); state.actions = input.Actions; return {}; },
  };
}

test('setRoute flips the weights once and is idempotent', async () => {
  const elbv2 = fakeElbv2([forward(1, 0)]);
  assert.equal(await setRoute(elbv2, cfg, 'waker'), true);
  assert.equal(currentTarget(elbv2.state.actions, cfg), 'waker');
  assert.equal(elbv2.state.modified[0].RuleArn, 'rule');
  assert.equal(await setRoute(elbv2, cfg, 'waker'), false);
  assert.equal(elbv2.state.modified.length, 1);
  assert.equal(await setRoute(elbv2, cfg, 'app'), true);
  assert.equal(currentTarget(elbv2.state.actions, cfg), 'app');
});

test('setRoute fails on a missing rule or an unknown target', async () => {
  await assert.rejects(setRoute(fakeElbv2([forward(1, 0)]), { ...cfg, ruleArn: 'other' }, 'app'), /rule not found/);
  await assert.rejects(setRoute(fakeElbv2([forward(1, 0)]), cfg, 'nowhere'), /invalid target/);
});
