import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventOf } from '../src/rows.mjs';

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
