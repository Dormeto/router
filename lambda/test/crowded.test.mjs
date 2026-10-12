// The idle check of a crowded account-region (scale design §6): 1,500 workloads on 300 load balancers, every AWS call
// taking simulated time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../src/lib/controller-core.mjs';
import { crowdedAccount } from './crowded-fake.mjs';
import { silentLog } from './fakes.mjs';
import { simClock } from './sim-clock.mjs';

const MINUTE = 60_000;
const BUDGET_MS = 240_000;

function setup({ workloads = 1500, balancers = 300, latencyMs = 400, lastRequest } = {}) {
  const clock = simClock();
  const account = crowdedAccount({ workloads, balancers, latencyMs, clock, lastRequest });
  const { store, ...aws } = account.clients;
  // The router reports to the manager after each check (its workloads as the list gives them).
  const reports = [];
  const publisher = { enabled: true, checked: async (report) => { reports.push(report); }, stateChanged: async () => {} };
  const handler = createController({
    store, ...aws, invokeSelf: account.invokeSelf, now: clock.now, sleep: clock.sleep, log: silentLog, publisher,
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
  return { clock, account, handler, check, reports };
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
