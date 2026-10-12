import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverCandidates } from '../src/lib/candidates.mjs';

const P = 'arn:aws:elasticloadbalancing:eu-west-1:111122223333';
const LB = `${P}:loadbalancer/app/web/abc`;
const L443 = `${P}:listener/app/web/abc/l443`;
const L80 = `${P}:listener/app/web/abc/l80`;
const tg = (name, type = 'instance') => ({ TargetGroupArn: `${P}:targetgroup/${name}/1`, TargetGroupName: name, TargetType: type });
const TGS = {
  shop: tg('shop'), api: tg('api', 'ip'), batch: tg('batch'), fn: tg('fn', 'lambda'), shared: tg('shared'), orphan: tg('orphan', 'ip'),
  empty: tg('empty'), demo: tg('demo-app'), waker: tg('dmt-dev-demo', 'lambda'), green: tg('green'), blue: tg('blue'),
};
const forward = (...groups) => [{ Type: 'forward', Order: 1, ForwardConfig: { TargetGroups: groups.map(([g, w]) => ({ TargetGroupArn: TGS[g].TargetGroupArn, Weight: w })) } }];
const host = (h) => [{ Field: 'host-header', HostHeaderConfig: { Values: [h] } }];
const RULES = {
  [L80]: [{ RuleArn: 'r80', Priority: 'default', IsDefault: true, Conditions: [], Actions: [{ Type: 'redirect', Order: 1 }] }],
  [L443]: [
    { RuleArn: 'r-demo', Priority: '10', Conditions: host('dev.example.com'), Actions: forward(['demo', 1], ['waker', 0]) },
    { RuleArn: 'r-admin', Priority: '5', Conditions: host('dev.example.com'), Actions: forward(['waker', 1]) },
    { RuleArn: 'r-shop', Priority: '20', Conditions: host('shop.example.com'), Actions: [{ Type: 'forward', Order: 1, TargetGroupArn: TGS.shop.TargetGroupArn }] },
    { RuleArn: 'r-api', Priority: '30', Conditions: [{ Field: 'path-pattern', PathPatternConfig: { Values: ['/api/*'] } }], Actions: forward(['api', 1]) },
    { RuleArn: 'r-batch', Priority: '40', Conditions: host('batch.example.com'), Actions: forward(['batch', 1]) },
    { RuleArn: 'r-canary', Priority: '50', Conditions: host('canary.example.com'), Actions: forward(['shop', 0], ['green', 1], ['blue', 1]) },
    { RuleArn: 'r-fn', Priority: '60', Conditions: host('fn.example.com'), Actions: forward(['fn', 1]) },
    { RuleArn: 'r-shared-1', Priority: '70', Conditions: host('a.example.com'), Actions: forward(['shared', 1]) },
    { RuleArn: 'r-shared-2', Priority: '71', Conditions: host('b.example.com'), Actions: forward(['shared', 1]) },
    { RuleArn: 'r-orphan', Priority: '80', Conditions: host('orphan.example.com'), Actions: forward(['orphan', 1]) },
    { RuleArn: 'r-empty', Priority: '90', Conditions: host('empty.example.com'), Actions: forward(['empty', 1]) },
    { RuleArn: 'r-fixed', Priority: '95', Conditions: host('down.example.com'), Actions: [{ Type: 'fixed-response', Order: 1 }] },
    { RuleArn: 'r-default', Priority: 'default', IsDefault: true, Conditions: [], Actions: [{ Type: 'fixed-response', Order: 1 }] },
  ],
};
const TAGS = { 'r-demo': { 'dormeto:workload': 'demo' }, 'r-admin': { 'dormeto:workload': 'demo', 'dormeto:role': 'admin' } };
const TARGETS = {
  shop: ['i-shop'], api: ['10.0.1.5'], batch: [], shared: ['i-s'], orphan: ['10.0.9.9'], empty: [], demo: ['i-demo'], green: ['i-g'], blue: ['i-b'],
};

function clients({ hourly = {} } = {}) {
  const calls = { metricQueries: 0 };
  const page = (items, key, input, size = 5) => {
    const start = Number(input?.Marker ?? 0);
    const next = start + size < items.length ? String(start + size) : undefined;
    return { [key]: items.slice(start, start + size), NextMarker: next };
  };
  return {
    calls,
    elbv2: {
      async describeLoadBalancers(input) { return page([{ LoadBalancerArn: LB, LoadBalancerName: 'web', Type: 'application' }, { LoadBalancerArn: `${P}:loadbalancer/net/nlb/x`, LoadBalancerName: 'nlb', Type: 'network' }], 'LoadBalancers', input); },
      async describeListeners({ LoadBalancerArn }) { return { Listeners: LoadBalancerArn === LB ? [{ ListenerArn: L80, Port: 80, Protocol: 'HTTP' }, { ListenerArn: L443, Port: 443, Protocol: 'HTTPS' }] : [] }; },
      async describeRules(input) { return page(RULES[input.ListenerArn], 'Rules', input); },
      async describeTags({ ResourceArns }) {
        assert.ok(ResourceArns.length <= 20);
        return { TagDescriptions: ResourceArns.map((a) => ({ ResourceArn: a, Tags: Object.entries(TAGS[a] ?? {}).map(([Key, Value]) => ({ Key, Value })) })) };
      },
      async describeTargetGroups(input) { return page(Object.values(TGS), 'TargetGroups', input); },
      async describeTargetHealth({ TargetGroupArn }) {
        const name = Object.keys(TGS).find((k) => TGS[k].TargetGroupArn === TargetGroupArn);
        return { TargetHealthDescriptions: (TARGETS[name] ?? []).map((Id) => ({ Target: { Id }, TargetHealth: { State: 'healthy' } })) };
      },
    },
    autoscaling: {
      async describeAutoScalingGroups() {
        return { AutoScalingGroups: [{ AutoScalingGroupName: 'batch-asg', TargetGroupARNs: [TGS.batch.TargetGroupArn], DesiredCapacity: 0 }] };
      },
    },
    ecs: {
      async listClusters() { return { clusterArns: ['arn:aws:ecs:eu-west-1:111122223333:cluster/main'] }; },
      async listServices() { return { serviceArns: ['arn:aws:ecs:eu-west-1:111122223333:service/main/api'] }; },
      async describeServices({ services }) {
        return { services: services.map((s) => ({ serviceArn: s, loadBalancers: [{ targetGroupArn: TGS.api.TargetGroupArn }] })) };
      },
    },
    cloudwatch: {
      async getMetricData({ MetricDataQueries, StartTime, EndTime }) {
        calls.metricQueries += MetricDataQueries.length;
        assert.equal((EndTime - StartTime) / 3_600_000, 168);
        return {
          MetricDataResults: MetricDataQueries.map((q) => {
            const dim = q.MetricStat.Metric.Dimensions.find((d) => d.Name === 'TargetGroup').Value;
            return { Id: q.Id, Values: hourly[dim] ?? [] };
          }),
        };
      },
    },
  };
}

const byRule = (result) => Object.fromEntries(result.candidates.map((c) => [c.ruleArn, c]));

test('discovery lists every rule of the application load balancers with its status', async () => {
  const result = await discoverCandidates(clients(), { now: () => Date.UTC(2026, 9, 4, 12, 30) });
  const rules = byRule(result);
  assert.ok(!('r-admin' in rules), 'admin rules are skipped');
  assert.equal(result.candidates.length, 13);
  assert.deepEqual([rules['r-demo'].status, rules['r-demo'].workloadId], ['managed', 'demo']);
  assert.deepEqual([rules['r-shop'].status, rules['r-shop'].backend], ['eligible', { kind: 'instance', id: 'i-shop' }]);
  assert.deepEqual([rules['r-api'].status, rules['r-api'].backend], ['eligible', { kind: 'ecs', id: 'arn:aws:ecs:eu-west-1:111122223333:service/main/api' }]);
  assert.deepEqual([rules['r-batch'].status, rules['r-batch'].backend], ['eligible', { kind: 'asg', id: 'batch-asg' }], 'a group scaled to zero is eligible');
  const reasons = Object.fromEntries(result.candidates.filter((c) => c.status === 'ineligible').map((c) => [c.ruleArn, c.reason]));
  assert.deepEqual(reasons, {
    r80: 'redirect action',
    'r-canary': 'weighted forward to several target groups',
    'r-fn': 'Lambda target group',
    'r-shared-1': 'target group shared by 2 rules',
    'r-shared-2': 'target group shared by 2 rules',
    'r-orphan': 'IP targets without an ECS service',
    'r-empty': 'no backend: no registered target, Auto Scaling group or ECS service',
    'r-fixed': 'fixed response',
    'r-default': 'fixed response',
  });
});

test('each candidate describes its listener, conditions, target group and suggested workload id', async () => {
  const rules = byRule(await discoverCandidates(clients(), { now: () => Date.UTC(2026, 9, 4, 12, 30) }));
  assert.deepEqual(
    (({ loadBalancer, listener, priority, conditions, targetGroup, suggestedId }) => ({ loadBalancer, listener, priority, conditions, targetGroup, suggestedId }))(rules['r-shop']),
    { loadBalancer: 'web', listener: 'HTTPS:443', priority: '20', conditions: 'host shop.example.com', targetGroup: 'shop', suggestedId: 'shop' },
  );
  assert.equal(rules['r-api'].conditions, 'path /api/*');
  assert.equal(rules['r-default'].conditions, 'default');
});

test('idle hours count the hours without any request over the last 7 days', async () => {
  const hourly = { 'targetgroup/shop/1': [5, 0, 3], 'targetgroup/demo-app/1': [] };
  const c = clients({ hourly });
  const rules = byRule(await discoverCandidates(c, { now: () => Date.UTC(2026, 9, 4, 12, 30) }));
  assert.deepEqual([rules['r-shop'].idleHours7d, rules['r-shop'].requests7d], [166, 8]);
  assert.deepEqual([rules['r-demo'].idleHours7d, rules['r-demo'].requests7d], [168, 0]);
  assert.equal(rules['r-fn'].idleHours7d, null, 'no idle hours for ineligible candidates');
  assert.equal(c.calls.metricQueries, 4, 'one query per eligible or managed target group');
});

test('a sleeping managed workload reports its application target group, not the waker', async () => {
  const sleeping = RULES[L443][0];
  const awake = sleeping.Actions;
  sleeping.Actions = forward(['demo', 0], ['waker', 1]);
  try {
    const rules = byRule(await discoverCandidates(clients(), { now: () => Date.UTC(2026, 9, 4, 12, 30) }));
    assert.equal(rules['r-demo'].targetGroup, 'demo-app');
  } finally {
    sleeping.Actions = awake;
  }
});
