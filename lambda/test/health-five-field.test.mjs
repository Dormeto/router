import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkLate } from '../src/lib/health.mjs';

const NOW = Date.parse('2026-11-09T12:00:00Z');

test('checkLate: the five-field cron of Cloud Scheduler, */N in the minutes, is N minutes', () => {
  assert.equal(checkLate('*/5 * * * *', NOW - 14 * 60_000, NOW), false);
  assert.equal(checkLate('*/5 * * * *', NOW - 16 * 60_000, NOW), true);
  assert.equal(checkLate('*/15 * * * *', NOW - 40 * 60_000, NOW), false);
  assert.equal(checkLate('*/15 * * * *', NOW - 50 * 60_000, NOW), true);
  assert.equal(checkLate('*/5 * * * *', null, NOW), true);
});
