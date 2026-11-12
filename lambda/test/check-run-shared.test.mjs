// Both routers' check loop (lib/check-run.mjs) on plain ports: the concurrency, the chunks and their preparation, the passes'
// outcomes, the cloud's end of the loop; then the contract on the DynamoDB store's fake (gcp/test/check-run-shared.test.mjs runs it
// on the Firestore store).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCheck } from '../src/lib/check-run.mjs';
import { checkRunContract } from './check-run-contract.mjs';
import { fakeStore, silentLog, testConfig } from './fakes.mjs';

const ids = (n) => Array.from({ length: n }, (_, i) => ({ workloadId: `w${String(i).padStart(2, '0')}` }));
// A store with no cursor, every workload configured.
const plainStore = () => ({ getCheck: async () => null, getConfig: async (workloadId) => ({ workloadId }) });
function clock() {
  let t = 0;
  return { now: () => t, advance: (ms) => { t += ms; } };
}
const keeping = (logs) => ({ info: (event, data) => logs.push([event, data]), warn: (event, data) => logs.push([event, data]), error: (event, data) => logs.push([event, data]) });

test('the check runs concurrency workloads at a time, never more, 8 by default, each next one as one ends', async () => {
  for (const [concurrency, expected] of [[3, 3], [undefined, 8]]) {
    let running = 0;
    let most = 0;
    const checkOne = async () => {
      running += 1;
      most = Math.max(most, running);
      await new Promise(setImmediate);
      running -= 1;
      return { state: 'AWAKE' };
    };
    const { results, cursor } = await runCheck({ store: plainStore(), workloads: ids(20), checkOne, deadline: 1, concurrency, now: () => 0, log: silentLog });
    assert.equal(most, expected);
    assert.equal(results.length, 20);
    assert.equal(cursor, null);
  }
});

test('chunks are prepared in the check\'s order before their workloads; one is not started when its preparation, as long as the last one\'s, would end past the deadline', async () => {
  const c = clock();
  const events = [];
  const logs = [];
  const chunk = {
    size: 3,
    prepare: async (workloads) => {
      events.push(`prepare ${workloads.map((w) => w.workloadId).join(',')}`);
      c.advance(50_000);
    },
  };
  const checkOne = async ({ workloadId }) => {
    events.push(`check ${workloadId}`);
    return { state: 'AWAKE' };
  };
  // Prepared at 0 (until 50 s), at 50 s (until 100 s); at 100 s, another 50 s would end past 120 s.
  const { results, cursor } = await runCheck({ store: plainStore(), workloads: ids(9), checkOne, deadline: 120_000, chunk, now: c.now, log: keeping(logs) });
  assert.deepEqual(events, ['prepare w00,w01,w02', 'check w00', 'check w01', 'check w02', 'prepare w03,w04,w05', 'check w03', 'check w04', 'check w05']);
  assert.deepEqual([results.length, cursor], [6, 'w05']);
  assert.deepEqual(logs, [['CheckBudgetReached', { checked: 6, workloads: 9, next: 'w06' }]]);
  // Without chunks, nothing is prepared: one wave over every workload.
  events.length = 0;
  await runCheck({ store: plainStore(), workloads: ids(3), checkOne, deadline: 1, now: () => 0, log: silentLog });
  assert.deepEqual(events, ['check w00', 'check w01', 'check w02']);
});

test('what the passes before the loop did is in a reached workload\'s result, and alone for one the loop did not reach; a failed one\'s says its error', async () => {
  const c = clock();
  const logs = [];
  const passes = new Map([['w00', { schedule: 'wake' }], ['w01', { schedule: 'nap' }], ['w05', { hibernation: 'maintenance' }]]);
  const checkOne = async ({ workloadId }) => {
    if (workloadId === 'w01') throw new Error('throttled');
    c.advance(100);
    return { state: 'AWAKE' };
  };
  // Two at a time and 100 ms each, 150 ms: w00, w01 (failing at once) and w02 are started, then the time is up.
  const { results, cursor } = await runCheck({ store: plainStore(), workloads: ids(6), checkOne, deadline: 150, concurrency: 2, passes, now: c.now, log: keeping(logs) });
  assert.deepEqual(results, [
    { workloadId: 'w00', state: 'AWAKE', schedule: 'wake' }, { workloadId: 'w02', state: 'AWAKE' }, { workloadId: 'w01', error: 'throttled' },
    { workloadId: 'w05', hibernation: 'maintenance' },
  ]);
  assert.equal(cursor, 'w02');
  assert.deepEqual(logs, [['CheckFailed', { workloadId: 'w01', error: 'throttled' }], ['CheckBudgetReached', { checked: 3, workloads: 6, next: 'w03' }]]);
});

test('the cloud\'s end of the loop comes once, after the last workload\'s check and before the budget\'s line', async () => {
  const events = [];
  const log = { info() {}, warn: (event) => events.push(event), error() {} };
  const checkOne = async ({ workloadId }) => {
    await null;
    events.push(workloadId);
    return {};
  };
  const end = () => events.push('end');
  await runCheck({ store: plainStore(), workloads: ids(2), checkOne, deadline: 1, end, now: () => 0, log });
  assert.deepEqual(events, ['w00', 'w01', 'end']);
  events.length = 0;
  await runCheck({ store: plainStore(), workloads: ids(2), checkOne, deadline: 0, end, now: () => 0, log });
  assert.deepEqual(events, ['end', 'CheckBudgetReached']);
});

checkRunContract('the DynamoDB store', ({ now }) => {
  const store = fakeStore({ config: testConfig(), run: null, clock: { now } });
  return {
    store,
    // Where the check stopped, on its CHECK item (state.mjs's setCheckCursor), at once.
    keep: (cursor) => store.setCheckCursor(cursor),
    // An offboarding deletes the configuration (state.mjs's deleteWorkload).
    offboard: async () => { store.getConfig = async () => null; },
  };
});
