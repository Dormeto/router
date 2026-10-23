// The check applies the schedules (R12 design, section 4): each window occurrence once, no idle nap in an awake window
// or just before one, the maximum nap's maintenance wake, and the pauses that win over them. Then the hibernation's
// 60-day limit (hibernation design §4), for every workload.
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
  if (schedule) store.state.schedules.demo = schedule;
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
  const logs = [];
  const log = { info: (event, data) => logs.push([event, data]), warn: (event, data) => logs.push([event, data]), error: (event, data) => logs.push([event, data]) };
  let ids = 0;
  const handler = createController({
    store: wrapped, ec2, elbv2, cloudwatch, autoscaling: fakeAutoScaling(), ecs, tagging: fakeTagging(ecs), appscaling: fakeAppScaling(),
    invokeSelf: async (payload) => { invocations.push(payload); }, ...(queue ? { queueWork: async (m) => { queued.push(m); } } : {}),
    now: clock.now, sleep: clock.sleep, newId: () => `w${++ids}`, log, router: { name: 'dmt-dev' },
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
  const logged = (name) => logs.filter(([event]) => event === name).map(([, data]) => data);
  // Asleep again (a wake that failed and was released, say): only the state matters to the schedule.
  const putAsleep = () => { store.state.run.state = STATES.ASLEEP; };
  return { handler, store, wrapped, clock, cloudwatch, changes, queued, invocations, checkAt, deliver, wakes, causes, putAsleep, logged };
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

test('at an awake window\'s start a napping workload gets its pending wake, recorded once the nap settled, and a failed one is woken', async () => {
  const napping = setup({ run: { state: STATES.NAPPING, updatedAt: at('19T07:58') }, schedule: stored({ windows: [OFFICE] }) });
  const [result] = await napping.checkAt('19T08:00');
  assert.equal(result.schedule, 'pending wake');
  assert.equal(napping.store.state.run.pendingWake, true);
  assert.equal(napping.store.state.stats['wake:schedule'], 1);
  // Not written while it naps: the stuck nap's detection reads updatedAt.
  assert.equal(napping.store.state.run.scheduleApplied, undefined);
  assert.equal(napping.store.state.run.updatedAt, at('19T07:58'));
  // Still napping at the next check: its pending wake is already set, nothing more to say or count.
  const [again] = await napping.checkAt('19T08:01');
  assert.equal(again.schedule, undefined);
  assert.equal(napping.store.state.stats['wake:schedule'], 1);
  // The pending wake ended the nap awake: the next check records the occurrence, with nothing to do.
  Object.assign(napping.store.state.run, { state: STATES.AWAKE, awakeSince: at('19T08:02'), pendingWake: false });
  await napping.checkAt('19T08:05');
  assert.equal(napping.store.state.run.scheduleApplied, occurrence(0, '19T08:00'));
  assert.deepEqual(napping.logged('ScheduleApplied').map((d) => d.action), ['none']);
  assert.equal(napping.wakes(), 0);
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
  assert.deepEqual(s.queued, [{ action: 'nap', workloadId: 'demo', requestedAt: at('19T20:00'), cause: 'schedule', until: at('20T07:00') }]);
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
  assert.deepEqual(s.queued, [{ action: 'nap', workloadId: 'demo', requestedAt: at('19T21:00'), cause: 'schedule', until: at('20T07:00') }]);
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
  // Waking, it is not woken again at the next check.
  await s.checkAt('19T10:10');
  assert.equal(s.wakes(), 1);
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

test('a crowded router wakes a scheduled workload that its check reaches in a later chunk at the first check: the schedules come before the loop', async () => {
  const clock = simClock(at('19T08:00'));
  const account = crowdedAccount({ workloads: 30, balancers: 6, latencyMs: 400, clock });
  const { store, ...aws } = account.clients;
  const last = account.ids.at(-1);
  store.listWorkloads = async () => ({ configs: structuredClone(account.configs), schedules: new Map([[last, stored({ windows: [OFFICE] })]]) });
  account.runs.get(last).state = STATES.ASLEEP;
  const invoked = [];
  const handler = createController({ store, ...aws, invokeSelf: async (e) => { invoked.push(e); }, now: clock.now, sleep: clock.sleep, log: silentLog });
  // An invocation with no time left for the loop (30 s are kept for the end): it reaches no workload.
  const results = await clock.until(handler({ action: 'check' }, { getRemainingTimeInMillis: () => 30_000 }));
  // The check's results still say what the schedule did.
  assert.deepEqual(results, [{ workloadId: last, schedule: 'wake' }]);
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

test('a scheduled nap waits in the work queue as long as its window lasts: 11 minutes late it naps, after the window it is dropped', async () => {
  const late = setup({ run: { state: STATES.AWAKE, awakeSince: 1 }, schedule: stored({ windows: [OFFICE, NIGHT] }) });
  await late.checkAt('19T20:00');
  late.clock.advance(11 * MINUTE);
  await late.deliver(late.queued[0]);
  assert.equal(late.store.state.run.state, STATES.ASLEEP);
  assert.deepEqual(late.causes()[0], [STATES.NAPPING, 'schedule']);

  const ended = setup({ run: { state: STATES.AWAKE, awakeSince: 1 }, schedule: stored({ windows: [OFFICE, NIGHT] }) });
  await ended.checkAt('19T20:00');
  ended.clock.advance(at('20T07:00') - ended.clock.now());
  await ended.deliver(ended.queued[0]);
  assert.equal(ended.store.state.run.state, STATES.AWAKE);
  assert.deepEqual(ended.logged('NapSkipped'), [{ workloadId: 'demo', reason: 'the nap window ended' }]);
});

test('a nap window that finds the workload waking leaves its occurrence for the next check, which naps it once awake', async () => {
  const s = setup({ run: { state: STATES.WAKING, wakeId: 'traffic', wakeStartedAt: at('19T19:59') }, schedule: stored({ windows: [OFFICE, NIGHT] }) });
  await s.checkAt('19T20:00');
  assert.deepEqual(s.queued, []);
  assert.equal(s.store.state.run.scheduleApplied, undefined);
  Object.assign(s.store.state.run, { state: STATES.AWAKE, awakeSince: at('19T20:01') });
  await s.checkAt('19T20:05');
  assert.deepEqual(s.queued, [{ action: 'nap', workloadId: 'demo', requestedAt: at('19T20:05'), cause: 'schedule', until: at('20T07:00') }]);
  assert.equal(s.store.state.run.scheduleApplied, occurrence(1, '19T20:00'));
});

test('a wake by a request between the schedule\'s read and its wake is not taken for the schedule\'s: the next check records the occurrence', async () => {
  const s = setup({ run: { state: STATES.ASLEEP }, schedule: stored({ windows: [OFFICE] }) });
  const { getRun } = s.wrapped;
  let reads = 0;
  // The waker starts a wake right after the schedule pass read the run (its first read of the check).
  s.wrapped.getRun = async (id) => {
    const run = await getRun(id);
    if ((reads += 1) === 1) Object.assign(s.store.state.run, { state: STATES.WAKING, wakeId: 'traffic', wakeStartedAt: s.clock.now() });
    return run;
  };
  const [result] = await s.checkAt('19T08:00');
  assert.deepEqual(result, { workloadId: 'demo', state: STATES.WAKING });
  assert.equal(s.store.state.run.scheduleApplied, undefined);
  assert.equal(s.store.state.run.wakeId, 'traffic');
  assert.deepEqual([s.wakes(), s.store.state.stats, s.logged('ScheduleApplied')], [0, {}, []]);
  s.wrapped.getRun = getRun;
  await s.checkAt('19T08:05');
  assert.equal(s.store.state.run.scheduleApplied, occurrence(0, '19T08:00'));
  assert.deepEqual(s.logged('ScheduleApplied').map((d) => d.action), ['none']);
});

test('an occurrence is recorded and logged only once written: a run that changed since the read (a manager\'s nap) is left for the next check', async () => {
  const s = setup({ run: { state: STATES.AWAKE, awakeSince: 1 }, schedule: stored({ windows: [OFFICE] }) });
  const { getRun } = s.wrapped;
  let reads = 0;
  s.wrapped.getRun = async (id) => {
    const run = await getRun(id);
    if ((reads += 1) === 1) Object.assign(s.store.state.run, { state: STATES.NAPPING });
    return run;
  };
  await s.checkAt('19T08:00');
  assert.equal(s.store.state.run.scheduleApplied, undefined);
  assert.deepEqual(s.logged('ScheduleApplied'), []);
});

test('a nap window first applied within 30 minutes of an awake start is skipped too', async () => {
  const morning = { kind: 'awake', days: WEEKDAYS, start: '07:30', end: '18:00' };
  const night = { kind: 'nap', days: WEEKDAYS, start: '20:00', end: '07:30' };
  const s = setup({ run: { state: STATES.AWAKE, awakeSince: 1 }, schedule: stored({ windows: [morning, night] }) });
  // The first check inside Monday's night, on Tuesday at 07:10 (a deploy, or the schedule set then).
  await s.checkAt('20T07:10');
  assert.deepEqual(s.queued, []);
  assert.equal(s.store.state.run.scheduleApplied, occurrence(1, '19T20:00'));
});

// --- The hibernation's 60-day limit (hibernation design §4) ---------------------------------------------------------

const DAY = 86_400_000;
// The run's record of what a nap hibernated, and when.
const hibernated = (since) => JSON.stringify({ ids: ['i-0123456789abcdef0'], at: since });

test('a workload hibernated 59 days ago, without a schedule, is woken at the first check after, cause maintenance, its run asking for a fresh boot (hibernation)', async () => {
  const since = at('19T10:02') - 59 * DAY;
  const s = setup({ run: { state: STATES.ASLEEP, stateAt: since, hibernated: hibernated(since) } });
  await s.checkAt('19T10:00');
  assert.equal(s.wakes(), 0);
  const [result] = await s.checkAt('19T10:05');
  assert.equal(s.wakes(), 1);
  assert.deepEqual(result, { workloadId: 'demo', state: STATES.WAKING, hibernation: 'maintenance' });
  assert.deepEqual(s.causes(), [[STATES.WAKING, 'maintenance']]);
  assert.equal(s.store.state.run.freshBoot, true);
  assert.deepEqual(s.store.state.stats, { 'wake:maintenance': 1 });
  // Waking, it is not woken again at the next check.
  await s.checkAt('19T10:10');
  assert.equal(s.wakes(), 1);
});

test('a failed workload hibernated 59 days ago is woken too, before the loop would release it; hibernated 58 days ago, nothing (hibernation)', async () => {
  const failed = setup({ run: { state: STATES.FAILED, failedAt: at('19T09:00'), hibernated: hibernated(at('19T10:05') - 59 * DAY) } });
  const [result] = await failed.checkAt('19T10:05');
  assert.deepEqual(result, { workloadId: 'demo', state: STATES.WAKING, hibernation: 'maintenance' });
  assert.deepEqual(failed.causes(), [[STATES.WAKING, 'maintenance']]);
  assert.equal(failed.store.state.run.freshBoot, true);
  assert.deepEqual(failed.queued, []);

  const recent = setup({ run: { state: STATES.ASLEEP, hibernated: hibernated(at('19T10:05') - 58 * DAY) } });
  const [none] = await recent.checkAt('19T10:05');
  assert.deepEqual(none, { workloadId: 'demo', state: STATES.ASLEEP });
  assert.deepEqual([recent.wakes(), recent.changes, 'freshBoot' in recent.store.state.run], [0, [], false]);
});

test('a 60-day wake that fails is not tried again by the check: the failed workload is released as any other, and its next stop is plain (hibernation)', async () => {
  const s = setup({ run: { state: STATES.ASLEEP, hibernated: hibernated(at('19T10:00') - 59 * DAY) } });
  await s.checkAt('19T10:05');
  assert.equal(s.wakes(), 1);
  // The instance starts but never gets healthy: the wake fails at its timeout, its run keeping both records.
  assert.equal((await s.handler(s.invocations.at(-1))).state, STATES.FAILED);
  assert.deepEqual([s.store.state.run.freshBoot, typeof s.store.state.run.hibernated], [true, 'string']);
  await s.checkAt('19T10:20');
  assert.equal(s.wakes(), 1);
  // Once its idle window passed since the failure, released as any failed workload.
  await s.checkAt('19T10:35');
  assert.deepEqual(s.queued, [{ action: 'release', workloadId: 'demo', requestedAt: at('19T10:35') }]);
  assert.equal(s.wakes(), 1);
  assert.equal((await s.handler({ action: 'status', workloadId: 'demo' })).maintenanceDue, null, 'no 60-day wake to come');
});

test('a keepAsleep pause holds the 60-day wake, the workload\'s or the router\'s; resumed, the next check wakes it (hibernation)', async () => {
  const since = at('19T10:00') - 59 * DAY;
  const s = setup({ run: { state: STATES.ASLEEP, hibernated: hibernated(since) } });
  await s.handler({ action: 'pause', workloadId: 'demo', by: 'ops@example.com', reason: 'budget freeze', keepAsleep: true });
  const [held] = await s.checkAt('19T10:05');
  assert.deepEqual(held, { workloadId: 'demo', state: STATES.ASLEEP, hibernation: 'held by a keepAsleep pause' });
  assert.deepEqual([s.wakes(), 'freshBoot' in s.store.state.run], [0, false]);
  await s.handler({ action: 'resume', workloadId: 'demo', by: 'ops@example.com' });
  await s.checkAt('19T10:10');
  assert.equal(s.wakes(), 1);
  assert.deepEqual(s.causes(), [[STATES.WAKING, 'maintenance']]);
  assert.equal(s.store.state.run.freshBoot, true);

  const router = setup({ run: { state: STATES.ASLEEP, hibernated: hibernated(since) } });
  await router.handler({ action: 'pause', by: 'ops@example.com', reason: 'router freeze', keepAsleep: true });
  await router.checkAt('19T10:05');
  assert.equal(router.wakes(), 0);
});

test('a scheduled workload gets the 60-day wake too, when its schedule has nothing to do (hibernation)', async () => {
  const s = setup({ run: { state: STATES.ASLEEP, hibernated: hibernated(at('19T10:00') - 59 * DAY) }, schedule: stored({ windows: [NIGHT] }) });
  const [result] = await s.checkAt('19T10:05');
  assert.deepEqual(result, { workloadId: 'demo', state: STATES.WAKING, hibernation: 'maintenance' });
  assert.equal(s.store.state.run.freshBoot, true);
});

test('a schedule\'s maxNapDays wake asks for no fresh boot, and the 60-day pass leaves the workload it woke without reading it again (hibernation)', async () => {
  const s = setup({ run: { state: STATES.ASLEEP, stateAt: at('12T10:02'), hibernated: hibernated(at('12T10:01')) }, schedule: stored({ maxNapDays: 7 }) });
  const { getRun } = s.wrapped;
  let reads = 0;
  s.wrapped.getRun = async (id) => { reads += 1; return getRun(id); };
  const [result] = await s.checkAt('19T10:05');
  assert.deepEqual(result, { workloadId: 'demo', state: STATES.WAKING, schedule: 'maintenance' });
  assert.deepEqual(s.causes(), [[STATES.WAKING, 'maintenance']]);
  assert.equal('freshBoot' in s.store.state.run, false);
  // The schedule's pass and the loop's reconcile.
  assert.equal(reads, 2);
});

test('status: maintenanceDue is the earlier of the schedule\'s and the hibernation\'s 60-day limit, for an asleep or failed workload (hibernation)', async () => {
  // Hibernated by a nap that failed, released asleep 49 days later: the 60-day limit comes before maxNapDays 30.
  const since = at('19T07:00') - 50 * DAY;
  const released = at('19T07:00') - DAY;
  const s = setup({ run: { state: STATES.ASLEEP, stateAt: released, hibernated: hibernated(since) }, schedule: stored({ maxNapDays: 30 }) });
  const due = async () => (await s.handler({ action: 'status', workloadId: 'demo' })).maintenanceDue;
  const limit = new Date(since + 59 * DAY).toISOString();
  assert.equal(await due(), limit);
  s.store.state.schedules.demo = stored({ maxNapDays: 7 });
  assert.equal(await due(), new Date(released + 7 * DAY).toISOString());
  // A schedule the router cannot read, or none: the 60-day limit alone; failed alike.
  s.store.state.schedules.demo = stored({ timeZone: 'Nowhere/Land', windows: [NIGHT] });
  assert.equal(await due(), limit);
  delete s.store.state.schedules.demo;
  s.store.state.run.state = STATES.FAILED;
  assert.equal(await due(), limit);
  s.store.state.run.state = STATES.AWAKE;
  assert.equal(await due(), null);
});
