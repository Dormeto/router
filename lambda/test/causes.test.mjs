// Workload state changed carries its cause (scale design §3, for the state history of R8): what started a wake or a
// nap, or ended one early. The cause never reaches the store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../src/lib/controller-core.mjs';
import { createWaker } from '../src/lib/waker-core.mjs';
import { withTransitionEvents } from '../src/lib/events.mjs';
import { STATES } from '../src/lib/state.mjs';
import { albEvent, fakeAppScaling, fakeAutoScaling, fakeClock, fakeCloudWatch, fakeEc2, fakeEcs, fakeElbv2, fakeStore, fakeTagging, silentLog, testConfig } from './fakes.mjs';

function setup({ run, instance = 'running', target = 'app' }) {
  const clock = fakeClock();
  const cfg = testConfig();
  const store = fakeStore({ config: cfg, run, clock });
  const specs = [];
  const transition = store.transition.bind(store);
  store.transition = async (id, spec) => { specs.push(spec); return transition(id, spec); };
  const changes = [];
  const wrapped = withTransitionEvents(store, { stateChanged: async (c) => { changes.push(c); } }, { now: clock.now });
  const ecs = fakeEcs();
  const queued = [];
  const handler = createController({
    store: wrapped, ec2: fakeEc2(cfg.instanceIds, { state: instance }), elbv2: fakeElbv2(cfg, { target }), cloudwatch: fakeCloudWatch([0, 0, 0]), autoscaling: fakeAutoScaling(),
    ecs, tagging: fakeTagging(ecs), appscaling: fakeAppScaling(), invokeSelf: async () => {}, queueWork: async (m) => { queued.push(m); },
    now: clock.now, sleep: clock.sleep, newId: () => 'w1', log: silentLog, router: { name: 'dmt-dev' },
  });
  const deliver = (m) => handler({ Records: [{ messageId: 'm', eventSource: 'aws:sqs', body: JSON.stringify(m) }] });
  return { handler, store, wrapped, clock, cfg, changes, specs, queued, deliver };
}
const causes = (changes) => changes.map((c) => [c.to, c.cause ?? null]);

test('the event says what started a nap (the idle check or the manager) and a wake (the manager, a router pause); the store never gets it', async () => {
  const idle = setup({ run: { state: STATES.AWAKE, awakeSince: 1 } });
  await idle.handler({ action: 'check' });
  await idle.deliver(idle.queued[0]);
  assert.deepEqual(causes(idle.changes), [[STATES.NAPPING, 'idle'], [STATES.ASLEEP, null]]);
  assert.ok(idle.specs.every((spec) => !('cause' in spec)));

  const asked = setup({ run: { state: STATES.AWAKE, awakeSince: 1 } });
  await asked.handler({ action: 'request-nap', workloadId: 'demo', by: 'ops@example.com' });
  await asked.deliver(asked.queued[0]);
  assert.deepEqual(causes(asked.changes)[0], [STATES.NAPPING, 'manager']);

  const woken = setup({ run: { state: STATES.ASLEEP }, instance: 'stopped', target: 'waker' });
  await woken.handler({ action: 'force-wake', workloadId: 'demo', by: 'ops@example.com' });
  assert.deepEqual(causes(woken.changes)[0], [STATES.WAKING, 'manager']);

  const paused = setup({ run: { state: STATES.ASLEEP }, instance: 'stopped', target: 'waker' });
  await paused.handler({ action: 'pause', by: 'ops@example.com', reason: 'freeze' });
  await paused.deliver(paused.queued[0]);
  assert.deepEqual(causes(paused.changes)[0], [STATES.WAKING, 'pause']);
});

test('a nap aborted by a wake asked during its drain says so; a wake started by a request has the request\'s trigger', async () => {
  const s = setup({ run: { state: STATES.AWAKE, awakeSince: 1 } });
  // A request during the drain sets the pending wake.
  s.clock.onSleep(async () => { await s.store.setPendingWake('demo'); });
  await s.handler({ action: 'nap', workloadId: 'demo' });
  assert.deepEqual(causes(s.changes), [[STATES.NAPPING, 'idle'], [STATES.AWAKE, 'pending-wake']]);

  const clock = fakeClock();
  const cfg = testConfig({ waitSeconds: 0 });
  const changes = [];
  const store = withTransitionEvents(fakeStore({ config: cfg, run: { state: STATES.ASLEEP }, clock }), { stateChanged: async (c) => { changes.push(c); } }, { now: clock.now });
  const waker = createWaker({ store, invokeController: async () => {}, prefix: 'dmt-dev-', now: clock.now, sleep: clock.sleep, newId: () => 'w1', log: silentLog });
  await waker(albEvent({ cfg }));
  // The trigger of the request, as the wake counters name it.
  assert.deepEqual(causes(changes), [[STATES.WAKING, 'normal']]);
});

test('a state change dates the run (stateAt) with its event\'s instant; a write that changes no state does not (R8)', async () => {
  const s = setup({ run: { state: STATES.AWAKE, awakeSince: 1 } });
  await s.handler({ action: 'check' });
  await s.deliver(s.queued[0]);
  assert.equal(s.store.state.run.state, STATES.ASLEEP);
  assert.equal(s.store.state.run.stateAt, Date.parse(s.changes.at(-1).at));
  const before = s.store.state.run.stateAt;
  s.clock.advance(60_000);
  await s.wrapped.transition('demo', { cond: { state: STATES.ASLEEP }, set: { holders: 1 } });
  assert.equal(s.store.state.run.stateAt, before);
});

test('the event says who asked a nap or a wake from the manager, or the pause that woke it (R8); an idle nap and a request say no one', async () => {
  const asked = setup({ run: { state: STATES.AWAKE, awakeSince: 1 } });
  await asked.handler({ action: 'request-nap', workloadId: 'demo', by: 'ops@example.com' });
  await asked.deliver(asked.queued[0]);
  assert.equal(asked.changes[0].by, 'ops@example.com');
  const woken = setup({ run: { state: STATES.ASLEEP }, instance: 'stopped', target: 'waker' });
  await woken.handler({ action: 'force-wake', workloadId: 'demo', by: 'ops@example.com' });
  assert.equal(woken.changes[0].by, 'ops@example.com');
  const paused = setup({ run: { state: STATES.ASLEEP }, instance: 'stopped', target: 'waker' });
  await paused.handler({ action: 'pause', by: 'ops@example.com', reason: 'freeze' });
  await paused.deliver(paused.queued[0]);
  assert.equal(paused.changes[0].by, 'ops@example.com');
  const idle = setup({ run: { state: STATES.AWAKE, awakeSince: 1 } });
  await idle.handler({ action: 'check' });
  await idle.deliver(idle.queued[0]);
  assert.ok(idle.changes.every((c) => !('by' in c)));
});

test('the event of a nap\'s end says what it stopped, for the manager\'s savings (R9a)', async () => {
  const s = setup({ run: { state: STATES.AWAKE, awakeSince: 1 } });
  await s.handler({ action: 'check' });
  await s.deliver(s.queued[0]);
  const asleep = s.changes.find((c) => c.to === STATES.ASLEEP);
  assert.deepEqual(asleep.stopped, s.cfg.instanceIds.map(() => ({ kind: 'ec2', type: 't3.medium', count: 1, os: 'Linux' })));
  assert.ok(!('stopped' in s.store.state.run), 'never in the store');
});
