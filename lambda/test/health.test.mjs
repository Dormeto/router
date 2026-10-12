import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkLate, healthOf, lambdaMetrics, queueDepths } from '../src/lib/health.mjs';
import { createController } from '../src/lib/controller-core.mjs';
import { STATES } from '../src/lib/state.mjs';
import { fakeAppScaling, fakeAutoScaling, fakeClock, fakeEc2, fakeEcs, fakeElbv2, fakeStore, fakeTagging, silentLog, testConfig } from './fakes.mjs';

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

// CloudWatch answering the Lambda metrics of the router: values per query id.
function fakeLambdaMetrics(values = {}) {
  const calls = [];
  return {
    calls,
    async getMetricData(input) {
      calls.push(input);
      return { MetricDataResults: input.MetricDataQueries.map((q) => ({ Id: q.Id, Values: values[q.Id] ?? [] })) };
    },
  };
}

function fakeSqs(depths = {}) {
  const calls = [];
  return {
    calls,
    async getQueueAttributes({ QueueUrl, AttributeNames }) {
      calls.push({ QueueUrl, AttributeNames });
      if (depths[QueueUrl] instanceof Error) throw depths[QueueUrl];
      return { Attributes: { ApproximateNumberOfMessages: String(depths[QueueUrl] ?? 0) } };
    },
  };
}

test('lambdaMetrics reads errors and throttles of both functions and the waker peak concurrency over 24 hours', async () => {
  const cloudwatch = fakeLambdaMetrics({ controllerErrors: [1, 2], controllerThrottles: [], wakerErrors: [0], wakerThrottles: [3], wakerConcurrency: [4, 9, 2] });
  const figures = await lambdaMetrics(cloudwatch, { controller: 'dmt-dev-controller', waker: 'dmt-dev-waker' }, NOW);
  assert.deepEqual(figures, { controller: { errors: 3, throttles: 0 }, waker: { errors: 0, throttles: 3, peakConcurrency: 9 } });
  const [input] = cloudwatch.calls;
  assert.equal(input.EndTime.getTime() - input.StartTime.getTime(), 24 * HOUR);
  const byId = Object.fromEntries(input.MetricDataQueries.map((q) => [q.Id, q.MetricStat]));
  assert.deepEqual(byId.controllerErrors.Metric, { Namespace: 'AWS/Lambda', MetricName: 'Errors', Dimensions: [{ Name: 'FunctionName', Value: 'dmt-dev-controller' }] });
  assert.equal(byId.controllerErrors.Stat, 'Sum');
  assert.equal(byId.wakerConcurrency.Metric.MetricName, 'ConcurrentExecutions');
  assert.equal(byId.wakerConcurrency.Stat, 'Maximum');
});

test('queueDepths counts the messages waiting in each failure queue', async () => {
  const sqs = fakeSqs({ 'https://q/check': 2, 'https://q/controller': 0 });
  assert.deepEqual(await queueDepths(sqs, { check: 'https://q/check', controller: 'https://q/controller' }), { check: 2, controller: 0 });
  assert.deepEqual(sqs.calls[0], { QueueUrl: 'https://q/check', AttributeNames: ['ApproximateNumberOfMessages'] });
  assert.deepEqual(await queueDepths(sqs, {}), {});
});

test('checkLate: three periods of the schedule without a scheduled check, or none recorded', () => {
  assert.equal(checkLate('rate(5 minutes)', NOW - 14 * 60_000, NOW), false);
  assert.equal(checkLate('rate(5 minutes)', NOW - 16 * 60_000, NOW), true);
  assert.equal(checkLate('rate(1 hour)', NOW - 2 * HOUR, NOW), false);
  assert.equal(checkLate(undefined, NOW - 16 * 60_000, NOW), true, 'five minutes by default');
  assert.equal(checkLate('rate(5 minutes)', null, NOW), true);
});

const healthy = {
  checkSchedule: 'rate(5 minutes)', lastScheduledCheckAt: NOW - 60_000, now: NOW,
  lambda: { controller: { errors: 0, throttles: 0 }, waker: { errors: 0, throttles: 0, peakConcurrency: 3 } },
  queues: { check: 0, controller: 0 },
  ipLists: [{ name: 'ipsum', fetchedAt: new Date(NOW - HOUR).toISOString(), refreshHours: 24 }],
  failed: 0,
};

test('healthOf: ok without problem', () => {
  assert.deepEqual(healthOf(healthy), { status: 'ok', problems: [] });
});

test('healthOf: a late idle check is an error', () => {
  assert.deepEqual(healthOf({ ...healthy, lastScheduledCheckAt: NOW - HOUR }), {
    status: 'error', problems: [{ level: 'error', text: 'idle check late: the last scheduled check ran 60 minutes ago, workloads do not nap on their own' }],
  });
  assert.equal(healthOf({ ...healthy, lastScheduledCheckAt: null }).problems[0].text, 'no scheduled idle check recorded: workloads do not nap on their own');
});

test('healthOf: failure queue messages, Lambda errors and throttles, IP lists and failed workloads are warnings', () => {
  const health = healthOf({
    ...healthy,
    lambda: { controller: { errors: 2, throttles: 0 }, waker: { errors: 0, throttles: 5, peakConcurrency: 50 } },
    queues: { check: 1, controller: 3 },
    ipLists: [{ name: 'ipsum', error: 'HTTP 404', refreshHours: 24 }, { name: 'tor', fetchedAt: new Date(NOW - 49 * HOUR).toISOString(), refreshHours: 24 }],
    failed: 1,
  });
  assert.equal(health.status, 'warning');
  assert.deepEqual(health.problems.map((p) => [p.level, p.text]), [
    ['warning', '1 message in the check-failures queue: scheduled idle checks that could not invoke the controller'],
    ['warning', '3 messages in the controller-failures queue: naps or wakes that failed in their own invocation'],
    ['warning', 'controller: 2 errors in 24 hours'],
    ['warning', 'waker: 5 throttles in 24 hours'],
    ['warning', 'IP list ipsum: HTTP 404'],
    ['warning', 'IP list tor: last downloaded 49 hours ago'],
    ['warning', '1 failed workload'],
  ]);
});

test('healthOf: a Lambda concurrency limit below what a burst can hold is a warning', () => {
  assert.deepEqual(healthOf({ ...healthy, concurrency: { limit: 1000, needed: 60 } }), { status: 'ok', problems: [] });
  assert.deepEqual(healthOf({ ...healthy, concurrency: { limit: 10, needed: 60 } }).problems, [{
    level: 'warning',
    text: 'Lambda concurrency limit of the account in this region is 10, below the 60 a wake can hold (maxHolders and the router): requests beyond it get errors; request a quota increase',
  }]);
  assert.deepEqual(healthOf({ ...healthy, concurrency: { error: 'AccessDenied' } }).problems, [{ level: 'warning', text: 'Lambda concurrency limit unreadable: AccessDenied' }]);
});

test('healthOf: metrics or queues that cannot be read are warnings', () => {
  const health = healthOf({ ...healthy, lambda: { error: 'AccessDenied' }, queues: { error: 'throttled' } });
  assert.deepEqual(health, { status: 'warning', problems: [
    { level: 'warning', text: 'failure queues unreadable: throttled' },
    { level: 'warning', text: 'Lambda metrics unreadable: AccessDenied' },
  ] });
});

// --- Controller action -----------------------------------------------------------------------------------------------

function setup({ run = { state: STATES.AWAKE, updatedAt: NOW - HOUR }, metrics = {}, depths = {}, concurrency = 1000 } = {}) {
  const clock = fakeClock(NOW);
  const cfg = testConfig();
  const store = fakeStore({ config: cfg, run, clock });
  const ecs = fakeEcs();
  const cloudwatch = fakeLambdaMetrics(metrics);
  const sqs = fakeSqs(depths);
  const handler = createController({
    store, ec2: fakeEc2(cfg.instanceIds), elbv2: fakeElbv2(cfg), cloudwatch, autoscaling: fakeAutoScaling(), ecs, tagging: fakeTagging(ecs), appscaling: fakeAppScaling(),
    sqs, lambda: { getAccountSettings: async () => ({ AccountLimit: { ConcurrentExecutions: concurrency } }) },
    invokeSelf: async () => {}, now: clock.now, sleep: clock.sleep, log: silentLog,
    router: {
      name: 'dmt-dev', version: '0.16.0', build: 'abc', checkSchedule: 'rate(5 minutes)', metrics: true,
      functions: { controller: 'dmt-dev-controller', waker: 'dmt-dev-waker' }, queues: { check: 'https://q/check', controller: 'https://q/controller' },
    },
    defaultRules: [{ name: 'e2e', headers: [{ name: 'x-e2e', value: '1' }] }],
    ipLists: [{ name: 'ipsum', url: 'https://x', action: 'defer', refreshHours: 24 }],
  });
  return { handler, store, clock, cloudwatch, sqs };
}

test('router action: identity, configuration with its source, workloads per state, pauses and health', async () => {
  const s = setup();
  await s.store.recordScheduledCheck(NOW - 60_000);
  s.store.state.lists.ipsum = { meta: { version: 'v1', entries: 42, fetchedAt: NOW - HOUR }, parts: {} };
  await s.handler({ action: 'pause', by: 'ops', reason: 'freeze', keepAsleep: true });
  const info = await s.handler({ action: 'router' });
  assert.deepEqual(info.router, { name: 'dmt-dev', version: '0.16.0', build: 'abc' });
  assert.deepEqual(info.configuration.checkSchedule, { value: 'rate(5 minutes)', source: 'terraform' });
  assert.deepEqual(info.configuration.metrics, { value: true, source: 'terraform' });
  assert.deepEqual(info.configuration.ipLists, { value: [{ name: 'ipsum', url: 'https://x', action: 'defer', refreshHours: 24 }], source: 'terraform' });
  assert.deepEqual(info.configuration.noWakeRules.value.map((r) => [r.name, r.level]), [['e2e', 'router']]);
  assert.equal(info.configuration.noWakeRules.source, 'terraform');
  assert.deepEqual(info.pauses.map((p) => [p.scope, p.reason]), [['router', 'freeze']]);
  assert.deepEqual(info.workloads, { total: 1, byState: { AWAKE: 1 }, paused: 1, lastActivityAt: new Date(NOW - HOUR).toISOString() });
  assert.equal(info.health.status, 'ok');
  assert.equal(info.health.lastScheduledCheckAt, new Date(NOW - 60_000).toISOString());
  assert.deepEqual(info.health.queues, { check: 0, controller: 0 });
  assert.deepEqual(info.health.lambda.waker, { errors: 0, throttles: 0, peakConcurrency: 0 });
  assert.deepEqual(info.health.ipLists.map((l) => [l.name, l.entries]), [['ipsum', 42]]);
});

test('router action reads the health the scheduled check stores: metrics and queues are never read per call', async () => {
  const s = setup();
  // Nothing stored yet: measured once, and stored.
  await s.handler({ action: 'router' });
  await s.handler({ action: 'pause', by: 'ops', reason: 'freeze', keepAsleep: true });
  const again = await s.handler({ action: 'router' });
  assert.deepEqual([s.cloudwatch.calls.length, s.sqs.calls.length], [1, 2]);
  assert.equal(again.pauses.length, 1);
  s.clock.advance(16 * 60_000);
  await s.handler({ action: 'router' });
  assert.equal(s.cloudwatch.calls.length, 1, 'a call never measures when a health is stored');
  // The scheduled check measures again once the stored health is 15 minutes old, not before.
  await s.handler({ action: 'check', source: 'schedule' });
  assert.equal(s.cloudwatch.calls.length, 2);
  s.clock.advance(5 * 60_000);
  await s.handler({ action: 'check', source: 'schedule' });
  assert.equal(s.cloudwatch.calls.length, 2);
});

test('a scheduled check measures the health before its work, so one that dies still does; an old health is measured on read', async () => {
  const s = setup();
  await s.handler({ action: 'router' });
  s.clock.advance(16 * 60_000);
  // The check dies in its work (a timeout lands it in the failure queue): the health was measured first.
  const listConfigs = s.store.listConfigs;
  s.store.listConfigs = async () => { throw new Error('timed out'); };
  await assert.rejects(s.handler({ action: 'check', source: 'schedule' }), /timed out/);
  s.store.listConfigs = listConfigs;
  assert.equal(s.cloudwatch.calls.length, 2);
  // No scheduled check stored a health for more than 30 minutes: a read measures it.
  s.clock.advance(31 * 60_000);
  await s.handler({ action: 'router' });
  assert.equal(s.cloudwatch.calls.length, 3);
});

test('router action reports the concurrency limit of the region against the largest maxHolders', async () => {
  const s = setup({ concurrency: 10 });
  const info = await s.handler({ action: 'router' });
  assert.deepEqual(info.health.concurrency, { limit: 10, needed: 15 });
  assert.ok(info.health.problems.some((p) => p.text.startsWith('Lambda concurrency limit of the account in this region is 10')));
});

test('router action answers when CloudWatch, SQS and the table fail', async () => {
  const s = setup({ depths: { 'https://q/check': new Error('throttled') } });
  s.cloudwatch.getMetricData = async () => { throw new Error('AccessDenied'); };
  s.store.getCheck = async () => { throw new Error('table'); };
  s.store.listPauses = async () => { throw new Error('table'); };
  const info = await s.handler({ action: 'router' });
  assert.equal(info.health.status, 'error', 'no scheduled check known');
  assert.ok(info.health.problems.some((p) => p.text === 'Lambda metrics unreadable: AccessDenied'));
  assert.ok(info.health.problems.some((p) => p.text === 'failure queues unreadable: throttled'));
  assert.ok(info.health.problems.some((p) => p.text === 'pauses unreadable: table'));
});
