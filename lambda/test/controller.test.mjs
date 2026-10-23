import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../src/lib/controller-core.mjs';
import { currentTarget } from '../src/lib/route.mjs';
import { STATES } from '../src/lib/state.mjs';
import { asgGroup, ecsService, fakeAppScaling, fakeEcs, fakeKubernetes, fakeRds, fakeRdsTagging, fakeTagging, fakeAutoScaling, fakeClock, fakeCloudWatch, fakeEc2, fakeElbv2, fakeStore, k8sConfig, k8sCustomerIngress, k8sGroupedConfig, k8sNode, k8sOwner, k8sPod, routeOf, silentLog, testConfig } from './fakes.mjs';
import { dormetoIngress, weightsOf } from '../src/lib/kube-route.mjs';
import { ROUTER_RULES } from '../src/lib/kube-access.mjs';

function setup({ run, instance = 'running', target = 'app', healthy = 1, metric = [], metricAt = [], cfg = testConfig(), groups = [], services = [], databases, k8s, managerSettings = null } = {}) {
  const clock = fakeClock();
  const store = fakeStore({ config: cfg, run, clock });
  const ec2 = fakeEc2(cfg.instanceIds, { state: instance });
  const elbv2 = fakeElbv2(cfg, { target, healthy });
  const cloudwatch = fakeCloudWatch(metric, metricAt);
  const autoscaling = fakeAutoScaling(groups);
  const ecs = fakeEcs(services);
  const rds = databases ? fakeRds(databases) : undefined;
  const ecsTagging = fakeTagging(ecs);
  const rdsTagging = rds ? fakeRdsTagging(rds) : null;
  // One call may ask for several resource types (as the tagging API allows): each fake answers for its own.
  const tagging = {
    async getResources(input) {
      const parts = await Promise.all([ecsTagging, rdsTagging].filter(Boolean).map((t) => t.getResources(input)));
      return { ResourceTagMappingList: parts.flatMap((p) => p.ResourceTagMappingList ?? []) };
    },
  };
  const appscaling = fakeAppScaling();
  let ids = 0;
  const invocations = [];
  const log = { ...silentLog };
  const handler = createController({
    store, ec2, elbv2, cloudwatch, autoscaling, ecs, tagging, appscaling, rds, kubernetesOf: k8s ? async () => k8s : undefined,
    invokeSelf: async (payload) => { invocations.push(payload); }, now: clock.now, sleep: clock.sleep, newId: () => `wake-${++ids}`, log, managerSettings,
  });
  return { handler, store, ec2, elbv2, cloudwatch, autoscaling, ecs, appscaling, rds, clock, cfg, invocations, log };
}

test('wake: starts the instance, waits for health, switches the route and becomes AWAKE', async () => {
  const s = setup({ run: { state: STATES.WAKING, wakeId: 'w1', holders: 3, pendingWake: true }, instance: 'stopped', target: 'waker', healthy: 0 });
  s.ec2.state.onStart.push(() => { s.clock.onSleep(() => { s.elbv2.state.healthy = 1; }); });
  const result = await s.handler({ action: 'wake', workloadId: 'demo', wakeId: 'w1' });
  assert.equal(result.state, STATES.AWAKE);
  assert.equal(s.ec2.state.started, 1);
  assert.equal(routeOf(s.elbv2, s.cfg), 'app');
  assert.equal(s.store.state.run.state, STATES.AWAKE);
  assert.equal(s.store.state.run.holders, 0);
  assert.equal('pendingWake' in s.store.state.run, false);
  assert.equal(s.store.state.run.awakeSince, s.clock.now());
});

test('wake: times out to FAILED and keeps the route on the waker', async () => {
  const s = setup({ run: { state: STATES.WAKING, wakeId: 'w1' }, instance: 'stopped', target: 'waker', healthy: 0 });
  const result = await s.handler({ action: 'wake', workloadId: 'demo', wakeId: 'w1' });
  assert.equal(result.state, STATES.FAILED);
  assert.equal(s.store.state.run.state, STATES.FAILED);
  assert.equal(s.store.state.run.failedAt, s.clock.now());
  assert.equal(routeOf(s.elbv2, s.cfg), 'waker');
});

test('wake: a refused start records why, the backend and the consecutive failures, and says it in the event (R7a)', async () => {
  const s = setup({ run: { state: STATES.WAKING, wakeId: 'w1', wakeStartedAt: 1, consecutiveFailures: 1 }, instance: 'stopped', target: 'waker', healthy: 0 });
  const specs = [];
  const transition = s.store.transition;
  s.store.transition = async (id, spec) => { specs.push(spec); return transition(id, spec); };
  s.ec2.startInstances = async () => { throw Object.assign(new Error('You are not authorized to perform this operation.'), { name: 'UnauthorizedOperation' }); };
  const result = await s.handler({ action: 'wake', workloadId: 'demo', wakeId: 'w1' });
  assert.equal(result.state, STATES.FAILED);
  const failure = { kind: 'permission', step: 'wake', backend: 'instance:i-0123456789abcdef0', message: 'You are not authorized to perform this operation.', at: s.clock.now() };
  assert.deepEqual(JSON.parse(s.store.state.run.failure), failure);
  assert.equal(s.store.state.run.consecutiveFailures, 2);
  // The event's time is ISO, as the change's and the summary's (the manager reads only ISO times).
  assert.deepEqual(specs.at(-1).event, { wakeId: 'w1', failure: { ...failure, at: new Date(s.clock.now()).toISOString() } });
});

test('wake: a successful wake clears the failure and gives its duration in the event (R7a)', async () => {
  const s = setup({ run: { state: STATES.WAKING, wakeId: 'w1', failure: '{"kind":"capacity"}', consecutiveFailures: 2 }, instance: 'stopped', target: 'waker', healthy: 0 });
  s.store.state.run.wakeStartedAt = s.clock.now() - 40_000;
  const specs = [];
  const transition = s.store.transition;
  s.store.transition = async (id, spec) => { specs.push(spec); return transition(id, spec); };
  s.ec2.state.onStart.push(() => { s.clock.onSleep(() => { s.elbv2.state.healthy = 1; }); });
  await s.handler({ action: 'wake', workloadId: 'demo', wakeId: 'w1' });
  assert.equal(s.store.state.run.state, STATES.AWAKE);
  assert.equal('failure' in s.store.state.run, false);
  assert.equal('consecutiveFailures' in s.store.state.run, false);
  const done = specs.at(-1);
  assert.equal(done.event.wakeId, 'w1');
  assert.ok(done.event.durationMs >= 40_000);
});

test('wake: a superseded wakeId does not overwrite the state', async () => {
  const s = setup({ run: { state: STATES.WAKING, wakeId: 'newer' }, instance: 'stopped', target: 'waker' });
  const result = await s.handler({ action: 'wake', workloadId: 'demo', wakeId: 'older' });
  assert.equal(result.state, 'SUPERSEDED');
  assert.equal(s.store.state.run.state, STATES.WAKING);
  assert.equal(s.ec2.state.started, 0, 'no side effect');
  assert.equal(routeOf(s.elbv2, s.cfg), 'waker');
});

test('wake: a stale event after the workload went back to sleep has no side effect', async () => {
  const s = setup({ run: { state: STATES.ASLEEP }, instance: 'stopped', target: 'waker' });
  const result = await s.handler({ action: 'wake', workloadId: 'demo', wakeId: 'stale' });
  assert.equal(result.state, 'SUPERSEDED');
  assert.equal(s.ec2.state.started, 0);
  assert.equal(routeOf(s.elbv2, s.cfg), 'waker');
});

test('nap: switches to the waker, stops the instance and becomes ASLEEP', async () => {
  const s = setup({ run: { state: STATES.AWAKE } });
  const result = await s.handler({ action: 'nap', workloadId: 'demo' });
  assert.equal(result.state, STATES.ASLEEP);
  assert.equal(routeOf(s.elbv2, s.cfg), 'waker');
  assert.equal(s.ec2.state.instances[s.cfg.instanceIds[0]], 'stopped');
  assert.equal(s.store.state.run.state, STATES.ASLEEP);
  assert.equal('stopping' in s.store.state.run, false);
});

test('nap: skipped unless AWAKE', async () => {
  const s = setup({ run: { state: STATES.ASLEEP }, target: 'waker', instance: 'stopped' });
  assert.equal((await s.handler({ action: 'nap', workloadId: 'demo' })).state, 'SKIPPED');
});

test('nap: a request during the drain aborts the nap without stopping the instance', async () => {
  const s = setup({ run: { state: STATES.AWAKE } });
  s.clock.onSleep(() => { if (s.store.state.run.state === STATES.NAPPING) s.store.state.run.pendingWake = true; });
  const result = await s.handler({ action: 'nap', workloadId: 'demo' });
  assert.deepEqual(result, { state: STATES.AWAKE, aborted: true });
  assert.equal(s.ec2.state.stopped, 0);
  assert.equal(routeOf(s.elbv2, s.cfg), 'app');
  assert.equal(s.store.state.run.state, STATES.AWAKE);
  assert.equal('pendingWake' in s.store.state.run, false);
});

test('nap: a request after the stop commit wakes the workload right after the nap', async () => {
  const s = setup({ run: { state: STATES.AWAKE, wakeCount: 0 } });
  s.ec2.state.onStop.push(() => { s.store.state.run.pendingWake = true; });
  const result = await s.handler({ action: 'nap', workloadId: 'demo' });
  assert.equal(result.state, STATES.AWAKE);
  assert.equal(s.ec2.state.stopped, 1);
  assert.equal(s.ec2.state.started, 1);
  assert.equal(s.store.state.run.wakeCount, 1);
  assert.equal(routeOf(s.elbv2, s.cfg), 'app');
});

test('nap: a failure while stopping ends FAILED so that requests retry the wake', async () => {
  const s = setup({ run: { state: STATES.AWAKE } });
  s.ec2.stopInstances = async () => { throw new Error('UnauthorizedOperation'); };
  const result = await s.handler({ action: 'nap', workloadId: 'demo' });
  assert.equal(result.state, STATES.FAILED);
  assert.equal(s.store.state.run.state, STATES.FAILED);
});

test('check: requests the nap of an idle workload asynchronously, without napping inline', async () => {
  const s = setup({ run: { state: STATES.AWAKE, awakeSince: 1 }, metric: [0, 0, 0] });
  const [result] = await s.handler({ action: 'check' });
  assert.deepEqual(result, { workloadId: 'demo', state: STATES.AWAKE, nap: 'requested' });
  assert.deepEqual(s.invocations, [{ action: 'nap', workloadId: 'demo' }]);
  assert.equal(s.ec2.state.stopped, 0, 'the check itself does not stop anything');
  const query = s.cloudwatch.calls[0];
  assert.equal(query.EndTime.getTime() - query.StartTime.getTime(), 15 * 60_000);
});

test('check: keeps a workload with requests awake, until its last request plus the idle window', async () => {
  const t = fakeClock().now();
  // Requests in the minute that started 3 minutes ago: idle 15 minutes after the end of that minute at the earliest.
  const minute = t - 3 * 60_000;
  const s = setup({ run: { state: STATES.AWAKE, awakeSince: 1 }, metric: [0, 4], metricAt: [new Date(minute - 60_000), new Date(minute)] });
  const [result] = await s.handler({ action: 'check' });
  const idleNotBefore = minute + 60_000 + 15 * 60_000;
  assert.deepEqual(result, { workloadId: 'demo', state: STATES.AWAKE, idleNotBefore });
  assert.equal(s.store.state.run.idleNotBefore, idleNotBefore);
  assert.equal(s.ec2.state.stopped, 0);
});

test('check: starts the idle window on the first check after deployment instead of napping', async () => {
  const s = setup({ run: { state: STATES.AWAKE, awakeSince: 0 }, metric: [0, 0, 0] });
  const [result] = await s.handler({ action: 'check' });
  assert.deepEqual(result, { workloadId: 'demo', state: STATES.AWAKE });
  assert.equal(s.store.state.run.awakeSince, s.clock.now());
  assert.equal(s.ec2.state.stopped, 0);
  assert.equal(s.cloudwatch.calls.length, 0);
});

test('check: does not query metrics before idleMinutes of awake time', async () => {
  const s = setup({ run: { state: STATES.AWAKE } });
  s.store.state.run.awakeSince = s.clock.now() - 60_000;
  await s.handler({ action: 'check' });
  assert.equal(s.cloudwatch.calls.length, 0);
});

test('check: reconciles an instance started outside Dormeto', async () => {
  const s = setup({ run: { state: STATES.ASLEEP }, instance: 'running', target: 'waker', healthy: 1, metric: [1] });
  const [result] = await s.handler({ action: 'check' });
  assert.equal(result.state, STATES.AWAKE);
  assert.equal(routeOf(s.elbv2, s.cfg), 'app');
  assert.equal(s.store.state.run.awakeSince, s.clock.now());
});

test('check: reconciles an instance stopped outside Dormeto', async () => {
  const s = setup({ run: { state: STATES.AWAKE, awakeSince: 0 }, instance: 'stopped', target: 'app' });
  const [result] = await s.handler({ action: 'check' });
  assert.equal(result.state, STATES.ASLEEP);
  assert.equal(routeOf(s.elbv2, s.cfg), 'waker');
});

test('check: repairs a route reset while the workload sleeps', async () => {
  const s = setup({ run: { state: STATES.ASLEEP }, instance: 'stopped', target: 'app' });
  await s.handler({ action: 'check' });
  assert.equal(routeOf(s.elbv2, s.cfg), 'waker');
});

test('check: releases a nap stuck for 15 minutes to FAILED', async () => {
  const s = setup({ run: { state: STATES.NAPPING } });
  s.store.state.run.updatedAt = s.clock.now() - 16 * 60_000;
  const [result] = await s.handler({ action: 'check' });
  assert.equal(result.state, STATES.FAILED);
});

test('check: an error on one workload is reported, not thrown', async () => {
  const s = setup({ run: { state: STATES.AWAKE, awakeSince: 0 } });
  s.ec2.describeInstances = async () => { throw new Error('throttled'); };
  const [result] = await s.handler({ action: 'check' });
  assert.deepEqual(result, { workloadId: 'demo', error: 'throttled' });
});

test('ensure-awake switches the route back when the workload is awake and healthy', async () => {
  const s = setup({ run: { state: STATES.AWAKE }, target: 'waker', healthy: 1 });
  const result = await s.handler({ action: 'ensure-awake', workloadId: 'demo' });
  assert.equal(result.changed, true);
  assert.equal(routeOf(s.elbv2, s.cfg), 'app');
});

// --- Several rules per workload, found from the target group --------------------------------------------------------

const TWO_RULES = testConfig({ ruleArns: ['arn:rule/main', 'arn:rule/static'] });
const host = (h) => ({ Field: 'host-header', HostHeaderConfig: { Values: [h] } });
const path = (p) => ({ Field: 'path-pattern', PathPatternConfig: { Values: [p] } });
const appOnly = (c) => [{ Type: 'forward', Order: 1, ForwardConfig: { TargetGroups: [{ TargetGroupArn: c.appTargetGroupArn, Weight: 1 }] } }];
const recordWarnings = (s) => {
  const warnings = [];
  s.log.warn = (event, data) => warnings.push([event, data]);
  return warnings;
};

test('nap and wake switch every rule of a workload with several rules', async () => {
  const s = setup({ run: { state: STATES.AWAKE, awakeSince: 0 }, cfg: TWO_RULES });
  await s.handler({ action: 'nap', workloadId: 'demo' });
  assert.equal(s.store.state.run.state, STATES.ASLEEP);
  assert.equal(routeOf(s.elbv2, s.cfg), 'waker');
  assert.equal(s.elbv2.state.modifyCount, 2);
  s.store.state.run = { ...s.store.state.run, state: STATES.WAKING, wakeId: 'w1' };
  await s.handler({ action: 'wake', workloadId: 'demo', wakeId: 'w1' });
  assert.equal(s.store.state.run.state, STATES.AWAKE);
  assert.equal(routeOf(s.elbv2, s.cfg), 'app');
});

test('a rule added to the target group is switched with the others, without any configuration change', async () => {
  const s = setup({ run: { state: STATES.AWAKE, awakeSince: 0 }, cfg: testConfig() });
  s.elbv2.state.rules.set('arn:rule/added', { actions: s.elbv2.state.forward(1, 0), priority: '15', tags: { 'dormeto:workload': 'demo' } });
  await s.handler({ action: 'nap', workloadId: 'demo' });
  assert.equal(currentTarget(s.elbv2.state.rules.get('arn:rule/added').actions, s.cfg), 'waker');
});

test('a nap is refused while a rule forwarding to the target group is not instrumented; the backend keeps running', async () => {
  const s = setup({ run: { state: STATES.AWAKE, awakeSince: 0 }, cfg: TWO_RULES });
  const warnings = recordWarnings(s);
  s.elbv2.state.rules.set('arn:rule/new', { actions: appOnly(s.cfg), priority: '19', tags: {} });
  const result = await s.handler({ action: 'nap', workloadId: 'demo' });
  assert.deepEqual([result.state, result.reason], ['SKIPPED', 'rules not instrumented']);
  assert.equal(s.store.state.run.state, STATES.AWAKE);
  assert.equal(s.ec2.state.stopped, 0);
  assert.equal(s.elbv2.state.modifyCount, 0);
  assert.deepEqual(warnings.find(([e]) => e === 'NapSkipped')[1].issues, ['rule 19 forwards to the target group without the waker (not instrumented)']);
});

test('a nap failing on the second rule is not a success, and the next check repairs the route', async () => {
  const s = setup({ run: { state: STATES.AWAKE, awakeSince: 0 }, cfg: TWO_RULES });
  s.elbv2.state.failOn = 'arn:rule/static';
  const result = await s.handler({ action: 'nap', workloadId: 'demo' });
  assert.deepEqual([result.state, s.store.state.run.state], [STATES.FAILED, STATES.FAILED]);
  assert.match(result.error, /ModifyRule failed/);
  assert.equal(routeOf(s.elbv2, s.cfg), 'mixed');
  s.elbv2.state.failOn = null;
  await s.handler({ action: 'check' });
  assert.equal(routeOf(s.elbv2, s.cfg), 'app');
});

test('a wake completes with a rule it cannot switch: the instrumented rules serve the application, the issue is logged', async () => {
  const s = setup({ run: { state: STATES.WAKING, wakeId: 'w1' }, instance: 'stopped', target: 'waker', cfg: TWO_RULES });
  const warnings = recordWarnings(s);
  s.elbv2.state.rules.set('arn:rule/new', { actions: appOnly(s.cfg), priority: '19', tags: {} });
  const result = await s.handler({ action: 'wake', workloadId: 'demo', wakeId: 'w1' });
  assert.equal(result.state, STATES.AWAKE);
  assert.equal(currentTarget(s.elbv2.state.rules.get('arn:rule/static').actions, s.cfg), 'app');
  assert.deepEqual(warnings.find(([e]) => e === 'RuleIssues')[1], { workloadId: 'demo', issues: ['rule 19 forwards to the target group without the waker (not instrumented)'] });
});

test('check wakes an asleep workload when a rule forwarding to its target group cannot be switched', async () => {
  const s = setup({ run: { state: STATES.ASLEEP }, instance: 'stopped', target: 'waker', cfg: TWO_RULES });
  const warnings = recordWarnings(s);
  s.elbv2.state.rules.set('arn:rule/new', { actions: appOnly(s.cfg), priority: '19', tags: {} });
  await s.handler({ action: 'check' });
  assert.equal(s.store.state.run.state, STATES.WAKING);
  assert.ok(s.invocations.some((i) => i.action === 'wake' && i.workloadId === 'demo'));
  assert.ok(warnings.some(([e]) => e === 'WokenForRuleIssues'));
});

test('an asleep workload whose target group has no rule (or no load balancer) is not woken', async () => {
  const s = setup({ run: { state: STATES.ASLEEP }, instance: 'stopped', target: 'waker', cfg: TWO_RULES });
  s.elbv2.state.rules.clear();
  await s.handler({ action: 'check' });
  assert.equal(s.store.state.run.state, STATES.ASLEEP);
  assert.equal(s.invocations.some((i) => i.action === 'wake'), false);
  s.elbv2.state.detached = true;
  await s.handler({ action: 'check' });
  assert.equal(s.store.state.run.state, STATES.ASLEEP);
});

test('a backend stopped outside Dormeto with a rule issue: instrumented rules to the waker, then woken for the issue', async () => {
  const s = setup({ run: { state: STATES.AWAKE, awakeSince: 0 }, instance: 'stopped', healthy: 0, cfg: TWO_RULES });
  const warnings = recordWarnings(s);
  s.elbv2.state.rules.set('arn:rule/new', { actions: appOnly(s.cfg), priority: '19', tags: {} });
  const [result] = await s.handler({ action: 'check' });
  assert.equal(result.error, undefined);
  assert.equal(currentTarget(s.elbv2.state.rules.get('arn:rule/main').actions, s.cfg), 'waker');
  assert.equal(s.store.state.run.state, STATES.WAKING);
  assert.ok(warnings.some(([e]) => e === 'WokenForRuleIssues'));
});

test('a FAILED workload with a stopped backend and a rule issue recovers the same way', async () => {
  const s = setup({ run: { state: STATES.FAILED, failedAt: 0 }, instance: 'stopped', healthy: 0, cfg: TWO_RULES });
  s.elbv2.state.rules.set('arn:rule/new', { actions: appOnly(s.cfg), priority: '19', tags: {} });
  const [result] = await s.handler({ action: 'check' });
  assert.equal(result.error, undefined);
  assert.equal(s.store.state.run.state, STATES.WAKING);
});

test('a FAILED workload with a rule issue keeps its instrumented rules behind the waker', async () => {
  const s = setup({ run: { state: STATES.FAILED, failedAt: 0 }, instance: 'pending', healthy: 0, cfg: TWO_RULES });
  s.elbv2.state.rules.set('arn:rule/new', { actions: appOnly(s.cfg), priority: '19', tags: {} });
  const [result] = await s.handler({ action: 'check' });
  assert.equal(result.error, undefined);
  assert.deepEqual(['arn:rule/main', 'arn:rule/static'].map((arn) => currentTarget(s.elbv2.state.rules.get(arn).actions, s.cfg)), ['waker', 'waker']);
});

test('status reports the rules found from the target group, their route, and the issues', async () => {
  const s = setup({ run: { state: STATES.AWAKE }, cfg: TWO_RULES });
  s.elbv2.state.rules.get('arn:rule/main').conditions = [host('asg.example.com')];
  s.elbv2.state.rules.get('arn:rule/main').priority = '20';
  Object.assign(s.elbv2.state.rules.get('arn:rule/static'), { conditions: [host('asg.example.com'), path('/static/*')], priority: '19', actions: s.elbv2.state.forward(0, 1) });
  s.elbv2.state.rules.set('arn:rule/new', { actions: appOnly(s.cfg), priority: '30', conditions: [path('/new/*')], tags: {} });
  const status = await s.handler({ action: 'status', workloadId: 'demo' });
  assert.equal(status.route, 'mixed');
  assert.deepEqual(status.rules, [
    { arn: 'arn:rule/main', priority: '20', conditions: 'host asg.example.com', route: 'app' },
    { arn: 'arn:rule/static', priority: '19', conditions: 'host asg.example.com, path /static/*', route: 'waker' },
    { arn: 'arn:rule/new', priority: '30', conditions: 'path /new/*', route: 'app', issue: 'rule 30 forwards to the target group without the waker (not instrumented)' },
  ]);
  assert.deepEqual(status.issues, ['rule 30 forwards to the target group without the waker (not instrumented)']);
});

test('status answers for a target group without any rule', async () => {
  const s = setup({ run: { state: STATES.AWAKE }, cfg: TWO_RULES });
  s.elbv2.state.rules.clear();
  const status = await s.handler({ action: 'status', workloadId: 'demo' });
  assert.deepEqual([status.route, status.rules, status.issues], ['unknown', [], ['no rule forwards to the target group']]);
});

test('list gives the URL of the first rule with a host condition', async () => {
  const s = setup({ run: { state: STATES.AWAKE }, cfg: TWO_RULES });
  s.elbv2.state.rules.get('arn:rule/main').conditions = [path('/api/*')];
  s.elbv2.state.rules.get('arn:rule/static').conditions = [host('asg.example.com'), path('/static/*')];
  const { workloads } = await s.handler({ action: 'list' });
  assert.equal(workloads[0].url, 'https://asg.example.com/');
});

test('check repairs one rule switched back by hand while the workload sleeps, and reports which', async () => {
  const s = setup({ run: { state: STATES.ASLEEP }, instance: 'stopped', target: 'waker', cfg: TWO_RULES });
  const warnings = recordWarnings(s);
  s.elbv2.state.rules.get('arn:rule/static').actions = s.elbv2.state.forward(1, 0);
  assert.equal(routeOf(s.elbv2, s.cfg), 'mixed');
  await s.handler({ action: 'check' });
  assert.equal(routeOf(s.elbv2, s.cfg), 'waker');
  assert.deepEqual(warnings.find(([e]) => e === 'RouteRepaired'), ['RouteRepaired', { workloadId: 'demo', route: 'waker', rules: ['arn:rule/static'] }]);
  await s.handler({ action: 'check' });
  assert.equal(warnings.filter(([e]) => e === 'RouteRepaired').length, 1, 'no repair reported when nothing changed');
});

test('unknown actions are rejected', async () => {
  const s = setup({ run: { state: STATES.AWAKE } });
  await assert.rejects(s.handler({ action: 'dance' }), /unknown action/);
});

test('check: recovers FAILED with a running healthy instance to AWAKE', async () => {
  const s = setup({ run: { state: STATES.FAILED, failedAt: 1 }, instance: 'running', target: 'waker', healthy: 1 });
  const [result] = await s.handler({ action: 'check' });
  assert.equal(result.state, STATES.AWAKE);
  assert.equal(routeOf(s.elbv2, s.cfg), 'app');
});

test('check: recovers FAILED with a stopped instance to ASLEEP behind the waker', async () => {
  const s = setup({ run: { state: STATES.FAILED, failedAt: 1 }, instance: 'stopped', target: 'app', healthy: 0 });
  const [result] = await s.handler({ action: 'check' });
  assert.equal(result.state, STATES.ASLEEP);
  assert.equal(routeOf(s.elbv2, s.cfg), 'waker');
});

test('check: keeps a FAILED workload with an unhealthy instance behind the waker', async () => {
  const s = setup({ run: { state: STATES.FAILED, failedAt: 1 }, instance: 'running', target: 'app', healthy: 0 });
  const [result] = await s.handler({ action: 'check' });
  assert.equal(result.state, STATES.FAILED);
  assert.equal(routeOf(s.elbv2, s.cfg), 'waker');
});

test('check: releases a wake stuck beyond wakeTimeoutSeconds to FAILED', async () => {
  const s = setup({ run: { state: STATES.WAKING, wakeId: 'w' } });
  s.store.state.run.wakeStartedAt = s.clock.now() - 12 * 60_000;
  const [result] = await s.handler({ action: 'check' });
  assert.equal(result.state, STATES.FAILED);
});

// --- discovery mode (no static instanceIds) ---------------------------------------------------------------------

function discovery({ run, instances, tags, target = 'app' }) {
  const s = setup({ run, cfg: testConfig({ instanceIds: [] }), target });
  s.ec2.state.instances = Object.fromEntries(Object.entries(instances).map(([id, v]) => [id, v.state]));
  s.ec2.state.tags = tags;
  s.elbv2.state.targets = Object.entries(instances).map(([id, v]) => ({ Id: id, State: v.health }));
  return s;
}

test('nap (discovery): stops only the managed instances and records them', async () => {
  const s = discovery({
    run: { state: STATES.AWAKE },
    instances: { 'i-a': { state: 'running', health: 'healthy' }, 'i-x': { state: 'running', health: 'healthy' } },
    tags: { 'i-a': { 'dormeto:workload': 'demo' } },
  });
  const result = await s.handler({ action: 'nap', workloadId: 'demo' });
  assert.equal(result.state, STATES.ASLEEP);
  assert.equal(s.ec2.state.instances['i-a'], 'stopped');
  assert.equal(s.ec2.state.instances['i-x'], 'running', 'untagged target is never stopped');
  assert.deepEqual(JSON.parse(s.store.state.run.napBackends), [{ kind: 'instance', id: 'i-a' }]);
});

test('nap (discovery): skipped when no instance is managed', async () => {
  const s = discovery({
    run: { state: STATES.AWAKE },
    instances: { 'i-x': { state: 'running', health: 'healthy' } },
    tags: {},
  });
  const result = await s.handler({ action: 'nap', workloadId: 'demo' });
  assert.deepEqual(result, { state: 'SKIPPED', reason: 'no-instances' });
  assert.equal(s.store.state.run.state, STATES.AWAKE);
  assert.equal(routeOf(s.elbv2, s.cfg), 'app');
  assert.equal(s.ec2.state.stopped, 0);
});

test('wake (discovery): starts the instances recorded by the nap', async () => {
  const s = discovery({
    run: { state: STATES.WAKING, wakeId: 'w1', napInstances: '["i-a"]' },
    instances: { 'i-a': { state: 'stopped', health: 'unused' }, 'i-b': { state: 'stopped', health: 'unused' } },
    tags: { 'i-a': { 'dormeto:workload': 'demo' }, 'i-b': { 'dormeto:workload': 'demo' } },
    target: 'waker',
  });
  s.ec2.state.onStart.push(() => { s.elbv2.state.targets[0].State = 'healthy'; });
  const result = await s.handler({ action: 'wake', workloadId: 'demo', wakeId: 'w1' });
  assert.equal(result.state, STATES.AWAKE);
  assert.equal(s.ec2.state.instances['i-a'], 'running');
  assert.equal(s.ec2.state.instances['i-b'], 'stopped', 'only the napped instances are started');
  assert.equal('napInstances' in s.store.state.run, false);
});

test('check (discovery): reconciles on the discovered instances', async () => {
  const s = discovery({
    run: { state: STATES.ASLEEP },
    instances: { 'i-a': { state: 'running', health: 'healthy' } },
    tags: { 'i-a': { 'dormeto:workload': 'demo' } },
    target: 'waker',
  });
  const [result] = await s.handler({ action: 'check' });
  assert.equal(result.state, STATES.AWAKE);
  assert.equal(routeOf(s.elbv2, s.cfg), 'app');
});

test('check (discovery): no managed instance leaves the state alone and keeps the route consistent', async () => {
  const s = discovery({ run: { state: STATES.ASLEEP }, instances: {}, tags: {}, target: 'app' });
  const [result] = await s.handler({ action: 'check' });
  assert.equal(result.state, STATES.ASLEEP);
  assert.equal(routeOf(s.elbv2, s.cfg), 'waker');
});

test('check (discovery): an AWAKE workload without managed instance is not marked ASLEEP', async () => {
  const s = discovery({ run: { state: STATES.AWAKE, awakeSince: 1 }, instances: {}, tags: {}, target: 'app' });
  await s.handler({ action: 'check' });
  assert.notEqual(s.store.state.run.state, STATES.ASLEEP);
  assert.equal(routeOf(s.elbv2, s.cfg), 'app');
});

// --- cleanup: holders, time budget, config errors ----------------------------------------------------------------

test('wake failure resets the held-request counter', async () => {
  const s = setup({ run: { state: STATES.WAKING, wakeId: 'w1', holders: 3 }, instance: 'stopped', target: 'waker', healthy: 0 });
  await s.handler({ action: 'wake', workloadId: 'demo', wakeId: 'w1' });
  assert.equal(s.store.state.run.state, STATES.FAILED);
  assert.equal(s.store.state.run.holders, 0);
});

test('a completed nap resets the held-request counter', async () => {
  const s = setup({ run: { state: STATES.AWAKE, holders: 2 } });
  await s.handler({ action: 'nap', workloadId: 'demo' });
  assert.equal(s.store.state.run.state, STATES.ASLEEP);
  assert.equal(s.store.state.run.holders, 0);
});

test('check clears a leaked held-request counter outside a wake', async () => {
  const s = setup({ run: { state: STATES.AWAKE, awakeSince: 1, holders: 4 }, metric: [1] });
  await s.handler({ action: 'check' });
  assert.equal(s.store.state.run.holders, 0);
});

test('wake hands over to a new invocation before the Lambda timeout instead of failing', async () => {
  const s = setup({ run: { state: STATES.WAKING, wakeId: 'w1' }, instance: 'stopped', target: 'waker', healthy: 0 });
  s.store.state.run.wakeStartedAt = s.clock.now();
  const start = s.clock.now();
  const result = await s.handler({ action: 'wake', workloadId: 'demo', wakeId: 'w1' }, { getRemainingTimeInMillis: () => 60_000 });
  assert.deepEqual(result, { state: STATES.WAKING, continued: true });
  assert.ok(s.clock.now() - start <= 33_000, `handed over after ${s.clock.now() - start} ms`);
  assert.deepEqual(s.invocations, [{ action: 'wake', workloadId: 'demo', wakeId: 'w1' }]);
});

test('a configuration read error during wake ends FAILED instead of a stuck WAKING', async () => {
  const s = setup({ run: { state: STATES.WAKING, wakeId: 'w1' } });
  s.store.getConfig = async () => { throw new Error('ProvisionedThroughputExceededException'); };
  const result = await s.handler({ action: 'wake', workloadId: 'demo', wakeId: 'w1' });
  assert.equal(result.state, STATES.FAILED);
  assert.equal(s.store.state.run.state, STATES.FAILED);
});

// --- Auto Scaling group backends -------------------------------------------------------------------------------

const ASG_TAGS = { 'dormeto:workload': 'demo' };

function asgSetup({ run, desired = 1, target = 'app', healthy = 1 }) {
  const cfg = testConfig({ instanceIds: [] });
  const s = setup({
    run, cfg, target, healthy,
    groups: [asgGroup('asg-demo', { min: desired, max: 3, desired, targetGroups: [cfg.appTargetGroupArn], tags: ASG_TAGS })],
  });
  s.elbv2.state.healthy = healthy;
  return s;
}

test('nap (asg): records the group sizes, suspends scaling and scales the group to zero', async () => {
  const s = asgSetup({ run: { state: STATES.AWAKE }, desired: 2 });
  const result = await s.handler({ action: 'nap', workloadId: 'demo' });
  assert.equal(result.state, STATES.ASLEEP);
  assert.deepEqual(JSON.parse(s.store.state.run.napBackends), [{ kind: 'asg', name: 'asg-demo', min: 2, max: 3, desired: 2 }]);
  const group = s.autoscaling.state.groups[0];
  assert.equal(group.DesiredCapacity, 0);
  assert.equal(group.MinSize, 0);
  assert.ok(s.autoscaling.state.suspended['asg-demo']);
  assert.equal(routeOf(s.elbv2, s.cfg), 'waker');
});

test('wake (asg): restores the recorded sizes, resumes scaling and switches the route back', async () => {
  const s = asgSetup({
    run: { state: STATES.WAKING, wakeId: 'w1', napBackends: JSON.stringify([{ kind: 'asg', name: 'asg-demo', min: 2, max: 3, desired: 2 }]) },
    desired: 0, target: 'waker', healthy: 0,
  });
  const update = s.autoscaling.updateAutoScalingGroup;
  s.autoscaling.updateAutoScalingGroup = async (input) => { await update(input); s.elbv2.state.healthy = input.DesiredCapacity; };
  const result = await s.handler({ action: 'wake', workloadId: 'demo', wakeId: 'w1' });
  assert.equal(result.state, STATES.AWAKE);
  const group = s.autoscaling.state.groups[0];
  assert.deepEqual([group.MinSize, group.MaxSize, group.DesiredCapacity], [2, 3, 2]);
  assert.equal(s.autoscaling.state.resumed.length, 1);
  assert.equal(routeOf(s.elbv2, s.cfg), 'app');
  assert.equal('napBackends' in s.store.state.run, false);
});

test('check (asg): a group scaled up outside Dormeto while asleep is reconciled to AWAKE', async () => {
  const s = asgSetup({ run: { state: STATES.ASLEEP }, desired: 1, target: 'waker', healthy: 1 });
  const [result] = await s.handler({ action: 'check' });
  assert.equal(result.state, STATES.AWAKE);
  assert.equal(routeOf(s.elbv2, s.cfg), 'app');
});

test('check (asg): a group scaled to zero outside Dormeto while awake is reconciled to ASLEEP', async () => {
  const s = asgSetup({ run: { state: STATES.AWAKE, awakeSince: 1 }, desired: 0, target: 'app', healthy: 0 });
  const [result] = await s.handler({ action: 'check' });
  assert.equal(result.state, STATES.ASLEEP);
  assert.equal(routeOf(s.elbv2, s.cfg), 'waker');
});

test('check (asg): an external scale-up resumes the suspended processes and restores MinSize', async () => {
  const s = asgSetup({
    run: { state: STATES.ASLEEP, napBackends: JSON.stringify([{ kind: 'asg', name: 'asg-demo', min: 2, max: 3, desired: 2 }]) },
    desired: 1, target: 'waker', healthy: 1,
  });
  const group = s.autoscaling.state.groups[0];
  group.MinSize = 0;
  s.autoscaling.state.suspended['asg-demo'] = ['AlarmNotification'];
  const [result] = await s.handler({ action: 'check' });
  assert.equal(result.state, STATES.AWAKE);
  assert.equal(s.autoscaling.state.resumed.length, 1);
  assert.equal(group.MinSize, 1, 'MinSize restored, capped by the externally chosen capacity');
  assert.equal(group.DesiredCapacity, 1, 'the externally chosen capacity is kept');
  assert.equal('napBackends' in s.store.state.run, false);
});

// --- ECS service backends --------------------------------------------------------------------------------------

function ecsSetup({ run, desired = 1, target = 'app', healthy = 1 }) {
  const cfg = testConfig({ instanceIds: [] });
  const s = setup({ run, cfg, target, healthy, services: [ecsService('web', { desired, targetGroups: [cfg.appTargetGroupArn], tags: { 'dormeto:workload': 'demo' } })] });
  s.elbv2.state.healthy = healthy;
  return s;
}

test('nap (ecs): records the desired count and scales the service to zero', async () => {
  const s = ecsSetup({ run: { state: STATES.AWAKE }, desired: 2 });
  const result = await s.handler({ action: 'nap', workloadId: 'demo' });
  assert.equal(result.state, STATES.ASLEEP);
  const [record] = JSON.parse(s.store.state.run.napBackends);
  assert.equal(record.kind, 'ecs');
  assert.equal(record.desired, 2);
  assert.equal(s.ecs.state.services[0].desiredCount, 0);
  assert.equal(routeOf(s.elbv2, s.cfg), 'waker');
});

test('nap (ecs): becomes ASLEEP only once the target group released the stopped tasks', async () => {
  // ECS reports no running task before the target group drops its target: a wake right after the nap must not see it.
  const s = ecsSetup({ run: { state: STATES.AWAKE }, desired: 1 });
  s.elbv2.state.targets = [{ Id: '10.0.0.5', State: 'healthy' }];
  const describe = s.elbv2.describeTargetHealth;
  let afterStop = 0;
  s.elbv2.describeTargetHealth = async (input) => {
    if (s.ecs.state.services[0].desiredCount === 0) {
      afterStop += 1;
      s.elbv2.state.targets = afterStop === 1 ? [{ Id: '10.0.0.5', State: 'healthy' }] : afterStop === 2 ? [{ Id: '10.0.0.5', State: 'draining' }] : [];
    }
    return describe(input);
  };
  const result = await s.handler({ action: 'nap', workloadId: 'demo' });
  assert.equal(result.state, STATES.ASLEEP);
  assert.deepEqual(s.elbv2.state.targets, []);
  assert.ok(afterStop >= 3);
});

test('nap: stopped instance targets (unused) do not delay the nap; stuck targets end the wait after a timeout', async () => {
  const s = setup({ run: { state: STATES.AWAKE } });
  s.elbv2.state.targets = [{ Id: 'i-0123456789abcdef0', State: 'unused' }];
  const start = s.clock.now();
  assert.equal((await s.handler({ action: 'nap', workloadId: 'demo' })).state, STATES.ASLEEP);
  const quick = s.clock.now() - start;

  const stuck = setup({ run: { state: STATES.AWAKE } });
  stuck.elbv2.state.targets = [{ Id: 'i-0123456789abcdef0', State: 'draining' }];
  const t0 = stuck.clock.now();
  assert.equal((await stuck.handler({ action: 'nap', workloadId: 'demo' })).state, STATES.ASLEEP);
  assert.ok(stuck.clock.now() - t0 >= quick + 120_000, 'waited up to the release timeout');
});

test('wake (ecs): restores the desired count and switches the route back', async () => {
  const s = ecsSetup({ run: { state: STATES.WAKING, wakeId: 'w1' }, desired: 0, target: 'waker', healthy: 0 });
  const [service] = s.ecs.state.services;
  s.store.state.run.napBackends = JSON.stringify([{ kind: 'ecs', id: service.serviceArn, cluster: service.clusterArn, desired: 2, scalable: null }]);
  const update = s.ecs.updateService;
  s.ecs.updateService = async (input) => { await update(input); s.elbv2.state.healthy = input.desiredCount; };
  const result = await s.handler({ action: 'wake', workloadId: 'demo', wakeId: 'w1' });
  assert.equal(result.state, STATES.AWAKE);
  assert.equal(s.ecs.state.services[0].desiredCount, 2);
  assert.equal(routeOf(s.elbv2, s.cfg), 'app');
});

test('check (ecs): a service scaled up outside Dormeto while asleep is reconciled to AWAKE', async () => {
  const s = ecsSetup({ run: { state: STATES.ASLEEP }, desired: 1, target: 'waker', healthy: 1 });
  const [result] = await s.handler({ action: 'check' });
  assert.equal(result.state, STATES.AWAKE);
});

// --- RDS companions --------------------------------------------------------------------------------------------

const DB_TAG = { 'dormeto:workload': 'demo' };

function rdsSetup({ run, instance = 'running', db = 'available', target = 'app', healthy = 1, wakeTimeoutSeconds = 1800 }) {
  const cfg = testConfig({ wakeTimeoutSeconds });
  return setup({ run, cfg, instance, target, healthy, databases: { instances: { appdb: { status: db, tags: DB_TAG } } } });
}

test('nap (rds): stops the database after the application, without waiting for it', async () => {
  const s = rdsSetup({ run: { state: STATES.AWAKE } });
  const result = await s.handler({ action: 'nap', workloadId: 'demo' });
  assert.equal(result.state, STATES.ASLEEP);
  assert.equal(s.ec2.state.instances[s.cfg.instanceIds[0]], 'stopped');
  assert.deepEqual(s.rds.state.calls, [['stop', 'appdb']]);
  assert.deepEqual(JSON.parse(s.store.state.run.napBackends).map((b) => b.kind), ['instance', 'rds-instance']);
});

test('wake (rds): starts the database first and waits until it is available, then the application', async () => {
  const s = rdsSetup({ run: { state: STATES.WAKING, wakeId: 'w1' }, instance: 'stopped', db: 'stopped', target: 'waker' });
  s.store.state.run.wakeStartedAt = s.clock.now();
  s.store.state.run.napBackends = JSON.stringify([{ kind: 'instance', id: s.cfg.instanceIds[0] }, { kind: 'rds-instance', id: 'appdb' }]);
  const order = [];
  const startDb = s.rds.startDBInstance;
  s.rds.startDBInstance = async (input) => { order.push('db'); return startDb(input); };
  const startEc2 = s.ec2.startInstances;
  s.ec2.startInstances = async (input) => { order.push(`app (db ${s.rds.state.instances.appdb.status})`); return startEc2(input); };
  const result = await s.handler({ action: 'wake', workloadId: 'demo', wakeId: 'w1' });
  assert.equal(result.state, STATES.AWAKE);
  assert.deepEqual(order, ['db', 'app (db available)']);
});

test('wake (rds): continues in a new invocation when the budget runs out before the wake deadline', async () => {
  const s = rdsSetup({ run: { state: STATES.WAKING, wakeId: 'w1' }, instance: 'stopped', db: 'stopped', target: 'waker' });
  s.store.state.run.wakeStartedAt = s.clock.now();
  s.store.state.run.napBackends = JSON.stringify([{ kind: 'rds-instance', id: 'appdb' }]);
  s.rds.startDBInstance = async () => { s.rds.state.instances.appdb.status = 'starting'; s.rds.state.instances.appdb.slow = true; };
  const describe = s.rds.describeDBInstances;
  s.rds.describeDBInstances = async (input) => { const out = await describe(input); if (s.rds.state.instances.appdb.slow) s.rds.state.instances.appdb.status = 'starting'; return out; };
  const result = await s.handler({ action: 'wake', workloadId: 'demo', wakeId: 'w1' }, { getRemainingTimeInMillis: () => 120_000 });
  assert.deepEqual(result, { state: STATES.WAKING, continued: true });
  assert.deepEqual(s.invocations, [{ action: 'wake', workloadId: 'demo', wakeId: 'w1' }]);
  assert.equal(s.store.state.run.state, STATES.WAKING, 'not FAILED');
});

test('wake: the deadline counts from wakeStartedAt, so a continuation past it fails', async () => {
  const s = rdsSetup({ run: { state: STATES.WAKING, wakeId: 'w1' }, instance: 'stopped', db: 'available', target: 'waker', healthy: 0, wakeTimeoutSeconds: 600 });
  s.store.state.run.wakeStartedAt = s.clock.now() - 590_000;
  const result = await s.handler({ action: 'wake', workloadId: 'demo', wakeId: 'w1' }, { getRemainingTimeInMillis: () => 900_000 });
  assert.equal(result.state, STATES.FAILED);
  assert.equal(s.invocations.length, 0);
});

test('check (rds): stops a database started by AWS while the workload sleeps', async () => {
  const s = rdsSetup({ run: { state: STATES.ASLEEP }, instance: 'stopped', db: 'available', target: 'waker', healthy: 0 });
  await s.handler({ action: 'check' });
  assert.deepEqual(s.rds.state.calls, [['stop', 'appdb']]);
  assert.equal(s.store.state.run.state, STATES.ASLEEP);
});

test('check (rds): an external wake of the application starts the database', async () => {
  const s = rdsSetup({ run: { state: STATES.ASLEEP }, instance: 'running', db: 'stopped', target: 'waker', healthy: 1 });
  const [result] = await s.handler({ action: 'check' });
  assert.equal(result.state, STATES.AWAKE, 'the application decides: primaries running and healthy');
  assert.deepEqual(s.rds.state.calls, [['start', 'appdb']]);
});

// --- IP reputation lists --------------------------------------------------------------------------------------------

function listsSetup(dueNames) {
  const calls = [];
  const lists = {
    async due() { return dueNames; },
    async refresh(names) { calls.push(names); return names.map((name) => ({ name, entries: 1 })); },
  };
  const s = setup({ run: { state: STATES.AWAKE, awakeSince: 0 } });
  const handler = createController({
    store: s.store, ec2: s.ec2, elbv2: s.elbv2, cloudwatch: s.cloudwatch, autoscaling: s.autoscaling, ecs: s.ecs,
    appscaling: s.appscaling, invokeSelf: async (payload) => { s.invocations.push(payload); }, now: s.clock.now,
    sleep: s.clock.sleep, log: silentLog, lists,
  });
  return { ...s, handler, calls };
}

test('check requests an asynchronous refresh of the due lists only', async () => {
  const due = listsSetup(['ipsum']);
  await due.handler({ action: 'check' });
  assert.deepEqual(due.invocations.filter((i) => i.action === 'refresh-lists'), [{ action: 'refresh-lists', names: ['ipsum'] }]);
  const fresh = listsSetup([]);
  await fresh.handler({ action: 'check' });
  assert.equal(fresh.invocations.filter((i) => i.action === 'refresh-lists').length, 0);
});

test('refresh-lists refreshes the requested lists', async () => {
  const s = listsSetup([]);
  assert.deepEqual(await s.handler({ action: 'refresh-lists', names: ['ipsum'] }), [{ name: 'ipsum', entries: 1 }]);
  assert.deepEqual(s.calls, [['ipsum']]);
});

// --- Manager interface ----------------------------------------------------------------------------------------------

function managerSetup({ run, defaultRules = [], lists = [] }) {
  const s = setup({ run });
  const handler = createController({
    store: s.store, ec2: s.ec2, elbv2: s.elbv2, cloudwatch: s.cloudwatch, autoscaling: s.autoscaling, ecs: s.ecs,
    appscaling: s.appscaling, invokeSelf: async (payload) => { s.invocations.push(payload); }, now: s.clock.now,
    sleep: s.clock.sleep, newId: () => 'w-manager', log: silentLog,
    router: { name: 'dmt-dev', version: '0.11.0', build: 'abc', checkSchedule: 'rate(5 minutes)' }, defaultRules, ipLists: lists,
  });
  return { ...s, handler };
}

test('list returns the router and its workloads from the state table', async () => {
  const s = managerSetup({ run: { state: STATES.ASLEEP, wakeCount: 3, updatedAt: 1_700_000_000_000 } });
  const result = await s.handler({ action: 'list' });
  assert.deepEqual(result.router, { name: 'dmt-dev', version: '0.11.0', build: 'abc', checkSchedule: 'rate(5 minutes)', lastScheduledCheckAt: null, pauses: [] });
  const [workload] = result.workloads;
  assert.equal(workload.workloadId, 'demo');
  assert.equal(workload.state, STATES.ASLEEP);
  assert.equal(workload.wakeCount, 3);
  assert.equal(workload.wakeMode, 'any');
  assert.equal(workload.updatedAt, '2023-11-14T22:13:20.000Z');
  assert.equal(workload.settings.idleMinutes, 15);
  assert.deepEqual(workload.stats7d, { ignored: 0, deferred: 0, wakes: 0 });
});

test('the idle check records the kinds of a workload\'s backends, written again only when they change, and list gives them', async () => {
  const s = setup({ run: { state: STATES.AWAKE } });
  s.store.state.run.awakeSince = s.clock.now() - 60_000;
  assert.deepEqual((await s.handler({ action: 'list' })).workloads[0].backends, []);
  await s.handler({ action: 'check' });
  assert.deepEqual((await s.handler({ action: 'list' })).workloads[0].backends, ['instance']);
  const writes = s.store.state.backendKindWrites;
  await s.handler({ action: 'check' });
  assert.equal(s.store.state.backendKindWrites, writes);
});

test('list adds the 7-day totals of each workload, null when they cannot be read', async () => {
  const s = managerSetup({ run: { state: STATES.AWAKE } });
  s.store.state.stats = { 'ignored:HEAD': 2, 'ignored:bot user agent': 3, 'deferred:browser mode': 1, 'wake:probe': 4 };
  assert.deepEqual((await s.handler({ action: 'list' })).workloads[0].stats7d, { ignored: 5, deferred: 1, wakes: 4 });
  s.store.getStats = async () => { throw new Error('AccessDenied'); };
  assert.equal((await s.handler({ action: 'list' })).workloads[0].stats7d, null);
});

test('status returns the live status of a workload, with router rules, statistics and lists', async () => {
  const s = managerSetup({
    run: { state: STATES.AWAKE, awakeSince: 0 },
    defaultRules: [{ name: 'e2e', headers: [{ name: 'x-e2e', value: '1' }] }],
    lists: [{ name: 'ipsum', url: 'https://x', action: 'defer', refreshHours: 24 }],
  });
  s.store.state.lists.ipsum = { meta: { version: 'v1', format: 'ranges-v1', entries: 42, fetchedAt: 1_700_000_000_000 }, parts: {} };
  s.store.state.stats = { 'ignored:HEAD': 2 };
  const status = await s.handler({ action: 'status', workloadId: 'demo' });
  assert.equal(status.workloadId, 'demo');
  assert.equal(status.state, STATES.AWAKE);
  assert.equal(status.route, 'app');
  assert.deepEqual(status.router, { version: '0.11.0', build: 'abc' });
  assert.equal(status.targetGroupArn, s.cfg.appTargetGroupArn, 'what the manager excludes from the workload view');
  assert.deepEqual(status.noWakeRules.map((r) => [r.name, r.level]), [['e2e', 'router']]);
  assert.deepEqual(status.stats.total.ignored, { HEAD: 2 });
  assert.deepEqual(status.ipLists.map((l) => [l.name, l.entries, l.url]), [['ipsum', 42, 'https://x']]);
});

test('status gives a failed workload\'s next attempt and the fallback instance types in use (R7a)', async () => {
  const failedAt = Date.now() - 10_000;
  const s = managerSetup({ run: { state: STATES.FAILED, failedAt, consecutiveFailures: 2, failure: JSON.stringify({ kind: 'capacity', step: 'wake', message: 'no capacity', at: failedAt }) } });
  const status = await s.handler({ action: 'status', workloadId: 'demo' });
  assert.equal(status.nextAttemptAt, new Date(failedAt + 2 * (s.cfg.failedRetrySeconds ?? 60) * 1000).toISOString());
  assert.deepEqual(status.fallbacks, []);
  const awake = managerSetup({ run: { state: STATES.AWAKE, awakeSince: 0, instanceTypes: JSON.stringify({ 'i-1': { from: 't3.medium', to: 't3.large' } }) } });
  const on = await awake.handler({ action: 'status', workloadId: 'demo' });
  assert.deepEqual(on.fallbacks, [{ instance: 'i-1', from: 't3.medium', to: 't3.large' }]);
  assert.equal(on.nextAttemptAt, null);
});

test('status of an unknown workload is an error', async () => {
  const s = managerSetup({ run: { state: STATES.AWAKE } });
  await assert.rejects(s.handler({ action: 'status', workloadId: 'nope' }), /workload not configured: nope/);
});

test('force-wake wakes an asleep or failed workload, marks a pending wake during a nap, and is counted', async () => {
  for (const state of [STATES.ASLEEP, STATES.FAILED]) {
    const s = managerSetup({ run: { state, failedAt: 1 } });
    assert.deepEqual(await s.handler({ action: 'force-wake', workloadId: 'demo', by: 'ops@example.com' }), { state: STATES.WAKING });
    assert.deepEqual(s.invocations.filter((i) => i.action === 'wake'), [{ action: 'wake', workloadId: 'demo', wakeId: 'w-manager' }]);
    assert.equal(s.store.state.stats['wake:manager'], 1);
  }
  const napping = managerSetup({ run: { state: STATES.NAPPING } });
  assert.deepEqual(await napping.handler({ action: 'force-wake', workloadId: 'demo' }), { state: STATES.NAPPING, pendingWake: true });
  assert.equal(napping.store.state.run.pendingWake, true);
  const awake = managerSetup({ run: { state: STATES.AWAKE } });
  assert.deepEqual(await awake.handler({ action: 'force-wake', workloadId: 'demo' }), { state: STATES.AWAKE });
});

test('discovery moved to the manager: the discover action is unknown', async () => {
  const s = managerSetup({ run: { state: STATES.AWAKE } });
  await assert.rejects(s.handler({ action: 'discover' }), /unknown action: discover/);
});

// --- Scheduled check health -----------------------------------------------------------------------------------------

test('a scheduled check records its time; other checks do not hide a broken scheduler', async () => {
  const s = managerSetup({ run: { state: STATES.ASLEEP } });
  await s.handler({ action: 'check' });
  assert.equal(s.store.state.check?.lastScheduledCheckAt, undefined);
  await s.handler({ action: 'check', source: 'schedule' });
  assert.equal(s.store.state.check.lastScheduledCheckAt, s.clock.now());
});

test('list gives the last scheduled check and the schedule of the router', async () => {
  const s = managerSetup({ run: { state: STATES.ASLEEP } });
  await s.handler({ action: 'check', source: 'schedule' });
  const { router } = await s.handler({ action: 'list' });
  assert.equal(router.lastScheduledCheckAt, new Date(s.clock.now()).toISOString());
  assert.equal(router.checkSchedule, 'rate(5 minutes)');
});

// --- R4d: names ------------------------------------------------------------------------------------------------------

test('status and list give the workload name, its id when it has none', async () => {
  const named = setup({ run: { state: STATES.AWAKE }, cfg: testConfig({ name: 'Demo shop', source: 'manager' }) });
  assert.equal((await named.handler({ action: 'status', workloadId: 'demo' })).name, 'Demo shop');
  assert.equal((await named.handler({ action: 'list' })).workloads[0].name, 'Demo shop');
  const plain = setup({ run: { state: STATES.AWAKE } });
  assert.equal((await plain.handler({ action: 'status', workloadId: 'demo' })).name, 'demo');
});

test('rename changes only the name of a workload the manager onboarded', async () => {
  const s = setup({ run: { state: STATES.AWAKE }, cfg: testConfig({ name: 'Demo shop', source: 'manager' }) });
  assert.deepEqual(await s.handler({ action: 'rename', workloadId: 'demo', name: '  Shop front ', by: 'ops' }), { workloadId: 'demo', name: 'Shop front' });
  const cfg = await s.store.getConfig('demo');
  assert.deepEqual([cfg.name, cfg.appTargetGroupArn], ['Shop front', testConfig().appTargetGroupArn]);
  await assert.rejects(s.handler({ action: 'rename', workloadId: 'demo', name: 'x'.repeat(65), by: 'ops' }), /name: at most 64 characters/);
  await assert.rejects(s.handler({ action: 'rename', workloadId: 'demo', name: ' ', by: 'ops' }), /name: required/);
  await assert.rejects(s.handler({ action: 'rename', workloadId: 'nope', name: 'x', by: 'ops' }), /workload not configured: nope/);
  const terraform = setup({ run: { state: STATES.AWAKE } });
  await assert.rejects(terraform.handler({ action: 'rename', workloadId: 'demo', name: 'x', by: 'ops' }), /written by Terraform: set name in its workload module/);
});

test('a rename racing an offboarding never writes the configuration back', async () => {
  const s = setup({ run: { state: STATES.AWAKE }, cfg: testConfig({ name: 'Demo shop', source: 'manager' }) });
  const writes = [];
  s.store.putConfig = async (id, cfg, options) => { writes.push(options); if (options?.mustExist) return false; throw new Error('unconditional write'); };
  await assert.rejects(s.handler({ action: 'rename', workloadId: 'demo', name: 'Shop front', by: 'ops' }), /workload not configured: demo/);
  assert.deepEqual(writes, [{ mustExist: true }]);
});

// --- Scale (R4.5): router events -------------------------------------------------------------------------------------

test('each check sends the router\'s state to the manager: its workloads as the list gives them, counts and health', async () => {
  const s = setup({ run: { state: STATES.AWAKE }, cfg: testConfig({ name: 'Demo', source: 'manager' }) });
  const sent = [];
  const handler = createController({
    store: s.store, ec2: fakeEc2(s.cfg.instanceIds), elbv2: s.elbv2, cloudwatch: fakeCloudWatch([5]), autoscaling: fakeAutoScaling(), ecs: fakeEcs(), tagging: fakeTagging(fakeEcs()), appscaling: fakeAppScaling(),
    invokeSelf: async () => {}, now: s.clock.now, sleep: s.clock.sleep, log: silentLog,
    router: { name: 'dmt-dev', version: '0.21.0', build: 'abc', checkSchedule: 'rate(5 minutes)' },
    publisher: { enabled: true, checked: async (payload) => { sent.push(payload); }, stateChanged: async () => {} },
  });
  await handler({ action: 'check', source: 'schedule' });
  assert.equal(sent.length, 1);
  const [payload] = sent;
  const { workloads } = await handler({ action: 'list' });
  assert.deepEqual(payload.workloads, workloads.map((w) => ({ ...w, targetGroupArn: s.cfg.appTargetGroupArn })));
  assert.deepEqual([payload.workloads[0].name, payload.counts, typeof payload.durationMs, payload.checkedAt], ['Demo', { AWAKE: 1 }, 'number', new Date(s.clock.now()).toISOString()]);
  assert.ok(payload.health.status);
});

test('every way to FAILED records why (R7a): a failed nap, a nap or a wake stuck', async () => {
  const nap = setup({ run: { state: STATES.AWAKE } });
  nap.ec2.stopInstances = async () => { throw Object.assign(new Error('You are not authorized to perform this operation.'), { name: 'UnauthorizedOperation' }); };
  await nap.handler({ action: 'nap', workloadId: 'demo' });
  assert.deepEqual(JSON.parse(nap.store.state.run.failure), { kind: 'permission', step: 'nap', message: 'You are not authorized to perform this operation.', at: nap.clock.now() });
  assert.equal(nap.store.state.run.consecutiveFailures, 1);

  const napStuck = setup({ run: { state: STATES.NAPPING } });
  napStuck.store.state.run.updatedAt = napStuck.clock.now() - 16 * 60_000;
  await napStuck.handler({ action: 'check' });
  assert.deepEqual(JSON.parse(napStuck.store.state.run.failure), { kind: 'timeout', step: 'nap', message: 'the nap did not finish within 15 minutes (its invocation stopped)', at: napStuck.clock.now() });

  const wakeStuck = setup({ run: { state: STATES.WAKING, wakeId: 'w' } });
  wakeStuck.store.state.run.wakeStartedAt = wakeStuck.clock.now() - 12 * 60_000;
  await wakeStuck.handler({ action: 'check' });
  assert.deepEqual(JSON.parse(wakeStuck.store.state.run.failure), { kind: 'timeout', step: 'wake', message: 'the wake did not finish within 600 s (its invocation stopped)', at: wakeStuck.clock.now() });
});

test('a recovery to AWAKE clears the failure; a recovery to ASLEEP keeps it (the last wake failed) (R7a)', async () => {
  const awake = setup({ run: { state: STATES.FAILED, failedAt: 1, failure: '{"kind":"timeout"}', consecutiveFailures: 1 }, instance: 'running', target: 'waker', healthy: 1 });
  await awake.handler({ action: 'check' });
  assert.equal(awake.store.state.run.state, STATES.AWAKE);
  assert.equal('failure' in awake.store.state.run, false);
  assert.equal('consecutiveFailures' in awake.store.state.run, false);
  const asleep = setup({ run: { state: STATES.FAILED, failedAt: 1, failure: '{"kind":"timeout"}', consecutiveFailures: 1 }, instance: 'stopped', target: 'waker', healthy: 0 });
  await asleep.handler({ action: 'check' });
  assert.equal(asleep.store.state.run.state, STATES.ASLEEP);
  assert.equal(asleep.store.state.run.failure, '{"kind":"timeout"}');
});

test('wake (asg): a failed launch that will not fix itself ends the wake at once with its kind, not at the timeout (R7a)', async () => {
  const s = asgSetup({
    run: { state: STATES.WAKING, wakeId: 'w1', napBackends: JSON.stringify([{ kind: 'asg', name: 'asg-demo', min: 1, max: 3, desired: 1 }]) },
    desired: 0, target: 'waker', healthy: 0,
  });
  s.store.state.run.wakeStartedAt = s.clock.now();
  s.autoscaling.describeScalingActivities = async () => ({ Activities: [{
    StartTime: new Date(s.clock.now() + 1000), StatusCode: 'Failed',
    StatusMessage: 'The specified launch template, with template ID lt-0123456789, does not exist.',
  }] });
  const started = s.clock.now();
  const result = await s.handler({ action: 'wake', workloadId: 'demo', wakeId: 'w1' });
  assert.equal(result.state, STATES.FAILED);
  const failure = JSON.parse(s.store.state.run.failure);
  assert.deepEqual([failure.kind, failure.backend], ['configuration', 'asg:asg-demo']);
  assert.ok(s.clock.now() - started < 60_000, 'within a minute, not at the 10-minute timeout');
});

test('wake: at the timeout, the targets say why (unhealthy) (R7a)', async () => {
  const s = setup({ run: { state: STATES.WAKING, wakeId: 'w1' }, instance: 'stopped', target: 'waker', healthy: 0 });
  s.store.state.run.wakeStartedAt = s.clock.now();
  const describe = s.elbv2.describeTargetHealth;
  s.elbv2.describeTargetHealth = async (input) => {
    const out = await describe(input);
    const described = out.TargetHealthDescriptions?.length ? out.TargetHealthDescriptions : [{ Target: { Id: 'i-0123456789abcdef0' } }];
    return { TargetHealthDescriptions: described.map((d) => ({ ...d, TargetHealth: d.TargetHealth?.State === 'healthy' ? d.TargetHealth : { State: 'unhealthy', Reason: 'Target.FailedHealthChecks', Description: 'Health checks failed' } })) };
  };
  await s.handler({ action: 'wake', workloadId: 'demo', wakeId: 'w1' });
  const failure = JSON.parse(s.store.state.run.failure);
  assert.equal(failure.kind, 'unhealthy');
  assert.match(failure.message, /none healthy: Target\.FailedHealthChecks/);
});

// --- Capacity reactions (R7a) ---------------------------------------------------------------------------------------

const capacityError = (type = 't3.medium') => Object.assign(new Error(`We currently do not have sufficient ${type} capacity in the Availability Zone you requested (eu-west-1b).`), { name: 'InsufficientInstanceCapacity' });

test('wake: a capacity error of an EC2 start is tried again within the deadline, and wakes when capacity comes back', async () => {
  const s = setup({ run: { state: STATES.WAKING, wakeId: 'w1' }, instance: 'stopped', target: 'waker', healthy: 0 });
  s.store.state.run.wakeStartedAt = s.clock.now();
  const start = s.ec2.startInstances;
  let attempts = 0;
  s.ec2.startInstances = async (input) => {
    attempts += 1;
    if (attempts < 3) throw capacityError();
    s.clock.onSleep(() => { s.elbv2.state.healthy = 1; });
    return start(input);
  };
  const result = await s.handler({ action: 'wake', workloadId: 'demo', wakeId: 'w1' });
  assert.equal(result.state, STATES.AWAKE);
  assert.equal(attempts, 3);
});

test('wake: capacity until the deadline fails as capacity, with the AWS message', async () => {
  const s = setup({ run: { state: STATES.WAKING, wakeId: 'w1' }, instance: 'stopped', target: 'waker', healthy: 0 });
  s.store.state.run.wakeStartedAt = s.clock.now();
  let attempts = 0;
  s.ec2.startInstances = async () => { attempts += 1; throw capacityError(); };
  await s.handler({ action: 'wake', workloadId: 'demo', wakeId: 'w1' });
  const failure = JSON.parse(s.store.state.run.failure);
  assert.equal(failure.kind, 'capacity');
  assert.match(failure.message, /sufficient t3\.medium capacity/);
  assert.ok(attempts > 3 && attempts < 10, `${attempts} attempts in 10 minutes (30 s, 60 s, then every 120 s)`);
});

test('wake: an instance falls back to the next type of its list, and gets its own type back after the nap (FinOps)', async () => {
  const cfg = testConfig({ fallbackInstanceTypes: ['t3a.medium', 'm5.large'] });
  const s = setup({ run: { state: STATES.WAKING, wakeId: 'w1' }, cfg, instance: 'stopped', target: 'waker', healthy: 0 });
  s.store.state.run.wakeStartedAt = s.clock.now();
  const id = cfg.instanceIds[0];
  const start = s.ec2.startInstances;
  s.ec2.startInstances = async (input) => {
    if (s.ec2.state.types[id] === 't3.medium') throw capacityError('t3.medium');
    s.clock.onSleep(() => { s.elbv2.state.healthy = 1; });
    return start(input);
  };
  const result = await s.handler({ action: 'wake', workloadId: 'demo', wakeId: 'w1' });
  assert.equal(result.state, STATES.AWAKE);
  assert.equal(s.ec2.state.types[id], 't3a.medium');
  assert.equal(s.ec2.state.tags[id]['dormeto:instance-type'], 't3.medium');
  assert.deepEqual(JSON.parse(s.store.state.run.instanceTypes), { [id]: { from: 't3.medium', to: 't3a.medium' } });
  s.ec2.startInstances = start;
  s.elbv2.state.healthy = 1;
  await s.handler({ action: 'nap', workloadId: 'demo' });
  assert.equal(s.store.state.run.state, STATES.ASLEEP);
  assert.equal(s.ec2.state.types[id], 't3.medium', 'its own type back after the stop');
  assert.equal('dormeto:instance-type' in s.ec2.state.tags[id], false);
  assert.equal('instanceTypes' in s.store.state.run, false);
});

test('wake: an instance left on a fallback type (its nap failed after the stop) starts on its own type (review I1)', async () => {
  const cfg = testConfig({ fallbackInstanceTypes: ['t3a.medium'] });
  const s = setup({ run: { state: STATES.WAKING, wakeId: 'w1' }, cfg, instance: 'stopped', target: 'waker', healthy: 0 });
  s.store.state.run.wakeStartedAt = s.clock.now();
  const id = cfg.instanceIds[0];
  s.ec2.state.types[id] = 't3a.medium';
  s.ec2.state.tags[id] = { 'dormeto:instance-type': 't3.medium' };
  const start = s.ec2.startInstances;
  let startedOn = null;
  s.ec2.startInstances = async (input) => {
    startedOn = s.ec2.state.types[id];
    s.clock.onSleep(() => { s.elbv2.state.healthy = 1; });
    return start(input);
  };
  const result = await s.handler({ action: 'wake', workloadId: 'demo', wakeId: 'w1' });
  assert.equal(result.state, STATES.AWAKE);
  assert.equal(startedOn, 't3.medium', 'its own type first');
  assert.equal('dormeto:instance-type' in s.ec2.state.tags[id], false);
  assert.equal('instanceTypes' in s.store.state.run, false);
});

test('wake: a fallback the boundary refuses fails as permission, naming the access module', async () => {
  const cfg = testConfig({ fallbackInstanceTypes: ['t3a.medium'] });
  const s = setup({ run: { state: STATES.WAKING, wakeId: 'w1' }, cfg, instance: 'stopped', target: 'waker', healthy: 0 });
  s.store.state.run.wakeStartedAt = s.clock.now();
  s.ec2.startInstances = async () => { throw capacityError(); };
  s.ec2.modifyInstanceAttribute = async () => { throw Object.assign(new Error('You are not authorized to perform this operation.'), { name: 'UnauthorizedOperation' }); };
  await s.handler({ action: 'wake', workloadId: 'demo', wakeId: 'w1' });
  const failure = JSON.parse(s.store.state.run.failure);
  assert.equal(failure.kind, 'permission');
  assert.match(failure.message, /instance type fallback refused.*apply the access module/);
});

test('wake: a hibernated instance never falls back to another type: tried again on its own type, failing at the deadline with why (hibernation)', async () => {
  const cfg = testConfig({ fallbackInstanceTypes: ['t3a.medium', 'm5.large'] });
  const s = setup({ run: { state: STATES.WAKING, wakeId: 'w1' }, cfg, instance: 'stopped', target: 'waker', healthy: 0 });
  s.store.state.run.wakeStartedAt = s.clock.now();
  const id = cfg.instanceIds[0];
  s.ec2.state.configured[id] = true;
  s.ec2.state.reasons[id] = 'Client.UserInitiatedHibernate';
  // AWS's full message (325 characters): the note comes first, so that the failure's 300-character cut keeps it.
  const aws = 'We currently do not have sufficient m5.large capacity in the Availability Zone you requested (us-east-1a). Our system will be working on provisioning additional capacity. You can currently get m5.large capacity by not specifying an Availability Zone in your request or choosing us-east-1b, us-east-1c, us-east-1d, us-east-1f.';
  assert.equal(aws.length, 325);
  let attempts = 0;
  s.ec2.startInstances = async () => { attempts += 1; throw Object.assign(new Error(aws), { name: 'InsufficientInstanceCapacity' }); };
  await s.handler({ action: 'wake', workloadId: 'demo', wakeId: 'w1' });
  const failure = JSON.parse(s.store.state.run.failure);
  assert.equal(failure.kind, 'capacity');
  assert.ok(failure.message.startsWith('hibernated: AWS does not allow its type to change; We currently do not have sufficient m5.large capacity'), failure.message);
  assert.deepEqual(s.ec2.state.modified, [], 'AWS refuses any change of a hibernated instance');
  assert.equal(s.ec2.state.tags[id]?.['dormeto:instance-type'], undefined);
  assert.ok(attempts > 3 && attempts < 10, `${attempts} attempts on its own type until the deadline`);
});

test('wake: a hibernated instance is never modified, even tagged with its own type (AWS refuses any change of it)', async () => {
  const cfg = testConfig({ fallbackInstanceTypes: ['t3a.medium'] });
  const s = setup({ run: { state: STATES.WAKING, wakeId: 'w1' }, cfg, instance: 'stopped', target: 'waker', healthy: 0 });
  s.store.state.run.wakeStartedAt = s.clock.now();
  const id = cfg.instanceIds[0];
  s.ec2.state.types[id] = 't3a.medium';
  s.ec2.state.tags[id] = { 'dormeto:instance-type': 't3.medium' };
  s.ec2.state.configured[id] = true;
  s.ec2.state.reasons[id] = 'Client.UserInitiatedHibernate';
  s.ec2.state.onStart.push(() => { s.clock.onSleep(() => { s.elbv2.state.healthy = 1; }); });
  const result = await s.handler({ action: 'wake', workloadId: 'demo', wakeId: 'w1' });
  assert.equal(result.state, STATES.AWAKE);
  assert.deepEqual(s.ec2.state.modified, []);
});

test('wake (rds): a capacity error of the database start is tried again within the deadline', async () => {
  const cfg = testConfig({ wakeTimeoutSeconds: 1800 });
  const s = setup({ run: { state: STATES.WAKING, wakeId: 'w1', napBackends: JSON.stringify([{ kind: 'rds-instance', id: 'db1' }, { kind: 'instance', id: cfg.instanceIds[0] }]) }, cfg, instance: 'stopped', target: 'waker', healthy: 0, databases: { instances: { db1: { status: 'stopped' } } } });
  s.store.state.run.wakeStartedAt = s.clock.now();
  const startDb = s.rds.startDBInstance;
  let attempts = 0;
  s.rds.startDBInstance = async (input) => {
    attempts += 1;
    if (attempts < 2) throw Object.assign(new Error('no capacity for your instance class db.t4g.micro in AZ eu-west-1b'), { name: 'InsufficientDBInstanceCapacity' });
    return startDb(input);
  };
  s.ec2.state.onStart.push(() => { s.clock.onSleep(() => { s.elbv2.state.healthy = 1; }); });
  const rdsState = s.rds.state;
  s.clock.onSleep(() => { for (const db of Object.values(rdsState.instances)) if (db.status === 'starting') db.status = 'available'; });
  const result = await s.handler({ action: 'wake', workloadId: 'demo', wakeId: 'w1' });
  assert.equal(result.state, STATES.AWAKE);
  assert.equal(attempts, 2);
});

test('wake (asg): no capacity reported by Auto Scaling is waited out (it keeps trying), failing as capacity at the deadline', async () => {
  const s = asgSetup({
    run: { state: STATES.WAKING, wakeId: 'w1', napBackends: JSON.stringify([{ kind: 'asg', name: 'asg-demo', min: 1, max: 3, desired: 1 }]) },
    desired: 0, target: 'waker', healthy: 0,
  });
  s.store.state.run.wakeStartedAt = s.clock.now();
  s.autoscaling.describeScalingActivities = async () => ({ Activities: [{ StartTime: new Date(s.clock.now()), StatusCode: 'Failed', StatusMessage: 'We currently do not have sufficient t3.micro capacity in the Availability Zone you requested (eu-west-1a).' }] });
  const started = s.clock.now();
  await s.handler({ action: 'wake', workloadId: 'demo', wakeId: 'w1' });
  const failure = JSON.parse(s.store.state.run.failure);
  assert.deepEqual([failure.kind, failure.backend], ['capacity', 'asg:asg-demo']);
  assert.ok(s.clock.now() - started >= 600_000, 'waited until the deadline');
});

test('check: a failed workload whose backends run without a healthy target is released after its idle window, not before, not paused (R7a, FinOps)', async () => {
  const cfg = testConfig({ idleMinutes: 15 });
  const recent = setup({ run: { state: STATES.FAILED, failure: '{"kind":"unhealthy"}', consecutiveFailures: 1 }, cfg, instance: 'running', target: 'waker', healthy: 0 });
  recent.store.state.run.failedAt = recent.clock.now() - 10 * 60_000;
  await recent.handler({ action: 'check' });
  assert.equal(recent.store.state.run.state, STATES.FAILED);
  assert.equal(recent.ec2.state.stopped, 0);
  assert.deepEqual(recent.invocations, []);

  const old = setup({ run: { state: STATES.FAILED, failure: '{"kind":"unhealthy"}', consecutiveFailures: 1 }, cfg, instance: 'running', target: 'waker', healthy: 0 });
  old.store.state.run.failedAt = old.clock.now() - 16 * 60_000;
  await old.handler({ action: 'check' });
  assert.deepEqual(old.invocations, [{ action: 'release', workloadId: 'demo' }]);
  const result = await old.handler({ action: 'release', workloadId: 'demo' });
  assert.equal(result.state, STATES.ASLEEP);
  assert.equal(old.ec2.state.instances['i-0123456789abcdef0'], 'stopped');
  assert.equal(old.store.state.run.state, STATES.ASLEEP);
  assert.equal(old.store.state.run.failure, '{"kind":"unhealthy"}', 'the last wake failed: kept for the manager');
  assert.equal(routeOf(old.elbv2, old.cfg), 'waker');

  const paused = setup({ run: { state: STATES.FAILED, failure: '{"kind":"unhealthy"}' }, cfg, instance: 'running', target: 'waker', healthy: 0 });
  paused.store.state.run.failedAt = paused.clock.now() - 16 * 60_000;
  await paused.handler({ action: 'pause', by: 'ops', reason: 'debugging' });
  paused.invocations.length = 0;
  await paused.handler({ action: 'check' });
  assert.deepEqual(paused.invocations.filter((i) => i.action === 'release'), [], 'a paused workload is left as it is');
  // A release that finds the workload woken meanwhile changes nothing.
  const woken = setup({ run: { state: STATES.AWAKE }, cfg, instance: 'running', target: 'app', healthy: 1 });
  assert.equal((await woken.handler({ action: 'release', workloadId: 'demo' })).state, 'SKIPPED');
});

// A Kubernetes workload behind a TargetGroupBinding (the rule switch: today's rules), napped and woken by the controller.
function k8sSetup(run, { replicas = 2, pods = 2 } = {}) {
  const cfg = k8sConfig({ switch: 'rule' });
  const node = 'ip-10-0-1-1.eu-west-1.compute.internal';
  const k8s = fakeKubernetes({
    owners: [k8sOwner('web', { replicas })],
    pods: Array.from({ length: pods }, (_, i) => k8sPod(`web-${i + 1}`, { ip: `10.0.1.${i + 1}`, node })),
    nodes: [k8sNode(node, { labels: { 'karpenter.sh/nodepool': 'default' } })],
  });
  const s = setup({ run, cfg, k8s, target: run.state === STATES.AWAKE ? 'app' : 'waker', healthy: run.state === STATES.AWAKE ? pods : 0 });
  s.elbv2.state.targets = k8s.state.pods.map((p) => ({ Id: p.status.podIP, State: 'healthy' }));
  return { ...s, k8s };
}

test('nap of a Kubernetes workload: the waker switched in, the owner scaled to 0, its replicas recorded and its pods described (R9)', async () => {
  const s = k8sSetup({ state: STATES.AWAKE });
  const events = [];
  const store = s.store;
  const transition = store.transition.bind(store);
  store.transition = async (id, spec) => { if (spec.event) events.push(spec.event); return transition(id, spec); };
  const result = await s.handler({ action: 'nap', workloadId: 'demo' });
  assert.equal(result.state, STATES.ASLEEP);
  assert.equal(routeOf(s.elbv2, s.cfg), 'waker');
  assert.equal(s.k8s.state.owners[0].spec.replicas, 0);
  assert.deepEqual(JSON.parse(s.store.state.run.napBackends), [
    { kind: 'k8s', id: 'eks-demo/demo/Deployment/web', cluster: 'eks-demo', namespace: 'demo', owner: { kind: 'Deployment', name: 'web' }, replicas: 2, keda: null },
  ]);
  assert.deepEqual(events.at(-1).stopped, [
    { kind: 'k8s-pods', count: 2, cpu: 0.25, memoryGb: 0.5, nodeType: 'm5.large', os: 'Linux', autoscaled: true, allocatable: { cpu: 1.93, memoryGb: 6.886 } },
  ]);
});

test('a Kubernetes nap does not wait for the targets of its gone pods to drain (the target group\'s deregistration delay, 300 s by default); a target still serving holds it', async () => {
  // The controller deregisters a pod as it terminates: its target drains for the group's deregistration delay, an IP that
  // never serves again (read on dev-eks: every nap waited the 2-minute release timeout).
  const napped = (s, state) => {
    const describe = s.elbv2.describeTargetHealth;
    s.elbv2.describeTargetHealth = async (input) => {
      if (s.k8s.state.owners[0].spec.replicas === 0) s.elbv2.state.targets = s.elbv2.state.targets.map((t) => ({ ...t, State: state }));
      return describe(input);
    };
  };
  const s = k8sSetup({ state: STATES.AWAKE });
  napped(s, 'draining');
  const t0 = s.clock.now();
  assert.equal((await s.handler({ action: 'nap', workloadId: 'demo' })).state, STATES.ASLEEP);
  assert.ok(s.clock.now() - t0 < 120_000, `waited ${(s.clock.now() - t0) / 1000} s`);

  const serving = k8sSetup({ state: STATES.AWAKE });
  napped(serving, 'healthy');
  const t1 = serving.clock.now();
  assert.equal((await serving.handler({ action: 'nap', workloadId: 'demo' })).state, STATES.ASLEEP);
  assert.ok(serving.clock.now() - t1 >= 120_000, 'a target still healthy holds the nap up to the release timeout');
});

test('wake of a Kubernetes workload: the recorded replicas back, then the app once a target is healthy', async () => {
  const napBackends = JSON.stringify([{ kind: 'k8s', id: 'eks-demo/demo/Deployment/web', cluster: 'eks-demo', namespace: 'demo', owner: { kind: 'Deployment', name: 'web' }, replicas: 2, keda: null }]);
  const s = k8sSetup({ state: STATES.WAKING, wakeId: 'w1', napBackends }, { replicas: 0, pods: 0 });
  s.elbv2.state.targets = undefined;
  s.clock.onSleep(() => { if (s.k8s.state.owners[0].spec.replicas === 2) s.elbv2.state.healthy = 1; });
  const result = await s.handler({ action: 'wake', workloadId: 'demo', wakeId: 'w1' });
  assert.equal(result.state, STATES.AWAKE);
  assert.equal(s.k8s.state.owners[0].spec.replicas, 2);
  assert.equal(routeOf(s.elbv2, s.cfg), 'app');
});

test('the status action shows a Kubernetes backend', async () => {
  const s = k8sSetup({ state: STATES.AWAKE });
  const status = await s.handler({ action: 'status', workloadId: 'demo' });
  assert.equal(status.discovery, 'kubernetes');
  assert.deepEqual(status.backends.map((b) => [b.kind, b.id, b.status, b.replicas, b.switch]), [['k8s', 'eks-demo/demo/Deployment/web', 'running', 2, 'rule']]);
});

// A Kubernetes workload behind an Ingress in an IngressGroup: Dormeto's Ingress before the customer's, the load balancer
// as the controller leaves it (stuck: it does not apply Dormeto's Ingress), each target group with its own targets.
const DORMETO_TG = 'arn:aws:elasticloadbalancing:eu-west-1:111122223333:targetgroup/k8s-demo-web-1da7898e9b/333';
const ALB = 'alb.ingress.kubernetes.io/';
function groupedSetup(run, { stuck = false, events = [], cloudwatch } = {}) {
  const cfg = k8sGroupedConfig();
  const awake = run.state === STATES.AWAKE;
  const target = awake ? 'app' : 'waker';
  const pods = awake ? [k8sPod('web-1', { ip: '10.0.1.1' }), k8sPod('web-2', { ip: '10.0.1.2' })] : [];
  const ours = { ...dormetoIngress(cfg, weightsOf(target), k8sCustomerIngress()) };
  ours.metadata = { ...ours.metadata, resourceVersion: '50' };
  const k8s = fakeKubernetes({ owners: [k8sOwner('web', { replicas: awake ? 2 : 0 })], pods, ingresses: [k8sCustomerIngress(), ours], events, nodes: [k8sNode('ip-10-0-1-1.eu-west-1.compute.internal')] });
  const s = setup({ run, cfg, k8s, target });
  if (cloudwatch) s.handler = createController({ ...s, store: s.store, cloudwatch, kubernetesOf: async () => k8s, invokeSelf: async (p) => { s.invocations.push(p); }, now: s.clock.now, sleep: s.clock.sleep, log: silentLog });
  const host = (h) => ({ Field: 'host-header', HostHeaderConfig: { Values: [h] } });
  const conditions = [host('web.example.com'), { Field: 'path-pattern', PathPatternConfig: { Values: ['/*'] } }];
  const forward = (groups) => [{ Type: 'forward', Order: 1, ForwardConfig: { TargetGroups: groups.map(([TargetGroupArn, Weight]) => ({ TargetGroupArn, Weight })) } }];
  const rule = ([app, waker]) => ({ actions: forward([[DORMETO_TG, app], [cfg.wakerTargetGroupArn, waker]]), conditions, priority: '1', tags: {} });
  s.elbv2.state.rules.clear();
  s.elbv2.state.rules.set('arn:rule/dormeto', rule(awake ? [1, 0] : [0, 1]));
  s.elbv2.state.rules.set('arn:rule/customer', { actions: forward([[cfg.appTargetGroupArn, 1]]), conditions, priority: '2', tags: {} });
  const ips = pods.map((p) => ({ Id: p.status.podIP, State: 'healthy' }));
  s.elbv2.state.targetsOf = { [cfg.appTargetGroupArn]: ips, [DORMETO_TG]: [...ips] };
  const switches = [];
  k8s.state.onIngress = (ingress) => {
    if (ingress?.metadata.name !== 'dormeto-demo') return;
    const { targetGroups } = JSON.parse(ingress.metadata.annotations[`${ALB}actions.dormeto`]).forwardConfig;
    switches.push({ at: s.clock.now(), app: targetGroups[0].weight });
    if (!stuck) s.elbv2.state.rules.set('arn:rule/dormeto', rule([targetGroups[0].weight, targetGroups[1].weight]));
  };
  const dormetoWeights = () => s.elbv2.state.rules.get('arn:rule/dormeto').actions[0].ForwardConfig.TargetGroups.map((tg) => tg.Weight);
  return { ...s, k8s, switches, dormetoWeights };
}

test('nap of a grouped Ingress workload: Dormeto\'s Ingress switched to the waker (never a rule of the controller), then the owner scaled to 0', async () => {
  const s = groupedSetup({ state: STATES.AWAKE });
  const result = await s.handler({ action: 'nap', workloadId: 'demo' });
  assert.equal(result.state, STATES.ASLEEP);
  assert.deepEqual(s.dormetoWeights(), [0, 1]);
  assert.equal(s.elbv2.state.modifyCount, 0, 'no ModifyRule');
  assert.equal(s.k8s.state.owners[0].spec.replicas, 0);
});

test('a nap whose switch the load balancer does not apply goes back to the application, still awake, the owner untouched (review focus 2)', async () => {
  const s = groupedSetup({ state: STATES.AWAKE }, { stuck: true });
  const result = await s.handler({ action: 'nap', workloadId: 'demo' });
  assert.equal(result.state, STATES.AWAKE);
  assert.equal(result.aborted, true);
  assert.match(result.error, /did not apply the switch to the waker within 120 s/);
  assert.equal(s.store.state.run.state, STATES.AWAKE);
  assert.equal(s.k8s.state.owners[0].spec.replicas, 2);
  const ours = s.k8s.state.ingresses.find((i) => i.metadata.name === 'dormeto-demo');
  assert.equal(JSON.parse(ours.metadata.annotations[`${ALB}actions.dormeto`]).forwardConfig.targetGroups[0].weight, 1, 'Dormeto\'s Ingress back on the application');
});

test('a grouped Ingress wake waits for a healthy target in Dormeto\'s own target group, not the customer\'s, before switching back', async () => {
  const napBackends = JSON.stringify([{ kind: 'k8s', id: 'eks-demo/demo/Deployment/web', cluster: 'eks-demo', namespace: 'demo', owner: { kind: 'Deployment', name: 'web' }, replicas: 2, keda: null }]);
  const s = groupedSetup({ state: STATES.WAKING, wakeId: 'w1', napBackends });
  // The customer's target group registers the pods first; Dormeto's a minute later.
  let healthyAt = null;
  s.clock.onSleep((t) => {
    if (s.k8s.state.owners[0].spec.replicas !== 2) return;
    s.elbv2.state.targetsOf[s.cfg.appTargetGroupArn] = [{ Id: '10.0.1.9', State: 'healthy' }];
    if (healthyAt === null) healthyAt = t + 60_000;
    if (t >= healthyAt) s.elbv2.state.targetsOf[DORMETO_TG] = [{ Id: '10.0.1.9', State: 'healthy' }];
  });
  const result = await s.handler({ action: 'wake', workloadId: 'demo', wakeId: 'w1' });
  assert.equal(result.state, STATES.AWAKE);
  assert.deepEqual(s.dormetoWeights(), [1, 0]);
  assert.ok(s.switches.length === 1 && s.switches[0].app === 1 && s.switches[0].at >= healthyAt, 'switched once Dormeto\'s target group had a healthy target');
});

test('a wake whose switch back the load balancer does not apply fails as configuration, with the controller\'s warnings', async () => {
  const napBackends = JSON.stringify([{ kind: 'k8s', id: 'eks-demo/demo/Deployment/web', cluster: 'eks-demo', namespace: 'demo', owner: { kind: 'Deployment', name: 'web' }, replicas: 2, keda: null }]);
  const events = [{ involvedObject: { kind: 'Ingress', name: 'dormeto-demo' }, type: 'Warning', reason: 'FailedDeployModel', message: 'Failed deploy model due to AccessDenied', lastTimestamp: '2026-10-11T10:00:00Z' }];
  const s = groupedSetup({ state: STATES.WAKING, wakeId: 'w1', napBackends }, { stuck: true, events });
  s.elbv2.state.targetsOf[DORMETO_TG] = [{ Id: '10.0.1.9', State: 'healthy' }];
  const result = await s.handler({ action: 'wake', workloadId: 'demo', wakeId: 'w1' });
  assert.equal(result.state, STATES.FAILED);
  assert.equal(JSON.parse(s.store.state.run.failure).kind, 'configuration');
  assert.match(JSON.parse(s.store.state.run.failure).message, /FailedDeployModel: Failed deploy model due to AccessDenied/);
});

test('the idle check of a grouped Ingress workload counts the requests of Dormeto\'s target group, which takes them while its rule is there', async () => {
  const minute = fakeClock().now() - 3 * 60_000;
  const queries = [];
  const cloudwatch = {
    async getMetricData(input) {
      queries.push(input);
      return { MetricDataResults: input.MetricDataQueries.map((q) => ({ Id: q.Id, Values: q.MetricStat.Metric.Dimensions[1].Value.includes('k8s-demo-web-1da7898e9b') ? [5] : [], Timestamps: [new Date(minute)] })) };
    },
  };
  const s = groupedSetup({ state: STATES.AWAKE, awakeSince: 1 }, { cloudwatch });
  const [result] = await s.handler({ action: 'check' });
  assert.equal(result.idleNotBefore, minute + 60_000 + 15 * 60_000);
  assert.deepEqual(queries[0].MetricDataQueries.map((q) => q.MetricStat.Metric.Dimensions[1].Value), [s.cfg.appTargetGroupDimension, 'targetgroup/k8s-demo-web-1da7898e9b/333']);
  assert.deepEqual(s.invocations, []);
});

test('the status of a grouped Ingress workload names the target group its requests go to (Dormeto\'s), for the manager\'s request charts', async () => {
  const s = groupedSetup({ state: STATES.AWAKE });
  const status = await s.handler({ action: 'status', workloadId: 'demo' });
  assert.equal(status.route, 'app');
  assert.equal(status.servingTargetGroupArn, DORMETO_TG);
  const plain = setup({ run: { state: STATES.AWAKE } });
  assert.equal((await plain.handler({ action: 'status', workloadId: 'demo' })).servingTargetGroupArn, plain.cfg.appTargetGroupArn);
});

// A Kubernetes wake whose pod waits for a node (Karpenter launching one): capacity, waited for until the wake's deadline.
function pendingWake() {
  const start = fakeClock().now();
  const napBackends = JSON.stringify([{ kind: 'k8s', id: 'eks-demo/demo/Deployment/web', cluster: 'eks-demo', namespace: 'demo', owner: { kind: 'Deployment', name: 'web' }, replicas: 1, keda: null }]);
  const k8s = fakeKubernetes({
    owners: [k8sOwner('web', { replicas: 0 })],
    pods: [k8sPod('web-5d9c-a1', { labels: { app: 'web' }, phase: 'Pending', ready: false, owner: { kind: 'ReplicaSet', name: 'web-5d4f8' } })],
    events: [{ involvedObject: { kind: 'Pod', name: 'web-5d9c-a1' }, type: 'Warning', reason: 'FailedScheduling', message: '0/1 nodes are available: 1 Insufficient cpu.', lastTimestamp: new Date(start + 5_000).toISOString() }],
  });
  const s = setup({ run: { state: STATES.WAKING, wakeId: 'w1', wakeStartedAt: start, napBackends }, cfg: k8sConfig({ switch: 'rule' }), k8s, target: 'waker', healthy: 0 });
  return { ...s, k8s, start };
}

test('a Kubernetes wake whose pods wait for a node goes on while the scheduler waits, and completes once a target is healthy', async () => {
  const s = pendingWake();
  s.clock.onSleep((t) => { if (t - s.start >= 90_000) s.elbv2.state.healthy = 1; });
  const result = await s.handler({ action: 'wake', workloadId: 'demo', wakeId: 'w1' });
  assert.equal(result.state, STATES.AWAKE);
  assert.ok(s.clock.now() - s.start >= 90_000);
});

test('a Kubernetes wake whose pods never get a node fails at its deadline as capacity, quoting the scheduler\'s Event', async () => {
  const s = pendingWake();
  const result = await s.handler({ action: 'wake', workloadId: 'demo', wakeId: 'w1' });
  assert.equal(result.state, STATES.FAILED);
  const failure = JSON.parse(s.store.state.run.failure);
  assert.deepEqual([failure.kind, failure.backend], ['capacity', 'k8s:eks-demo/demo/Deployment/web']);
  assert.equal(failure.message, 'pod web-5d9c-a1: FailedScheduling: 0/1 nodes are available: 1 Insufficient cpu.');
  assert.ok(s.clock.now() - s.start >= 300_000, 'the Kubernetes wake timeout (5 minutes)');
});

test('clusterCheck: whether the router reaches a cluster and may do what Kubernetes workloads need, with what is missing', async () => {
  const k8s = fakeKubernetes();
  k8s.state.review = { resourceRules: ROUTER_RULES.filter((r) => !r.resources.includes('nodes')).map((r) => ({ apiGroups: [r.group], resources: r.resources, verbs: r.verbs })), incomplete: false };
  const s = setup({ run: { state: STATES.AWAKE }, k8s });
  assert.deepEqual(await s.handler({ action: 'clusterCheck', cluster: 'eks-demo', namespace: 'demo' }), { cluster: 'eks-demo', reachable: true, allowed: false, missing: ['get nodes'] });
  assert.deepEqual(k8s.state.calls.at(-1), ['REVIEW', 'demo']);
  k8s.state.review.resourceRules.push({ apiGroups: [''], resources: ['nodes'], verbs: ['get'] });
  assert.deepEqual(await s.handler({ action: 'clusterCheck', cluster: 'eks-demo' }), { cluster: 'eks-demo', reachable: true, allowed: true, missing: [] });
  assert.deepEqual(k8s.state.calls.at(-1), ['REVIEW', 'default']);
});

test('clusterCheck: a cluster without the router\'s access entry, or one it cannot reach, says so', async () => {
  const k8s = fakeKubernetes();
  const s = setup({ run: { state: STATES.AWAKE }, k8s });
  k8s.state.reviewError = Object.assign(new Error('Unauthorized'), { name: 'KubernetesError', status: 401, reason: 'Unauthorized' });
  assert.deepEqual(await s.handler({ action: 'clusterCheck', cluster: 'eks-demo' }), {
    cluster: 'eks-demo', reachable: true, allowed: false, missing: [], reason: 'the cluster does not know the router\'s role (no access entry, or not mapped in aws-auth): Unauthorized',
  });
  k8s.state.reviewError = Object.assign(new Error('GET /apis: no connection within 3000 ms'), { name: 'KubernetesError', status: 0, reason: 'Timeout' });
  assert.deepEqual(await s.handler({ action: 'clusterCheck', cluster: 'eks-demo' }), {
    cluster: 'eks-demo', reachable: false, allowed: false, missing: [], reason: 'GET /apis: no connection within 3000 ms',
  });
});

test('clusterCheck: rights an EKS access policy gives (a review that cannot list them) are asked one by one', async () => {
  const k8s = fakeKubernetes();
  k8s.state.review = { resourceRules: [{ apiGroups: ['authorization.k8s.io'], resources: ['selfsubjectrulesreviews'], verbs: ['create'] }], incomplete: true };
  k8s.state.allow = ({ verb, resource }) => !(verb === 'get' && resource === 'nodes');
  const s = setup({ run: { state: STATES.AWAKE }, k8s });
  assert.deepEqual(await s.handler({ action: 'clusterCheck', cluster: 'eks-demo', namespace: 'demo' }), { cluster: 'eks-demo', reachable: true, allowed: false, missing: ['get nodes'] });
  const asked = k8s.state.calls.filter(([what]) => what === 'ACCESS').map(([, a]) => a);
  assert.deepEqual(asked.find((a) => a.resource === 'deployments' && a.subresource === 'scale' && a.verb === 'patch'), { namespace: 'demo', verb: 'patch', group: 'apps', resource: 'deployments', subresource: 'scale' });
  assert.equal(asked.find((a) => a.resource === 'nodes').namespace, undefined, 'nodes belong to no namespace');
});

// Drift (vision docs/specs/2026-10-11-kubernetes-design.md, section 8): Kubernetes changes do not reach CloudTrail, the
// check sees them.
const drift = (s) => (s.store.state.drift ?? []).map((e) => [e.kind, e.detail]);

test('GitOps resetting the replicas while asleep: the check marks the workload awake and reports the drift, no visitor\'s wake counted (review focus 3)', async () => {
  const napBackends = JSON.stringify([{ kind: 'k8s', id: 'eks-demo/demo/Deployment/web', cluster: 'eks-demo', namespace: 'demo', owner: { kind: 'Deployment', name: 'web' }, replicas: 2, keda: null }]);
  const s = k8sSetup({ state: STATES.ASLEEP, napBackends, wakeCount: 4 });
  s.elbv2.state.healthy = 2;
  await s.handler({ action: 'check' });
  assert.equal(s.store.state.run.state, STATES.AWAKE);
  assert.equal(s.store.state.run.wakeCount, 4);
  assert.deepEqual(drift(s), [['replicas set while asleep', 'Deployment demo/web runs 2 replicas, set outside Dormeto (a GitOps tool resetting spec.replicas?)']]);
  // One replica, said so (read on dev-eks: "runs 1 replicas").
  const one = k8sSetup({ state: STATES.ASLEEP, napBackends, wakeCount: 4 }, { replicas: 1, pods: 1 });
  one.elbv2.state.healthy = 1;
  await one.handler({ action: 'check' });
  assert.deepEqual(drift(one), [['replicas set while asleep', 'Deployment demo/web runs 1 replica, set outside Dormeto (a GitOps tool resetting spec.replicas?)']]);
});

test('Dormeto\'s Ingress deleted: the check reports it and applies it again', async () => {
  const s = groupedSetup({ state: STATES.AWAKE, awakeSince: s0() });
  s.k8s.state.ingresses = s.k8s.state.ingresses.filter((i) => i.metadata.name !== 'dormeto-demo');
  s.elbv2.state.rules.delete('arn:rule/dormeto');
  await s.handler({ action: 'check' });
  assert.deepEqual(drift(s), [['Dormeto Ingress re-applied', 'Dormeto\'s Ingress demo/dormeto-demo is missing']]);
  const ours = s.k8s.state.ingresses.find((i) => i.metadata.name === 'dormeto-demo');
  assert.equal(JSON.parse(ours.metadata.annotations[`${ALB}actions.dormeto`]).forwardConfig.targetGroups[0].weight, 1);
});

test('a target group annotation the customer changed: the check reports it and copies it again into Dormeto\'s Ingress', async () => {
  const s = groupedSetup({ state: STATES.AWAKE, awakeSince: s0() });
  s.k8s.state.ingresses.find((i) => i.metadata.name === 'web').metadata.annotations[`${ALB}healthcheck-path`] = '/ready';
  await s.handler({ action: 'check' });
  assert.deepEqual(drift(s), [['Dormeto Ingress re-applied', `Dormeto's Ingress demo/dormeto-demo differs: ${ALB}healthcheck-path`]]);
  assert.equal(s.k8s.state.ingresses.find((i) => i.metadata.name === 'dormeto-demo').metadata.annotations[`${ALB}healthcheck-path`], '/ready');
  // Applied: the next check finds nothing.
  await s.handler({ action: 'check' });
  assert.equal(drift(s).length, 1);
});

test('a patched lone Ingress reverted (GitOps): the check reports it and patches it again', async () => {
  const cfg = k8sConfig({ switch: 'patched-ingress', owner: { kind: 'Deployment', name: 'web' }, ingress: { name: 'web', ruleIndex: 1, service: { name: 'web', port: { number: 80 } } } });
  const lone = k8sCustomerIngress();
  delete lone.metadata.annotations[`${ALB}group.name`];
  const k8s = fakeKubernetes({ owners: [k8sOwner('web', { replicas: 2 })], pods: [k8sPod('web-1', { ip: '10.0.1.1' })], ingresses: [lone] });
  const s = setup({ run: { state: STATES.AWAKE, awakeSince: s0() }, cfg, k8s });
  s.elbv2.state.rules.get(cfg.ruleArn).tags = {};
  s.elbv2.state.targets = [{ Id: '10.0.1.1', State: 'healthy' }];
  await s.handler({ action: 'check' });
  assert.deepEqual(drift(s), [['Ingress patch re-applied', 'the actions annotation of Ingress demo/web is missing (reverted?)']]);
  const web = k8s.state.ingresses[0];
  assert.equal(web.spec.rules[1].http.paths[0].backend.service.name, 'dormeto');
  assert.ok(web.metadata.annotations[`${ALB}actions.dormeto`]);
});
const s0 = () => fakeClock().now() - 60_000;

test('the list gives each workload\'s tags ({} without)', async () => {
  const tagged = setup({ run: { state: STATES.AWAKE }, cfg: testConfig({ tags: { team: 'payments' } }) });
  assert.deepEqual((await tagged.handler({ action: 'list' })).workloads[0].tags, { team: 'payments' });
  const plain = setup({ run: { state: STATES.AWAKE } });
  assert.deepEqual((await plain.handler({ action: 'list' })).workloads[0].tags, {});
});

test('tag replaces the tags of a workload the manager onboarded', async () => {
  const s = setup({ run: { state: STATES.AWAKE }, cfg: testConfig({ name: 'Demo shop', source: 'manager', tags: { team: 'old' } }) });
  assert.deepEqual(await s.handler({ action: 'tag', workloadId: 'demo', tags: { team: 'payments', env: 'staging' }, by: 'ops' }), { workloadId: 'demo', tags: { team: 'payments', env: 'staging' } });
  const cfg = await s.store.getConfig('demo');
  assert.deepEqual([cfg.tags, cfg.name, cfg.appTargetGroupArn], [{ team: 'payments', env: 'staging' }, 'Demo shop', testConfig().appTargetGroupArn]);
  assert.deepEqual(await s.handler({ action: 'tag', workloadId: 'demo', tags: {}, by: 'ops' }), { workloadId: 'demo', tags: {} });
  assert.deepEqual((await s.store.getConfig('demo')).tags, {});
});

test('tag refuses bad tags, a Terraform workload and an unknown one, changing nothing', async () => {
  const s = setup({ run: { state: STATES.AWAKE }, cfg: testConfig({ source: 'manager', tags: { team: 'kept' } }) });
  await assert.rejects(s.handler({ action: 'tag', workloadId: 'demo', tags: { 'dormeto:x': '1' }, by: 'ops' }), /tag "dormeto:x": the dormeto: prefix is reserved/);
  await assert.rejects(s.handler({ action: 'tag', workloadId: 'demo', tags: { team: 'a,b' }, by: 'ops' }), /tag "team": value characters/);
  await assert.rejects(s.handler({ action: 'tag', workloadId: 'demo', by: 'ops' }), /tags: an object/);
  assert.deepEqual((await s.store.getConfig('demo')).tags, { team: 'kept' });
  await assert.rejects(s.handler({ action: 'tag', workloadId: 'nope', tags: {}, by: 'ops' }), /workload not configured: nope/);
  const terraform = setup({ run: { state: STATES.AWAKE } });
  await assert.rejects(terraform.handler({ action: 'tag', workloadId: 'demo', tags: { team: 'x' }, by: 'ops' }), /workload demo was written by Terraform: set tags in its workload module/);
});

test('a tag racing an offboarding never writes the configuration back', async () => {
  const s = setup({ run: { state: STATES.AWAKE }, cfg: testConfig({ source: 'manager' }) });
  const writes = [];
  s.store.putConfig = async (id, cfg, options) => { writes.push(options); if (options?.mustExist) return false; throw new Error('unconditional write'); };
  await assert.rejects(s.handler({ action: 'tag', workloadId: 'demo', tags: { team: 'x' }, by: 'ops' }), /workload not configured: demo/);
  assert.deepEqual(writes, [{ mustExist: true }]);
});

test('the status gives the workload\'s tags ({} without), for the manager when its router stopped reporting', async () => {
  const tagged = setup({ run: { state: STATES.AWAKE }, cfg: testConfig({ tags: { team: 'payments' } }) });
  assert.deepEqual((await tagged.handler({ action: 'status', workloadId: 'demo' })).tags, { team: 'payments' });
  const plain = setup({ run: { state: STATES.AWAKE } });
  assert.deepEqual((await plain.handler({ action: 'status', workloadId: 'demo' })).tags, {});
});

// --- R12: schedules ---------------------------------------------------------------------------------------------------

const weekly = () => ({
  timeZone: 'europe/paris',
  windows: [{ kind: 'awake', days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '08:30', end: '19:00' }],
  maxNapDays: 7,
});

test('schedule: invalid answers the problems and writes nothing', async () => {
  const s = setup({ run: { state: STATES.AWAKE } });
  const bad = { ...weekly(), maxNapDays: 99 };
  const result = await s.handler({ action: 'schedule', workloadId: 'demo', schedule: bad, by: 'me' });
  assert.ok(result.problems.some((p) => /maxNapDays/.test(p)));
  assert.equal('schedule' in result, false);
  assert.deepEqual(s.store.state.schedules, {});
});

test('schedule: valid is stored with who and when, its zone canonical, and answers the next events', async () => {
  const s = setup({ run: { state: STATES.AWAKE } });
  const result = await s.handler({ action: 'schedule', workloadId: 'demo', schedule: weekly(), by: 'me' });
  assert.equal(result.problems, undefined);
  assert.equal(result.schedule.timeZone, 'Europe/Paris');
  assert.equal(result.schedule.by, 'me');
  assert.equal(result.schedule.at, new Date(s.clock.now()).toISOString());
  assert.equal(result.next.length, 5);
  assert.deepEqual(Object.keys(result.next[0]), ['at', 'kind', 'window']);
  assert.equal(result.maintenanceDue, null, 'awake: no maintenance due');
  assert.deepEqual(s.store.state.schedules.demo, { ...weekly(), timeZone: 'Europe/Paris', by: 'me', at: s.clock.now() });
});

test('schedule: the maintenance time is the asleep time plus maxNapDays', async () => {
  const stateAt = Date.UTC(2026, 9, 1);
  const s = setup({ run: { state: STATES.ASLEEP, stateAt } });
  const result = await s.handler({ action: 'schedule', workloadId: 'demo', schedule: weekly(), by: 'me' });
  assert.equal(result.maintenanceDue, new Date(stateAt + 7 * 86_400_000).toISOString());
});

test('schedule and clear-schedule: an unknown workload is not configured', async () => {
  const s = setup({ run: { state: STATES.AWAKE } });
  await assert.rejects(s.handler({ action: 'schedule', workloadId: 'nope', schedule: weekly(), by: 'me' }), /^Error: workload not configured: nope/);
  await assert.rejects(s.handler({ action: 'clear-schedule', workloadId: 'nope', by: 'me' }), /^Error: workload not configured: nope/);
});

test('clear-schedule: true when one was there, then false', async () => {
  const s = setup({ run: { state: STATES.AWAKE } });
  await s.handler({ action: 'schedule', workloadId: 'demo', schedule: weekly(), by: 'me' });
  assert.deepEqual(await s.handler({ action: 'clear-schedule', workloadId: 'demo', by: 'me' }), { cleared: true });
  assert.deepEqual(await s.handler({ action: 'clear-schedule', workloadId: 'demo', by: 'me' }), { cleared: false });
});

test('status gives the schedule, its next events and the maintenance time; null and empty without one', async () => {
  const stateAt = Date.UTC(2026, 9, 1);
  const s = setup({ run: { state: STATES.ASLEEP, stateAt } });
  const none = await s.handler({ action: 'status', workloadId: 'demo' });
  assert.equal(none.schedule, null);
  assert.deepEqual(none.next, []);
  assert.equal(none.maintenanceDue, null);
  await s.handler({ action: 'schedule', workloadId: 'demo', schedule: weekly(), by: 'me' });
  const status = await s.handler({ action: 'status', workloadId: 'demo' });
  assert.equal(status.schedule.timeZone, 'Europe/Paris');
  assert.equal(status.schedule.by, 'me');
  assert.equal(typeof status.schedule.at, 'string');
  assert.equal(status.next.length, 5);
  assert.equal(status.maintenanceDue, new Date(stateAt + 7 * 86_400_000).toISOString());
});

test('status survives a corrupt schedule or one the runtime refuses: no schedule, logged', async () => {
  const s = setup({ run: { state: STATES.ASLEEP, stateAt: Date.UTC(2026, 9, 1) } });
  const logs = [];
  s.log.warn = (event, fields) => logs.push({ event, ...fields });
  s.store.state.schedules.demo = { timeZone: 'Nowhere/Land', windows: [{ kind: 'nap', days: ['mon'], start: '20:00', end: '07:00' }], by: 'me', at: s.clock.now() };
  const bad = await s.handler({ action: 'status', workloadId: 'demo' });
  assert.equal(bad.schedule, null);
  assert.deepEqual(bad.next, []);
  assert.equal(bad.maintenanceDue, null);
  assert.equal(logs.filter((l) => l.event === 'ScheduleSkipped').length, 1);
  s.store.getSchedule = async () => JSON.parse('{not json');
  const corrupt = await s.handler({ action: 'status', workloadId: 'demo' });
  assert.equal(corrupt.schedule, null);
  assert.equal(logs.filter((l) => l.event === 'ScheduleSkipped').length, 2);
});

test('status fails on a failed schedule read (a store error), not "no schedule"', async () => {
  const s = setup({ run: { state: STATES.ASLEEP, stateAt: Date.UTC(2026, 9, 1) } });
  s.store.getSchedule = async () => { throw new Error('ProvisionedThroughputExceededException'); };
  await assert.rejects(() => s.handler({ action: 'status', workloadId: 'demo' }), /ProvisionedThroughput/);
});

test('list marks the workloads that have a schedule', async () => {
  const s = setup({ run: { state: STATES.AWAKE } });
  assert.equal('scheduled' in (await s.handler({ action: 'list' })).workloads[0], false);
  await s.handler({ action: 'schedule', workloadId: 'demo', schedule: weekly(), by: 'me' });
  assert.equal((await s.handler({ action: 'list' })).workloads[0].scheduled, true);
});

// --- EC2 hibernation ------------------------------------------------------------------------------------------------

const HIBERNATE = 'Client.UserInitiatedHibernate';
const transitionsOf = (s) => {
  const specs = [];
  const transition = s.store.transition;
  s.store.transition = async (id, spec) => { specs.push(spec); return transition(id, spec); };
  return specs;
};
const stopsOf = (s) => s.ec2.state.stops.map((x) => [x.InstanceIds, x.Hibernate === true]);
const managerSays = (hibernate, readAt = 1_700_000_000_000) => ({ url: 's3://b/settings.json', refresh: async () => {}, current: async () => ({ hibernate, readAt, error: null }) });

test('nap: by default, an instance launched with hibernation is hibernated, said on the run and in the ASLEEP event (hibernation)', async () => {
  const s = setup({ run: { state: STATES.AWAKE } });
  const [id] = s.cfg.instanceIds;
  s.ec2.state.configured[id] = true;
  let stoppedAt;
  s.ec2.state.onStop.push(() => { stoppedAt = s.clock.now(); });
  const specs = transitionsOf(s);
  assert.equal((await s.handler({ action: 'nap', workloadId: 'demo' })).state, STATES.ASLEEP);
  assert.deepEqual(stopsOf(s), [[[id], true]]);
  assert.deepEqual(JSON.parse(s.store.state.run.hibernated), { ids: [id], at: stoppedAt });
  assert.deepEqual(specs.find((x) => x.set?.state === STATES.ASLEEP).event.hibernated, [id]);
});

test('nap: the router\'s or the manager\'s false stops the instance; an unreadable level stops it too, never failing the nap (hibernation)', async () => {
  const off = setup({ run: { state: STATES.AWAKE } });
  const [id] = off.cfg.instanceIds;
  off.ec2.state.configured[id] = true;
  await off.store.putRouterSettings({ hibernate: false, by: 'ana', at: 1 });
  const specs = transitionsOf(off);
  assert.equal((await off.handler({ action: 'nap', workloadId: 'demo' })).state, STATES.ASLEEP);
  assert.deepEqual(stopsOf(off), [[[id], false]]);
  assert.equal('hibernated' in off.store.state.run, false);
  assert.equal('hibernated' in specs.find((x) => x.set?.state === STATES.ASLEEP).event, false, 'only when the nap hibernated some');

  const manager = setup({ run: { state: STATES.AWAKE }, managerSettings: managerSays(false) });
  manager.ec2.state.configured[id] = true;
  await manager.handler({ action: 'nap', workloadId: 'demo' });
  assert.deepEqual(stopsOf(manager), [[[id], false]]);

  // A level that cannot be read (a throttled table) is a plain stop, never a lower level nor the built-in true: the record
  // it could not read may be an administrator's "off". Without manager settings, the router's unreadable record would
  // otherwise fall to true; the manager's unreadable settings alike.
  const warnings = [];
  const unreadable = setup({ run: { state: STATES.AWAKE } });
  unreadable.ec2.state.configured[id] = true;
  unreadable.log.warn = (event, fields) => warnings.push({ event, ...fields });
  unreadable.store.getRouterSettings = async () => { throw new Error('ProvisionedThroughputExceededException'); };
  assert.equal((await unreadable.handler({ action: 'nap', workloadId: 'demo' })).state, STATES.ASLEEP);
  assert.deepEqual(stopsOf(unreadable), [[[id], false]]);
  const failing = setup({ run: { state: STATES.AWAKE }, managerSettings: { url: 's3://b/settings.json', refresh: async () => {}, current: async () => { throw new Error('table'); } } });
  failing.ec2.state.configured[id] = true;
  failing.log.warn = (event, fields) => warnings.push({ event, ...fields });
  assert.equal((await failing.handler({ action: 'nap', workloadId: 'demo' })).state, STATES.ASLEEP);
  assert.deepEqual(stopsOf(failing), [[[id], false]]);
  // The release of a failed workload stops as the nap does.
  const release = setup({ run: { state: STATES.FAILED, failedAt: 1 }, instance: 'running', target: 'waker', healthy: 0 });
  release.ec2.state.configured[id] = true;
  release.log.warn = (event, fields) => warnings.push({ event, ...fields });
  release.store.getRouterSettings = async () => { throw new Error('ThrottlingException'); };
  assert.equal((await release.handler({ action: 'release', workloadId: 'demo' })).state, STATES.ASLEEP);
  assert.deepEqual(stopsOf(release), [[[id], false]]);
  assert.deepEqual(warnings.filter((w) => w.event.endsWith('Unreadable')).map((w) => [w.event, w.error]),
    [['HibernationLevelUnreadable', 'ProvisionedThroughputExceededException'], ['HibernationLevelUnreadable', 'table'], ['HibernationLevelUnreadable', 'ThrottlingException']]);
});

test('nap: a run that asks for a fresh boot stops the instance, and the nap removes freshBoot (hibernation, 60 days)', async () => {
  const s = setup({ run: { state: STATES.AWAKE, freshBoot: true } });
  const [id] = s.cfg.instanceIds;
  s.ec2.state.configured[id] = true;
  assert.equal((await s.handler({ action: 'nap', workloadId: 'demo' })).state, STATES.ASLEEP);
  assert.deepEqual(stopsOf(s), [[[id], false]]);
  assert.equal('freshBoot' in s.store.state.run, false);
  assert.equal('hibernated' in s.store.state.run, false);
});

test('nap: a nap failing after an accepted hibernation keeps what it hibernated; the wake that reaches AWAKE removes it (hibernation)', async () => {
  const cfg = testConfig({ instanceIds: ['i-0aaaaaaaaaaaaaaa1', 'i-0bbbbbbbbbbbbbbb2'] });
  const s = setup({ run: { state: STATES.AWAKE }, cfg });
  s.ec2.state.configured['i-0aaaaaaaaaaaaaaa1'] = true;
  // The plain stop of the other instance never ends: the nap fails at the stop wait, after the hibernation.
  s.ec2.state.slowStops = ['i-0bbbbbbbbbbbbbbb2'];
  assert.equal((await s.handler({ action: 'nap', workloadId: 'demo' })).state, STATES.FAILED);
  assert.deepEqual(stopsOf(s), [[['i-0aaaaaaaaaaaaaaa1'], true], [['i-0bbbbbbbbbbbbbbb2'], false]]);
  assert.deepEqual(JSON.parse(s.store.state.run.hibernated).ids, ['i-0aaaaaaaaaaaaaaa1']);

  const w = setup({ run: { state: STATES.WAKING, wakeId: 'w1', hibernated: JSON.stringify({ ids: ['i-0123456789abcdef0'], at: 1 }) }, instance: 'stopped', target: 'waker', healthy: 0 });
  w.ec2.state.reasons['i-0123456789abcdef0'] = HIBERNATE;
  w.ec2.state.onStart.push(() => { w.clock.onSleep(() => { w.elbv2.state.healthy = 1; }); });
  assert.equal((await w.handler({ action: 'wake', workloadId: 'demo', wakeId: 'w1' })).state, STATES.AWAKE);
  assert.equal('hibernated' in w.store.state.run, false);
});

test('a workload found awake again (started outside Dormeto, or recovered) loses its hibernated record; a failed wake keeps it (hibernation)', async () => {
  // A day ago (the fake clock's start): well within the 60-day limit, which would wake it first.
  const hibernated = JSON.stringify({ ids: ['i-0123456789abcdef0'], at: 1_700_000_000_000 - 86_400_000 });
  for (const state of [STATES.ASLEEP, STATES.FAILED]) {
    const s = setup({ run: { state, failedAt: 1, hibernated }, instance: 'running', target: 'waker', healthy: 1 });
    const [result] = await s.handler({ action: 'check' });
    assert.equal(result.state, STATES.AWAKE);
    assert.equal('hibernated' in s.store.state.run, false, state);
  }
  const failed = setup({ run: { state: STATES.WAKING, wakeId: 'w1', hibernated }, instance: 'stopped', target: 'waker', healthy: 0 });
  assert.equal((await failed.handler({ action: 'wake', workloadId: 'demo', wakeId: 'w1' })).state, STATES.FAILED);
  assert.equal(failed.store.state.run.hibernated, hibernated);
});

test('release: a failed workload is stopped as a nap would be, hibernating what can be, freshBoot kept (hibernation)', async () => {
  const s = setup({ run: { state: STATES.FAILED, failedAt: 1, failure: '{"kind":"unhealthy"}' }, instance: 'running', target: 'waker', healthy: 0 });
  const [id] = s.cfg.instanceIds;
  s.ec2.state.configured[id] = true;
  assert.equal((await s.handler({ action: 'release', workloadId: 'demo' })).state, STATES.ASLEEP);
  assert.deepEqual(stopsOf(s), [[[id], true]]);
  assert.deepEqual(JSON.parse(s.store.state.run.hibernated).ids, [id]);

  const fresh = setup({ run: { state: STATES.FAILED, failedAt: 1, freshBoot: true }, instance: 'running', target: 'waker', healthy: 0 });
  fresh.ec2.state.configured[id] = true;
  assert.equal((await fresh.handler({ action: 'release', workloadId: 'demo' })).state, STATES.ASLEEP);
  assert.deepEqual(stopsOf(fresh), [[[id], false]]);
  assert.equal(fresh.store.state.run.freshBoot, true, 'the next nap stops too');
});

test('settings of the router: true is recorded with who and when, null removes the record (hibernation)', async () => {
  const s = setup({ run: { state: STATES.AWAKE } });
  const at = s.clock.now();
  assert.deepEqual(await s.handler({ action: 'settings', settings: { hibernate: true }, by: 'ana' }), { level: 'router', settings: { hibernate: true, by: 'ana', at: new Date(at).toISOString() } });
  assert.deepEqual(s.store.state.routerSettings, { hibernate: true, by: 'ana', at });
  assert.deepEqual(await s.handler({ action: 'settings', settings: { hibernate: null }, by: 'ana' }), { level: 'router', settings: { hibernate: null, by: null, at: null } });
  assert.equal(s.store.state.routerSettings, undefined);
});

test('settings of a workload the manager onboarded: written in its configuration, null removes the key, answers the resolution (hibernation)', async () => {
  const s = setup({ run: { state: STATES.ASLEEP }, instance: 'stopped', cfg: testConfig({ source: 'manager' }) });
  const off = await s.handler({ action: 'settings', workloadId: 'demo', settings: { hibernate: false }, by: 'ana' });
  assert.deepEqual([off.level, off.settings, off.hibernation.hibernate, off.hibernation.from], ['workload', { hibernate: false }, false, 'workload']);
  assert.deepEqual(off.hibernation.instances, [{ id: 'i-0123456789abcdef0', configured: false, hibernated: false }]);
  const written = await s.store.getConfig('demo');
  assert.deepEqual([written.hibernate, written.appTargetGroupArn], [false, testConfig().appTargetGroupArn]);
  const inherit = await s.handler({ action: 'settings', workloadId: 'demo', settings: { hibernate: null }, by: 'ana' });
  assert.deepEqual([inherit.settings, inherit.hibernation.hibernate, inherit.hibernation.from], [{ hibernate: null }, true, 'default']);
  assert.equal('hibernate' in (await s.store.getConfig('demo')), false);
});

test('settings: refused for a Terraform workload, an unknown one, or one offboarded meanwhile; bad settings answer the problems, nothing written (hibernation)', async () => {
  const terraform = setup({ run: { state: STATES.AWAKE } });
  await assert.rejects(terraform.handler({ action: 'settings', workloadId: 'demo', settings: { hibernate: true }, by: 'ana' }),
    { message: 'workload demo was written by Terraform: set hibernate in its workload module' });
  await assert.rejects(terraform.handler({ action: 'settings', workloadId: 'nope', settings: { hibernate: true }, by: 'ana' }), { message: 'workload not configured: nope' });
  assert.equal('hibernate' in (await terraform.store.getConfig('demo')), false);

  const s = setup({ run: { state: STATES.AWAKE }, cfg: testConfig({ source: 'manager' }) });
  const problems = ['settings: hibernate must be true, false or null'];
  assert.deepEqual(await s.handler({ action: 'settings', workloadId: 'demo', settings: { hibernate: 'x' }, by: 'ana' }), { problems });
  assert.deepEqual(await s.handler({ action: 'settings', settings: { hibernate: 'x' }, by: 'ana' }), { problems });
  assert.equal('hibernate' in (await s.store.getConfig('demo')), false);
  assert.equal(s.store.state.routerSettings, undefined);

  const writes = [];
  s.store.putConfig = async (id, cfg, options) => { writes.push(options); if (options?.mustExist) return false; throw new Error('unconditional write'); };
  await assert.rejects(s.handler({ action: 'settings', workloadId: 'demo', settings: { hibernate: true }, by: 'ana' }), { message: 'workload not configured: demo' });
  assert.deepEqual(writes, [{ mustExist: true }]);
});

test('status gives the hibernation: the resolution, each level, the instances EC2 describes, freshBoot (hibernation)', async () => {
  const readAt = 1_700_000_000_000 - 120_000;
  const s = setup({ run: { state: STATES.ASLEEP, freshBoot: true }, instance: 'stopped', target: 'waker', managerSettings: managerSays(false, readAt) });
  const [id] = s.cfg.instanceIds;
  s.ec2.state.configured[id] = true;
  s.ec2.state.reasons[id] = HIBERNATE;
  await s.store.putRouterSettings({ hibernate: true, by: 'ana', at: 1 });
  const { hibernation } = await s.handler({ action: 'status', workloadId: 'demo' });
  assert.deepEqual(hibernation, {
    hibernate: true, from: 'router', workload: null, router: true, manager: { hibernate: false, readAt: new Date(readAt).toISOString(), error: null },
    instances: [{ id, configured: true, hibernated: true }], freshBoot: true,
  });

  // The hibernation's DescribeInstances (made once the levels are read) failing gives no instances, never a failed status.
  const warnings = [];
  s.log.warn = (event, fields) => warnings.push({ event, ...fields });
  const describe = s.ec2.describeInstances;
  const routerSettings = s.store.getRouterSettings;
  let levelsRead = false;
  s.store.getRouterSettings = async () => { levelsRead = true; return routerSettings(); };
  s.ec2.describeInstances = async (input) => { if (levelsRead) throw new Error('RequestLimitExceeded'); return describe(input); };
  const degraded = await s.handler({ action: 'status', workloadId: 'demo' });
  assert.equal(degraded.hibernation.instances, null);
  assert.deepEqual(warnings.map((w) => [w.event, w.error]), [['HibernationUnread', 'RequestLimitExceeded']]);
});

test('status of a workload without standalone instances (ECS) gives no instances; without manager settings, the built-in default (hibernation)', async () => {
  const s = ecsSetup({ run: { state: STATES.AWAKE } });
  const { hibernation } = await s.handler({ action: 'status', workloadId: 'demo' });
  assert.deepEqual(hibernation, { hibernate: true, from: 'default', workload: null, router: null, manager: null, instances: null, freshBoot: false });
});

test('status and the settings answer fail on a failed read of the router\'s or the manager\'s level (a store error), not "unset"; the settings write nothing then (hibernation)', async () => {
  const router = setup({ run: { state: STATES.ASLEEP }, instance: 'stopped', target: 'waker', cfg: testConfig({ source: 'manager' }) });
  router.store.getRouterSettings = async () => { throw new Error('ProvisionedThroughputExceededException'); };
  await assert.rejects(router.handler({ action: 'status', workloadId: 'demo' }), /ProvisionedThroughputExceededException/);
  await assert.rejects(router.handler({ action: 'settings', workloadId: 'demo', settings: { hibernate: false }, by: 'ana' }), /ProvisionedThroughputExceededException/);
  assert.equal('hibernate' in (await router.store.getConfig('demo')), false);

  const manager = setup({
    run: { state: STATES.ASLEEP }, instance: 'stopped', target: 'waker', cfg: testConfig({ source: 'manager' }),
    managerSettings: { url: 's3://b/settings.json', refresh: async () => {}, current: async () => { throw new Error('table'); } },
  });
  await assert.rejects(manager.handler({ action: 'status', workloadId: 'demo' }), /table/);
  await assert.rejects(manager.handler({ action: 'settings', workloadId: 'demo', settings: { hibernate: true }, by: 'ana' }), /table/);
  assert.equal('hibernate' in (await manager.store.getConfig('demo')), false);
});
