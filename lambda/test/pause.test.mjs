import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../src/lib/controller-core.mjs';
import { STATES } from '../src/lib/state.mjs';
import { fakeAppScaling, fakeAutoScaling, fakeClock, fakeCloudWatch, fakeEc2, fakeEcs, fakeElbv2, fakeStore, fakeTagging, routeOf, testConfig } from './fakes.mjs';

const HOUR = 3_600_000;

function setup({ run, instance = 'running', target = 'app', metric = [0, 0, 0] } = {}) {
  const clock = fakeClock();
  const cfg = testConfig();
  const store = fakeStore({ config: cfg, run, clock });
  const ec2 = fakeEc2(cfg.instanceIds, { state: instance });
  const elbv2 = fakeElbv2(cfg, { target });
  const ecs = fakeEcs();
  const invocations = [];
  const logs = [];
  const log = { info: (event, data) => logs.push([event, data]), warn: (event, data) => logs.push([event, data]), error: (event, data) => logs.push([event, data]) };
  const handler = createController({
    store, ec2, elbv2, cloudwatch: fakeCloudWatch(metric), autoscaling: fakeAutoScaling(), ecs, tagging: fakeTagging(ecs), appscaling: fakeAppScaling(),
    invokeSelf: async (payload) => { invocations.push(payload); }, now: clock.now, sleep: clock.sleep, newId: () => 'w1', log,
    router: { name: 'dmt-dev', version: '0.16.0', build: 'abc', checkSchedule: 'rate(5 minutes)' },
  });
  return { handler, store, ec2, elbv2, clock, cfg, invocations, logs };
}

const pauseEvent = (extra = {}) => ({ action: 'pause', workloadId: 'demo', by: 'ops@example.com', reason: 'incident 42', ...extra });

test('pause records who, when and why, and wakes an asleep workload', async () => {
  const s = setup({ run: { state: STATES.ASLEEP }, instance: 'stopped', target: 'waker' });
  const result = await s.handler(pauseEvent({ until: new Date(s.clock.now() + HOUR).toISOString() }));
  assert.deepEqual(result, {
    pause: { scope: 'workload', by: 'ops@example.com', at: new Date(s.clock.now()).toISOString(), reason: 'incident 42', until: new Date(s.clock.now() + HOUR).toISOString(), keepAsleep: false },
    woken: ['demo'],
  });
  assert.deepEqual(s.store.state.pauses, [{ workloadId: 'demo', by: 'ops@example.com', at: s.clock.now(), reason: 'incident 42', until: s.clock.now() + HOUR, keepAsleep: false }]);
  assert.equal(s.store.state.run.state, STATES.WAKING);
  assert.deepEqual(s.invocations, [{ action: 'wake', workloadId: 'demo', wakeId: 'w1' }]);
  assert.equal(s.store.state.stats['wake:pause'], 1);
});

test('pause wakes a failed workload, gives a napping one a pending wake, and leaves them with keepAsleep', async () => {
  const failed = setup({ run: { state: STATES.FAILED }, instance: 'stopped', target: 'waker' });
  assert.deepEqual((await failed.handler(pauseEvent())).woken, ['demo']);
  const napping = setup({ run: { state: STATES.NAPPING } });
  assert.deepEqual((await napping.handler(pauseEvent())).woken, ['demo']);
  assert.equal(napping.store.state.run.pendingWake, true);
  assert.equal(napping.store.state.stats['wake:pause'], 1);
  const kept = setup({ run: { state: STATES.ASLEEP }, instance: 'stopped', target: 'waker' });
  const result = await kept.handler(pauseEvent({ keepAsleep: true }));
  assert.deepEqual(result.woken, []);
  assert.equal(result.pause.keepAsleep, true);
  assert.equal(kept.store.state.run.state, STATES.ASLEEP);
  assert.deepEqual(kept.invocations, []);
});

test('a router pause wakes every asleep workload', async () => {
  const s = setup({ run: { state: STATES.ASLEEP }, instance: 'stopped', target: 'waker' });
  const result = await s.handler(pauseEvent({ workloadId: undefined, reason: 'change freeze' }));
  assert.equal(result.pause.scope, 'router');
  assert.deepEqual(result.woken, ['demo']);
  assert.deepEqual(s.store.state.pauses.map((p) => [p.workloadId, p.reason]), [[null, 'change freeze']]);
});

test('pause refuses an unknown workload, a missing reason, and an automatic resume in the past or beyond 366 days', async () => {
  const s = setup({ run: { state: STATES.AWAKE } });
  await assert.rejects(s.handler(pauseEvent({ workloadId: 'nope' })), /workload not configured: nope/);
  await assert.rejects(s.handler(pauseEvent({ reason: ' ' })), /reason required/);
  await assert.rejects(s.handler(pauseEvent({ reason: 'x'.repeat(257) })), /reason required/);
  await assert.rejects(s.handler(pauseEvent({ until: new Date(s.clock.now() - 1000).toISOString() })), /until must be in the future, within 366 days/);
  await assert.rejects(s.handler(pauseEvent({ until: new Date(s.clock.now() + 367 * 24 * HOUR).toISOString() })), /until must be in the future, within 366 days/);
  await assert.rejects(s.handler(pauseEvent({ until: 'tomorrow' })), /until must be in the future, within 366 days/);
  assert.deepEqual(s.store.state.pauses, []);
});

test('the idle check never requests the nap of a paused workload, or of any workload of a paused router', async () => {
  for (const workloadId of ['demo', undefined]) {
    const s = setup({ run: { state: STATES.AWAKE, awakeSince: 1 } });
    await s.handler(pauseEvent({ workloadId }));
    const [result] = await s.handler({ action: 'check' });
    assert.deepEqual(result, { workloadId: 'demo', state: STATES.AWAKE, paused: true });
    assert.deepEqual(s.invocations, []);
  }
});

test('the reconcile still runs while paused: a route reset by hand is repaired', async () => {
  const s = setup({ run: { state: STATES.AWAKE, awakeSince: 1 }, target: 'waker' });
  await s.handler(pauseEvent());
  await s.handler({ action: 'check' });
  assert.equal(routeOf(s.elbv2, s.cfg), 'app');
});

test('a nap queued before the pause is refused when it starts', async () => {
  const s = setup({ run: { state: STATES.AWAKE, awakeSince: 1 } });
  await s.handler(pauseEvent());
  assert.deepEqual(await s.handler({ action: 'nap', workloadId: 'demo' }), { state: 'SKIPPED', reason: 'paused' });
  assert.equal(s.store.state.run.state, STATES.AWAKE);
  assert.equal(routeOf(s.elbv2, s.cfg), 'app');
  assert.ok(s.logs.some(([event, data]) => event === 'NapSkipped' && data.reason === 'paused'));
});

test('a pause written during the drain aborts the nap before anything is stopped, even with keepAsleep', async () => {
  const s = setup({ run: { state: STATES.AWAKE, awakeSince: 1 } });
  s.clock.onSleep(async () => {
    if (s.store.state.run.state === STATES.NAPPING && !s.store.state.pauses.length) await s.store.putPause('demo', { by: 'ops', at: s.clock.now(), reason: 'late', keepAsleep: true });
  });
  const result = await s.handler({ action: 'nap', workloadId: 'demo' });
  assert.deepEqual(result, { state: STATES.AWAKE, aborted: true });
  assert.equal(s.ec2.state.stopped, 0);
  assert.equal(routeOf(s.elbv2, s.cfg), 'app');
});

test('an expired pause no longer counts, and the next check deletes it', async () => {
  const s = setup({ run: { state: STATES.AWAKE, awakeSince: 1 } });
  await s.handler(pauseEvent({ until: new Date(s.clock.now() + HOUR).toISOString() }));
  s.clock.advance(HOUR);
  const [result] = await s.handler({ action: 'check' });
  assert.equal(result.nap, 'requested');
  assert.deepEqual(s.store.state.pauses, []);
  assert.ok(s.logs.some(([event, data]) => event === 'PauseExpired' && data.workloadId === 'demo' && data.reason === 'incident 42'));
});

test('the check keeps a newer pause written after it read the expired one', async () => {
  const s = setup({ run: { state: STATES.AWAKE, awakeSince: 1 } });
  await s.handler(pauseEvent({ until: new Date(s.clock.now() + HOUR).toISOString() }));
  s.clock.advance(HOUR);
  const stale = await s.store.listPauses();
  s.store.listPauses = async () => stale;
  await s.store.putPause('demo', { by: 'ops', at: s.clock.now(), reason: 'again', keepAsleep: false });
  await s.handler({ action: 'check' });
  assert.deepEqual(s.store.state.pauses.map((p) => p.reason), ['again']);
});

test('pauses that cannot be read stop the naps of the check, not the check', async () => {
  const s = setup({ run: { state: STATES.AWAKE, awakeSince: 1 }, target: 'waker' });
  s.store.listPauses = async () => { throw new Error('throttled'); };
  const [result] = await s.handler({ action: 'check' });
  assert.deepEqual(result, { workloadId: 'demo', state: STATES.AWAKE, paused: true });
  assert.deepEqual(s.invocations, []);
  assert.equal(routeOf(s.elbv2, s.cfg), 'app', 'reconcile ran');
  assert.ok(s.logs.some(([event]) => event === 'PausesUnreadable'));
});

test('resume removes the operator pause only: the router pause and an exclusion pause stay', async () => {
  const s = setup({ run: { state: STATES.AWAKE } });
  await s.handler(pauseEvent());
  await s.handler(pauseEvent({ workloadId: undefined, reason: 'freeze' }));
  await s.handler(pauseEvent({ reason: 'excluded: migration', exclusionId: 'x1' }));
  assert.deepEqual(await s.handler({ action: 'resume', workloadId: 'demo', by: 'ops' }), { resumed: true });
  assert.deepEqual(s.store.state.pauses.map((p) => [p.workloadId, p.exclusionId ?? null]), [[null, null], ['demo', 'x1']]);
  assert.deepEqual(await s.handler({ action: 'resume', by: 'ops' }), { resumed: true });
  assert.deepEqual(await s.handler({ action: 'resume', workloadId: 'demo', by: 'ops' }), { resumed: false });
  assert.deepEqual(await s.handler({ action: 'resume', workloadId: 'demo', by: 'ops', exclusionId: 'x1' }), { resumed: true });
  assert.deepEqual(s.store.state.pauses, []);
});

test('request-nap: refused with the reason while paused or not awake, else the nap runs in its own invocation', async () => {
  const s = setup({ run: { state: STATES.AWAKE } });
  assert.deepEqual(await s.handler({ action: 'request-nap', workloadId: 'demo', by: 'ops' }), { requested: true });
  assert.deepEqual(s.invocations, [{ action: 'nap', workloadId: 'demo' }]);
  await s.handler(pauseEvent());
  assert.deepEqual(await s.handler({ action: 'request-nap', workloadId: 'demo', by: 'ops' }), { requested: false, reason: 'paused by ops@example.com: incident 42' });
  const asleep = setup({ run: { state: STATES.ASLEEP }, instance: 'stopped', target: 'waker' });
  assert.deepEqual(await asleep.handler({ action: 'request-nap', workloadId: 'demo', by: 'ops' }), { requested: false, reason: 'not awake (ASLEEP)' });
  await assert.rejects(s.handler({ action: 'request-nap', workloadId: 'nope', by: 'ops' }), /workload not configured: nope/);
});

test('list gives the router pauses and each workload its own and its router\'s, exclusions first', async () => {
  const s = setup({ run: { state: STATES.AWAKE } });
  await s.handler(pauseEvent({ workloadId: undefined, reason: 'freeze', keepAsleep: true }));
  s.clock.advance(1000);
  await s.handler(pauseEvent());
  await s.handler(pauseEvent({ reason: 'excluded: migration', exclusionId: 'x1' }));
  const { router, workloads: [workload] } = await s.handler({ action: 'list' });
  assert.deepEqual(router.pauses.map((p) => [p.scope, p.reason]), [['router', 'freeze']]);
  assert.deepEqual(workload.pauses.map((p) => [p.scope, p.reason, p.exclusionId ?? null]), [
    ['workload', 'excluded: migration', 'x1'], ['workload', 'incident 42', null], ['router', 'freeze', null],
  ]);
});

test('list and status leave expired pauses out; status gives the pauses and no nap estimate while paused', async () => {
  const s = setup({ run: { state: STATES.AWAKE, awakeSince: 1 } });
  await s.handler(pauseEvent({ until: new Date(s.clock.now() + HOUR).toISOString() }));
  const paused = await s.handler({ action: 'status', workloadId: 'demo' });
  assert.deepEqual(paused.pauses.map((p) => p.reason), ['incident 42']);
  assert.equal(paused.nap, null);
  s.clock.advance(HOUR);
  assert.deepEqual((await s.handler({ action: 'list' })).workloads[0].pauses, []);
  const resumed = await s.handler({ action: 'status', workloadId: 'demo' });
  assert.deepEqual(resumed.pauses, []);
  assert.notEqual(resumed.nap, null);
});

test('a pause naming a target group is refused by a router whose workload of that id has another one', async () => {
  const s = setup({ run: { state: STATES.AWAKE } });
  await assert.rejects(s.handler(pauseEvent({ targetGroupArn: 'arn:aws:elasticloadbalancing:eu-west-1:111122223333:targetgroup/other/999' })),
    /workload not configured: demo \(its target group is not arn:aws:elasticloadbalancing:eu-west-1:111122223333:targetgroup\/other\/999\)/);
  assert.deepEqual(s.store.state.pauses, []);
  assert.equal((await s.handler(pauseEvent({ targetGroupArn: s.cfg.appTargetGroupArn }))).pause.reason, 'incident 42');
});
