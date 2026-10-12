import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPublisher, withTransitionEvents } from '../src/lib/events.mjs';

const BUS = 'arn:aws:events:eu-west-1:121014831971:event-bus/dmt-dev-manager';
const ROUTER = { name: 'dmtr-dev', region: 'eu-west-3', version: '0.21.0', build: 'abc', checkSchedule: 'rate(5 minutes)' };

function fakeEvents({ fail = null } = {}) {
  const calls = [];
  return {
    calls,
    async putEvents(input, options) {
      calls.push({ input, options });
      if (fail === 'throw') throw new Error('Throttling');
      if (fail === 'entries') return { FailedEntryCount: 1, Entries: [{ ErrorCode: 'InternalFailure' }] };
      return { FailedEntryCount: 0 };
    },
  };
}
const logs = () => {
  const lines = [];
  return { lines, info: (e, d) => lines.push(['info', e, d]), warn: (e, d) => lines.push(['warn', e, d]), error: (e, d) => lines.push(['error', e, d]) };
};
const bytes = (value) => Buffer.byteLength(value);

test('without a bus, nothing is published', async () => {
  const events = fakeEvents();
  const publisher = createPublisher({ events, busArn: '', router: ROUTER, log: logs() });
  await publisher.checked({ checkedAt: 'x', workloads: [{ workloadId: 'a' }] });
  await publisher.stateChanged({ workloadId: 'a', from: 'AWAKE', to: 'NAPPING', at: 'x' });
  assert.equal(events.calls.length, 0);
  assert.equal(publisher.enabled, false);
});

test('a checked router is sent in entries under 64 KB, calls under 256 KB and 10 entries, to the bus in its region', async () => {
  const events = fakeEvents();
  const publisher = createPublisher({ events, busArn: BUS, router: ROUTER, log: logs() });
  // 300 workloads of about 1.5 KB: several entries, several calls.
  const workloads = Array.from({ length: 300 }, (_, i) => ({ workloadId: `w${i}`, name: 'x'.repeat(1400), state: 'AWAKE' }));
  await publisher.checked({ checkedAt: '2026-10-05T12:00:00.000Z', durationMs: 2500, health: { status: 'ok' }, pauses: [], counts: { AWAKE: 300 }, workloads });
  assert.ok(events.calls.length >= 2);
  const entries = events.calls.flatMap((c) => c.input.Entries);
  for (const call of events.calls) {
    assert.equal(call.options.region, 'eu-west-1');
    assert.ok(call.input.Entries.length <= 10);
    assert.ok(call.input.Entries.reduce((n, e) => n + bytes(e.Detail) + bytes(e.DetailType) + bytes(e.Source), 0) <= 256 * 1024);
  }
  for (const e of entries) {
    assert.deepEqual([e.EventBusName, e.Source, e.DetailType], [BUS, 'dormeto.router', 'Router checked']);
    assert.ok(bytes(e.Detail) <= 64 * 1024, `entry of ${bytes(e.Detail)} bytes`);
  }
  const details = entries.map((e) => JSON.parse(e.Detail));
  assert.deepEqual(details.map((d) => d.chunk), details.map((_, i) => ({ index: i, total: details.length })));
  assert.deepEqual(details.flatMap((d) => d.workloads.map((w) => w.workloadId)), workloads.map((w) => w.workloadId));
  for (const d of details) assert.deepEqual([d.router, d.checkedAt, d.counts], [ROUTER, '2026-10-05T12:00:00.000Z', { AWAKE: 300 }]);
});

test('a router without workloads still sends one checked entry', async () => {
  const events = fakeEvents();
  await createPublisher({ events, busArn: BUS, router: ROUTER, log: logs() }).checked({ checkedAt: 'x', counts: {}, workloads: [] });
  assert.deepEqual(JSON.parse(events.calls[0].input.Entries[0].Detail).chunk, { index: 0, total: 1 });
});

test('a state change is one entry; a failed publish is logged, never thrown', async () => {
  for (const fail of [null, 'throw', 'entries']) {
    const events = fakeEvents({ fail });
    const log = logs();
    await createPublisher({ events, busArn: BUS, router: ROUTER, log }).stateChanged({ workloadId: 'a', from: 'ASLEEP', to: 'WAKING', at: '2026-10-05T12:00:00.000Z', wakeId: 'w1' });
    const [entry] = events.calls[0].input.Entries;
    assert.equal(entry.DetailType, 'Workload state changed');
    // The router's region travels in the event: the envelope carries the bus's region.
    assert.deepEqual(JSON.parse(entry.Detail), { router: 'dmtr-dev', region: 'eu-west-3', workloadId: 'a', from: 'ASLEEP', to: 'WAKING', at: '2026-10-05T12:00:00.000Z', wakeId: 'w1' });
    assert.equal(log.lines.some(([level, event]) => level === 'warn' && event === 'PublishFailed'), fail !== null, String(fail));
  }
});

test('every successful state transition is published once; a failed transition or a failed publish changes nothing', async () => {
  const published = [];
  let next = { state: 'WAKING', wakeId: 'w1', version: 3 };
  const store = { transition: async () => next, getRun: async () => null };
  const wrapped = withTransitionEvents(store, { stateChanged: async (c) => { published.push(c); } }, { now: () => Date.UTC(2026, 9, 5, 12) });
  assert.deepEqual(await wrapped.transition('a', { cond: { state: 'ASLEEP' }, set: { state: 'WAKING', wakeId: 'w1' } }), next);
  assert.deepEqual(published, [{ workloadId: 'a', from: 'ASLEEP', to: 'WAKING', at: '2026-10-05T12:00:00.000Z', wakeId: 'w1' }]);
  await wrapped.transition('a', { cond: { state: 'WAKING' }, set: { holders: 2 } });
  next = null;
  await wrapped.transition('a', { cond: { state: 'ASLEEP' }, set: { state: 'WAKING' } });
  assert.equal(published.length, 1, 'no state change, or the condition failed: nothing published');
  next = { state: 'ASLEEP' };
  const failing = withTransitionEvents(store, { stateChanged: async () => { throw new Error('boom'); } }, { now: () => 0 });
  assert.deepEqual(await failing.transition('a', { cond: { state: 'NAPPING' }, set: { state: 'ASLEEP' } }), { state: 'ASLEEP' });
  assert.equal(wrapped.getRun, store.getRun, 'the other methods are the store\'s');
});
