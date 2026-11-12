// Both routers' schedules as the check applies them (lib/check-schedules.mjs): the join, what keeps a workload from its idle nap, a
// pass over many workloads, then the contract on the DynamoDB store's fake (gcp/test/check-schedules-shared.test.mjs runs it on the
// Firestore store).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScheduleCheck, joinOf, scheduleKeeps } from '../src/lib/check-schedules.mjs';
import { pauseHolds } from '../src/lib/pauses.mjs';
import { matches, STATES } from '../src/lib/state.mjs';
import { checkSchedulesContract } from './check-schedules-contract.mjs';
import { fakeStore, testConfig } from './fakes.mjs';

const at = (time, day = 19) => Date.parse(`2026-10-${day}T${time}:00Z`);
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];
const OFFICE = { kind: 'awake', days: WEEKDAYS, start: '08:00', end: '18:00' };
const ENDED = { kind: 'awake', days: ['sat'], start: '10:00', end: '11:00', until: '2025-09-27' };
const MORNING = { kind: 'awake', days: ['mon'], start: '08:00', end: '12:00' };
const AFTERNOON = { kind: 'awake', days: ['mon'], start: '13:00', end: '18:00' };
const stored = (fields) => ({ timeZone: 'UTC', ...fields, by: 'ops@example.com', at: at('09:00', 12) });

test('a schedule\'s windows join as far as its own joinMinutes says, else the router\'s, else the organization\'s, else 15', () => {
  assert.deepEqual(joinOf({ joinMinutes: 0 }, { router: 60, manager: 30 }), { joinMinutes: 0 });
  assert.deepEqual(joinOf({}, { router: 60, manager: 30 }), { joinMinutes: 60 });
  assert.deepEqual(joinOf(null, { router: null, manager: 30 }), { joinMinutes: 30 });
  assert.deepEqual(joinOf(undefined, {}), { joinMinutes: 15 });
});

test('what keeps a workload from its idle nap: the nap the schedules decided, an awake window active or starting within 30 minutes', () => {
  const ctx = (schedule, applied = null, joins = {}) => ({ schedules: new Map([['demo', schedule]]), applied: new Map(applied ? [['demo', applied]] : []), joins });
  const office = stored({ windows: [OFFICE] });
  assert.equal(scheduleKeeps('demo', null, at('12:00')), null, 'no check context');
  assert.equal(scheduleKeeps('other', ctx(office), at('12:00')), null, 'no schedule');
  // Asked, put off or refused: not asked twice, nor ahead of a cloud's caps.
  for (const outcome of ['nap', 'nap deferred', 'nap refused']) assert.deepEqual(scheduleKeeps('demo', ctx(office, outcome), at('19:00')), {}, outcome);
  assert.deepEqual(scheduleKeeps('demo', ctx(office, 'wake'), at('12:00')), { kept: 'awake window' });
  assert.deepEqual(scheduleKeeps('demo', ctx(office), at('07:35')), { kept: 'awake window within 30 minutes' });
  assert.equal(scheduleKeeps('demo', ctx(office), at('07:25')), null);
  assert.equal(scheduleKeeps('demo', ctx(office), at('18:00')), null);
  // The levels' join: a gap of 60 joined keeps it, not joined it does not (13:00 is 55 minutes away).
  const gap = stored({ windows: [MORNING, AFTERNOON] });
  assert.deepEqual(scheduleKeeps('demo', ctx(gap, null, { router: 60 }), at('12:05')), { kept: 'awake window' });
  assert.equal(scheduleKeeps('demo', ctx(gap), at('12:05')), null);
  // One the runtime refuses throws: each cloud says it its own way.
  assert.throws(() => scheduleKeeps('demo', ctx(stored({ timeZone: 'Mars/Olympus', windows: [OFFICE] })), at('12:00')), RangeError);
});

// Workloads by id, each its run, in one store as both stores keep them (the shared condition).
function memoryStore(runs) {
  const store = {
    runs: new Map(Object.entries(runs)),
    async getRun(id) { return structuredClone(store.runs.get(id) ?? null); },
    async transition(id, { cond, set = {} }) {
      const run = store.runs.get(id);
      if (!run || !matches(run, cond)) return null;
      Object.assign(run, set);
      return structuredClone(run);
    },
    async replaceSchedule() { return true; },
  };
  return store;
}

function pass(store, { concurrency, events = [] } = {}) {
  const logs = [];
  const keep = (event, data) => { logs.push([event, data]); events.push(event); };
  const check = createScheduleCheck({
    store,
    wake: async (workloadId, run, kind) => Boolean(await store.transition(workloadId, { cond: { state: run.state }, set: { state: STATES.WAKING } })),
    pendingWake: async () => true,
    concurrency,
    log: { info: keep, warn: keep, error: keep },
  });
  return { check, logs, logged: (event) => logs.filter(([e]) => e === event).map(([, d]) => d) };
}

test('a pass applies the schedules a given number of workloads at a time (8 by default), every one in the end', async () => {
  for (const [concurrency, most] of [[3, 3], [undefined, 8]]) {
    const ids = Array.from({ length: 20 }, (_, i) => `w${String(i).padStart(2, '0')}`);
    const store = memoryStore(Object.fromEntries(ids.map((id) => [id, { state: STATES.ASLEEP }])));
    let reading = 0;
    let highest = 0;
    const { getRun } = store;
    store.getRun = async (id) => {
      reading += 1;
      highest = Math.max(highest, reading);
      await new Promise((resolve) => setImmediate(resolve));
      reading -= 1;
      return getRun(id);
    };
    const { check } = pass(store, { concurrency });
    const { applied } = await check.applySchedules(ids.map((workloadId) => ({ workloadId })), new Map(ids.map((id) => [id, stored({ windows: [OFFICE] })])), pauseHolds([]), at('08:00'), { joins: {}, nap: { ask: async () => true } });
    assert.equal(highest, most);
    assert.deepEqual([...applied.keys()].sort(), ids);
    assert.equal([...store.runs.values()].every((run) => run.state === STATES.WAKING), true);
  }
});

test('a pass leaves out a schedule it cannot read and a workload whose pass fails, and goes on with the others', async () => {
  const store = memoryStore({ bad: { state: STATES.ASLEEP }, broken: { state: STATES.ASLEEP }, good: { state: STATES.ASLEEP } });
  const { getRun } = store;
  store.getRun = async (id) => {
    if (id === 'broken') throw new Error('throttled');
    return getRun(id);
  };
  const { check, logged } = pass(store);
  const schedules = new Map([['bad', stored({ timeZone: 'Mars/Olympus', windows: [OFFICE] })], ['broken', stored({ windows: [OFFICE] })], ['good', stored({ windows: [OFFICE] })]]);
  const { applied, readable } = await check.applySchedules([{ workloadId: 'bad' }, { workloadId: 'broken' }, { workloadId: 'good' }, { workloadId: 'none' }], schedules, pauseHolds([]), at('08:00'), { joins: {}, nap: { ask: async () => true } });
  assert.deepEqual([...applied], [['good', 'wake']]);
  assert.deepEqual([...readable.keys()], ['broken', 'good']);
  assert.deepEqual(logged('ScheduleSkipped').map((d) => d.workloadId), ['bad']);
  assert.deepEqual(logged('ScheduleFailed'), [{ workloadId: 'broken', error: 'throttled' }]);
});

test('the nap a cloud asks after every workload\'s comes once, after the last ask, before the ended windows leave', async () => {
  const NAP = { kind: 'nap', days: WEEKDAYS, start: '07:00', end: '07:45' };
  const store = memoryStore({ a: { state: STATES.AWAKE }, b: { state: STATES.AWAKE } });
  const events = [];
  store.replaceSchedule = async () => { events.push('replaceSchedule'); return true; };
  const { check } = pass(store, { events });
  const nap = {
    ask: ({ workloadId }) => { events.push(`ask ${workloadId}`); return false; },
    end: (applied, t) => { events.push(`end ${applied.size} ${t}`); },
  };
  const schedules = new Map([['a', stored({ windows: [NAP] })], ['b', stored({ windows: [NAP] })], ['c', stored({ windows: [OFFICE, ENDED] })]]);
  await check.applySchedules(['a', 'b', 'c'].map((workloadId) => ({ workloadId })), schedules, pauseHolds([]), at('07:30'), { joins: {}, endedDays: 365, nap });
  assert.deepEqual(events.filter((e) => !e.startsWith('Ended')), ['ask a', 'ask b', `end 0 ${at('07:30')}`, 'replaceSchedule']);
});

checkSchedulesContract('the DynamoDB store', ({ run, schedule, now }) => {
  const store = fakeStore({ config: testConfig(), run, clock: { now } });
  if (schedule) store.state.schedules.demo = structuredClone(schedule);
  return store;
});
