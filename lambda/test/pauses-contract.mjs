// The contract of lib/pauses.mjs on a cloud's store (vision docs/specs/2026-11-12-cloud-duplication-design.md, §2 rule 4): run on
// the DynamoDB store's fake by pauses-shared.test.mjs and on the Firestore store over its fake by gcp/test/pauses-shared.test.mjs.
// `setup()` answers `{ store, workloads }`: the cloud's adapter of its store, as its controller builds it, and `workloads(ids)`,
// which makes its store list those workloads' configurations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPauses } from '../src/lib/pauses.mjs';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const START = Date.parse('2026-03-10T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const reasons = (pauses) => pauses.map((p) => p.reason).sort();
const REASON = 'reason required (1 to 256 characters)';
const UNTIL = 'until must be in the future, within 366 days';

export function pausesContract(cloud, setup) {
  // The pauses on the cloud's store, its clock at START, its log kept, and a wake port that answers `wake(id)` (true: this call woke
  // it) and keeps its calls.
  async function harness({ wake = async () => true, concurrency } = {}) {
    const { store, workloads } = await setup();
    let t = START;
    const logs = [];
    const keep = (event, data) => { logs.push([event, data]); };
    const calls = [];
    const pauses = createPauses({
      store,
      wake: async (workloadId, options) => {
        calls.push([workloadId, options]);
        return wake(workloadId, options);
      },
      concurrency,
      refuse: (message) => Object.assign(new Error(message), { refused: true }),
      now: () => t,
      log: { info: keep, warn: keep, error: keep },
    });
    return { store, workloads, pauses, calls, advance: (ms) => { t += ms; }, logged: (event) => logs.filter(([e]) => e === event).map(([, d]) => d) };
  }
  const named = (what) => `pauses on ${cloud}: ${what}`;

  test(named('a pause as written and shown: its author or unknown, its reason trimmed, keepAsleep only when true, until to its 366 days'), async () => {
    const h = await harness();
    const until = iso(START + 366 * DAY);
    const answer = await h.pauses.pause('demo', { by: 'ops', reason: '  load test ', until, keepAsleep: true });
    assert.deepEqual(answer, { pause: { scope: 'workload', by: 'ops', at: iso(START), reason: 'load test', until, keepAsleep: true }, woken: [] });
    const record = { by: 'ops', at: START, reason: 'load test', until: START + 366 * DAY, keepAsleep: true };
    assert.deepEqual(await h.store.listPauses(), [{ workloadId: 'demo', ...record }]);
    assert.deepEqual(h.logged('Paused'), [{ workloadId: 'demo', ...record }]);
    // The operator's pause is one: a new one replaces it. An until may be a time in ms; the longest reason is 256 characters.
    h.advance(1000);
    await h.pauses.pause('demo', { reason: 'x'.repeat(256), until: START + HOUR });
    assert.deepEqual(await h.pauses.pausesFor('demo'), [{ scope: 'workload', by: 'unknown', at: iso(START + 1000), reason: 'x'.repeat(256), until: iso(START + HOUR), keepAsleep: false }]);
    // The router's is one too, shown with its scope.
    await h.pauses.pause(null, { by: 'adm', reason: 'freeze', keepAsleep: true });
    h.advance(1000);
    const router = await h.pauses.pause(null, { by: 'adm', reason: 'change freeze', keepAsleep: true });
    assert.deepEqual(router.pause, { scope: 'router', by: 'adm', at: iso(START + 2000), reason: 'change freeze', until: null, keepAsleep: true });
    assert.deepEqual(reasons(await h.store.getPauses(null)), ['change freeze']);
    assert.deepEqual((await h.store.getPauses(null)).map((p) => p.workloadId), [null]);
  });

  test(named('a pause refused: no reason, one too long, an until past, too far or unreadable, a keepAsleep that is not a boolean; nothing written'), async () => {
    const h = await harness();
    for (const [workloadId, input, message] of [
      ['demo', {}, REASON],
      ['demo', { reason: '   ' }, REASON],
      ['demo', { reason: 7 }, REASON],
      ['demo', { reason: 'x'.repeat(257) }, REASON],
      ['demo', { reason: 'r', until: iso(START) }, UNTIL],
      ['demo', { reason: 'r', until: START + 366 * DAY + 1 }, UNTIL],
      ['demo', { reason: 'r', until: 'soon' }, UNTIL],
      ['demo', { reason: 'r', keepAsleep: 'true' }, 'keepAsleep must be true or false'],
      [null, { reason: 'r', until: START }, UNTIL],
      [null, { reason: 'r', keepAsleep: 1 }, 'keepAsleep must be true or false'],
    ]) {
      await assert.rejects(h.pauses.pause(workloadId, input), (err) => err.refused === true && err.message === message, JSON.stringify(input));
    }
    assert.deepEqual(await h.store.listPauses(), []);
    assert.deepEqual([h.calls, h.logged('Paused')], [[], []]);
  });

  test(named('a pause with no until goes to the store without one, and never expires'), async () => {
    for (const input of [{}, { until: undefined }, { until: null }]) {
      const h = await harness();
      await h.pauses.pause('demo', { reason: 'load test', keepAsleep: true, ...input });
      const [stored] = await h.store.listPauses();
      assert.equal(Object.hasOwn(stored, 'until'), false, JSON.stringify(input));
      h.advance(400 * DAY);
      assert.equal(await h.pauses.isPaused('demo'), true, JSON.stringify(input));
      assert.equal((await h.pauses.activePauses()).pauses.length, 1, JSON.stringify(input));
      assert.deepEqual((await h.pauses.pausesFor('demo'))[0].until, null);
    }
  });

  test(named('a workload\'s pauses: its exclusions\' first, then its own, then its router\'s, the newest first within each; another workload\'s are not its'), async () => {
    const h = await harness();
    await h.pauses.pause(null, { by: 'adm', reason: 'freeze', keepAsleep: true });
    h.advance(1000);
    await h.pauses.pause('demo', { by: 'ops', reason: 'mine', keepAsleep: true });
    h.advance(1000);
    await h.pauses.pause('demo', { by: 'mgr', reason: 'excluded: a', keepAsleep: true }, { exclusionId: 'x1' });
    h.advance(1000);
    const { pause } = await h.pauses.pause('demo', { by: 'mgr', reason: 'excluded: b', keepAsleep: true }, { exclusionId: 'x2' });
    assert.deepEqual(pause, { scope: 'workload', by: 'mgr', at: iso(START + 3000), reason: 'excluded: b', until: null, keepAsleep: true, exclusionId: 'x2' });
    h.advance(1000);
    await h.pauses.pause('demo-2', { by: 'ops', reason: 'theirs', keepAsleep: true });
    const shown = await h.pauses.pausesFor('demo');
    assert.deepEqual(shown.map((p) => [p.scope, p.reason, p.exclusionId ?? null]), [
      ['workload', 'excluded: b', 'x2'], ['workload', 'excluded: a', 'x1'], ['workload', 'mine', null], ['router', 'freeze', null],
    ]);
    assert.deepEqual(reasons(await h.store.getPauses('demo')), ['excluded: a', 'excluded: b', 'mine']);
    // The list's view: the same, from every pause the store lists.
    const all = await h.store.listPauses();
    assert.deepEqual(h.pauses.shownPauses(all.filter((p) => p.workloadId === 'demo' || p.workloadId === null)), shown);
    assert.deepEqual(h.pauses.shownPauses(all.filter((p) => p.workloadId === null)).map((p) => p.reason), ['freeze']);
  });

  test(named('a pause past its until no longer holds; the active pauses delete it, an exclusion\'s named, unless a newer one replaced it'), async () => {
    const h = await harness();
    await h.pauses.pause('demo', { by: 'ops', reason: 'mine', until: START + HOUR, keepAsleep: true });
    await h.pauses.pause('demo', { by: 'mgr', reason: 'excluded', until: START + HOUR, keepAsleep: true }, { exclusionId: 'x1' });
    await h.pauses.pause(null, { by: 'adm', reason: 'freeze', keepAsleep: true });
    h.advance(HOUR);
    assert.deepEqual((await h.pauses.pausesFor('demo')).map((p) => p.reason), ['freeze']);
    assert.equal(h.pauses.expired((await h.store.getPauses('demo'))[0]), true);
    const { pauses } = await h.pauses.activePauses();
    assert.deepEqual(reasons(pauses), ['freeze']);
    assert.deepEqual(reasons(await h.store.listPauses()), ['freeze']);
    assert.deepEqual(h.logged('PauseExpired').sort((a, b) => a.reason.localeCompare(b.reason)), [
      { workloadId: 'demo', by: 'mgr', reason: 'excluded', exclusionId: 'x1' }, { workloadId: 'demo', by: 'ops', reason: 'mine' },
    ]);

    // A newer pause written after the read of the expired one stays.
    const kept = await harness();
    await kept.pauses.pause('demo', { by: 'ops', reason: 'old', until: START + HOUR, keepAsleep: true });
    kept.advance(HOUR);
    const { listPauses } = kept.store;
    kept.store.listPauses = async () => {
      const read = await listPauses();
      await kept.pauses.pause('demo', { by: 'ops', reason: 'new', keepAsleep: true });
      return read;
    };
    assert.deepEqual((await kept.pauses.activePauses()).pauses, []);
    assert.deepEqual(reasons(await listPauses()), ['new']);
    assert.deepEqual(kept.logged('PauseExpired'), []);

    // One that cannot be deleted is said, and stays out of the active ones.
    const broken = await harness();
    await broken.pauses.pause('demo', { by: 'mgr', reason: 'excluded', until: START + HOUR, keepAsleep: true }, { exclusionId: 'x1' });
    broken.advance(HOUR);
    broken.store.deletePause = async () => { throw new Error('throttled'); };
    assert.deepEqual((await broken.pauses.activePauses()).pauses, []);
    assert.deepEqual(broken.logged('PauseDeleteFailed'), [{ workloadId: 'demo', exclusionId: 'x1', error: 'throttled' }]);
    assert.deepEqual(broken.logged('PauseExpired'), []);
  });

  test(named('pauses that cannot be read hold: a workload counts as paused, and the active pauses are none, with the read\'s error'), async () => {
    const h = await harness();
    await h.pauses.pause('demo', { by: 'ops', reason: 'mine', keepAsleep: true });
    assert.equal(await h.pauses.isPaused('demo'), true);
    assert.equal(await h.pauses.isPaused('demo-2'), false);
    h.store.getPauses = async () => { throw new Error('throttled'); };
    assert.equal(await h.pauses.isPaused('demo-2'), true);
    assert.deepEqual(h.logged('PausesUnreadable'), [{ workloadId: 'demo-2', error: 'throttled' }]);
    await assert.rejects(h.pauses.pausesFor('demo'), /throttled/);
    h.store.listPauses = async () => { throw new Error('throttled'); };
    assert.deepEqual(await h.pauses.activePauses(), { pauses: null, error: 'throttled' });
    assert.deepEqual(h.logged('PausesUnreadable').at(-1), { error: 'throttled' });
  });

  test(named('resume removes one pause, once: the operator\'s, an exclusion\'s by its id, or the router\'s; the others stay'), async () => {
    const h = await harness();
    await h.pauses.pause('demo', { by: 'ops', reason: 'mine', keepAsleep: true });
    await h.pauses.pause('demo', { by: 'mgr', reason: 'excluded', keepAsleep: true }, { exclusionId: 'x1' });
    await h.pauses.pause(null, { by: 'adm', reason: 'freeze', keepAsleep: true });
    assert.deepEqual(await h.pauses.resume('demo', 'ann'), { resumed: true });
    assert.deepEqual(await h.pauses.resume('demo', 'ann'), { resumed: false });
    assert.deepEqual(reasons(await h.store.listPauses()), ['excluded', 'freeze']);
    assert.deepEqual(await h.pauses.resume('demo', 'mgr', { exclusionId: 'x1' }), { resumed: true });
    assert.deepEqual(await h.pauses.resume('demo', 'mgr', { exclusionId: 'x1' }), { resumed: false });
    assert.deepEqual(reasons(await h.store.listPauses()), ['freeze']);
    assert.deepEqual(await h.pauses.resume(null, 'adm'), { resumed: true });
    assert.deepEqual(await h.pauses.resume(null, 'adm'), { resumed: false });
    assert.deepEqual(await h.pauses.resume('demo-2', 'ann'), { resumed: false });
    assert.deepEqual(await h.store.listPauses(), []);
    assert.deepEqual(h.logged('Resumed'), [{ workloadId: 'demo', by: 'ann' }, { workloadId: 'demo', by: 'mgr', exclusionId: 'x1' }, { workloadId: null, by: 'adm' }]);
  });

  test(named('a pause wakes its workload, a router\'s each one the store lists, unless keepAsleep: woken lists those the cloud woke, in the store\'s order; a failed wake is said, the pause stays'), async () => {
    const h = await harness({ wake: async (id) => { if (id === 'c') throw new Error('throttled'); return id !== 'b'; } });
    assert.deepEqual((await h.pauses.pause('a', { by: 'ops', reason: 'mine' })).woken, ['a']);
    assert.deepEqual(h.calls, [['a', { by: 'ops', router: false }]]);
    assert.deepEqual((await h.pauses.pause('b', { reason: 'mine' })).woken, []);
    assert.deepEqual(h.calls.at(-1), ['b', { by: 'unknown', router: false }]);
    await h.workloads(['a', 'b', 'c', 'd']);
    const router = await h.pauses.pause(null, { by: 'adm', reason: 'freeze' });
    assert.deepEqual(router.woken, ['a', 'd']);
    assert.deepEqual(h.calls.slice(2).map(([id, options]) => [id, options.router, options.by]), [['a', true, 'adm'], ['b', true, 'adm'], ['c', true, 'adm'], ['d', true, 'adm']]);
    assert.deepEqual(h.logged('PauseWakeFailed'), [{ workloadId: 'c', error: 'throttled' }]);
    assert.deepEqual((await h.store.getPauses(null)).map((p) => p.reason), ['freeze']);
    // keepAsleep wakes none, and reads no workload.
    const calls = h.calls.length;
    h.store.listConfigs = async () => { throw new Error('no workload is read'); };
    assert.deepEqual((await h.pauses.pause(null, { by: 'adm', reason: 'freeze', keepAsleep: true })).woken, []);
    assert.deepEqual((await h.pauses.pause('a', { by: 'ops', reason: 'mine', keepAsleep: true })).woken, []);
    assert.equal(h.calls.length, calls);
  });

  test(named('a router pause\'s wakes go as many at a time as the cloud asks, one by default, and woken keeps the store\'s order'), async () => {
    for (const concurrency of [undefined, 3]) {
      let running = 0;
      let most = 0;
      const h = await harness({
        concurrency,
        // The first ends last: woken still lists it first.
        wake: async (id) => {
          running += 1;
          most = Math.max(most, running);
          for (let i = id === 'w0' ? 20 : 1; i > 0; i -= 1) await new Promise((resolve) => { setImmediate(resolve); });
          running -= 1;
          return true;
        },
      });
      const ids = ['w0', 'w1', 'w2', 'w3', 'w4', 'w5'];
      await h.workloads(ids);
      assert.deepEqual((await h.pauses.pause(null, { by: 'adm', reason: 'freeze' })).woken, ids);
      assert.equal(most, concurrency ?? 1);
    }
  });
}
