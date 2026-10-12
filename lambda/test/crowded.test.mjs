// The idle check of a crowded account-region (scale design §6): 1,500 workloads on 300 load balancers, every AWS call
// taking simulated time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../src/lib/controller-core.mjs';
import { crowdedAccount, withSdkRetries } from './crowded-fake.mjs';
import { silentLog } from './fakes.mjs';
import { simClock } from './sim-clock.mjs';

const MINUTE = 60_000;
const BUDGET_MS = 240_000;

// queues: naps go to the work queue and repairs to the drift queue (routers 0.22.1 and later), recorded in `queued`.
function setup({ workloads = 1500, balancers = 300, latencyMs = 400, lastRequest, elb, drifted, queues = false, log = silentLog } = {}) {
  const clock = simClock();
  const account = crowdedAccount({ workloads, balancers, latencyMs, clock, lastRequest, elbBucket: elb, drifted });
  const { store, ...aws } = account.clients;
  const retries = withSdkRetries(aws.elbv2, { now: clock.now, sleep: clock.sleep });
  aws.elbv2 = retries.client;
  const queued = { work: [], repair: [] };
  const repairsInvoked = [];
  const queueing = queues ? { queueWork: async (m) => { queued.work.push(m); }, queueRepair: async (m) => { queued.repair.push(m); } } : {};
  // The router reports to the manager after each check (its workloads as the list gives them).
  const reports = [];
  const publisher = { enabled: true, checked: async (report) => { reports.push(report); }, stateChanged: async () => {} };
  const handler = createController({
    store, ...aws, invokeSelf: account.invokeSelf, invokeOnboarder: async (p) => { repairsInvoked.push(p); }, ...queueing,
    now: clock.now, sleep: clock.sleep, log, publisher,
    router: { name: 'dmtr-dev', region: 'eu-west-3', checkSchedule: 'rate(5 minutes)' },
  });
  // One check, as the schedule starts it; the next one starts 5 minutes after it.
  async function check() {
    const started = clock.now();
    const listings = { ...account.listings };
    const result = await clock.until(handler({ action: 'check', source: 'schedule' }));
    const ms = clock.now() - started;
    const relisted = Object.entries(account.listings).filter(([lb, n]) => n - (listings[lb] ?? 0) > 1).map(([lb]) => lb);
    clock.advance(Math.max(0, 5 * MINUTE - ms));
    return { result, ms, relisted };
  }
  return { clock, account, handler, check, reports, retries, queued, repairsInvoked };
}

test('a crowded check lists each load balancer once, its report to the manager included, stays within its budget, and reaches every workload within a few checks', async () => {
  const s = setup();
  const seen = new Set();
  const durations = [];
  while (seen.size < 1500 && durations.length < 4) {
    const { result, ms, relisted } = await s.check();
    assert.ok(Array.isArray(result));
    for (const r of result) seen.add(r.workloadId);
    assert.deepEqual(relisted, [], 'a load balancer listed twice in one check');
    durations.push(ms);
  }
  assert.equal(seen.size, 1500);
  // Each check reported every workload, with its host, from the check's own listing.
  assert.equal(s.reports.length, durations.length);
  for (const report of s.reports) assert.equal(report.workloads.filter((w) => w.url).length, 1500);
  assert.ok(durations.length >= 2 && durations.length <= 3, `${durations.length} checks`);
  for (const ms of durations) assert.ok(ms <= BUDGET_MS + 5_000, `a check took ${ms / 1000} s`);
  // Backends found by tag once per check, not once per workload.
  assert.ok(s.account.calls.describeAutoScalingGroups <= durations.length, `${s.account.calls.describeAutoScalingGroups} Auto Scaling listings`);
  assert.ok(s.account.calls.getResources <= durations.length, `${s.account.calls.getResources} tag listings`);
});

test('a check while the previous one still runs is skipped', async () => {
  const s = setup();
  const first = s.handler({ action: 'check', source: 'schedule' });
  await s.clock.until(s.clock.sleep(10_000));
  const second = await s.clock.until(s.handler({ action: 'check', source: 'schedule' }));
  assert.deepEqual(second, { skipped: 'the previous check is still running' });
  assert.ok(Array.isArray(await s.clock.until(first)));
  // Once it is over, the next check runs.
  assert.ok(Array.isArray(await s.clock.until(s.handler({ action: 'check', source: 'schedule' }))));
});

test('the request metric is not read before the earliest time the workload can be idle', async () => {
  // w0000 had a request 2 minutes ago, the others none.
  let busy = true;
  const s = setup({ workloads: 4, balancers: 2, latencyMs: 10, lastRequest: (id, now) => (id === 'w0000' && busy ? now - 2 * MINUTE : null) });
  await s.check();
  assert.equal(s.account.metricReads.w0000, 1);
  assert.deepEqual(s.account.naps.sort(), ['w0001', 'w0002', 'w0003']);
  // Busy for at least the idle window (30 minutes) after its last request: not read again before.
  await s.check();
  assert.equal(s.account.metricReads.w0000, 1);
  busy = false;
  s.clock.advance(25 * MINUTE);
  await s.check();
  assert.equal(s.account.metricReads.w0000, 2);
  assert.ok(s.account.naps.includes('w0000'));
});

// Warnings and errors the controller logs, by event.
function recordingLog() {
  const events = [];
  const record = (event) => events.push(event);
  return { info() {}, warn: record, error: record, events };
}

test('a crowded check under ELB throttling (200 burst, 50 calls per second, 20 of them taken by the customer\'s tools) fails no call: the SDK\'s adaptive retries slow it down, within its budget', async () => {
  const log = recordingLog();
  // A fast API: the listings outrun the 30 calls per second left.
  const s = setup({ latencyMs: 40, elb: { burst: 200, rate: 50, shared: 20 }, log });
  const seen = new Set();
  const durations = [];
  while (seen.size < 1500 && durations.length < 4) {
    const { result, ms } = await s.check();
    for (const r of result) seen.add(r.workloadId);
    durations.push(ms);
  }
  assert.ok(s.account.stats.throttled > 0, 'the bucket never ran dry: nothing was throttled');
  assert.equal(s.retries.stats.failed, 0, 'an ELB call failed');
  assert.deepEqual(log.events.filter((e) => e !== 'CheckBudgetReached'), []);
  assert.equal(seen.size, 1500);
  for (const ms of durations) assert.ok(ms <= BUDGET_MS + 5_000, `a check took ${ms / 1000} s`);
});

test('a crowded check of idle and drifted workloads queues every nap and repair: none runs in the check itself', async () => {
  // 300 workloads idle for 6 hours, the first 10 onboarded by the manager with a rule that lost its waker.
  const s = setup({ workloads: 300, balancers: 60, latencyMs: 100, drifted: 10, queues: true });
  const { result, ms } = await s.check();
  assert.equal(result.length, 300);
  assert.equal(s.queued.work.length, 300);
  assert.ok(s.queued.work.every((m) => m.action === 'nap'));
  assert.deepEqual(s.queued.repair.map((m) => m.workloadId).sort(), s.account.ids.slice(0, 10));
  assert.deepEqual([s.account.naps, s.repairsInvoked], [[], []]);
  assert.ok(ms <= BUDGET_MS, `the check took ${ms / 1000} s`);
});
