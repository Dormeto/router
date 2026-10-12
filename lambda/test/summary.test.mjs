import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workloadSummary } from '../src/lib/summary.mjs';
import { testConfig } from './fakes.mjs';

test('a workload summary gives the last failure and the consecutive failures (R7a), none after a successful wake', () => {
  const failure = { kind: 'capacity', step: 'wake', backend: 'rds:db', message: 'no capacity', at: Date.UTC(2026, 9, 8, 12) };
  const failed = workloadSummary(testConfig(), { state: 'FAILED', failure: JSON.stringify(failure), consecutiveFailures: 2, failedAt: failure.at });
  assert.deepEqual(failed.failure, { ...failure, at: '2026-10-08T12:00:00.000Z' });
  assert.equal(failed.consecutiveFailures, 2);
  const awake = workloadSummary(testConfig(), { state: 'AWAKE' });
  assert.equal(awake.failure, null);
  assert.equal(awake.consecutiveFailures, 0);
  assert.equal(workloadSummary(testConfig(), { state: 'FAILED', failure: 'not json' }).failure, null, 'an unreadable record is no failure');
});

test('a failed workload\'s summary gives its next attempt (R7a)', () => {
  const at = Date.UTC(2026, 9, 8, 12);
  const summary = workloadSummary(testConfig({ failedRetrySeconds: 60 }), { state: 'FAILED', failedAt: at, consecutiveFailures: 3 });
  assert.equal(summary.nextAttemptAt, new Date(at + 240_000).toISOString());
  assert.equal(workloadSummary(testConfig(), { state: 'ASLEEP' }).nextAttemptAt, null);
});
