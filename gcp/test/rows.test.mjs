import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventOf, rowOf } from '../src/rows.mjs';

const router = { name: 'dmtr-europe-west1', region: 'europe-west1', project: 'p' };
const AT = Date.parse('2026-03-10T12:00:00Z');

test('eventOf: the AWS detail of a wake that finished, with the cause, the tags and the instant as ISO', () => {
  assert.deepEqual(eventOf({
    workloadId: 'app', from: 'WAKING', to: 'AWAKE', stateAt: AT, cause: 'visitor', event: { wakeId: 'w1', durationMs: 4200 }, router, tags: { team: 'a' },
  }), {
    workloadId: 'app', from: 'WAKING', to: 'AWAKE', router: 'dmtr-europe-west1', region: 'europe-west1', project: 'p', at: '2026-03-10T12:00:00.000Z',
    cause: 'visitor', wakeId: 'w1', durationMs: 4200, tags: { team: 'a' },
  });
});

test('eventOf: a failure stored in ms comes out ISO; the items a nap stopped and the run\'s fields stay out; the suspended VMs are hibernated', () => {
  const event = eventOf({
    workloadId: 'app', from: 'NAPPING', to: 'ASLEEP', stateAt: AT, router,
    event: { stopped: ['a'], suspended: ['b'], autoscalers: [{}], failure: { kind: 'quota', step: 'nap', message: 'm', at: AT }, by: 'ada' },
  });
  assert.deepEqual(event.failure, { kind: 'quota', step: 'nap', message: 'm', at: '2026-03-10T12:00:00.000Z' });
  assert.deepEqual([event.hibernated, event.by, event.stopped, event.autoscalers, event.tags], [['b'], 'ada', undefined, undefined, {}]);
  assert.equal('hibernated' in eventOf({ workloadId: 'a', from: 'NAPPING', to: 'ASLEEP', stateAt: AT, router, event: { suspended: [] } }), false);
});

// --- rowOf: the AWS row ------------------------------------------------------------------------------------------------

const cfg = {
  workloadId: 'app', name: 'The app', tags: { team: 'a' }, source: 'manager', urlMap: 'lb', backendService: 'app', wakerBackendService: 'dmtr-europe-west1-app',
  hosts: ['app.example.com', 'b.example.com'], backends: [{ kind: 'vm', location: 'z', name: 'vm-a', id: '1' }, { kind: 'vm', location: 'z', name: 'vm-b', id: '2' }, { kind: 'cloudsql', name: 'db' }],
};
const day = (n) => ({ wakes: { visitor: n }, ignored: { bot: 2 * n }, deferred: { early: 3 * n } });
const stats = { days: 7, total: { wakes: { visitor: 7, api: 1 }, ignored: { bot: 14 }, deferred: { early: 21 } }, today: day(1) };

test('rowOf: a workload asleep with a suspended VM is the AWS row, hibernated, with its Google resources instead of a target group', () => {
  const row = rowOf({
    cfg, run: { state: 'ASLEEP', stateAt: AT, wakeCount: 3, suspended: ['vm-a'], updatedAt: AT }, stats7d: stats, routerName: 'dmtr-europe-west1', now: AT + 1000,
  });
  assert.equal(row.hibernated, true);
  assert.deepEqual([row.workloadId, row.name, row.source, row.tags, row.state, row.wakeCount], ['app', 'The app', 'manager', { team: 'a' }, 'ASLEEP', 3]);
  assert.equal(row.stateAt, '2026-03-10T12:00:00.000Z');
  assert.equal(row.url, 'https://app.example.com/');
  assert.deepEqual([row.backendService, row.wakerBackendService, row.urlMap, row.lb], ['app', 'dmtr-europe-west1-app', 'lb', { kind: 'global' }]);
  assert.equal('targetGroupArn' in row, false);
  assert.deepEqual(row.backends, ['vm', 'cloudsql']);
  assert.deepEqual(row.stats7d, { wakes: 8, ignored: 14, deferred: 21 });
  assert.deepEqual(row.pauses, []);
  assert.equal(row.settings.idleMinutes, 15);
});

test('rowOf: awake, or asleep with nothing suspended, is not hibernated; no stats read is null; the name defaults to the id', () => {
  const { name, ...unnamed } = cfg;
  const awake = rowOf({ cfg: unnamed, run: { state: 'AWAKE', stateAt: AT, suspended: ['vm-a'] }, stats7d: null, routerName: 'r', now: AT });
  assert.equal('hibernated' in awake, false);
  assert.deepEqual([awake.stats7d, awake.name], [null, 'app']);
  assert.equal('hibernated' in rowOf({ cfg, run: { state: 'ASLEEP', stateAt: AT }, stats7d: stats, routerName: 'r', now: AT }), false);
});

test('rowOf: the last failure with its time as ISO, the retry time, the fallbacks and the regional load balancer', () => {
  const failure = JSON.stringify({ kind: 'quota', step: 'wake', message: 'm', at: AT });
  const row = rowOf({
    cfg: { ...cfg, lb: { kind: 'regional', region: 'europe-west1' } },
    run: { state: 'FAILED', stateAt: AT, failure, failedAt: AT, consecutiveFailures: 1, instanceTypes: { 'vm-a': { from: 'n2', to: 'e2' } }, wakeStartedAt: AT - 5 },
    stats7d: stats, routerName: 'r', now: AT,
  });
  assert.deepEqual(row.failure, { kind: 'quota', step: 'wake', message: 'm', at: '2026-03-10T12:00:00.000Z' });
  assert.equal(row.failedAt, '2026-03-10T12:00:00.000Z');
  assert.ok(row.nextAttemptAt > row.failedAt);
  assert.deepEqual(row.fallbacks, [{ instance: 'vm-a', from: 'n2', to: 'e2' }]);
  assert.deepEqual(row.lb, { kind: 'regional', region: 'europe-west1' });
});
