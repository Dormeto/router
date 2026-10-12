// A crowded account-region (scale design §6): `workloads` workloads spread over `balancers` load balancers, one HTTPS
// listener each, one instrumented rule and one instance per workload. Every AWS call is counted and takes `latencyMs` of
// simulated time (sim-clock); the store answers at once.
import { matches, STATES } from '../src/lib/state.mjs';
import { testConfig } from './fakes.mjs';

const REGION = 'eu-west-3';
const ACCOUNT = '111122223333';
const hex = (n) => n.toString(16).padStart(16, '0');
const elb = (kind) => `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:${kind}`;

export function crowdedAccount({ workloads = 1500, balancers = 300, latencyMs = 100, clock, lastRequest = () => null }) {
  const calls = {};
  const listings = {}; // load balancer → DescribeListeners calls
  const metricReads = {}; // workload → GetMetricData calls
  const call = async (api, value) => {
    calls[api] = (calls[api] ?? 0) + 1;
    await clock.sleep(latencyMs);
    return value;
  };
  const ids = Array.from({ length: workloads }, (_, i) => `w${String(i).padStart(4, '0')}`);
  const index = new Map(ids.map((id, i) => [id, i]));
  const lbOf = (i) => i % balancers;
  const lbArn = (b) => elb(`loadbalancer/app/lb${b}/${hex(b)}`);
  const listenerArn = (b) => elb(`listener/app/lb${b}/${hex(b)}/${hex(b + 1)}`);
  const tgArn = (i) => elb(`targetgroup/w${i}/${hex(i)}`);
  const wakerArn = (i) => elb(`targetgroup/w${i}-waker/${hex(i)}`);
  const ruleArn = (i) => elb(`listener-rule/app/lb${lbOf(i)}/${hex(lbOf(i))}/${hex(lbOf(i) + 1)}/${hex(i)}`);
  const instance = (i) => `i-${hex(i + 1).slice(-17)}`;
  const configs = ids.map((workloadId, i) => testConfig({
    workloadId, ruleArn: ruleArn(i), appTargetGroupArn: tgArn(i), wakerTargetGroupArn: wakerArn(i), instanceIds: undefined, idleMinutes: 30,
    loadBalancerDimension: `app/lb${lbOf(i)}/${hex(lbOf(i))}`, appTargetGroupDimension: `targetgroup/w${i}/${hex(i)}`,
  }));
  const rules = new Map(ids.map((workloadId, i) => [ruleArn(i), {
    RuleArn: ruleArn(i), Priority: String(i + 1), IsDefault: false,
    Conditions: [{ Field: 'host-header', HostHeaderConfig: { Values: [`${workloadId}.example.com`] } }],
    Actions: [{ Type: 'forward', ForwardConfig: { TargetGroups: [{ TargetGroupArn: tgArn(i), Weight: 1 }, { TargetGroupArn: wakerArn(i), Weight: 0 }] } }],
  }]));
  const runs = new Map(ids.map((id) => [id, { state: STATES.AWAKE, awakeSince: clock.now() - 6 * 3_600_000, updatedAt: clock.now() - 3_600_000, version: 1 }]));
  const check = {};
  const naps = [];

  const store = {
    async listConfigs() { return structuredClone(configs); },
    async getConfig(id) { return structuredClone(configs[index.get(id)] ?? null); },
    async getRun(id) { return structuredClone(runs.get(id) ?? null); },
    async transition(id, { cond, set = {}, remove = [], increment = [] }) {
      const run = runs.get(id);
      if (!run || !matches(run, cond)) return null;
      Object.assign(run, set);
      for (const name of remove) delete run[name];
      for (const name of increment) run[name] = (run[name] ?? 0) + 1;
      run.version += 1;
      run.updatedAt = clock.now();
      return structuredClone(run);
    },
    async recordScheduledCheck(at) { check.lastScheduledCheckAt = at; },
    async getCheck() { return structuredClone(check); },
    async acquireCheckLease(holder, until, now) {
      if (check.leaseHolder && check.leaseUntil > now) return false;
      Object.assign(check, { leaseHolder: holder, leaseUntil: until });
      return true;
    },
    async releaseCheckLease(holder) {
      if (check.leaseHolder === holder) {
        delete check.leaseHolder;
        delete check.leaseUntil;
      }
    },
    async setCheckCursor(cursor) {
      if (cursor) check.cursor = cursor;
      else delete check.cursor;
    },
    async listPauses() { return []; },
    async getPauses() { return []; },
    async listDrift() { return []; },
    async getStats() { return null; },
    async getHealth() { return null; },
    async putHealth() {},
    async count() {},
  };

  const elbv2 = {
    describeTargetGroups: ({ TargetGroupArns }) => call('describeTargetGroups', {
      TargetGroups: TargetGroupArns.map((arn) => ({ TargetGroupArn: arn, LoadBalancerArns: [lbArn(lbOf(Number.parseInt(arn.split('/').at(-1), 16)))] })),
    }),
    describeListeners: ({ LoadBalancerArn }) => {
      listings[LoadBalancerArn] = (listings[LoadBalancerArn] ?? 0) + 1;
      const b = Number.parseInt(LoadBalancerArn.split('/').at(-1), 16);
      return call('describeListeners', { Listeners: [{ ListenerArn: listenerArn(b), Port: 443, Protocol: 'HTTPS', LoadBalancerArn }] });
    },
    describeRules: ({ ListenerArn }) => {
      const b = Number.parseInt(ListenerArn.split('/').at(-2), 16);
      return call('describeRules', { Rules: ids.map((_, i) => i).filter((i) => lbOf(i) === b).map((i) => structuredClone(rules.get(ruleArn(i)))) });
    },
    describeTags: ({ ResourceArns }) => call('describeTags', {
      TagDescriptions: ResourceArns.map((arn) => ({ ResourceArn: arn, Tags: [{ Key: 'dormeto:workload', Value: ids[Number.parseInt(arn.split('/').at(-1), 16)] }] })),
    }),
    describeTargetHealth: ({ TargetGroupArn }) => call('describeTargetHealth', {
      TargetHealthDescriptions: [{ Target: { Id: instance(Number.parseInt(TargetGroupArn.split('/').at(-1), 16)) }, TargetHealth: { State: 'healthy' } }],
    }),
    modifyRule: ({ RuleArn, Actions }) => {
      rules.get(RuleArn).Actions = structuredClone(Actions);
      return call('modifyRule', {});
    },
  };
  const instanceIndex = (id) => Number.parseInt(id.slice(2), 16) - 1;
  const ec2 = {
    describeInstances: ({ InstanceIds }) => call('describeInstances', {
      Reservations: [{ Instances: InstanceIds.map((id) => ({ InstanceId: id, State: { Name: 'running' }, Tags: [{ Key: 'dormeto:workload', Value: ids[instanceIndex(id)] }] })) }],
    }),
  };
  const autoscaling = { describeAutoScalingGroups: () => call('describeAutoScalingGroups', { AutoScalingGroups: [] }) };
  const tagging = { getResources: () => call('getResources', { ResourceTagMappingList: [] }) };
  const ecs = { describeServices: () => call('describeServices', { services: [] }) };
  const appscaling = { describeScalableTargets: () => call('describeScalableTargets', { ScalableTargets: [] }) };
  const rds = {};
  // Request metric of each workload: one request at lastRequest(workloadId, now) (null: none in the window).
  const cloudwatch = {
    getMetricData: (input) => {
      const dims = input.MetricDataQueries[0].MetricStat.Metric.Dimensions;
      const workloadId = ids[Number.parseInt(dims.find((d) => d.Name === 'TargetGroup').Value.split('/').at(-1), 16)];
      metricReads[workloadId] = (metricReads[workloadId] ?? 0) + 1;
      const at = lastRequest(workloadId, clock.now());
      const inWindow = at !== null && at >= input.StartTime.getTime() && at < input.EndTime.getTime();
      return call('getMetricData', { MetricDataResults: [{ Id: 'requests', Timestamps: inWindow ? [new Date(at - (at % 60_000))] : [], Values: inWindow ? [1] : [] }] });
    },
  };
  return {
    ids, configs, runs, rules, check, naps, calls, listings, metricReads,
    clients: { store, elbv2, ec2, autoscaling, tagging, ecs, appscaling, rds, cloudwatch },
    invokeSelf: async (event) => { naps.push(event.workloadId); },
  };
}
