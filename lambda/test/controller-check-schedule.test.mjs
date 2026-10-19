// The check applies the schedules (R12 design, section 4): each window occurrence once, no idle nap in an awake window
// or just before one, the maximum nap's maintenance wake, and the pauses that win over them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../src/lib/controller-core.mjs';
import { withTransitionEvents } from '../src/lib/events.mjs';
import { STATES } from '../src/lib/state.mjs';
import { crowdedAccount } from './crowded-fake.mjs';
import { simClock } from './sim-clock.mjs';
import { fakeAppScaling, fakeAutoScaling, fakeClock, fakeCloudWatch, fakeEc2, fakeEcs, fakeElbv2, fakeStore, fakeTagging, silentLog, testConfig } from './fakes.mjs';

const MINUTE = 60_000;
// Paris wall times in October 2026 (CEST, UTC+2 until the 25th): '19T08:00' is Monday the 19th at 08:00.
const at = (local) => Date.parse(`2026-10-${local}:00+02:00`);
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];
const OFFICE = { kind: 'awake', days: WEEKDAYS, start: '08:00', end: '18:00' };
const NIGHT = { kind: 'nap', days: WEEKDAYS, start: '20:00', end: '07:00' };
// A schedule as the store keeps it.
const stored = (fields) => ({ timeZone: 'Europe/Paris', ...fields, by: 'ops@example.com', at: at('12T09:00') });
const occurrence = (window, local) => `${window}@${new Date(at(local)).toISOString()}`;

function setup({ run, schedule, queue = true }) {
  const clock = fakeClock(at('19T07:00'));
  const cfg = testConfig();
  const store = fakeStore({ config: cfg, run, clock });
  store.state.schedules.demo = schedule;
  const asleep = [STATES.ASLEEP, STATES.FAILED].includes(run.state);
  const ec2 = fakeEc2(cfg.instanceIds, { state: asleep ? 'stopped' : 'running' });
  const elbv2 = fakeElbv2(cfg, { target: asleep ? 'waker' : 'app', healthy: asleep ? 0 : 1 });
  ec2.state.onStop.push(() => { elbv2.state.healthy = 0; });
  const cloudwatch = fakeCloudWatch([0, 0, 0]);
  const changes = [];
  const wrapped = withTransitionEvents(store, { stateChanged: async (c) => { changes.push(c); } }, { now: clock.now });
  const ecs = fakeEcs();
  const queued = [];
  const invocations = [];
  let ids = 0;
  const handler = createController({
    store: wrapped, ec2, elbv2, cloudwatch, autoscaling: fakeAutoScaling(), ecs, tagging: fakeTagging(ecs), appscaling: fakeAppScaling(),
    invokeSelf: async (payload) => { invocations.push(payload); }, ...(queue ? { queueWork: async (m) => { queued.push(m); } } : {}),
    now: clock.now, sleep: clock.sleep, newId: () => `w${++ids}`, log: silentLog, router: { name: 'dmt-dev' },
  });
  // The check the schedule starts at that Paris time (later than the clock).
  async function checkAt(local) {
    assert.ok(at(local) >= clock.now(), `${local} is in the past`);
    clock.advance(at(local) - clock.now());
    return handler({ action: 'check' });
  }
  const deliver = (m) => handler({ Records: [{ messageId: 'm', eventSource: 'aws:sqs', body: JSON.stringify(m) }] });
  const wakes = () => invocations.filter((i) => i.action === 'wake').length;
  const causes = () => changes.map((c) => [c.to, c.cause ?? null]);
  // Asleep again (a wake that failed and was released, say): only the state matters to the schedule.
  const putAsleep = () => { store.state.run.state = STATES.ASLEEP; };
  return { handler, store, wrapped, clock, cloudwatch, changes, queued, invocations, checkAt, deliver, wakes, causes, putAsleep };
}

test('an awake window wakes an asleep workload at its start, once per occurrence: not again later in it, again at the next one', async () => {
  const s = setup({ run: { state: STATES.ASLEEP }, schedule: stored({ windows: [OFFICE] }) });
  await s.checkAt('19T07:55');
  assert.equal(s.wakes(), 0);
  const [result] = await s.checkAt('19T08:00');
  assert.equal(s.wakes(), 1);
  assert.deepEqual(result, { workloadId: 'demo', state: STATES.WAKING, schedule: 'wake' });
  assert.equal(s.store.state.run.scheduleApplied, occurrence(0, '19T08:00'));
  assert.deepEqual(s.causes(), [[STATES.WAKING, 'schedule']]);
  assert.equal(s.store.state.stats['wake:schedule'], 1);
  s.putAsleep();
  await s.checkAt('19T08:05');
  await s.checkAt('19T08:10');
  assert.equal(s.wakes(), 1);
  await s.checkAt('20T08:00');
  assert.equal(s.wakes(), 2);
  assert.equal(s.store.state.run.scheduleApplied, occurrence(0, '20T08:00'));
  assert.equal(s.store.state.stats['wake:schedule'], 2);
});

test('a check that first runs inside the window (after a deploy, or once the lease lets it run) applies it once', async () => {
  const s = setup({ run: { state: STATES.ASLEEP }, schedule: stored({ windows: [OFFICE] }) });
  let leased = true;
  s.wrapped.acquireCheckLease = async () => !leased;
  assert.deepEqual(await s.checkAt('19T08:00'), { skipped: 'the previous check is still running' });
  assert.equal(s.wakes(), 0);
  leased = false;
  await s.checkAt('19T11:35');
  assert.equal(s.wakes(), 1);
  assert.equal(s.store.state.run.scheduleApplied, occurrence(0, '19T08:00'));
  s.putAsleep();
  await s.checkAt('19T11:40');
  assert.equal(s.wakes(), 1);
});

test('at an awake window\'s start a napping workload gets its pending wake and a failed one is woken', async () => {
  const napping = setup({ run: { state: STATES.NAPPING, updatedAt: at('19T07:58') }, schedule: stored({ windows: [OFFICE] }) });
  const [result] = await napping.checkAt('19T08:00');
  assert.equal(result.schedule, 'pending wake');
  assert.equal(napping.store.state.run.pendingWake, true);
  assert.equal(napping.store.state.run.scheduleApplied, occurrence(0, '19T08:00'));
  assert.equal(napping.store.state.stats['wake:schedule'], 1);
  const failed = setup({ run: { state: STATES.FAILED, failedAt: at('19T06:00') }, schedule: stored({ windows: [OFFICE] }) });
  await failed.checkAt('19T08:00');
  assert.equal(failed.wakes(), 1);
  assert.deepEqual(failed.causes(), [[STATES.WAKING, 'schedule']]);
});

test('no idle nap while an awake window is active (the request metric is not even read), an idle nap once it ended', async () => {
  const s = setup({ run: { state: STATES.AWAKE, awakeSince: 1 }, schedule: stored({ windows: [OFFICE] }) });
  const [inside] = await s.checkAt('19T12:00');
  assert.deepEqual(inside, { workloadId: 'demo', state: STATES.AWAKE, kept: 'awake window' });
  await s.checkAt('19T17:55');
  assert.deepEqual(s.queued, []);
  assert.equal(s.cloudwatch.calls.length, 0);
  await s.checkAt('19T18:00');
  assert.deepEqual(s.queued, [{ action: 'nap', workloadId: 'demo', requestedAt: at('19T18:00') }]);
});

test('an idle nap is skipped when an awake window starts within 30 minutes', async () => {
  const close = setup({ run: { state: STATES.AWAKE, awakeSince: 1 }, schedule: stored({ windows: [OFFICE] }) });
  const [result] = await close.checkAt('19T07:35');
  assert.deepEqual(result, { workloadId: 'demo', state: STATES.AWAKE, kept: 'awake window within 30 minutes' });
  assert.deepEqual(close.queued, []);
  assert.equal(close.cloudwatch.calls.length, 0);
  const early = setup({ run: { state: STATES.AWAKE, awakeSince: 1 }, schedule: stored({ windows: [OFFICE] }) });
  await early.checkAt('19T07:25');
  assert.deepEqual(early.queued, [{ action: 'nap', workloadId: 'demo', requestedAt: at('19T07:25') }]);
});

test('a nap window naps an awake workload at its start, cause schedule, once, even with requests since', async () => {
  const s = setup({ run: { state: STATES.AWAKE, awakeSince: 1 }, schedule: stored({ windows: [OFFICE, NIGHT] }) });
  const [result] = await s.checkAt('19T20:00');
  // Idle as well: the check does not ask for a second nap.
  assert.deepEqual(s.queued, [{ action: 'nap', workloadId: 'demo', requestedAt: at('19T20:00'), cause: 'schedule' }]);
  assert.deepEqual(result, { workloadId: 'demo', state: STATES.AWAKE, schedule: 'nap' });
  assert.equal(s.store.state.run.scheduleApplied, occurrence(1, '19T20:00'));
  // Delivered 2 minutes later, after requests: napped all the same (the window does not wait for idleness).
  s.cloudwatch.getMetricData = async () => ({ MetricDataResults: [{ Id: 'requests', Values: [4], Timestamps: [new Date(s.clock.now() - MINUTE)] }] });
  s.clock.advance(2 * MINUTE);
  await s.deliver(s.queued[0]);
  assert.equal(s.store.state.run.state, STATES.ASLEEP);
  assert.deepEqual(s.causes(), [[STATES.NAPPING, 'schedule'], [STATES.ASLEEP, null]]);
  await s.checkAt('19T20:05');
  assert.equal(s.queued.length, 1);
});

test('a pause wins over a nap window at once: a paused workload stays awake, and the window naps it once the pause ends', async () => {
  const s = setup({ run: { state: STATES.AWAKE, awakeSince: 1 }, schedule: stored({ windows: [OFFICE, NIGHT] }) });
  await s.handler({ action: 'pause', workloadId: 'demo', by: 'ci@example.com', reason: 'nightly tests' });
  const [result] = await s.checkAt('19T20:00');
  assert.deepEqual(result, { workloadId: 'demo', state: STATES.AWAKE, paused: true, schedule: 'held by a pause' });
  assert.deepEqual(s.queued, []);
  assert.equal(s.store.state.run.scheduleApplied, undefined);
  await s.handler({ action: 'resume', workloadId: 'demo', by: 'ci@example.com' });
  await s.checkAt('19T21:00');
  assert.deepEqual(s.queued, [{ action: 'nap', workloadId: 'demo', requestedAt: at('19T21:00'), cause: 'schedule' }]);
});

test('without the work queue, the scheduled nap runs in its own invocation, with its cause', async () => {
  const s = setup({ run: { state: STATES.AWAKE, awakeSince: 1 }, schedule: stored({ windows: [OFFICE, NIGHT] }), queue: false });
  await s.checkAt('19T20:00');
  assert.deepEqual(s.invocations, [{ action: 'nap', workloadId: 'demo', cause: 'schedule' }]);
  await s.handler(s.invocations[0]);
  assert.deepEqual(s.causes(), [[STATES.NAPPING, 'schedule'], [STATES.ASLEEP, null]]);
});

test('a nap window that starts 20 minutes before an awake window is skipped, and so is the idle nap', async () => {
  const early = { kind: 'nap', days: ['mon'], start: '07:40', end: '08:00' };
  const s = setup({ run: { state: STATES.AWAKE, awakeSince: 1 }, schedule: stored({ windows: [early, OFFICE] }) });
  await s.checkAt('19T07:40');
  await s.checkAt('19T07:45');
  assert.deepEqual(s.queued, []);
  assert.equal(s.store.state.run.scheduleApplied, occurrence(0, '19T07:40'));
});

test('maxNapDays wakes a workload asleep longer, cause maintenance, at the first check after it', async () => {
  const s = setup({ run: { state: STATES.ASLEEP, stateAt: at('12T10:02') }, schedule: stored({ maxNapDays: 7 }) });
  await s.checkAt('19T10:00');
  assert.equal(s.wakes(), 0);
  const [result] = await s.checkAt('19T10:05');
  assert.equal(s.wakes(), 1);
  assert.deepEqual(result, { workloadId: 'demo', state: STATES.WAKING, schedule: 'maintenance' });
  assert.deepEqual(s.causes(), [[STATES.WAKING, 'maintenance']]);
  assert.deepEqual(s.store.state.stats, { 'wake:maintenance': 1 });
});

test('a keepAsleep pause holds the awake window\'s wake and the maintenance wake; resumed, the window wakes it', async () => {
  const s = setup({ run: { state: STATES.ASLEEP, stateAt: at('12T10:02') }, schedule: stored({ windows: [OFFICE], maxNapDays: 7 }) });
  await s.handler({ action: 'pause', workloadId: 'demo', by: 'ops@example.com', reason: 'budget freeze', keepAsleep: true });
  const [result] = await s.checkAt('19T08:00');
  assert.equal(result.schedule, 'held by a keepAsleep pause');
  await s.checkAt('19T10:05');
  assert.equal(s.wakes(), 0);
  assert.equal(s.store.state.run.scheduleApplied, undefined);
  await s.handler({ action: 'resume', workloadId: 'demo', by: 'ops@example.com' });
  await s.checkAt('19T10:10');
  assert.equal(s.wakes(), 1);
  assert.deepEqual(s.causes(), [[STATES.WAKING, 'schedule']]);

  const maintenance = setup({ run: { state: STATES.ASLEEP, stateAt: at('12T10:02') }, schedule: stored({ maxNapDays: 7 }) });
  await maintenance.handler({ action: 'pause', by: 'ops@example.com', reason: 'router freeze', keepAsleep: true });
  await maintenance.checkAt('19T10:05');
  assert.equal(maintenance.wakes(), 0);
});

test('a manager\'s nap inside an awake window stays napped until the next occurrence', async () => {
  const s = setup({ run: { state: STATES.AWAKE, awakeSince: 1 }, schedule: stored({ windows: [OFFICE] }) });
  await s.checkAt('19T08:00');
  assert.equal(s.store.state.run.scheduleApplied, occurrence(0, '19T08:00'));
  s.clock.advance(at('19T10:00') - s.clock.now());
  assert.deepEqual(await s.handler({ action: 'request-nap', workloadId: 'demo', by: 'ops@example.com' }), { requested: true });
  await s.deliver(s.queued.at(-1));
  assert.equal(s.store.state.run.state, STATES.ASLEEP);
  await s.checkAt('19T10:05');
  await s.checkAt('19T17:55');
  assert.equal(s.wakes(), 0);
  await s.checkAt('20T08:00');
  assert.equal(s.wakes(), 1);
  assert.deepEqual(s.causes().at(-1), [STATES.WAKING, 'schedule']);
});

test('pauses that cannot be read hold the scheduled wakes until a check reads them', async () => {
  const s = setup({ run: { state: STATES.ASLEEP }, schedule: stored({ windows: [OFFICE] }) });
  const { listPauses } = s.wrapped;
  s.wrapped.listPauses = async () => { throw new Error('throttled'); };
  await s.checkAt('19T08:00');
  assert.equal(s.wakes(), 0);
  s.wrapped.listPauses = listPauses;
  await s.checkAt('19T08:05');
  assert.equal(s.wakes(), 1);
});

// With 400 ms a call, the time the loop takes for its first chunk of 25 workloads (measured: 30 workloads need 12 s).
const ONE_CHUNK_MS = 10_000;

test('a crowded router wakes a scheduled workload that its check reaches in a later chunk at the first check: the schedules come before the loop', async () => {
  const clock = simClock(at('19T08:00'));
  const account = crowdedAccount({ workloads: 30, balancers: 6, latencyMs: 400, clock });
  const { store, ...aws } = account.clients;
  const last = account.ids.at(-1);
  store.listWorkloads = async () => ({ configs: structuredClone(account.configs), schedules: new Map([[last, stored({ windows: [OFFICE] })]]) });
  account.runs.get(last).state = STATES.ASLEEP;
  const invoked = [];
  const handler = createController({ store, ...aws, invokeSelf: async (e) => { invoked.push(e); }, now: clock.now, sleep: clock.sleep, log: silentLog });
  // An invocation with time for one chunk of 25 workloads (30 s are kept for the end).
  const results = await clock.until(handler({ action: 'check' }, { getRemainingTimeInMillis: () => 30_000 + ONE_CHUNK_MS }));
  assert.ok(results.length > 0 && results.length <= 25, `${results.length} workloads checked`);
  assert.ok(!results.some((r) => r.workloadId === last), 'the loop reached it');
  assert.deepEqual(invoked.filter((e) => e.action === 'wake').map((e) => e.workloadId), [last]);
  assert.equal(account.runs.get(last).state, STATES.WAKING);
  assert.equal(account.runs.get(last).scheduleApplied, occurrence(0, '19T08:00'));
});

test('a schedule the router cannot read (a time zone Intl refuses) is logged and skipped: that workload behaves as if it had none, the others get theirs', async () => {
  const clock = simClock(at('19T08:00'));
  const account = crowdedAccount({ workloads: 2, balancers: 1, latencyMs: 10, clock });
  const { store, ...aws } = account.clients;
  const [bad, good] = account.ids;
  store.listWorkloads = async () => ({
    configs: structuredClone(account.configs),
    schedules: new Map([[bad, stored({ timeZone: 'Mars/Olympus', windows: [OFFICE] })], [good, stored({ windows: [OFFICE] })]]),
  });
  account.runs.get(good).state = STATES.ASLEEP;
  const invoked = [];
  const logged = [];
  const log = { info() {}, warn: (event, data) => logged.push([event, data]), error: (event, data) => logged.push([event, data]) };
  const handler = createController({ store, ...aws, invokeSelf: async (e) => { invoked.push(e); }, now: clock.now, sleep: clock.sleep, log });
  const results = await clock.until(handler({ action: 'check' }));
  // Idle for hours, inside what would be its awake window: napped as without a schedule.
  assert.deepEqual(results.find((r) => r.workloadId === bad), { workloadId: bad, state: STATES.AWAKE, nap: 'requested' });
  assert.deepEqual(invoked.map((e) => [e.action, e.workloadId]).sort(), [['nap', bad], ['wake', good]]);
  assert.equal(account.runs.get(good).state, STATES.WAKING);
  const skipped = logged.filter(([event]) => event === 'ScheduleSkipped');
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0][1].workloadId, bad);
  assert.match(skipped[0][1].error, /Mars\/Olympus/);
  assert.deepEqual(logged.filter(([event]) => event !== 'ScheduleSkipped'), []);
});
