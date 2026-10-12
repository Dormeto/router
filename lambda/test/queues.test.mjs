// The router's work queue (scale design §6): naps and the wakes of a router pause go to a queue the controller reads at
// most 10 at a time, instead of one self-invocation each.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../src/lib/controller-core.mjs';
import { STATES } from '../src/lib/state.mjs';
import { fakeAppScaling, fakeAutoScaling, fakeClock, fakeCloudWatch, fakeEc2, fakeEcs, fakeElbv2, fakeStore, fakeTagging, testConfig } from './fakes.mjs';

const MINUTE = 60_000;

function setup({ run, instance = 'running', target = 'app', metric = [0, 0, 0], timestamps = [] } = {}) {
  const clock = fakeClock();
  const cfg = testConfig();
  const store = fakeStore({ config: cfg, run, clock });
  const ec2 = fakeEc2(cfg.instanceIds, { state: instance });
  const elbv2 = fakeElbv2(cfg, { target });
  const ecs = fakeEcs();
  const invocations = [];
  const queued = [];
  const logs = [];
  const cloudwatch = fakeCloudWatch(metric, timestamps);
  const log = { info: (event, data) => logs.push([event, data]), warn: (event, data) => logs.push([event, data]), error: (event, data) => logs.push([event, data]) };
  const handler = createController({
    store, ec2, elbv2, cloudwatch, autoscaling: fakeAutoScaling(), ecs, tagging: fakeTagging(ecs), appscaling: fakeAppScaling(),
    invokeSelf: async (payload) => { invocations.push(payload); }, queueWork: async (message) => { queued.push(message); },
    now: clock.now, sleep: clock.sleep, newId: () => 'w1', log,
    router: { name: 'dmt-dev', version: '0.22.0', build: 'abc', checkSchedule: 'rate(5 minutes)' },
  });
  // The queue delivers messages to the controller (an SQS event source mapping).
  const deliver = (...messages) => handler({ Records: messages.map((m, i) => ({ messageId: `m${i}`, eventSource: 'aws:sqs', body: JSON.stringify(m) })) });
  return { handler, store, ec2, clock, cfg, invocations, queued, logs, deliver, cloudwatch };
}

const skipped = (logs) => logs.filter(([event]) => event === 'NapSkipped').map(([, data]) => data.reason);

test('the idle check queues the nap of an idle workload, never invoking itself', async () => {
  const s = setup({ run: { state: STATES.AWAKE, awakeSince: 1 } });
  const [result] = await s.handler({ action: 'check' });
  assert.deepEqual(result, { workloadId: 'demo', state: STATES.AWAKE, nap: 'queued' });
  assert.deepEqual(s.queued, [{ action: 'nap', workloadId: 'demo', requestedAt: s.clock.now() }]);
  assert.deepEqual(s.invocations, []);
});

test('a queued nap runs; the same nap delivered again, or one the workload outlived, is refused', async () => {
  const s = setup({ run: { state: STATES.AWAKE, awakeSince: 1 } });
  const requestedAt = s.clock.now();
  assert.deepEqual(await s.deliver({ action: 'nap', workloadId: 'demo', requestedAt }), { batchItemFailures: [] });
  assert.equal(s.store.state.run.state, STATES.ASLEEP);
  // Delivered twice (at least once delivery): the workload is no longer awake.
  await s.deliver({ action: 'nap', workloadId: 'demo', requestedAt });
  assert.deepEqual(skipped(s.logs), ['not awake (ASLEEP)']);

  // Woken since the check asked for it, or asked too long ago (a backlog): the next check decides again.
  const woken = setup({ run: { state: STATES.AWAKE, awakeSince: 1 } });
  woken.store.state.run.awakeSince = woken.clock.now();
  await woken.deliver({ action: 'nap', workloadId: 'demo', requestedAt: woken.clock.now() - MINUTE });
  const old = setup({ run: { state: STATES.AWAKE, awakeSince: 1 } });
  await old.deliver({ action: 'nap', workloadId: 'demo', requestedAt: old.clock.now() - 11 * MINUTE });
  assert.deepEqual([woken.store.state.run.state, old.store.state.run.state], [STATES.AWAKE, STATES.AWAKE]);
  assert.deepEqual([...skipped(woken.logs), ...skipped(old.logs)], ['woken since it was requested', 'requested more than 10 minutes ago']);
});

test('a router pause queues the wake of every asleep workload; the queue runs it, without invoking itself', async () => {
  const s = setup({ run: { state: STATES.ASLEEP }, instance: 'stopped', target: 'waker' });
  const result = await s.handler({ action: 'pause', by: 'ops@example.com', reason: 'change freeze' });
  assert.equal(result.pause.scope, 'router');
  assert.deepEqual(result.woken, ['demo']);
  assert.deepEqual(s.queued, [{ action: 'wake', workloadId: 'demo', by: 'ops@example.com', kind: 'pause' }]);
  assert.equal(s.store.state.run.state, STATES.ASLEEP, 'nothing woken before the queue runs it');
  await s.deliver(s.queued[0]);
  assert.equal(s.store.state.run.state, STATES.AWAKE);
  assert.equal(s.ec2.state.instances[s.cfg.instanceIds[0]], 'running');
  assert.deepEqual(s.invocations, []);
});

test('a nap requested by the manager is queued', async () => {
  const s = setup({ run: { state: STATES.AWAKE } });
  assert.deepEqual(await s.handler({ action: 'request-nap', workloadId: 'demo', by: 'ops' }), { requested: true });
  assert.deepEqual(s.queued, [{ action: 'nap', workloadId: 'demo', requestedAt: s.clock.now(), by: 'ops' }]);
  assert.deepEqual(s.invocations, []);
});

test('a message the controller cannot run comes back alone (partial batch response)', async () => {
  const s = setup({ run: { state: STATES.AWAKE, awakeSince: 1 } });
  const out = await s.handler({ Records: [
    { messageId: 'bad', eventSource: 'aws:sqs', body: '{"action":"explode"}' },
    { messageId: 'ok', eventSource: 'aws:sqs', body: JSON.stringify({ action: 'nap', workloadId: 'demo', requestedAt: s.clock.now() }) },
  ] });
  assert.deepEqual(out, { batchItemFailures: [{ itemIdentifier: 'bad' }] });
  assert.equal(s.store.state.run.state, STATES.ASLEEP);
});

test('a queued nap waiting more than a minute reads the requests made since it was asked for: one request keeps the workload awake', async () => {
  const requestedAt = 1_700_000_000_000 - 5 * MINUTE;
  const s = setup({ run: { state: STATES.AWAKE, awakeSince: 1 }, metric: [2], timestamps: [new Date(requestedAt + 2 * MINUTE)] });
  await s.deliver({ action: 'nap', workloadId: 'demo', requestedAt });
  assert.equal(s.store.state.run.state, STATES.AWAKE);
  assert.deepEqual(skipped(s.logs), ['requests since it was requested']);
  assert.deepEqual(s.cloudwatch.calls.map((c) => c.StartTime.getTime()), [requestedAt]);
  // Delivered at once, the check's own read stands: no second read.
  const prompt = setup({ run: { state: STATES.AWAKE, awakeSince: 1 }, metric: [2], timestamps: [new Date(1_700_000_000_000)] });
  await prompt.deliver({ action: 'nap', workloadId: 'demo', requestedAt: prompt.clock.now() - 30_000 });
  assert.equal(prompt.store.state.run.state, STATES.ASLEEP);
  assert.deepEqual(prompt.cloudwatch.calls, []);
});

test('a queued pause wake is skipped once no pause applies, or once the workload is gone; it never fails into the dead-letter queue', async () => {
  const s = setup({ run: { state: STATES.ASLEEP }, instance: 'stopped', target: 'waker' });
  await s.handler({ action: 'pause', by: 'ops@example.com', reason: 'change freeze' });
  await s.handler({ action: 'resume', by: 'ops@example.com' });
  assert.deepEqual(await s.deliver(s.queued[0]), { batchItemFailures: [] });
  assert.equal(s.store.state.run.state, STATES.ASLEEP);
  const wakeSkipped = (logs) => logs.filter(([event]) => event === 'WakeSkipped').map(([, data]) => data.reason);
  assert.deepEqual(wakeSkipped(s.logs), ['no pause applies any more']);

  const gone = setup({ run: { state: STATES.ASLEEP }, instance: 'stopped', target: 'waker' });
  await gone.handler({ action: 'pause', by: 'ops@example.com', reason: 'change freeze' });
  // Offboarded since the pause.
  gone.store.getConfig = async () => null;
  assert.deepEqual(await gone.deliver(gone.queued[0]), { batchItemFailures: [] });
  assert.deepEqual(wakeSkipped(gone.logs), ['workload not configured any more']);
});
