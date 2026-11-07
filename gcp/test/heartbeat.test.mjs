import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATES } from '../../lambda/src/lib/state.mjs';
import { beatOf, beats, resendable, staleness } from '../src/heartbeat.mjs';

const T = 1_700_000_000_000;
const MINUTE = 60_000;
const waking = (more = {}) => ({ state: STATES.WAKING, wakeId: 'w1', wakeStartedAt: T - 10 * MINUTE, ...more });
const napping = (more = {}) => ({ state: STATES.NAPPING, napId: 'n1', stateAt: T - 10 * MINUTE, ...more });
const stale = (run) => staleness(run, T) !== null;

test('stale: a beat older than 3 minutes, or none 90 s after the request; a beat of 3 minutes, a request of 90 s are not', () => {
  for (const run of [waking, napping]) {
    assert.equal(stale(run({ beatAt: T - 30_000 })), false);
    assert.equal(stale(run({ beatAt: T - 3 * MINUTE })), false);
    assert.equal(stale(run({ beatAt: T - 3 * MINUTE - 1 })), true);
  }
  assert.equal(stale(waking({ wakeStartedAt: T - 90_000 })), false);
  assert.equal(stale(waking({ wakeStartedAt: T - 90_001 })), true);
  assert.equal(stale(napping({ stateAt: T - 90_000 })), false);
  assert.equal(stale(napping({ stateAt: T - 90_001 })), true);
});

test('staleness says why, in words', () => {
  assert.equal(staleness(waking({ beatAt: T - 4 * MINUTE }), T), 'no heartbeat for more than 3 minutes');
  assert.equal(staleness(napping(), T), 'no heartbeat 90 s after it started');
  assert.equal(staleness(waking({ beatAt: T }), T), null);
});

test('a beat from before the request is an earlier wake\'s or nap\'s: none for this one', () => {
  assert.equal(beatOf(waking({ beatAt: T - 11 * MINUTE })), undefined);
  assert.equal(beatOf(waking({ beatAt: T - 10 * MINUTE })), T - 10 * MINUTE);
  assert.equal(stale(waking({ wakeStartedAt: T - 30_000, beatAt: T - 11 * MINUTE })), false);
  assert.equal(stale(waking({ wakeStartedAt: T - 2 * MINUTE, beatAt: T - 11 * MINUTE })), true);
  assert.equal(beatOf(napping({ beatAt: T - 11 * MINUTE })), undefined);
});

test('a NAPPING run that no store dated: its last update is its start', () => {
  const run = { state: STATES.NAPPING, napId: 'n1', updatedAt: T - 2 * MINUTE };
  assert.equal(stale(run), true);
  assert.equal(stale({ ...run, beatAt: T - 2 * MINUTE }), false);
});

test('never stale: a nap from before the heartbeat (no napId), and the states that run nothing', () => {
  assert.equal(stale({ state: STATES.NAPPING, stateAt: T - 30 * MINUTE }), false);
  assert.equal(beatOf({ state: STATES.NAPPING, stateAt: T - 30 * MINUTE, beatAt: T }), undefined);
  for (const state of [STATES.AWAKE, STATES.ASLEEP, STATES.FAILED]) {
    assert.equal(stale({ state, wakeId: 'w1', napId: 'n1', wakeStartedAt: 0, stateAt: 0, beatAt: 0 }), false, state);
    assert.equal(beatOf({ state, wakeId: 'w1', wakeStartedAt: 0, beatAt: 0 }), undefined, state);
  }
});

test('beats: a wake\'s id while WAKING, a nap\'s while NAPPING; another id, field or state: no', () => {
  assert.equal(beats(waking(), 'wakeId', 'w1'), true);
  assert.equal(beats(waking(), 'wakeId', 'w2'), false);
  assert.equal(beats(waking({ napId: 'w1' }), 'napId', 'w1'), false);
  assert.equal(beats(napping(), 'napId', 'n1'), true);
  assert.equal(beats(napping(), 'napId', 'n2'), false);
  assert.equal(beats({ ...waking(), state: STATES.AWAKE }, 'wakeId', 'w1'), false);
  assert.equal(beats({ ...napping(), state: STATES.ASLEEP }, 'napId', 'n1'), false);
});

test('resendable: WAKING with that wakeId, and no resend in the last minute', () => {
  assert.equal(resendable(waking(), 'w1', T), true);
  assert.equal(resendable(waking(), 'w2', T), false);
  assert.equal(resendable({ ...waking(), state: STATES.AWAKE }, 'w1', T), false);
  assert.equal(resendable(waking({ resentAt: T - 30_000 }), 'w1', T), false);
  assert.equal(resendable(waking({ resentAt: T - MINUTE }), 'w1', T), false);
  assert.equal(resendable(waking({ resentAt: T - MINUTE - 1 }), 'w1', T), true);
});
