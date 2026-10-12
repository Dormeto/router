// A crowded account-region (scale design §6): `workloads` workloads spread over `balancers` load balancers, one HTTPS
// listener each, one instrumented rule and one instance per workload. Every AWS call is counted and takes `latencyMs` of
// simulated time (sim-clock); the store answers at once. elbBucket: the account's ELB token bucket ({ burst, rate, shared }:
// calls per second, `shared` of them taken by the customer's own tools), a call finding it empty is throttled. drifted:
// the first N workloads were onboarded by the manager and their rule lost the waker (a repair to request).
import { matches, STATES } from '../src/lib/state.mjs';
import { testConfig } from './fakes.mjs';

const REGION = 'eu-west-3';
const ACCOUNT = '111122223333';
const hex = (n) => n.toString(16).padStart(16, '0');
const elb = (kind) => `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:${kind}`;

export function crowdedAccount({ workloads = 1500, balancers = 300, latencyMs = 100, clock, lastRequest = () => null, elbBucket = null, drifted = 0 }) {
  const calls = {};
  const stats = { throttled: 0 };
  const bucket = elbBucket && { tokens: elbBucket.burst, at: clock.now() };
  // An ELB call takes a token from the bucket, refilled at the rate the customer's tools leave.
  const elbCall = async (api, value) => {
    calls[api] = (calls[api] ?? 0) + 1;
    await clock.sleep(latencyMs);
    if (bucket) {
      bucket.tokens = Math.min(elbBucket.burst, bucket.tokens + ((clock.now() - bucket.at) / 1000) * (elbBucket.rate - (elbBucket.shared ?? 0)));
      bucket.at = clock.now();
      if (bucket.tokens < 1) {
        stats.throttled += 1;
        throw Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });
      }
      bucket.tokens -= 1;
    }
    return value;
  };
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
    ...(i < drifted ? { source: 'manager' } : {}),
  }));
  const rules = new Map(ids.map((workloadId, i) => [ruleArn(i), {
    RuleArn: ruleArn(i), Priority: String(i + 1), IsDefault: false,
    Conditions: [{ Field: 'host-header', HostHeaderConfig: { Values: [`${workloadId}.example.com`] } }],
    Actions: [{ Type: 'forward', ForwardConfig: { TargetGroups: [{ TargetGroupArn: tgArn(i), Weight: 1 }, ...(i < drifted ? [] : [{ TargetGroupArn: wakerArn(i), Weight: 0 }])] } }],
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
    async setBackendKinds(id, kinds) {
      const run = runs.get(id);
      if (run) run.backendKinds = kinds;
      return Boolean(run);
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
    describeTargetGroups: ({ TargetGroupArns }) => elbCall('describeTargetGroups', {
      TargetGroups: TargetGroupArns.map((arn) => ({ TargetGroupArn: arn, LoadBalancerArns: [lbArn(lbOf(Number.parseInt(arn.split('/').at(-1), 16)))] })),
    }),
    describeListeners: ({ LoadBalancerArn }) => {
      listings[LoadBalancerArn] = (listings[LoadBalancerArn] ?? 0) + 1;
      const b = Number.parseInt(LoadBalancerArn.split('/').at(-1), 16);
      return elbCall('describeListeners', { Listeners: [{ ListenerArn: listenerArn(b), Port: 443, Protocol: 'HTTPS', LoadBalancerArn }] });
    },
    describeRules: ({ ListenerArn }) => {
      const b = Number.parseInt(ListenerArn.split('/').at(-2), 16);
      return elbCall('describeRules', { Rules: ids.map((_, i) => i).filter((i) => lbOf(i) === b).map((i) => structuredClone(rules.get(ruleArn(i)))) });
    },
    describeTags: ({ ResourceArns }) => elbCall('describeTags', {
      TagDescriptions: ResourceArns.map((arn) => ({ ResourceArn: arn, Tags: [{ Key: 'dormeto:workload', Value: ids[Number.parseInt(arn.split('/').at(-1), 16)] }] })),
    }),
    describeTargetHealth: ({ TargetGroupArn }) => elbCall('describeTargetHealth', {
      TargetHealthDescriptions: [{ Target: { Id: instance(Number.parseInt(TargetGroupArn.split('/').at(-1), 16)) }, TargetHealth: { State: 'healthy' } }],
    }),
    modifyRule: ({ RuleArn, Actions }) => {
      rules.get(RuleArn).Actions = structuredClone(Actions);
      return elbCall('modifyRule', {});
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
    ids, configs, runs, rules, check, naps, calls, listings, metricReads, stats,
    clients: { store, elbv2, ec2, autoscaling, tagging, ecs, appscaling, rds, cloudwatch },
    invokeSelf: async (event) => { naps.push(event.workloadId); },
  };
}

// The ELB adapter's SDK client (aws/elbv2.mjs: retryMode adaptive, maxAttempts 8), modelled on the AWS SDK for
// JavaScript v3's adaptive retry strategy (@smithy/util-retry): every attempt first takes a token from a client-side
// rate limiter that a throttle cuts to 70% of the measured rate and that grows back along a cubic curve; a throttled
// attempt waits a random share of 500 ms × 2^attempts (at most 20 s) and costs 5 of a 500-token retry quota, refunded on
// success. Times in seconds as in the SDK; a deterministic random keeps the simulation reproducible.
export function withSdkRetries(client, { now, sleep, maxAttempts = 8 }) {
  const stats = { retried: 0, failed: 0 };
  let seed = 1;
  const random = () => {
    seed = (seed * 48271) % 2147483647;
    return seed / 2147483647;
  };
  const seconds = () => now() / 1000;
  const limiter = {
    beta: 0.7, minCapacity: 1, minFillRate: 0.5, scaleConstant: 0.4, smooth: 0.8,
    currentCapacity: 0, enabled: false, lastMaxRate: 0, measuredTxRate: 0, requestCount: 0,
    fillRate: 0.5, lastThrottleTime: seconds(), lastTimestamp: 0, lastTxRateBucket: Math.floor(seconds()), maxCapacity: 1, timeWindow: 0,
  };
  const refill = () => {
    const t = seconds();
    if (!limiter.lastTimestamp) {
      limiter.lastTimestamp = t;
      return;
    }
    limiter.currentCapacity = Math.min(limiter.maxCapacity, limiter.currentCapacity + (t - limiter.lastTimestamp) * limiter.fillRate);
    limiter.lastTimestamp = t;
  };
  const sendToken = async () => {
    if (!limiter.enabled) return;
    refill();
    if (limiter.currentCapacity < 1) await sleep(((1 - limiter.currentCapacity) / limiter.fillRate) * 1000);
    limiter.currentCapacity -= 1;
  };
  const updateRate = (throttled) => {
    const t = seconds();
    const bucket = Math.floor(t * 2) / 2;
    limiter.requestCount += 1;
    if (bucket > limiter.lastTxRateBucket) {
      limiter.measuredTxRate = (limiter.requestCount / (bucket - limiter.lastTxRateBucket)) * limiter.smooth + limiter.measuredTxRate * (1 - limiter.smooth);
      limiter.requestCount = 0;
      limiter.lastTxRateBucket = bucket;
    }
    let rate;
    if (throttled) {
      const rateToUse = limiter.enabled ? Math.min(limiter.measuredTxRate, limiter.fillRate) : limiter.measuredTxRate;
      limiter.lastMaxRate = rateToUse;
      limiter.timeWindow = Math.cbrt((limiter.lastMaxRate * (1 - limiter.beta)) / limiter.scaleConstant);
      limiter.lastThrottleTime = t;
      rate = rateToUse * limiter.beta;
      limiter.enabled = true;
    } else {
      limiter.timeWindow = Math.cbrt((limiter.lastMaxRate * (1 - limiter.beta)) / limiter.scaleConstant);
      rate = limiter.scaleConstant * (t - limiter.lastThrottleTime - limiter.timeWindow) ** 3 + limiter.lastMaxRate;
    }
    const newRate = Math.min(rate, 2 * limiter.measuredTxRate);
    refill();
    limiter.fillRate = Math.max(newRate, limiter.minFillRate);
    limiter.maxCapacity = Math.max(newRate, limiter.minCapacity);
    limiter.currentCapacity = Math.min(limiter.currentCapacity, limiter.maxCapacity);
  };
  let quota = 500;
  const retrying = (fn) => async (input) => {
    let cost = 0;
    for (let attempt = 1; ; attempt += 1) {
      await sendToken();
      try {
        const out = await fn(input);
        updateRate(false);
        quota = Math.min(500, quota + (cost || 1));
        return out;
      } catch (err) {
        const throttled = err.name === 'ThrottlingException';
        updateRate(throttled);
        if (!throttled || attempt >= maxAttempts || quota < 5) {
          stats.failed += 1;
          throw err;
        }
        cost = 5;
        quota -= cost;
        stats.retried += 1;
        await sleep(Math.floor(random() * Math.min(20_000, 500 * 2 ** attempt)));
      }
    }
  };
  return { client: Object.fromEntries(Object.entries(client).map(([name, fn]) => [name, retrying(fn)])), stats };
}
