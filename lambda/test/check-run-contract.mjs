// The contract of lib/check-run.mjs's runCheck, and of the levels reader (lib/settings-levels.mjs), on a cloud's store (vision
// docs/specs/2026-11-12-cloud-duplication-design.md, §2 rule 4): run on the DynamoDB store's fake by check-run-shared.test.mjs and on
// the Firestore store over its fake by gcp/test/check-run-shared.test.mjs. `setup({ now })` answers `{ store, keep(cursor),
// offboard(workloadId) }`: the cloud's store holding the workload `demo`, how the cloud stores where its check stopped (AWS: on its
// CHECK item at once; Google Cloud: in the check's summary, router/check), and an offboarding of a workload.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCheck } from '../src/lib/check-run.mjs';
import { createLevelsReader } from '../src/lib/settings-levels.mjs';

const START = 1_700_000_000_000;
const ids = (n) => Array.from({ length: n }, (_, i) => `w${String(i).padStart(2, '0')}`);
const reachedOf = (results) => results.map((r) => r.workloadId);

export function checkRunContract(cloud, setup) {
  // The check's ports on the cloud's store: a clock that moves only when a workload's check takes `costMs`, the log kept, and the
  // workloads each check reached, counted.
  async function harness({ workloads = 12, costMs = 100_000 } = {}) {
    let t = START;
    const now = () => t;
    const { store, keep, offboard } = await setup({ now });
    const logs = [];
    const log = { info: (event, data) => logs.push([event, data]), warn: (event, data) => logs.push([event, data]), error: (event, data) => logs.push([event, data]) };
    const configs = ids(workloads).map((workloadId) => ({ workloadId }));
    const counts = new Map(configs.map(({ workloadId }) => [workloadId, 0]));
    const checkOne = async ({ workloadId }) => {
      await null;
      t += costMs;
      counts.set(workloadId, counts.get(workloadId) + 1);
      return { state: 'AWAKE' };
    };
    // One check as each cloud runs it: 8 at a time within 240 s, then where it stopped stored the cloud's way.
    async function check(options = {}) {
      const answer = await runCheck({ store, workloads: configs, checkOne, deadline: t + 240_000, concurrency: 8, now, log, ...options });
      await keep(answer.cursor);
      return answer;
    }
    const logged = (event) => logs.filter(([e]) => e === event).map(([, data]) => data);
    return { store, keep, offboard, check, counts, logged, advance: (ms) => { t += ms; }, now };
  }

  test(`${cloud}: a check its budget cuts short starts the next after the last workload it checked: every workload within ceil(N/k) + 1 checks, none starved`, async () => {
    // 12 workloads, 8 a check: each check takes 8 at once, and each one's 100 s puts the 240 s behind them.
    const h = await harness();
    const N = 12;
    const k = 8;
    const seen = new Set();
    const checks = [];
    while (seen.size < N && checks.length < Math.ceil(N / k) + 1) {
      const { results, cursor } = await h.check();
      checks.push({ reached: reachedOf(results), cursor });
      for (const id of reachedOf(results)) seen.add(id);
    }
    assert.equal(seen.size, N, `${seen.size} workloads reached in ${checks.length} checks`);
    assert.equal(checks.length, Math.ceil(N / k));
    assert.deepEqual(checks[0], { reached: ids(8), cursor: 'w07' });
    assert.deepEqual(checks[1], { reached: [...ids(12).slice(8), ...ids(4)], cursor: 'w03' });
    // The cursor stored the cloud's way is what the next check reads.
    assert.deepEqual(h.logged('CheckBudgetReached'), [{ checked: 8, workloads: 12, next: 'w08' }, { checked: 8, workloads: 12, next: 'w04' }]);
    // The third check takes the 8 after w03: every workload checked twice in 3 checks, none more, none less.
    assert.deepEqual(await h.check().then(({ results, cursor }) => ({ reached: reachedOf(results), cursor })), { reached: ids(12).slice(4), cursor: 'w11' });
    assert.deepEqual([...new Set(h.counts.values())], [2]);
    // Past the last id, the next starts at the first.
    assert.deepEqual(reachedOf((await h.check()).results), ids(8));
  });

  test(`${cloud}: a check that reaches every workload clears where the last one stopped; one that reaches none keeps it`, async () => {
    const h = await harness();
    await h.check();
    assert.equal((await h.store.getCheck())?.cursor, 'w07');
    // No workload started: the next check starts where this one did.
    const none = await h.check({ deadline: h.now() });
    assert.deepEqual([none.results, none.cursor], [[], 'w07']);
    assert.equal((await h.store.getCheck())?.cursor, 'w07');
    // Every workload reached: none kept.
    const all = await h.check({ checkOne: async () => ({ state: 'ASLEEP' }) });
    assert.deepEqual([reachedOf(all.results), all.cursor], [[...ids(12).slice(8), ...ids(8)], null]);
    assert.equal((await h.store.getCheck())?.cursor, undefined);
    // None stored and none reached: still none.
    assert.equal((await h.check({ deadline: h.now() })).cursor, null);
  });

  test(`${cloud}: a cursor past every workload, or one that cannot be read, starts at the first`, async () => {
    const h = await harness();
    await h.keep('zz');
    assert.deepEqual(reachedOf((await h.check()).results), ids(8));
    await h.keep('w07');
    const { getCheck } = h.store;
    h.store.getCheck = async () => { throw new Error('unavailable'); };
    const unread = await h.check();
    assert.deepEqual([reachedOf(unread.results), unread.cursor], [ids(8), 'w07']);
    h.store.getCheck = getCheck;
  });

  test(`${cloud}: a workload that fails is said and stops only itself; one offboarded under the check is skipped, not failed`, async () => {
    const h = await harness();
    const workloads = [{ workloadId: 'demo' }, { workloadId: 'w01' }];
    const failing = (fail) => async ({ workloadId }) => {
      if (workloadId === 'demo') await fail();
      return { state: 'AWAKE' };
    };
    // Still configured: CheckFailed, with its error in its result.
    const failed = await h.check({ workloads, checkOne: failing(async () => { throw new Error('throttled'); }) });
    assert.deepEqual(failed.results.sort((a, b) => a.workloadId.localeCompare(b.workloadId)), [{ workloadId: 'demo', error: 'throttled' }, { workloadId: 'w01', state: 'AWAKE' }]);
    assert.deepEqual(h.logged('CheckFailed'), [{ workloadId: 'demo', error: 'throttled' }]);
    assert.deepEqual(h.logged('CheckSkipped'), []);
    // A configuration that cannot be read counts as there: CheckFailed.
    const { getConfig } = h.store;
    h.store.getConfig = async () => { throw new Error('unavailable'); };
    assert.deepEqual((await h.check({ workloads: [workloads[0]], checkOne: failing(async () => { throw new Error('throttled'); }) })).results, [{ workloadId: 'demo', error: 'throttled' }]);
    assert.equal(h.logged('CheckFailed').length, 2);
    h.store.getConfig = getConfig;
    // Its offboarding ran under the check: its writes failing is no failure.
    const skipped = await h.check({ workloads, checkOne: failing(async () => { await h.offboard('demo'); throw new Error('gone'); }) });
    assert.deepEqual(skipped.results.sort((a, b) => a.workloadId.localeCompare(b.workloadId)), [{ workloadId: 'demo', skipped: 'offboarded' }, { workloadId: 'w01', state: 'AWAKE' }]);
    assert.deepEqual(h.logged('CheckSkipped'), [{ workloadId: 'demo', reason: 'offboarded' }]);
    assert.equal(h.logged('CheckFailed').length, 2);
  });

  test(`${cloud}: the levels: read fresh at each call, a failed read said with the last record kept; a level never read is unreadable`, async () => {
    const { store } = await setup({ now: () => START });
    const warned = [];
    const log = { warn: (event, data) => warned.push([event, data]) };
    const readLevels = createLevelsReader({ router: () => store.getRouterSettings() }, { log });
    assert.deepEqual(await readLevels(), { router: null });
    await store.putRouterSettings({ joinMinutes: 30, by: 'ops', at: 1 });
    assert.equal((await readLevels()).router.joinMinutes, 30);
    const { getRouterSettings } = store;
    store.getRouterSettings = async () => { throw new Error('unavailable'); };
    const kept = await readLevels();
    assert.deepEqual([kept.router.joinMinutes, kept.unreadable, kept.errors], [30, undefined, { router: 'unavailable' }]);
    const never = await createLevelsReader({ router: () => store.getRouterSettings() }, { log })();
    assert.deepEqual(never, { router: null, unreadable: true, errors: { router: 'unavailable' } });
    assert.deepEqual(warned, [['SettingsLevelUnreadable', { level: 'router', error: 'unavailable' }], ['SettingsLevelUnreadable', { level: 'router', error: 'unavailable' }]]);
    store.getRouterSettings = getRouterSettings;
  });
}
