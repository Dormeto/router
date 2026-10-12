import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentTarget, describeRulesOf, routeOf, rulesOf, setRoute, withWeights } from '../src/lib/route.mjs';

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
  assert.deepEqual(await setRoute(elbv2, cfg, 'waker'), ['rule']);
  assert.equal(currentTarget(elbv2.state.actions, cfg), 'waker');
  assert.equal(elbv2.state.modified[0].RuleArn, 'rule');
  assert.deepEqual(await setRoute(elbv2, cfg, 'waker'), []);
  assert.equal(elbv2.state.modified.length, 1);
  assert.deepEqual(await setRoute(elbv2, cfg, 'app'), ['rule']);
  assert.equal(currentTarget(elbv2.state.actions, cfg), 'app');
});

test('setRoute fails on a missing rule or an unknown target', async () => {
  await assert.rejects(setRoute(fakeElbv2([forward(1, 0)]), { ...cfg, ruleArn: 'other' }, 'app'), /rule not found/);
  await assert.rejects(setRoute(fakeElbv2([forward(1, 0)]), cfg, 'nowhere'), /invalid target/);
});

// --- Several rules per workload -------------------------------------------------------------------------------------

const multi = { ruleArns: ['r1', 'r2'], appTargetGroupArn: 'app-tg', wakerTargetGroupArn: 'waker-tg' };

function fakeRules(byArn) {
  const state = { rules: new Map(Object.entries(byArn)), modified: [], describeCalls: 0 };
  return {
    state,
    async describeRules({ RuleArns }) {
      state.describeCalls += 1;
      // Like ELBv2: one unknown rule fails the whole call.
      if (RuleArns.some((a) => !state.rules.has(a))) throw Object.assign(new Error('One or more rules not found'), { name: 'RuleNotFoundException' });
      return { Rules: RuleArns.map((a) => ({ RuleArn: a, Actions: structuredClone(state.rules.get(a)) })) };
    },
    async modifyRule({ RuleArn, Actions }) {
      state.modified.push(RuleArn);
      state.rules.set(RuleArn, Actions);
      return {};
    },
  };
}

test('rulesOf reads ruleArns, else the single ruleArn of older configurations', () => {
  assert.deepEqual(rulesOf(multi), ['r1', 'r2']);
  assert.deepEqual(rulesOf(cfg), ['rule']);
  assert.deepEqual(rulesOf({ ruleArns: [], ruleArn: 'rule' }), ['rule']);
});

test('routeOf aggregates the rules: app, waker, mixed, unknown when a rule is missing', () => {
  const rule = (arn, actions) => ({ RuleArn: arn, Actions: actions });
  assert.equal(routeOf([rule('r1', [forward(1, 0)]), rule('r2', [forward(1, 0)])], multi), 'app');
  assert.equal(routeOf([rule('r1', [forward(0, 1)]), rule('r2', [forward(0, 1)])], multi), 'waker');
  assert.equal(routeOf([rule('r1', [forward(0, 1)]), rule('r2', [forward(1, 0)])], multi), 'mixed');
  assert.equal(routeOf([rule('r1', [forward(0, 1)])], multi), 'unknown');
  assert.equal(routeOf([rule('r1', [forward(0, 1)]), rule('r2', [oidc])], multi), 'unknown');
});

test('setRoute switches every rule with one DescribeRules call, and only the rules that differ', async () => {
  const elbv2 = fakeRules({ r1: [forward(1, 0)], r2: [forward(0, 1)] });
  assert.deepEqual(await setRoute(elbv2, multi, 'waker'), ['r1']);
  assert.equal(elbv2.state.describeCalls, 1);
  assert.deepEqual(await setRoute(elbv2, multi, 'app'), ['r1', 'r2']);
  assert.equal(currentTarget(elbv2.state.rules.get('r2'), multi), 'app');
  assert.deepEqual(await setRoute(elbv2, multi, 'app'), []);
});

test('setRoute to the waker changes nothing when one rule of the workload is missing', async () => {
  const elbv2 = fakeRules({ r1: [forward(1, 0)] });
  await assert.rejects(setRoute(elbv2, multi, 'waker'), /rule not found: r2/);
  assert.deepEqual(elbv2.state.modified, []);
});

test('setRoute to the application switches the rules that remain and reports the missing one', async () => {
  const elbv2 = fakeRules({ r1: [forward(0, 1)] });
  const missing = [];
  assert.deepEqual(await setRoute(elbv2, multi, 'app', { onMissing: (arns) => missing.push(...arns) }), ['r1']);
  assert.deepEqual(missing, ['r2']);
  assert.equal(currentTarget(elbv2.state.rules.get('r1'), multi), 'app');
});

test('describeRulesOf falls back to one call per rule when one is missing, and rethrows other errors', async () => {
  const elbv2 = fakeRules({ r1: [forward(1, 0)] });
  const { rules, missing } = await describeRulesOf(elbv2, ['r1', 'r2']);
  assert.deepEqual([rules.map((r) => r.RuleArn), missing], [['r1'], ['r2']]);
  const broken = { async describeRules() { throw Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' }); } };
  await assert.rejects(describeRulesOf(broken, ['r1']), /Rate exceeded/);
});
