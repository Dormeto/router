// Both routers' pauses (lib/pauses.mjs): what they show and hold, then their contract on the DynamoDB store's fake, through the
// adapter the AWS controller builds (gcp/test/pauses-shared.test.mjs runs it on the Firestore store).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pauseStore } from '../src/lib/controller-core.mjs';
import { pauseHolds, pauseText, shownPause } from '../src/lib/pauses.mjs';
import { fakeStore, testConfig } from './fakes.mjs';
import { pausesContract } from './pauses-contract.mjs';

const AT = Date.parse('2026-03-10T12:00:00Z');

test('a pause as shown: its scope first, the workload\'s or the router\'s, until null without one, keepAsleep only when true, an exclusion\'s id', () => {
  const own = shownPause({ workloadId: 'demo', by: 'ops', at: AT, reason: 'r', until: AT + 1000, keepAsleep: true });
  assert.deepEqual(Object.entries(own), [['scope', 'workload'], ['by', 'ops'], ['at', '2026-03-10T12:00:00.000Z'], ['reason', 'r'], ['until', '2026-03-10T12:00:01.000Z'], ['keepAsleep', true]]);
  assert.deepEqual(shownPause({ workloadId: null, by: 'adm', at: AT, reason: 'freeze', keepAsleep: 'yes' }), {
    scope: 'router', by: 'adm', at: '2026-03-10T12:00:00.000Z', reason: 'freeze', until: null, keepAsleep: false,
  });
  assert.deepEqual(Object.keys(shownPause({ workloadId: 'demo', by: 'mgr', at: AT, reason: 'excluded', keepAsleep: false, exclusionId: 'x1' })).at(-1), 'exclusionId');
});

test('a pause in the words of a refused request-nap: the router\'s says so', () => {
  assert.equal(pauseText({ scope: 'workload', by: 'ops', reason: 'incident 42' }), 'paused by ops: incident 42');
  assert.equal(pauseText({ scope: 'router', by: 'adm', reason: 'freeze' }), 'router paused by adm: freeze');
});

test('what the active pauses hold: a workload\'s its naps, the router\'s every workload\'s, keepAsleep the wakes too; unreadable, every one', () => {
  const { paused, keptAsleep } = pauseHolds([
    { workloadId: 'a', keepAsleep: false }, { workloadId: 'b', keepAsleep: true, exclusionId: 'x1' },
  ]);
  assert.deepEqual(['a', 'b', 'c'].map((id) => [paused(id), keptAsleep(id)]), [[true, false], [true, true], [false, false]]);
  const router = pauseHolds([{ workloadId: null, keepAsleep: true }]);
  assert.deepEqual([router.paused('c'), router.keptAsleep('c')], [true, true]);
  const plain = pauseHolds([{ workloadId: null, keepAsleep: false }]);
  assert.deepEqual([plain.paused('c'), plain.keptAsleep('c')], [true, false]);
  const unreadable = pauseHolds(null);
  assert.deepEqual([unreadable.paused('c'), unreadable.keptAsleep('c')], [true, true]);
  const none = pauseHolds([]);
  assert.deepEqual([none.paused('c'), none.keptAsleep('c')], [false, false]);
});

pausesContract('the DynamoDB store', () => {
  const store = fakeStore({ config: testConfig(), run: null });
  return {
    store: pauseStore(store),
    workloads: async (ids) => { store.listConfigs = async () => ids.map((workloadId) => testConfig({ workloadId })); },
  };
});
