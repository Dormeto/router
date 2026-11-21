// A standalone workload in the controller (vision standalone workloads design §3, §4, §5): naps, wakes, releases, reconciles
// and checks with no load balancer call at all, its backends from its record and the workload tag, AWAKE when every backend
// runs, napped on its idle signals, its failed wake retried by the check. The ELB client of these tests throws on any call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../src/lib/controller-core.mjs';
import { withTransitionEvents } from '../src/lib/events.mjs';
import { STATES } from '../src/lib/state.mjs';
import { STANDALONE_KEYS } from '../src/lib/settings-levels.mjs';
import { METRIC_LAG_MS, PERIOD_MS } from '../src/lib/activity.mjs';
import { asgGroup, ecsService, fakeAppScaling, fakeAutoScaling, fakeClock, fakeEc2, fakeEcs, fakeRds, fakeRdsTagging, fakeStore, fakeTagging } from './fakes.mjs';

const MINUTE = 60_000;
const ID = 'batch';
const TAG = { 'dormeto:workload': ID };
const ARNS = {
  instance: 'arn:aws:ec2:eu-west-1:111122223333:instance/i-0aaa',
  asg: 'arn:aws:autoscaling:eu-west-1:111122223333:autoScalingGroup:0000:autoScalingGroupName/workers',
  ecs: 'arn:aws:ecs:eu-west-1:111122223333:service/jobs/worker',
  'rds-instance': 'arn:aws:rds:eu-west-1:111122223333:db:orders',
  'rds-cluster': 'arn:aws:rds:eu-west-1:111122223333:cluster:ledger',
};

// An ELB client that throws on any call, and says each one.
function noElb() {
  const calls = [];
  const client = new Proxy({}, {
    get(_, name) {
      if (name === 'then' || typeof name === 'symbol') return undefined;
      return () => {
        calls.push(name);
        throw new Error(`ELB called: ${name}`);
      };
    },
  });
  return { client, calls };
}

// A CloudWatch answering every query with a point every 5 minutes of the asked span, `values[query id prefix](t)` (undefined: none).
function idleCloudWatch(values = {}) {
  const calls = [];
  return {
    calls,
    values,
    async getMetricData(input) {
      calls.push(input);
      if (values.failure) throw values.failure;
      return {
        MetricDataResults: input.MetricDataQueries.map((q) => {
          const of = values[q.Id.split('_')[0]];
          const points = [];
          for (let t = input.StartTime.getTime(); t < input.EndTime.getTime(); t += PERIOD_MS) {
            const v = of?.(t);
            if (v !== undefined) points.push([t, v]);
          }
          return { Id: q.Id, StatusCode: 'Complete', Timestamps: points.map(([t]) => new Date(t)), Values: points.map(([, v]) => v) };
        }),
      };
    },
  };
}

// kind: the resource's; state: AWS's at the start ('running' or 'stopped'); companion: an RDS instance beside it.
function setup({ kind = 'instance', state = 'running', run = { state: state === 'running' ? STATES.AWAKE : STATES.ASLEEP }, companion = false, cfg: overrides = {}, metrics = { cpu: () => 1 }, queue = true, start } = {}) {
  const clock = fakeClock(start ?? Date.UTC(2026, 10, 23, 10, 0));
  const running = state === 'running';
  const cfg = { workloadId: ID, kind: 'standalone', resourceArn: ARNS[kind], name: 'Batch', tags: {}, databases: companion ? [{ kind: 'rds-instance', id: 'side' }] : [], source: 'manager', inherits: STANDALONE_KEYS, ...overrides };
  const store = fakeStore({ config: cfg, run: { awakeSince: running ? clock.now() - 10 * 60 * MINUTE : undefined, ...run }, clock });
  const ec2 = fakeEc2(kind === 'instance' ? ['i-0aaa'] : [], { state: running ? 'running' : 'stopped' });
  if (kind === 'instance') ec2.state.tags['i-0aaa'] = { ...TAG };
  const autoscaling = fakeAutoScaling(kind === 'asg' ? [asgGroup('workers', { min: 1, max: 2, desired: running ? 1 : 0, tags: TAG })] : []);
  const ecs = fakeEcs(kind === 'ecs' ? [ecsService('worker', { cluster: 'jobs', desired: running ? 1 : 0, tags: TAG })] : []);
  const available = running ? 'available' : 'stopped';
  const rds = fakeRds({
    instances: { ...(kind === 'rds-instance' ? { orders: { status: available, tags: TAG } } : {}), ...(companion ? { side: { status: available, tags: TAG } } : {}) },
    clusters: kind === 'rds-cluster' ? { ledger: { status: available, tags: TAG } } : {},
  });
  const ecsTagging = fakeTagging(ecs);
  const rdsTagging = fakeRdsTagging(rds, ID);
  const tagging = {
    async getResources(input) {
      const parts = await Promise.all([ecsTagging, rdsTagging].map((t) => t.getResources(input)));
      return { ResourceTagMappingList: parts.flatMap((p) => p.ResourceTagMappingList ?? []) };
    },
  };
  const elb = noElb();
  const cloudwatch = idleCloudWatch(metrics);
  const changes = [];
  const wrapped = withTransitionEvents(store, { stateChanged: async (c) => { changes.push(c); } }, { now: clock.now });
  const queued = [];
  const invocations = [];
  const logs = [];
  const log = { info: (e, d) => logs.push([e, d]), warn: (e, d) => logs.push([e, d]), error: (e, d) => logs.push([e, d]) };
  let ids = 0;
  const handler = createController({
    store: wrapped, ec2, elbv2: elb.client, cloudwatch, autoscaling, ecs, tagging, appscaling: fakeAppScaling(), rds,
    invokeSelf: async (payload) => { invocations.push(payload); }, ...(queue ? { queueWork: async (m) => { queued.push(m); } } : {}),
    now: clock.now, sleep: clock.sleep, newId: () => `w${++ids}`, log, router: { name: 'dmt-dev' },
  });
  const deliver = (m) => handler({ Records: [{ messageId: 'm', eventSource: 'aws:sqs', body: JSON.stringify(m) }] });
  const causes = () => changes.map((c) => [c.to, c.cause ?? null]);
  const logged = (name) => logs.filter(([event]) => event === name).map(([, data]) => data);
  // What AWS says of the resource now: 'running', 'stopped' or what it is between.
  const resource = () => {
    if (kind === 'instance') return ec2.state.instances['i-0aaa'];
    if (kind === 'asg') return autoscaling.state.groups[0].DesiredCapacity > 0 ? 'running' : 'stopped';
    if (kind === 'ecs') return ecs.state.services[0].desiredCount > 0 ? 'running' : 'stopped';
    const db = kind === 'rds-instance' ? rds.state.instances.orders : rds.state.clusters.ledger;
    return db.status === 'available' || db.status === 'starting' ? 'running' : 'stopped';
  };
  return { handler, store, clock, ec2, autoscaling, ecs, rds, elb, cloudwatch, changes, queued, invocations, deliver, causes, logged, resource, cfg };
}

const KINDS = Object.keys(ARNS);

for (const kind of KINDS) {
  test(`a standalone ${kind}: naps and wakes with no load balancer call`, async () => {
    const s = setup({ kind });
    assert.deepEqual(await s.handler({ action: 'nap', workloadId: ID, by: 'ana' }), { state: STATES.ASLEEP });
    assert.equal(s.resource(), 'stopped');
    assert.deepEqual(s.causes(), [[STATES.NAPPING, 'manager'], [STATES.ASLEEP, null]]);
    s.store.state.run = { ...s.store.state.run, state: STATES.WAKING, wakeId: 'w9', wakeStartedAt: s.clock.now() };
    assert.deepEqual(await s.handler({ action: 'wake', workloadId: ID, wakeId: 'w9' }), { state: STATES.AWAKE });
    assert.equal(s.resource(), 'running');
    assert.equal(s.store.state.run.state, STATES.AWAKE);
    assert.deepEqual(s.elb.calls, []);
  });
}

test('a standalone instance with a companion database: the instance stops before the database, the database starts before it', async () => {
  const s = setup({ companion: true });
  await s.handler({ action: 'nap', workloadId: ID });
  assert.deepEqual([s.resource(), s.rds.state.calls], ['stopped', [['stop', 'side']]]);
  assert.deepEqual(JSON.parse(s.store.state.run.napBackends), [{ kind: 'instance', id: 'i-0aaa' }, { kind: 'rds-instance', id: 'side' }]);
  s.store.state.run = { ...s.store.state.run, state: STATES.WAKING, wakeId: 'w9', wakeStartedAt: s.clock.now() };
  s.ec2.state.onStart.push(() => assert.equal(s.rds.state.instances.side.status, 'available', 'the database first'));
  assert.deepEqual(await s.handler({ action: 'wake', workloadId: ID, wakeId: 'w9' }), { state: STATES.AWAKE });
  assert.deepEqual(s.elb.calls, []);
});

test('a resource that lost the workload tag is not napped', async () => {
  const s = setup();
  s.ec2.state.tags['i-0aaa'] = { 'dormeto:workload': 'other' };
  assert.deepEqual(await s.handler({ action: 'nap', workloadId: ID }), { state: 'SKIPPED', reason: 'no-instances' });
  assert.equal(s.resource(), 'running');
});

test('a wake that does not finish in its timeout is FAILED; the check retries it after the backoff, held by a keepAsleep pause', async () => {
  const s = setup({ state: 'stopped' });
  // The instance stays pending: it never runs.
  s.ec2.state.onStart.push(() => { s.ec2.state.instances['i-0aaa'] = 'pending'; });
  s.store.state.run = { state: STATES.WAKING, wakeId: 'w9', wakeStartedAt: s.clock.now() };
  const failed = await s.handler({ action: 'wake', workloadId: ID, wakeId: 'w9' });
  assert.equal(failed.state, STATES.FAILED);
  assert.match(failed.error, /not every backend runs: instance:i-0aaa is transitioning/);
  assert.equal(JSON.parse(s.store.state.run.failure).kind, 'timeout');
  assert.equal(s.clock.now() - s.store.state.run.failedAt < MINUTE, true);
  // Before the backoff (60 s after the first failure): nothing.
  assert.deepEqual(await s.handler({ action: 'check' }), [{ workloadId: ID, state: STATES.FAILED }]);
  s.clock.advance(61_000);
  await s.store.putPause(ID, { by: 'ops', at: s.clock.now(), keepAsleep: true });
  assert.deepEqual(await s.handler({ action: 'check' }), [{ workloadId: ID, state: STATES.FAILED, retry: 'held', reason: 'a keepAsleep pause' }]);
  s.store.state.pauses = [];
  assert.deepEqual(await s.handler({ action: 'check' }), [{ workloadId: ID, state: STATES.WAKING, retry: 'requested' }]);
  assert.deepEqual(s.causes().at(-1), [STATES.WAKING, 'retry']);
  assert.deepEqual(s.invocations.at(-1), { action: 'wake', workloadId: ID, wakeId: s.store.state.run.wakeId });
  assert.deepEqual(s.elb.calls, []);
});

test('a failed nap is released once its idle window passed, with no load balancer call', async () => {
  // A service whose tasks do not run (neither running nor stopped): the reconcile leaves it FAILED.
  const s = setup({ kind: 'ecs', run: { state: STATES.FAILED, failedAt: Date.UTC(2026, 10, 23, 7, 0), failure: JSON.stringify({ kind: 'unknown', step: 'nap', message: 'x' }) } });
  s.ecs.state.services[0].runningCount = 0;
  assert.deepEqual(await s.handler({ action: 'check' }), [{ workloadId: ID, state: STATES.FAILED, release: 'requested' }]);
  assert.deepEqual(s.queued, [{ action: 'release', workloadId: ID, requestedAt: s.clock.now() }]);
  await s.deliver(s.queued[0]);
  assert.deepEqual([s.store.state.run.state, s.resource()], [STATES.ASLEEP, 'stopped']);
  assert.deepEqual(s.elb.calls, []);
  // Its running service: recovered, AWAKE.
  const running = setup({ run: { state: STATES.FAILED, failedAt: Date.UTC(2026, 10, 23, 7, 0), failure: JSON.stringify({ kind: 'unknown', step: 'nap', message: 'x' }) } });
  await running.handler({ action: 'check' });
  assert.deepEqual(running.causes(), [[STATES.AWAKE, 'recovered']]);
});

test('a start made outside Dormeto is seen at the check: AWAKE, cause external-start; an outside stop: ASLEEP, external-stop', async () => {
  for (const kind of KINDS) {
    const s = setup({ kind, state: 'stopped' });
    if (kind === 'instance') s.ec2.state.instances['i-0aaa'] = 'running';
    if (kind === 'asg') await s.autoscaling.updateAutoScalingGroup({ AutoScalingGroupName: 'workers', DesiredCapacity: 1 });
    if (kind === 'ecs') await s.ecs.updateService({ cluster: s.ecs.state.services[0].clusterArn, service: ARNS.ecs, desiredCount: 1 });
    if (kind === 'rds-instance') s.rds.state.instances.orders.status = 'available';
    if (kind === 'rds-cluster') s.rds.state.clusters.ledger.status = 'available';
    await s.handler({ action: 'check' });
    assert.deepEqual(s.causes(), [[STATES.AWAKE, 'external-start']], kind);
    assert.deepEqual(s.elb.calls, [], kind);
  }
  const s = setup();
  s.ec2.state.instances['i-0aaa'] = 'stopped';
  await s.handler({ action: 'check' });
  assert.deepEqual(s.causes(), [[STATES.ASLEEP, 'external-stop']]);
  assert.deepEqual(s.elb.calls, []);
});

test('a database restarted by AWS while its server sleeps is stopped again; the database of a database workload makes it AWAKE', async () => {
  const s = setup({ state: 'stopped', companion: true });
  s.rds.state.instances.side.status = 'available';
  await s.handler({ action: 'check' });
  assert.deepEqual([s.store.state.run.state, s.rds.state.calls], [STATES.ASLEEP, [['stop', 'side']]]);
  assert.deepEqual(s.elb.calls, []);
});

test('idle: every signal under at every point of its idle window, the workload awake for all of it: napped', async () => {
  const s = setup();
  assert.deepEqual(await s.handler({ action: 'check' }), [{ workloadId: ID, state: STATES.AWAKE, nap: 'queued' }]);
  const [read] = s.cloudwatch.calls;
  // 120 minutes, ending 10 minutes behind at a 5-minute boundary: 24 points.
  assert.equal(read.EndTime.getTime(), s.clock.now() - METRIC_LAG_MS);
  assert.equal(read.EndTime.getTime() - read.StartTime.getTime(), 120 * MINUTE);
  assert.deepEqual(read.MetricDataQueries.map((q) => q.MetricStat.Metric.MetricName), ['CPUUtilization']);
  await s.deliver(s.queued[0]);
  assert.deepEqual(s.causes(), [[STATES.NAPPING, 'idle'], [STATES.ASLEEP, null]]);
  assert.deepEqual(s.elb.calls, []);
});

test('busy at one point: no nap, and the next read waits until the window can be idle', async () => {
  const s = setup({ metrics: { cpu: (t) => (t === Date.UTC(2026, 10, 23, 9, 20) ? 40 : 1) } });
  const [answer] = await s.handler({ action: 'check' });
  // Under since 09:25: idle once the window starts there, 120 minutes and the 10 minutes' lag later.
  assert.deepEqual(answer, { workloadId: ID, state: STATES.AWAKE, idle: false, idleNotBefore: Date.UTC(2026, 10, 23, 9, 25) + 130 * MINUTE });
  assert.equal(s.store.state.run.idleNotBefore, answer.idleNotBefore);
  assert.deepEqual(s.queued, []);
  await s.handler({ action: 'check' });
  assert.equal(s.cloudwatch.calls.length, 1, 'not read again before then');
});

test('a missing point, a failed read or no signal at all: never napped', async () => {
  const gap = setup({ metrics: { cpu: (t) => (t === Date.UTC(2026, 10, 23, 9, 0) ? undefined : 1) } });
  assert.equal((await gap.handler({ action: 'check' }))[0].idle, false);
  assert.deepEqual(gap.queued, []);
  const failure = Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });
  const failed = setup({ metrics: { failure } });
  assert.deepEqual(await failed.handler({ action: 'check' }), [{ workloadId: ID, state: STATES.AWAKE, idle: false }]);
  assert.equal('idleNotBefore' in failed.store.state.run, false, 'read again at the next check');
  assert.equal(failed.logged('IdleSignalsUnread').length, 1);
  const none = setup({ cfg: { idleCpuPercent: 'off', inherits: ['idleMinutes', 'wakeTimeoutSeconds', 'idleNetworkBytes', 'idleMetric'] } });
  assert.deepEqual(await none.handler({ action: 'check' }), [{ workloadId: ID, state: STATES.AWAKE, idle: false }]);
  assert.equal(none.cloudwatch.calls.length, 0);
  assert.deepEqual([gap.queued, failed.queued, none.queued], [[], [], []]);
});

test('awake for less than its idle window: no read, no nap', async () => {
  const s = setup({ run: { state: STATES.AWAKE, awakeSince: Date.UTC(2026, 10, 23, 8, 30) } });
  assert.deepEqual(await s.handler({ action: 'check' }), [{ workloadId: ID, state: STATES.AWAKE }]);
  assert.equal(s.cloudwatch.calls.length, 0);
});

test('a paused workload is not napped; a pause wakes an asleep one', async () => {
  const s = setup();
  await s.handler({ action: 'pause', workloadId: ID, by: 'ops', reason: 'release day' });
  assert.deepEqual(await s.handler({ action: 'check' }), [{ workloadId: ID, state: STATES.AWAKE, paused: true }]);
  assert.equal(s.cloudwatch.calls.length, 0);
  const asleep = setup({ state: 'stopped' });
  const answer = await asleep.handler({ action: 'pause', workloadId: ID, by: 'ops', reason: 'release day' });
  assert.deepEqual(answer.woken, [ID]);
  assert.deepEqual(asleep.causes(), [[STATES.WAKING, 'pause']]);
  assert.deepEqual([s.elb.calls, asleep.elb.calls], [[], []]);
});

test('a schedule: its nap window naps it, its awake window wakes it and keeps it from its idle nap', async () => {
  // Monday 23 November 2026, 10:00 UTC.
  const napWindow = { timeZone: 'UTC', windows: [{ kind: 'nap', days: ['mon'], start: '09:00', end: '18:00' }], by: 'ops', at: Date.UTC(2026, 10, 20) };
  const s = setup({ metrics: { cpu: () => 50 } });
  s.store.state.schedules[ID] = napWindow;
  await s.handler({ action: 'check' });
  assert.equal(s.queued[0].cause, 'schedule');
  await s.deliver(s.queued[0]);
  assert.deepEqual([s.store.state.run.state, s.resource()], [STATES.ASLEEP, 'stopped']);

  const awakeWindow = { ...napWindow, windows: [{ kind: 'awake', days: ['mon'], start: '09:00', end: '18:00' }] };
  const asleep = setup({ state: 'stopped' });
  asleep.store.state.schedules[ID] = awakeWindow;
  await asleep.handler({ action: 'check' });
  assert.deepEqual(asleep.causes(), [[STATES.WAKING, 'schedule']]);

  const kept = setup();
  kept.store.state.schedules[ID] = awakeWindow;
  kept.store.state.run.scheduleApplied = `awake@${new Date(Date.UTC(2026, 10, 23, 9)).toISOString()}`;
  assert.deepEqual(await kept.handler({ action: 'check' }), [{ workloadId: ID, state: STATES.AWAKE, kept: 'awake window' }]);
  assert.equal(kept.cloudwatch.calls.length, 0);
  assert.deepEqual([s.elb.calls, asleep.elb.calls, kept.elb.calls], [[], [], []]);
});

test('hibernation: an instance launched with it is hibernated by the nap, as an HTTP workload\'s', async () => {
  const s = setup();
  s.ec2.state.configured['i-0aaa'] = true;
  await s.handler({ action: 'nap', workloadId: ID });
  assert.equal(s.ec2.state.stops.at(-1).Hibernate, true);
  assert.equal(JSON.parse(s.store.state.run.hibernated).ids[0], 'i-0aaa');
  const off = setup({ cfg: { hibernate: false } });
  off.ec2.state.configured['i-0aaa'] = true;
  await off.handler({ action: 'nap', workloadId: ID });
  assert.equal(off.ec2.state.stops.at(-1).Hibernate, undefined);
});

test('a queued idle nap is not checked against requests: a standalone workload has none', async () => {
  const s = setup();
  await s.handler({ action: 'check' });
  s.clock.advance(2 * MINUTE);
  await s.deliver(s.queued[0]);
  assert.equal(s.store.state.run.state, STATES.ASLEEP);
  assert.equal(s.cloudwatch.calls.length, 1, 'only the check read');
});
