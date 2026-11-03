import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createController } from '../src/lib/controller-core.mjs';
import { currentTarget } from '../src/lib/route.mjs';
import { STATES } from '../src/lib/state.mjs';
import { createManagerSettings } from '../src/lib/manager-settings.mjs';
import { asgGroup, ecsService, fakeAppScaling, fakeEcs, fakeKubernetes, fakeRds, fakeRdsTagging, fakeTagging, fakeAutoScaling, fakeClock, fakeCloudWatch, fakeEc2, fakeElbv2, fakeStore, k8sConfig, k8sCustomerIngress, k8sGroupedConfig, k8sNode, k8sOwner, k8sPod, routeOf, silentLog, testConfig } from './fakes.mjs';
import { dormetoIngress, weightsOf } from '../src/lib/kube-route.mjs';
import { ROUTER_RULES } from '../src/lib/kube-access.mjs';

function setup({ run, instance = 'running', target = 'app', healthy = 1, metric = [], metricAt = [], cfg = testConfig(), groups = [], services = [], databases, k8s, managerSettings = null, kubernetesOf, lambda = null, faviconBudgetMs = 50 } = {}) {
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
  // managerSettings: a fake, or ({ store, clock }) → the real reader on this store (lib/manager-settings.mjs).
  const settings = typeof managerSettings === 'function' ? managerSettings({ store, clock }) : managerSettings;
  // The favicon's network: none unless a test sets network.fetch, so that no test reaches one.
  const network = { fetch: async () => { throw new Error('no network in tests'); }, calls: [] };
  // The organization's page, from the manager's settings.json in the real router: set organization.page (or make it throw).
  const organization = { page: null, reads: 0, signals: [], async read({ signal } = {}) { organization.reads += 1; organization.signals.push(signal); if (organization.failure) throw organization.failure; return structuredClone(organization.page); } };
  const handler = createController({
    organizationPage: organization,
    fetch: (...args) => { network.calls.push(args[0]); return network.fetch(...args); }, ...(faviconBudgetMs === 'default' ? {} : { faviconBudgetMs }),
    store, ec2, elbv2, cloudwatch, autoscaling, ecs, tagging, appscaling, rds, kubernetesOf: kubernetesOf ?? (k8s ? async () => k8s : undefined), lambda,
    invokeSelf: async (payload) => { invocations.push(payload); }, now: clock.now, sleep: clock.sleep, newId: () => `wake-${++ids}`, log, managerSettings: settings,
  });
  return { handler, store, ec2, elbv2, cloudwatch, autoscaling, ecs, appscaling, rds, clock, cfg, invocations, log, settings, network, organization };
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
  assert.deepEqual(await s.handler({ action: 'clusterCheck', cluster: 'eks-demo', namespace: 'demo' }), { cluster: 'eks-demo', reachable: true, allowed: false, missing: ['get nodes'], via: 'direct' });
  assert.deepEqual(k8s.state.calls.at(-1), ['REVIEW', 'demo']);
  k8s.state.review.resourceRules.push({ apiGroups: [''], resources: ['nodes'], verbs: ['get'] });
  assert.deepEqual(await s.handler({ action: 'clusterCheck', cluster: 'eks-demo' }), { cluster: 'eks-demo', reachable: true, allowed: true, missing: [], via: 'direct' });
  assert.deepEqual(k8s.state.calls.at(-1), ['REVIEW', 'default']);
});

test('clusterCheck: a cluster without the router\'s access entry, or one it cannot reach, says so', async () => {
  const k8s = fakeKubernetes();
  const s = setup({ run: { state: STATES.AWAKE }, k8s });
  k8s.state.reviewError = Object.assign(new Error('Unauthorized'), { name: 'KubernetesError', status: 401, reason: 'Unauthorized' });
  assert.deepEqual(await s.handler({ action: 'clusterCheck', cluster: 'eks-demo' }), {
    cluster: 'eks-demo', reachable: true, allowed: false, missing: [], reason: 'the cluster does not know the router\'s role (no access entry, or not mapped in aws-auth): Unauthorized', via: 'direct',
  });
  k8s.state.reviewError = Object.assign(new Error('GET /apis: no connection within 3000 ms'), { name: 'KubernetesError', status: 0, reason: 'Timeout' });
  assert.deepEqual(await s.handler({ action: 'clusterCheck', cluster: 'eks-demo' }), {
    cluster: 'eks-demo', reachable: false, allowed: false, missing: [], reason: 'GET /apis: no connection within 3000 ms', via: 'direct',
  });
});

test('clusterCheck: rights an EKS access policy gives (a review that cannot list them) are asked one by one', async () => {
  const k8s = fakeKubernetes();
  k8s.state.review = { resourceRules: [{ apiGroups: ['authorization.k8s.io'], resources: ['selfsubjectrulesreviews'], verbs: ['create'] }], incomplete: true };
  k8s.state.allow = ({ verb, resource }) => !(verb === 'get' && resource === 'nodes');
  const s = setup({ run: { state: STATES.AWAKE }, k8s });
  assert.deepEqual(await s.handler({ action: 'clusterCheck', cluster: 'eks-demo', namespace: 'demo' }), { cluster: 'eks-demo', reachable: true, allowed: false, missing: ['get nodes'], via: 'direct' });
  const asked = k8s.state.calls.filter(([what]) => what === 'ACCESS').map(([, a]) => a);
  assert.deepEqual(asked.find((a) => a.resource === 'deployments' && a.subresource === 'scale' && a.verb === 'patch'), { namespace: 'demo', verb: 'patch', group: 'apps', resource: 'deployments', subresource: 'scale' });
  assert.equal(asked.find((a) => a.resource === 'nodes').namespace, undefined, 'nodes belong to no namespace');
});

// Clusters reached through a proxy function (vision docs/specs/2026-10-24-private-eks-endpoints-design.md, sections 5, 8, 9).
const ENDPOINT = 'https://ABC.eks.example';
const viaProxy = (k8s, proxy = 'dmt-kube-eks-demo', endpoint = ENDPOINT) => Object.assign(k8s, { via: 'proxy', proxy, endpoint });
// A fake proxy answering per request, as the real one: Stale for another endpoint, the probe's failure when asked to probe.
// proxies: {<function>: {endpoint?, probe?: 'Timeout' | 'Network', error?: Error}}.
const proxyLambda = (proxies = {}) => {
  const calls = [];
  return {
    calls,
    async getAccountSettings() { return { AccountLimit: { ConcurrentExecutions: 1000 } }; },
    async invoke(name, payload) {
      calls.push([name, payload]);
      const proxy = proxies[name] ?? {};
      if (proxy.error) throw proxy.error;
      if (payload.endpoint !== (proxy.endpoint ?? ENDPOINT)) return { v: 1, status: 0, reason: 'Stale', message: `the proxy points to an earlier endpoint of cluster ${name}: set up its access again` };
      if (payload.probe && proxy.probe) return { v: 1, status: 0, reason: proxy.probe, message: `ping: ${proxy.probe}` };
      return { v: 1, version: '0.33.0', cluster: name.replace('dmt-kube-', '') };
    },
  };
};

test('clusterCheck: a proxied cluster says so with its proxy and version', async () => {
  const lambda = proxyLambda();
  const s = setup({ run: { state: STATES.AWAKE }, k8s: viaProxy(fakeKubernetes()), lambda });
  const check = await s.handler({ action: 'clusterCheck', cluster: 'eks-demo' });
  assert.deepEqual(check, { cluster: 'eks-demo', reachable: true, allowed: check.allowed, missing: check.missing, via: 'proxy', proxy: { name: 'dmt-kube-eks-demo', version: '0.33.0' } });
  assert.deepEqual(lambda.calls[0], ['dmt-kube-eks-demo', { v: 1, ping: true, endpoint: ENDPOINT }], 'the cluster check pings without a probe');
});

test('clusterCheck: a proxied Timeout is the cluster security group not admitting the proxy', async () => {
  const k8s = viaProxy(fakeKubernetes());
  k8s.state.reviewError = Object.assign(new Error('POST /apis: no connection within 3000 ms'), { name: 'KubernetesError', status: 0, reason: 'Timeout' });
  const s = setup({ run: { state: STATES.AWAKE }, k8s, lambda: proxyLambda() });
  const check = await s.handler({ action: 'clusterCheck', cluster: 'eks-demo' });
  assert.equal(check.reachable, false);
  assert.equal(check.reason, 'the cluster security group must admit TCP 443 from the proxy\'s security group (dmt-kube-eks-demo unless security_group_ids were given)');
  assert.equal(check.via, 'proxy');
});

test('the check pings the proxy of each proxied cluster with workloads once, and records the answers', async () => {
  const lambda = proxyLambda({ 'dmt-kube-c-bad': { error: Object.assign(new Error('not found'), { name: 'ResourceNotFoundException' }) } });
  const clients = {
    'c-one': viaProxy(fakeKubernetes(), 'dmt-kube-c-one'), 'c-bad': viaProxy(fakeKubernetes(), 'dmt-kube-c-bad'), 'c-direct': Object.assign(fakeKubernetes(), { via: 'direct' }),
  };
  const s = setup({ run: { state: STATES.AWAKE }, lambda, kubernetesOf: async (cluster) => clients[cluster] });
  const at = (cluster, id) => k8sConfig({ cluster }, { workloadId: id });
  const configs = [at('c-one', 'a'), at('c-one', 'b'), at('c-bad', 'c'), at('c-direct', 'd'), testConfig({ workloadId: 'e' })];
  s.store.listConfigs = async () => structuredClone(configs);
  await s.handler({ action: 'check' });
  assert.deepEqual(lambda.calls.map(([name]) => name).sort(), ['dmt-kube-c-bad', 'dmt-kube-c-one']);
  assert.ok(lambda.calls.every(([, payload]) => payload.endpoint === ENDPOINT && payload.probe === true), 'each ping carries the endpoint and probes');
  const kept = s.store.state.kubeProxies;
  assert.deepEqual(Object.keys(kept).sort(), ['c-bad', 'c-one']);
  assert.deepEqual(kept['c-one'], { name: 'dmt-kube-c-one', ok: true, version: '0.33.0', at: s.clock.now() });
  assert.equal(kept['c-bad'].ok, false);
  assert.equal(kept['c-bad'].reason, 'NoProxy');
  assert.equal(kept['c-bad'].name, 'dmt-kube-c-bad');
});

test('the check records a Stale and a Timeout from real pings: a recreated cluster, a removed security group rule', async () => {
  const lambda = proxyLambda({ 'dmt-kube-c-old': { endpoint: 'https://OLD.eks.example' }, 'dmt-kube-c-sg': { probe: 'Timeout' }, 'dmt-kube-c-net': { probe: 'Network' } });
  const s = setup({ run: { state: STATES.AWAKE }, lambda, kubernetesOf: async (cluster) => viaProxy(fakeKubernetes(), `dmt-kube-${cluster}`) });
  s.store.listConfigs = async () => ['c-old', 'c-sg', 'c-net', 'c-ok'].map((cluster) => k8sConfig({ cluster }, { workloadId: cluster }));
  await s.handler({ action: 'check' });
  const kept = s.store.state.kubeProxies;
  assert.deepEqual(Object.entries(kept).map(([cluster, p]) => [cluster, p.ok, p.reason]).sort(), [['c-net', false, 'Network'], ['c-ok', true, undefined], ['c-old', false, 'Stale'], ['c-sg', false, 'Timeout']]);
  const { health } = await s.handler({ action: 'router' });
  const texts = health.problems.filter((p) => p.code.startsWith('kube-proxy:')).map((p) => p.text);
  assert.equal(texts.length, 3);
  assert.ok(texts.some((t) => t.startsWith('cluster c-old: its proxy dmt-kube-c-old has a stale endpoint: set up its access again')));
  assert.ok(texts.some((t) => t.includes('cluster c-sg: its proxy dmt-kube-c-sg did not reach the cluster: the cluster security group must admit TCP 443 from the proxy\'s security group (dmt-kube-c-sg unless security_group_ids were given)')));
});

test('the check pings after the schedules and the hibernation pass, and skips the pings its budget no longer allows', async () => {
  const events = [];
  const lambda = proxyLambda();
  const invoke = lambda.invoke;
  lambda.invoke = async (...args) => { events.push('ping'); return invoke(...args); };
  const s = setup({ run: { state: STATES.ASLEEP }, lambda, kubernetesOf: async (cluster) => viaProxy(fakeKubernetes(), `dmt-kube-${cluster}`) });
  const getRun = s.store.getRun;
  s.store.getRun = async (...args) => { events.push('run'); return getRun.apply(s.store, args); };
  s.store.listConfigs = async () => [k8sConfig({ cluster: 'c-one' })];
  s.store.state.kubeProxies = { 'c-one': { name: 'dmt-kube-c-one', ok: true, version: '0.32.0', at: 1 } };
  await s.handler({ action: 'check' });
  assert.ok(events.indexOf('run') < events.indexOf('ping'), 'the hibernation pass reads the runs before any ping');
  assert.equal(s.store.state.kubeProxies['c-one'].version, '0.33.0');
  // No time left: nothing is pinged, the previous record stays.
  s.store.state.kubeProxies = { 'c-one': { name: 'dmt-kube-c-one', ok: true, version: '0.32.0', at: 1 } };
  const before = lambda.calls.length;
  await s.handler({ action: 'check' }, { getRemainingTimeInMillis: () => 0 });
  assert.equal(lambda.calls.length, before);
  assert.equal(s.store.state.kubeProxies['c-one'].version, '0.32.0');
});

test('the check: a cluster no longer with workloads leaves the record, a failing ping never fails the check', async () => {
  const lambda = proxyLambda({ 'dmt-kube-c-one': { error: new Error('boom') } });
  const s = setup({ run: { state: STATES.AWAKE }, lambda, kubernetesOf: async () => viaProxy(fakeKubernetes(), 'dmt-kube-c-one') });
  s.store.state.kubeProxies = { gone: { name: 'dmt-kube-gone', ok: false, reason: 'NoProxy', at: 1 } };
  s.store.listConfigs = async () => [k8sConfig({ cluster: 'c-one' })];
  const result = await s.handler({ action: 'check' });
  assert.ok(Array.isArray(result));
  assert.deepEqual(Object.keys(s.store.state.kubeProxies), ['c-one']);
  assert.equal(s.store.state.kubeProxies['c-one'].ok, false);
});

test('router status: a recorded failed ping is a health warning naming the cluster', async () => {
  const s = setup({ run: { state: STATES.AWAKE } });
  s.store.state.kubeProxies = { 'c-bad': { name: 'dmt-kube-c-bad', ok: false, reason: 'ProxyNotReady', message: 'the proxy is becoming active again', at: s.clock.now() } };
  const { health } = await s.handler({ action: 'router' });
  assert.ok(health.problems.some((p) => p.code === 'kube-proxy:c-bad' && p.text.startsWith('cluster c-bad: its proxy dmt-kube-c-bad ')));
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

test('schedule: a recurrence is stored as sent, and its next events reach beyond 8 days', async () => {
  const s = setup({ run: { state: STATES.AWAKE } });
  const windows = [
    { kind: 'nap', start: '00:00', end: '00:00', repeat: { pattern: 'monthly', interval: 12, day: 25 }, from: '2026-12-01', until: '2030-12-31' },
    { kind: 'awake', repeat: { pattern: 'cron', cron: '30 8 1 * *', minutes: 630 } },
  ];
  const result = await s.handler({ action: 'schedule', workloadId: 'demo', schedule: { timeZone: 'Europe/Paris', windows }, by: 'me' });
  assert.equal(result.problems, undefined);
  assert.deepEqual(s.store.state.schedules.demo.windows, windows);
  assert.deepEqual(result.next[0], { at: '2023-12-01T07:30:00.000Z', kind: 'awake-start', window: 1 });
});

test('schedule: the overlap of recurrences counts from the controller\'s clock', async () => {
  // Overlapping every Monday up to 2025 only: still to come at the fake clock's 2023, past on any real date.
  const s = setup({ run: { state: STATES.AWAKE } });
  const windows = [
    { kind: 'awake', days: ['mon'], start: '08:00', end: '12:00', until: '2025-01-06' },
    { kind: 'nap', days: ['mon'], start: '08:00', end: '12:00' },
  ];
  const result = await s.handler({ action: 'schedule', workloadId: 'demo', schedule: { timeZone: 'UTC', windows }, by: 'me' });
  assert.deepEqual(result.problems, ['windows[1]: the nap window overlaps the awake window windows[0] (2023-11-20 08:00–12:00)']);
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

test('wake: one that completes with a run hibernated 59 days or more asks for a fresh boot, whatever woke it; a younger one does not (hibernation, 60 days)', async () => {
  const wakeAfter = async (days) => {
    const hibernated = JSON.stringify({ ids: ['i-0123456789abcdef0'], at: 1_700_000_000_000 - days * 86_400_000 });
    const s = setup({ run: { state: STATES.WAKING, wakeId: 'w1', hibernated }, instance: 'stopped', target: 'waker', healthy: 0 });
    s.ec2.state.reasons['i-0123456789abcdef0'] = HIBERNATE;
    s.ec2.state.onStart.push(() => { s.clock.onSleep(() => { s.elbv2.state.healthy = 1; }); });
    assert.equal((await s.handler({ action: 'wake', workloadId: 'demo', wakeId: 'w1' })).state, STATES.AWAKE);
    return s.store.state.run;
  };
  const old = await wakeAfter(59 + 1 / 24);
  assert.equal(old.freshBoot, true);
  assert.equal('hibernated' in old, false);
  assert.equal('freshBoot' in (await wakeAfter(10)), false);
});

test('nap: an unreadable hibernation level is a plain stop even for a workload set hibernate true (hibernation)', async () => {
  const s = setup({ run: { state: STATES.AWAKE }, cfg: testConfig({ hibernate: true }) });
  const [id] = s.cfg.instanceIds;
  s.ec2.state.configured[id] = true;
  s.store.getRouterSettings = async () => { throw new Error('ProvisionedThroughputExceededException'); };
  assert.equal((await s.handler({ action: 'nap', workloadId: 'demo' })).state, STATES.ASLEEP);
  assert.deepEqual(stopsOf(s), [[[id], false]]);
  assert.equal('hibernated' in s.store.state.run, false);
});

// The manager's bucket as the router reads it: settings.json answers `answer` (its content, or an S3 error name); the
// catalog is unreadable, so an AccessDenied is a failure, not "missing".
function managerBucket() {
  const bucket = { answer: 'SlowDown', tag: 0 };
  bucket.s3 = {
    async getObjectIf({ key }) {
      const error = key === 'catalog.json' ? 'AccessDenied' : typeof bucket.answer === 'string' ? bucket.answer : null;
      if (error) throw Object.assign(new Error(error), { name: error });
      return { body: Buffer.from(JSON.stringify(bucket.answer)), etag: `"e${++bucket.tag}"` };
    },
  };
  bucket.reader = (url = 's3://b/settings.json') => ({ store, clock }) => createManagerSettings({ s3: bucket.s3, url, catalogUrl: 's3://b/catalog.json', store, now: clock.now, log: silentLog });
  return bucket;
}

// Naps the workload again from AWAKE, its instance running: the stop calls it made.
async function napAgain(s) {
  const [id] = s.cfg.instanceIds;
  s.store.state.run = { state: STATES.AWAKE };
  s.ec2.state.instances[id] = 'running';
  delete s.ec2.state.reasons[id];
  s.ec2.state.stops = [];
  assert.equal((await s.handler({ action: 'nap', workloadId: 'demo' })).state, STATES.ASLEEP);
  return stopsOf(s);
}

test('nap: a router that reads the manager\'s settings stops plainly until a read succeeds (just upgraded, then failed reads), then follows what it read; a missing object is true (hibernation)', async () => {
  const bucket = managerBucket();
  const s = setup({ run: { state: STATES.AWAKE }, managerSettings: bucket.reader() });
  const [id] = s.cfg.instanceIds;
  s.ec2.state.configured[id] = true;
  const warnings = [];
  s.log.warn = (event, fields) => warnings.push({ event, ...fields });
  // Just upgraded: nothing read yet. The administrator's "off" may be what the router has not read.
  assert.deepEqual(await napAgain(s), [[[id], false]]);
  // A first read that fails: the level stays unknown, stored as such, and the naps stop plainly.
  await s.settings.refresh();
  assert.deepEqual(s.store.state.managerSettings, { hibernate: null, joinMinutes: null, endedWindowDays: null, etag: null, readAt: s.clock.now(), error: 'S3 SlowDown' });
  assert.deepEqual(await napAgain(s), [[[id], false]]);
  assert.deepEqual(warnings.filter((w) => w.event === 'HibernationLevelUnreadable').map((w) => [w.workloadId, w.error]),
    [['demo', 'manager settings not read yet'], ['demo', 'manager settings not read yet: S3 SlowDown']]);
  // Once read, the manager's value decides; a missing object is never set: true.
  for (const [answer, hibernate] of [[{ workloads: { hibernate: false } }, false], [{ workloads: { hibernate: true } }, true], ['NoSuchKey', true]]) {
    bucket.answer = answer;
    s.clock.advance(5 * 60_000);
    await s.settings.refresh();
    assert.deepEqual(await napAgain(s), [[[id], hibernate]], JSON.stringify(answer));
  }
  assert.equal(warnings.filter((w) => w.event === 'HibernationLevelUnreadable').length, 2);
});

test('nap: a router without a catalog (no settings URL) uses the built-in true; an unknown manager level never overrides the workload\'s or the router\'s own level (hibernation)', async () => {
  const none = setup({ run: { state: STATES.AWAKE }, managerSettings: managerBucket().reader(null) });
  const [id] = none.cfg.instanceIds;
  none.ec2.state.configured[id] = true;
  assert.deepEqual(await napAgain(none), [[[id], true]]);
  // The manager level only decides when the workload and the router set nothing: theirs hold, read or not.
  const workload = setup({ run: { state: STATES.AWAKE }, cfg: testConfig({ hibernate: true }), managerSettings: managerBucket().reader() });
  workload.ec2.state.configured[id] = true;
  assert.deepEqual(await napAgain(workload), [[[id], true]]);
  const router = setup({ run: { state: STATES.AWAKE }, managerSettings: managerBucket().reader() });
  router.ec2.state.configured[id] = true;
  await router.store.putRouterSettings({ hibernate: true, by: 'ana', at: 1 });
  assert.deepEqual(await napAgain(router), [[[id], true]]);
});

test('status: an unknown manager level says hibernate false from the manager with unknown true, its level null (hibernation)', async () => {
  const bucket = managerBucket();
  const s = setup({ run: { state: STATES.ASLEEP }, instance: 'stopped', target: 'waker', managerSettings: bucket.reader() });
  const [id] = s.cfg.instanceIds;
  const expected = (manager) => ({ hibernate: false, from: 'manager', unknown: true, workload: null, router: null, manager, instances: [{ id, configured: false, hibernated: false }], freshBoot: false });
  assert.deepEqual((await s.handler({ action: 'status', workloadId: 'demo' })).hibernation, expected({ hibernate: null, readAt: null, error: null }));
  await s.settings.refresh();
  assert.deepEqual((await s.handler({ action: 'status', workloadId: 'demo' })).hibernation, expected({ hibernate: null, readAt: new Date(s.clock.now()).toISOString(), error: 'S3 SlowDown' }));
  // Read at last: no unknown.
  bucket.answer = { workloads: { hibernate: false } };
  s.clock.advance(5 * 60_000);
  await s.settings.refresh();
  const { hibernation } = await s.handler({ action: 'status', workloadId: 'demo' });
  assert.deepEqual([hibernation.hibernate, hibernation.from, 'unknown' in hibernation], [false, 'manager', false]);
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

test('a workload found awake again 59 days or more after its hibernation asks for a fresh boot, as a wake does; a younger one does not (hibernation, 60 days)', async () => {
  const foundAwake = async (state, days) => {
    const hibernated = JSON.stringify({ ids: ['i-0123456789abcdef0'], at: 1_700_000_000_000 - days * 86_400_000 });
    const s = setup({ run: { state, failedAt: 1, hibernated }, instance: 'running', target: 'waker', healthy: 1 });
    // Held asleep (the 60-day wake too) while someone starts its instance by hand: the check finds it running.
    await s.handler({ action: 'pause', workloadId: 'demo', by: 'ops@example.com', reason: 'budget freeze', keepAsleep: true });
    const [result] = await s.handler({ action: 'check' });
    assert.equal(result.state, STATES.AWAKE, `${state} ${days}`);
    assert.equal('hibernated' in s.store.state.run, false);
    return s.store.state.run;
  };
  for (const state of [STATES.ASLEEP, STATES.FAILED]) {
    assert.equal((await foundAwake(state, 60)).freshBoot, true, state);
    assert.equal('freshBoot' in (await foundAwake(state, 10)), false, state);
  }
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
  assert.deepEqual(await s.handler({ action: 'settings', settings: { hibernate: true }, by: 'ana' }), { level: 'router', settings: { hibernate: true, joinMinutes: null, by: 'ana', at: new Date(at).toISOString() } });
  assert.deepEqual(s.store.state.routerSettings, { hibernate: true, by: 'ana', at });
  assert.deepEqual(await s.handler({ action: 'settings', settings: { hibernate: null }, by: 'ana' }), { level: 'router', settings: { hibernate: null, joinMinutes: null, by: null, at: null } });
  assert.equal(s.store.state.routerSettings, undefined);
});

test('settings of the router: joinMinutes and hibernate leave each other alone (joined windows)', async () => {
  const s = setup({ run: { state: STATES.AWAKE } });
  const at = new Date(s.clock.now()).toISOString();
  assert.deepEqual(await s.handler({ action: 'settings', settings: { joinMinutes: 30 }, by: 'ana' }), { level: 'router', settings: { hibernate: null, joinMinutes: 30, by: 'ana', at } });
  assert.deepEqual(await s.handler({ action: 'settings', settings: { hibernate: false }, by: 'bob' }), { level: 'router', settings: { hibernate: false, joinMinutes: 30, by: 'bob', at } });
  assert.deepEqual(s.store.state.routerSettings, { hibernate: false, joinMinutes: 30, by: 'bob', at: s.clock.now() });
  assert.deepEqual(await s.handler({ action: 'settings', settings: { joinMinutes: 0 }, by: 'ana' }), { level: 'router', settings: { hibernate: false, joinMinutes: 0, by: 'ana', at } });
  assert.deepEqual(await s.handler({ action: 'settings', settings: { joinMinutes: null }, by: 'ana' }), { level: 'router', settings: { hibernate: false, joinMinutes: null, by: 'ana', at } });
  assert.deepEqual(await s.handler({ action: 'settings', settings: { joinMinutes: 10 }, by: 'ana' }), { level: 'router', settings: { hibernate: false, joinMinutes: 10, by: 'ana', at } });
  assert.deepEqual(await s.handler({ action: 'settings', settings: { hibernate: null }, by: 'ana' }), { level: 'router', settings: { hibernate: null, joinMinutes: 10, by: 'ana', at } });
  // Nothing sent changes nothing, and who and when stay.
  assert.deepEqual(await s.handler({ action: 'settings', settings: {}, by: 'carl' }), { level: 'router', settings: { hibernate: null, joinMinutes: 10, by: 'ana', at } });
  assert.deepEqual(await s.handler({ action: 'settings', settings: { joinMinutes: null, hibernate: null }, by: 'ana' }), { level: 'router', settings: { hibernate: null, joinMinutes: null, by: null, at: null } });
  assert.equal(s.store.state.routerSettings, undefined);
  assert.deepEqual(await s.handler({ action: 'settings', settings: { hibernate: true, joinMinutes: 5 }, by: 'ana' }), { level: 'router', settings: { hibernate: true, joinMinutes: 5, by: 'ana', at } });
  assert.deepEqual((await s.handler({ action: 'settings', settings: { joinMinutes: 7 }, by: 'ana' })).problems, ['settings: joinMinutes must be a whole number from 0 to 120, a multiple of 5, or null']);
  assert.equal(s.store.state.routerSettings.joinMinutes, 5);
});

test('settings of the router: a record that cannot be read is not written over (joined windows)', async () => {
  const s = setup({ run: { state: STATES.AWAKE } });
  await s.store.putRouterSettings({ hibernate: false, by: 'ana', at: 1 });
  const read = s.store.getRouterSettings;
  s.store.getRouterSettings = async () => { throw new Error('ThrottlingException'); };
  await assert.rejects(s.handler({ action: 'settings', settings: { joinMinutes: 30 }, by: 'ana' }), /ThrottlingException/);
  s.store.getRouterSettings = read;
  assert.deepEqual(await s.store.getRouterSettings(), { hibernate: false, by: 'ana', at: 1 });
});

test('settings of a workload: joinMinutes is on its schedule, refused here (joined windows)', async () => {
  const s = setup({ run: { state: STATES.AWAKE }, cfg: testConfig({ source: 'manager' }) });
  assert.deepEqual(await s.handler({ action: 'settings', workloadId: 'demo', settings: { joinMinutes: 30 }, by: 'ana' }), { problems: ['settings: a workload\'s joinMinutes is on its schedule'] });
  assert.equal('joinMinutes' in await s.store.getConfig('demo'), false);
});

test('schedule and status answer the value in force, its level, and what removing the workload\'s would give (joined windows)', async () => {
  const s = setup({ run: { state: STATES.AWAKE }, managerSettings: { url: 's3://b/settings.json', refresh: async () => {}, current: async () => ({ hibernate: true, joinMinutes: 45, endedWindowDays: null, readAt: 1, error: null }) } });
  const none = await s.handler({ action: 'status', workloadId: 'demo' });
  assert.equal(none.schedule, null);
  assert.deepEqual([none.joinMinutes, none.joinFrom, none.joinInherited], [45, 'organization', { joinMinutes: 45, joinFrom: 'organization' }]);
  await s.store.putRouterSettings({ joinMinutes: 30, by: 'ana', at: 1 });
  // A gap of 20: joined at 30, not at the default.
  const windows = [{ kind: 'awake', days: ['mon'], start: '08:00', end: '12:00' }, { kind: 'awake', days: ['mon'], start: '12:20', end: '18:00' }];
  const inherited = await s.handler({ action: 'schedule', workloadId: 'demo', schedule: { timeZone: 'UTC', windows }, by: 'me' });
  assert.deepEqual([inherited.joinMinutes, inherited.joinFrom, inherited.joinInherited], [30, 'router', { joinMinutes: 30, joinFrom: 'router' }]);
  assert.deepEqual(inherited.next.slice(0, 2).map((e) => e.kind), ['awake-start', 'awake-start'], 'its next events use the value');
  const own = await s.handler({ action: 'schedule', workloadId: 'demo', schedule: { timeZone: 'UTC', windows, joinMinutes: 0 }, by: 'me' });
  assert.deepEqual([own.joinMinutes, own.joinFrom, own.joinInherited], [0, 'workload', { joinMinutes: 30, joinFrom: 'router' }]);
  assert.deepEqual(own.next.slice(0, 2).map((e) => e.kind), ['awake-start', 'awake-end']);
  assert.equal(own.schedule.joinMinutes, 0);
  assert.equal(s.store.state.schedules.demo.joinMinutes, 0);
  const shown = await s.handler({ action: 'status', workloadId: 'demo' });
  assert.deepEqual([shown.joinMinutes, shown.joinFrom, shown.joinInherited], [0, 'workload', { joinMinutes: 30, joinFrom: 'router' }]);
  // No level: the default.
  const bare = setup({ run: { state: STATES.AWAKE } });
  const nothing = await bare.handler({ action: 'schedule', workloadId: 'demo', schedule: { timeZone: 'UTC', windows }, by: 'me' });
  assert.deepEqual([nothing.joinMinutes, nothing.joinFrom, nothing.joinInherited], [15, 'default', { joinMinutes: 15, joinFrom: 'default' }]);
});

test('schedule: a level that cannot be read falls through and is logged, never failing the answer (joined windows)', async () => {
  const s = setup({ run: { state: STATES.AWAKE }, managerSettings: { url: 's3://b/settings.json', refresh: async () => {}, current: async () => ({ hibernate: true, joinMinutes: 30, endedWindowDays: null, readAt: 1, error: null }) } });
  const warnings = [];
  s.log.warn = (event, fields) => warnings.push({ event, ...fields });
  s.store.getRouterSettings = async () => { throw new Error('ThrottlingException'); };
  const windows = [{ kind: 'awake', days: ['mon'], start: '08:00', end: '12:00' }];
  const answer = await s.handler({ action: 'schedule', workloadId: 'demo', schedule: { timeZone: 'UTC', windows }, by: 'me' });
  assert.deepEqual([answer.joinMinutes, answer.joinFrom], [30, 'organization']);
  assert.deepEqual(warnings.filter((w) => w.event === 'JoinLevelUnreadable'), [{ event: 'JoinLevelUnreadable', level: 'router', error: 'ThrottlingException' }]);
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

// --- The branded waiting page (design §5, §9, §11) ---------------------------------------------------------------------

const wakeUp = async (s, wakeId = 'w1') => {
  s.ec2.state.onStart.push(() => { s.clock.onSleep(() => { s.elbv2.state.healthy = 1; }); });
  return s.handler({ action: 'wake', workloadId: 'demo', wakeId });
};

test('a completed wake adds its duration to the run\'s recentWakes (a JSON string, the last 10); a wake found awake, failed or superseded does not (waiting page)', async () => {
  const s = setup({ run: { state: STATES.WAKING, wakeId: 'w1', recentWakes: JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) }, instance: 'stopped', target: 'waker', healthy: 0 });
  s.store.state.run.wakeStartedAt = s.clock.now() - 40_000;
  assert.equal((await wakeUp(s)).state, STATES.AWAKE);
  const kept = JSON.parse(s.store.state.run.recentWakes);
  assert.equal(kept.length, 10);
  assert.deepEqual(kept.slice(0, 9), [2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.ok(kept[9] >= 40_000);

  const fresh = setup({ run: { state: STATES.WAKING, wakeId: 'w1', wakeStartedAt: 1_700_000_000_000 - 5000, recentWakes: 'not json' }, instance: 'stopped', target: 'waker', healthy: 0 });
  await wakeUp(fresh);
  const afresh = JSON.parse(fresh.store.state.run.recentWakes);
  assert.ok(afresh.length === 1 && afresh[0] >= 5000, 'a bad value starts afresh');

  const found = setup({ run: { state: STATES.ASLEEP, recentWakes: '[7]' }, instance: 'running', target: 'waker', healthy: 1, metric: [1] });
  await found.handler({ action: 'check' });
  assert.equal(found.store.state.run.state, STATES.AWAKE);
  assert.equal(found.store.state.run.recentWakes, '[7]', 'found awake: not a wake that ended');

  const failed = setup({ run: { state: STATES.WAKING, wakeId: 'w1', recentWakes: '[7]' }, instance: 'stopped', target: 'waker', healthy: 0 });
  assert.equal((await failed.handler({ action: 'wake', workloadId: 'demo', wakeId: 'w1' })).state, STATES.FAILED);
  assert.equal(failed.store.state.run.recentWakes, '[7]');

  const superseded = setup({ run: { state: STATES.WAKING, wakeId: 'newer', recentWakes: '[7]' }, instance: 'stopped', target: 'waker' });
  assert.equal((await superseded.handler({ action: 'wake', workloadId: 'demo', wakeId: 'older' })).state, 'SUPERSEDED');
  assert.equal(superseded.store.state.run.recentWakes, '[7]');
});

const TEMPLATE = { mode: 'template', title: 'Acme portal', description: 'Sleeps at night.' };
const CUSTOM = { mode: 'custom', html: '<!doctype html><p data-dormeto="status"></p>' };
const waitingPage = (s, op, extra = {}) => s.handler({ action: 'waiting-page', op, workloadId: 'demo', by: 'ana', ...extra });

test('waiting-page put at the workload level: validated, stored with who and when, answers the levels\' resolution, warnings and the cached favicon', async () => {
  const s = setup({ run: { state: STATES.AWAKE }, cfg: testConfig({ source: 'manager' }) });
  s.organization.page = { mode: 'template', icon: 'none', title: 'Org', description: 'From the organization.' };
  await s.store.putFavicon('demo', { icon: 'data:image/png;base64,AA==', fetchedAt: 1_700_000_000_000 - 1000, error: null });
  const at = s.clock.now();
  const view = await waitingPage(s, 'put', { page: TEMPLATE });
  assert.deepEqual(s.store.state.pages['WL#demo'], { page: TEMPLATE, by: 'ana', at });
  assert.deepEqual(view.own, TEMPLATE);
  assert.deepEqual(view.inherited, { mode: 'template', icon: 'none', title: 'Org', description: 'From the organization.', from: { mode: 'organization', icon: 'organization', title: 'organization', description: 'organization' } });
  assert.deepEqual([view.effective.title, view.effective.icon, view.effective.description], ['Acme portal', 'none', 'Sleeps at night.']);
  assert.deepEqual(view.from, { mode: 'workload', icon: 'organization', title: 'workload', description: 'workload' });
  assert.deepEqual(view.favicon, { icon: 'data:image/png;base64,AA==', fetchedAt: new Date(at - 1000).toISOString(), error: null });
  assert.deepEqual([view.warnings, view.terraform, view.by, view.at], [[], false, 'ana', new Date(at).toISOString()]);

  const custom = await waitingPage(s, 'put', { page: { mode: 'custom', html: '<p>no status</p>' } });
  assert.equal(custom.warnings.length, 1);
  assert.match(custom.warnings[0], /data-dormeto="status"/);
});

test('waiting-page: bad pages answer the problems and write nothing; a 256 KiB page round-trips; the log holds its size and hash, never the html', async () => {
  const s = setup({ run: { state: STATES.AWAKE }, cfg: testConfig({ source: 'manager' }) });
  const logged = [];
  s.log.info = (event, fields) => logged.push({ event, ...fields });
  const bad = await waitingPage(s, 'put', { page: { mode: 'template', title: 'x'.repeat(81) } });
  assert.deepEqual(bad.problems.length, 1);
  assert.deepEqual((await waitingPage(s, 'put', { page: { mode: 'custom' } })).problems, ['html is required in a custom page']);
  assert.deepEqual((await s.handler({ action: 'waiting-page', op: 'put', page: 'x', by: 'ana' })).problems, ['the page must be an object']);
  assert.deepEqual(s.store.state.pages, {});

  const html = `<!doctype html><p data-dormeto="status"></p>${'a'.repeat(256 * 1024 - 60)}`;
  assert.ok(Buffer.byteLength(html) <= 256 * 1024);
  const view = await waitingPage(s, 'put', { page: { mode: 'custom', html } });
  assert.equal(view.own.html, html);
  assert.equal(view.effective.html, html);
  const line = logged.find((l) => l.event === 'WaitingPageSet');
  assert.deepEqual([line.level, line.mode, line.bytes], ['workload', 'custom', Buffer.byteLength(html)]);
  assert.equal(line.sha256, createHash('sha256').update(html).digest('hex'), 'the hash of the HTML alone, as the audit\'s');
  assert.ok(logged.every((l) => !JSON.stringify(l).includes('aaaaaaaa')));
});

test('waiting-page at the router level: no workload id, the router\'s item; the view has no favicon and is not Terraform\'s', async () => {
  const s = setup({ run: { state: STATES.AWAKE } });
  const view = await s.handler({ action: 'waiting-page', op: 'put', page: TEMPLATE, by: 'ana' });
  assert.deepEqual(s.store.state.pages.router.page, TEMPLATE);
  assert.deepEqual([view.own, view.favicon, view.terraform, view.from.title], [TEMPLATE, null, false, 'router']);
  assert.equal((await s.handler({ action: 'waiting-page', op: 'get' })).own.title, 'Acme portal');
  await s.handler({ action: 'waiting-page', op: 'delete', by: 'ana' });
  assert.equal((await s.handler({ action: 'waiting-page', op: 'get' })).own, null);
  assert.equal('router' in s.store.state.pages, false);
});

test('waiting-page get: an unreadable stored page reads as none, inherited by the levels above; Terraform-written is flagged', async () => {
  const s = setup({ run: { state: STATES.AWAKE } });
  s.store.state.pages['WL#demo'] = { page: { mode: 'template', title: 'x'.repeat(200) }, by: null, at: null };
  s.organization.page = CUSTOM;
  const view = await waitingPage(s, 'get');
  assert.deepEqual([view.own, view.terraform, view.by, view.at], [{ mode: 'template' }, true, null, null]);
  assert.equal(view.effective.mode, 'template', 'the field that is bad is dropped, the document still decides the mode');
  await assert.rejects(waitingPage(s, 'get', { workloadId: 'nope' }), { message: 'workload not configured: nope' });
  await assert.rejects(waitingPage(s, 'frob'), { message: 'unknown waiting-page op: frob' });
});

test('waiting-page: a Terraform workload refuses a put; a delete is refused for an item Terraform wrote (no by) and allowed for one the manager wrote before (waiting page §11)', async () => {
  const s = setup({ run: { state: STATES.AWAKE } });
  await assert.rejects(waitingPage(s, 'put', { page: TEMPLATE }), { message: 'workload demo was written by Terraform: set waiting_page in its workload module' });
  assert.deepEqual(s.store.state.pages, {});

  s.store.state.pages['WL#demo'] = { page: TEMPLATE, by: null, at: null };
  await assert.rejects(waitingPage(s, 'delete'), { message: 'workload demo was written by Terraform: set waiting_page in its workload module' });
  assert.ok('WL#demo' in s.store.state.pages);

  s.store.state.pages['WL#demo'] = { page: TEMPLATE, by: 'ana', at: 5 };
  const view = await waitingPage(s, 'delete');
  assert.equal(view.own, null);
  assert.equal('WL#demo' in s.store.state.pages, false);

  const manager = setup({ run: { state: STATES.AWAKE }, cfg: testConfig({ source: 'manager' }) });
  manager.store.state.pages['WL#demo'] = { page: TEMPLATE, by: null, at: null };
  await waitingPage(manager, 'delete');
  assert.equal('WL#demo' in manager.store.state.pages, false);
});

test('a 256 KiB page and a recentWakes list reach neither the list, the status nor the check\'s summary (waiting page review focus 4)', async () => {
  const s = setup({ run: { state: STATES.AWAKE, recentWakes: '[1000,2000]' }, cfg: testConfig({ source: 'manager' }) });
  const html = `<!doctype html><p data-dormeto="status"></p><!--${'z'.repeat(256 * 1024 - 80)}-->`;
  await waitingPage(s, 'put', { page: { mode: 'custom', html } });
  await s.store.putFavicon('demo', { icon: `data:image/png;base64,${'A'.repeat(1000)}`, fetchedAt: 1, error: null });
  for (const event of [{ action: 'list' }, { action: 'status', workloadId: 'demo' }, { action: 'check' }, { action: 'router' }]) {
    const out = JSON.stringify(await s.handler(event));
    assert.ok(!out.includes('zzzzzzzz') && !out.includes('AAAAAAAA'), event.action);
    assert.ok(out.length < 20_000, `${event.action}: ${out.length}`);
  }
});

// --- The favicon read in nap() (design §6) -------------------------------------------------------------------------------

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PNG_URI = `data:image/png;base64,${PNG_BYTES.toString('base64')}`;
const DAY = 86_400_000;
// A fetch for demo.example.com: its home page links /f.png.
const app = (s, { onPage } = {}) => {
  s.network.fetch = async (url) => {
    if (url === 'https://demo.example.com/') { onPage?.(); return new Response('<link rel="icon" href="/f.png">', { status: 200 }); }
    if (url === 'https://demo.example.com/f.png') return new Response(PNG_BYTES, { status: 200 });
    return new Response('', { status: 404 });
  };
};
const hostRule = (s, ...hosts) => { s.elbv2.state.rules.get(s.cfg.ruleArn).conditions = hosts.map(host); };
const napped = async (s) => (await s.handler({ action: 'nap', workloadId: 'demo' })).state;

test('nap: the favicon is read once every check passed and just before the NAPPING transition, while the route still goes to the application; cached with its date', async () => {
  const s = setup({ run: { state: STATES.AWAKE } });
  hostRule(s, 'demo.example.com');
  const seen = [];
  app(s, { onPage: () => seen.push([s.store.state.run.state, routeOf(s.elbv2, s.cfg)]) });
  const at = s.clock.now();
  assert.equal(await napped(s), STATES.ASLEEP);
  assert.deepEqual(seen, [[STATES.AWAKE, 'app']]);
  assert.deepEqual(s.network.calls, ['https://demo.example.com/', 'https://demo.example.com/f.png']);
  assert.deepEqual(s.store.state.favicons.demo, { icon: PNG_URI, fetchedAt: at, error: null });
});

test('nap: the favicon is due once in 24 hours, successful or not; the FAVICON item is read first and the levels only when due', async () => {
  const s = setup({ run: { state: STATES.AWAKE } });
  hostRule(s, 'demo.example.com');
  app(s);
  const levels = [];
  const getPage = s.store.getWaitingPage;
  s.store.getWaitingPage = async (level, ...rest) => { levels.push(level); return getPage(level, ...rest); };
  s.store.state.favicons.demo = { icon: null, fetchedAt: s.clock.now() - DAY + 60_000, error: 'the page answered 401' };
  assert.equal(await napped(s), STATES.ASLEEP);
  assert.deepEqual([s.network.calls, levels, s.organization.reads], [[], [], 0], 'read less than a day ago, even when it failed: nothing read');

  s.store.state.run.state = STATES.AWAKE;
  s.store.state.favicons.demo.fetchedAt = s.clock.now() - DAY - 1;
  assert.equal(await napped(s), STATES.ASLEEP);
  assert.equal(s.network.calls.length, 2);
  assert.deepEqual([levels.length, s.organization.reads], [2, 1], 'router and workload from the table, the organization\'s from the manager\'s settings');
});

test('nap: the read happens only for a template with icon auto: not for none, an upload or a custom page, at any level', async () => {
  for (const [name, pages] of [
    ['none at the organization', { organization: { mode: 'template', icon: 'none' } }],
    ['an upload at the router', { router: { mode: 'template', icon: PNG_URI } }],
    ['a custom page at the workload', { 'WL#demo': { mode: 'custom', html: '<p data-dormeto="status"></p>' } }],
    ['a custom page above an auto template', { organization: { mode: 'template', icon: 'auto' }, router: { mode: 'custom', html: '<p>x</p>' } }],
  ]) {
    const s = setup({ run: { state: STATES.AWAKE } });
    hostRule(s, 'demo.example.com');
    app(s);
    for (const [level, page] of Object.entries(pages)) {
      if (level === 'organization') s.organization.page = page;
      else s.store.state.pages[level] = { page, by: 'ana', at: 1 };
    }
    assert.equal(await napped(s), STATES.ASLEEP, name);
    assert.deepEqual([name, s.network.calls, s.store.state.favicons], [name, [], {}]);
  }
  const auto = setup({ run: { state: STATES.AWAKE } });
  hostRule(auto, 'demo.example.com');
  app(auto);
  auto.organization.page = { mode: 'template', icon: 'auto', title: 'Org' };
  await napped(auto);
  assert.equal(auto.network.calls.length, 2, 'auto explicitly');
});

test('nap: a read that throws, hangs or finds nothing leaves the nap going; a failed read keeps the last icon, records the error and waits 24 hours', async () => {
  const boom = setup({ run: { state: STATES.AWAKE } });
  hostRule(boom, 'demo.example.com');
  boom.network.fetch = async () => { throw new TypeError('fetch failed'); };
  assert.equal(await napped(boom), STATES.ASLEEP);
  assert.deepEqual([boom.store.state.favicons.demo.icon, boom.store.state.favicons.demo.error], [null, 'fetch failed']);

  const hang = setup({ run: { state: STATES.AWAKE } });
  hostRule(hang, 'demo.example.com');
  hang.network.fetch = () => new Promise(() => {});
  const started = Date.now();
  assert.equal(await napped(hang), STATES.ASLEEP);
  assert.ok(Date.now() - started < 1500);
  assert.match(hang.store.state.favicons.demo.error, /time budget/);

  const kept = setup({ run: { state: STATES.AWAKE } });
  hostRule(kept, 'demo.example.com');
  kept.network.fetch = async () => new Response('', { status: 401 });
  kept.store.state.favicons.demo = { icon: PNG_URI, fetchedAt: kept.clock.now() - DAY - 1, error: null };
  const at = kept.clock.now();
  assert.equal(await napped(kept), STATES.ASLEEP);
  assert.deepEqual(kept.store.state.favicons.demo, { icon: PNG_URI, fetchedAt: at, error: 'the page answered 401' });
});

test('nap: a store that cannot read or write the favicon, or the levels, changes nothing about the nap', async () => {
  for (const method of ['getFavicon', 'putFavicon', 'getWaitingPage']) {
    const s = setup({ run: { state: STATES.AWAKE } });
    hostRule(s, 'demo.example.com');
    app(s);
    s.store[method] = async () => { throw new Error('ProvisionedThroughputExceeded'); };
    assert.equal(await napped(s), STATES.ASLEEP, method);
    assert.equal(routeOf(s.elbv2, s.cfg), 'waker');
  }
});

test('nap: no host name (no rule with a literal host) is recorded as the reason and waits 24 hours; the first literal host of the rules is used', async () => {
  const none = setup({ run: { state: STATES.AWAKE } });
  const at = none.clock.now();
  assert.equal(await napped(none), STATES.ASLEEP);
  assert.deepEqual(none.store.state.favicons.demo, { icon: null, fetchedAt: at, error: 'no rule for the whole of a host name' });
  assert.deepEqual(none.network.calls, []);

  const wild = setup({ run: { state: STATES.AWAKE } });
  hostRule(wild, '*.example.com');
  wild.elbv2.state.rules.set('arn:rule/second', { actions: wild.elbv2.state.forward(1, 0), conditions: [host('demo.example.com')], priority: '30', tags: { 'dormeto:workload': 'demo' } });
  app(wild);
  await napped(wild);
  assert.equal(wild.network.calls[0], 'https://demo.example.com/');
});

test('nap: a nap that is skipped (paused, nothing to stop, a rule the router cannot switch) reads no favicon', async () => {
  const paused = setup({ run: { state: STATES.AWAKE } });
  hostRule(paused, 'demo.example.com');
  app(paused);
  await paused.store.putPause('demo', { by: 'ana', at: 1, reason: 'x', keepAsleep: false });
  assert.equal(await napped(paused), 'SKIPPED');
  const rule = setup({ run: { state: STATES.AWAKE } });
  hostRule(rule, 'demo.example.com');
  app(rule);
  rule.elbv2.state.rules.set('arn:rule/new', { actions: appOnly(rule.cfg), priority: '30', conditions: [path('/new/*')], tags: {} });
  assert.equal(await napped(rule), 'SKIPPED');
  for (const s of [paused, rule]) assert.deepEqual([s.network.calls, s.store.state.favicons], [[], {}]);
});

test('nap of a Kubernetes workload: the host comes from the rules the load balancer holds for its target group', async () => {
  const s = k8sSetup({ state: STATES.AWAKE });
  hostRule(s, 'web.example.com');
  app(s);
  s.network.fetch = async (url) => (url === 'https://web.example.com/' ? new Response('<link rel="icon" href="/f.png">') : new Response(PNG_BYTES));
  assert.equal(await napped(s), STATES.ASLEEP);
  assert.equal(s.network.calls[0], 'https://web.example.com/');
  assert.equal(s.store.state.favicons.demo.icon, PNG_URI);
});

// --- Fix round 1: one budget for the favicon step ----------------------------------------------------------------------

const later = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('nap: a store that hangs or answers late spends the favicon\'s one budget: the nap goes on, nothing goes out afterwards, and it is logged', async () => {
  for (const delay of [Infinity, 200]) {
    const s = setup({ run: { state: STATES.AWAKE } });
    hostRule(s, 'demo.example.com');
    app(s);
    const warned = [];
    s.log.warn = (event, fields) => warned.push([event, fields.workloadId]);
    s.store.getFavicon = () => (delay === Infinity ? new Promise(() => {}) : later(delay).then(() => null));
    const started = Date.now();
    assert.equal(await napped(s), STATES.ASLEEP);
    assert.ok(Date.now() - started < 1000, `${Date.now() - started} ms`);
    await later(delay === Infinity ? 100 : 400);
    assert.deepEqual(s.network.calls, [], 'nothing goes out once the budget is spent');
    assert.deepEqual(s.store.state.favicons, {});
    assert.deepEqual(warned.filter(([event]) => event === 'FaviconGaveUp'), [['FaviconGaveUp', 'demo']]);
  }
});

test('nap: a nap on a workload that is not awake reads no favicon', async () => {
  const s = setup({ run: { state: STATES.ASLEEP }, instance: 'stopped', target: 'waker' });
  hostRule(s, 'demo.example.com');
  app(s);
  assert.equal(await napped(s), 'SKIPPED');
  assert.deepEqual([s.network.calls, s.store.state.favicons, s.store.state.run.state], [[], {}, STATES.ASLEEP]);
});

test('nap: the host comes only from rules that are all host (or the path /*): a path, a header or a wildcard alone gives no host name', async () => {
  const path = (p) => ({ Field: 'path-pattern', PathPatternConfig: { Values: [p] } });
  const shared = setup({ run: { state: STATES.AWAKE } });
  shared.elbv2.state.rules.get(shared.cfg.ruleArn).conditions = [host('shop.example.com'), path('/api/*')];
  app(shared);
  assert.equal(await napped(shared), STATES.ASLEEP);
  assert.deepEqual([shared.network.calls, shared.store.state.favicons.demo.error], [[], 'no rule for the whole of a host name']);

  const header = setup({ run: { state: STATES.AWAKE } });
  header.elbv2.state.rules.get(header.cfg.ruleArn).conditions = [host('shop.example.com'), { Field: 'http-header', HttpHeaderConfig: { HttpHeaderName: 'x-env', Values: ['a'] } }];
  app(header);
  await napped(header);
  assert.deepEqual(header.network.calls, []);

  const wild = setup({ run: { state: STATES.AWAKE } });
  wild.elbv2.state.rules.get(wild.cfg.ruleArn).conditions = [{ Field: 'host-header', HostHeaderConfig: { Values: ['*.example.com', 'demo.example.com'] } }, path('/*')];
  app(wild);
  await napped(wild);
  assert.equal(wild.network.calls[0], 'https://demo.example.com/');
});

test('the organization\'s page: read from the manager\'s settings by the favicon step inside its budget and by get; a failed read skips the favicon and leaves get answering', async () => {
  const s = setup({ run: { state: STATES.AWAKE } });
  hostRule(s, 'demo.example.com');
  app(s);
  s.organization.page = { mode: 'template', icon: 'auto', title: 'Org' };
  assert.equal(await napped(s), STATES.ASLEEP);
  assert.equal(s.organization.signals.length, 1);
  assert.ok(s.organization.signals[0] instanceof AbortSignal, 'inside the step\'s budget');
  assert.equal(s.network.calls.length, 2);

  const failing = setup({ run: { state: STATES.AWAKE } });
  hostRule(failing, 'demo.example.com');
  app(failing);
  failing.organization.failure = new Error('SlowDown');
  const warned = [];
  failing.log.warn = (event, fields) => warned.push([event, fields.error]);
  assert.equal(await napped(failing), STATES.ASLEEP);
  assert.deepEqual([failing.network.calls, failing.store.state.favicons], [[], {}], 'the organization may have said none: no read');
  assert.ok(warned.some(([event]) => event === 'FaviconSkipped'));
  const view = await waitingPage(failing, 'get');
  assert.equal(view.effective.mode, 'template');
  assert.ok(warned.some(([event]) => event === 'WaitingPageUnread'));
});

test('the organization\'s level reaches the get answer from settings.json, and nothing of it is ever written to the table', async () => {
  const s = setup({ run: { state: STATES.AWAKE }, cfg: testConfig({ source: 'manager' }) });
  s.organization.page = { mode: 'template', title: 'Org' };
  const view = await waitingPage(s, 'put', { page: { mode: 'template', description: 'Ours.' } });
  assert.deepEqual([view.effective.title, view.effective.description, view.from.title], ['Org', 'Ours.', 'organization']);
  assert.deepEqual(Object.keys(s.store.state.pages), ['WL#demo']);
});

test('waiting-page refuses what would widen its target: an empty or odd workloadId (it is not the router\'s level) and a put with no by', async () => {
  const s = setup({ run: { state: STATES.AWAKE }, cfg: testConfig({ source: 'manager' }) });
  for (const workloadId of ['', 0, false, {}, ['demo']]) {
    await assert.rejects(s.handler({ action: 'waiting-page', op: 'put', workloadId, page: TEMPLATE, by: 'ana' }), { message: 'workloadId must be the id of a workload' }, JSON.stringify(workloadId));
  }
  for (const by of [undefined, '', null, 7]) {
    await assert.rejects(waitingPage(s, 'put', { page: TEMPLATE, by }), { message: 'a put needs by: who sets the page' });
  }
  assert.deepEqual(s.store.state.pages, {});
  // Absent or null is the router's level.
  for (const workloadId of [undefined, null]) assert.equal((await s.handler({ action: 'waiting-page', op: 'get', workloadId })).terraform, false);
});

test('waiting-page: a Terraform workload with no item can be deleted from (nothing to refuse)', async () => {
  const s = setup({ run: { state: STATES.AWAKE } });
  const view = await waitingPage(s, 'delete');
  assert.equal(view.own, null);
});

// --- Pinned: the favicon step's 3 s budget, and the one budget for the whole step ------------------------------------------

// Lets the promises that are ready run (the timers are the test's).
const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

test('nap: the favicon step\'s budget is 3 s by default: aborted at 3000 ms, not before', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = setup({ run: { state: STATES.AWAKE }, faviconBudgetMs: 'default' });
  hostRule(s, 'demo.example.com');
  app(s);
  let signal;
  s.organization.read = async (options) => { signal = options.signal; return new Promise(() => {}); };
  const nap = napped(s);
  await settle();
  t.mock.timers.tick(2999);
  await settle();
  assert.equal(signal.aborted, false, 'still within 3 s');
  t.mock.timers.tick(1);
  await settle();
  assert.equal(signal.aborted, true, 'spent at 3 s');
  t.mock.timers.tick(10_000);
  assert.equal(await nap, STATES.ASLEEP);
});

test('nap: the read of the icon runs on the step\'s budget, not on a fresh one: what the levels\' read spent is not given again', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = setup({ run: { state: STATES.AWAKE }, faviconBudgetMs: 200 });
  hostRule(s, 'demo.example.com');
  let signal;
  s.network.fetch = async (url, options) => { signal = options.signal; return new Promise(() => {}); };
  s.organization.read = async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    return { mode: 'template', icon: 'auto' };
  };
  const nap = napped(s);
  await settle();
  t.mock.timers.tick(150);
  await settle();
  assert.ok(signal, 'the read went out');
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(50);
  await settle();
  assert.equal(signal.aborted, true, 'aborted at 200 ms of the step (50 ms after it started), not at 350');
  t.mock.timers.tick(10_000);
  assert.equal(await nap, STATES.ASLEEP);
});

// Refusals are answers, not errors (vision refusals design §1): a caller that sends refusals: true gets each one as
// { refused: { code, message } }, with the message thrown before, and no Lambda error.
test('refusals: a caller that understands them gets each one as an answer with its code, logged at info', async () => {
  const manager = setup({ run: { state: STATES.AWAKE }, cfg: testConfig({ name: 'Demo shop', source: 'manager' }) });
  const terraform = setup({ run: { state: STATES.AWAKE } });
  const logged = [];
  for (const s of [manager, terraform]) s.log.info = (event, data) => logged.push([event, data]);
  const ask = (s, event) => s.handler({ ...event, refusals: true });
  const refused = (code, message) => ({ refused: { code, message } });
  assert.deepEqual(await ask(manager, { action: 'status', workloadId: 'nope' }), refused('not_found', 'workload not configured: nope'));
  assert.deepEqual(await ask(manager, { action: 'schedule', workloadId: 'nope', schedule: weekly(), by: 'me' }), refused('not_found', 'workload not configured: nope'));
  assert.deepEqual(await ask(manager, { action: 'rename', workloadId: 'demo', name: ' ', by: 'ops' }), refused('invalid', 'name: required'));
  assert.deepEqual(await ask(manager, { action: 'tag', workloadId: 'demo', tags: { 'dormeto:x': '1' }, by: 'ops' }), refused('invalid', 'tag "dormeto:x": the dormeto: prefix is reserved'));
  assert.deepEqual(await ask(manager, { action: 'pause', workloadId: 'demo', by: 'ops', reason: ' ' }), refused('invalid', 'reason required (1 to 256 characters)'));
  assert.deepEqual(await ask(manager, { action: 'pause', workloadId: 'demo', by: 'ops', reason: 'x', until: 1 }), refused('invalid', 'until must be in the future, within 366 days'));
  assert.deepEqual(await ask(manager, { action: 'pause', workloadId: 'demo', by: 'ops', reason: 'x', targetGroupArn: 'arn:other' }), refused('not_found', 'workload not configured: demo (its target group is not arn:other)'));
  assert.deepEqual(await ask(manager, { action: 'waiting-page', op: 'move', workloadId: 'demo', by: 'ops' }), refused('invalid', 'unknown waiting-page op: move'));
  assert.deepEqual(await ask(manager, { action: 'waiting-page', op: 'put', workloadId: 'demo' }), refused('invalid', 'a put needs by: who sets the page'));
  assert.deepEqual(await ask(manager, { action: 'dance' }), refused('unsupported', 'unknown action: dance'));
  assert.deepEqual(await ask(terraform, { action: 'rename', workloadId: 'demo', name: 'x', by: 'ops' }), refused('conflict', 'workload demo was written by Terraform: set name in its workload module'));
  assert.deepEqual(await ask(terraform, { action: 'tag', workloadId: 'demo', tags: { team: 'x' }, by: 'ops' }), refused('conflict', 'workload demo was written by Terraform: set tags in its workload module'));
  assert.deepEqual(await ask(terraform, { action: 'settings', workloadId: 'demo', settings: { hibernate: true }, by: 'ana' }), refused('conflict', 'workload demo was written by Terraform: set hibernate in its workload module'));
  assert.deepEqual(await ask(terraform, { action: 'waiting-page', op: 'put', workloadId: 'demo', page: { mode: 'template' }, by: 'ops' }), refused('conflict', 'workload demo was written by Terraform: set waiting_page in its workload module'));
  // A change racing an offboarding: the workload is gone.
  manager.store.putConfig = async () => false;
  assert.deepEqual(await ask(manager, { action: 'rename', workloadId: 'demo', name: 'Shop', by: 'ops' }), refused('not_found', 'workload not configured: demo'));
  const said = logged.filter(([event]) => event === 'Refused');
  assert.equal(said.length, 15);
  assert.deepEqual(said[0][1], { action: 'status', workloadId: 'nope', code: 'not_found', message: 'workload not configured: nope' });
  assert.deepEqual(said.at(-6)[1], { action: 'dance', workloadId: null, code: 'unsupported', message: 'unknown action: dance' });
});

test('refusals: thrown as before without the flag; an error that is no refusal is thrown with it', async () => {
  const terraform = setup({ run: { state: STATES.AWAKE } });
  await assert.rejects(terraform.handler({ action: 'rename', workloadId: 'demo', name: 'x', by: 'ops' }), { message: 'workload demo was written by Terraform: set name in its workload module' });
  await assert.rejects(terraform.handler({ action: 'dance', refusals: false }), { message: 'unknown action: dance' });
  terraform.store.getConfig = async () => { throw new Error('ProvisionedThroughputExceededException'); };
  await assert.rejects(terraform.handler({ action: 'status', workloadId: 'demo', refusals: true }), { message: 'ProvisionedThroughputExceededException' });
});

