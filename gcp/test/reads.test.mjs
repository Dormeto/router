// What a request costs in Firestore reads, through the real store, on a workload with no schedule, no pause and no list. The
// schedule's read per probe and the two lists per check were accepted rather than a "has a schedule" flag to keep in step:
// these counts keep them from growing. A commit is no read; a run's transition reads the run first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATES } from '../../lambda/src/lib/state.mjs';
import { fakeClock, silentLog, testConfig } from '../../lambda/test/fakes.mjs';
import { createFirestoreStore, toFields } from '../src/firestore.mjs';
import { createCloudRunWaker } from '../src/waker.mjs';
import { fakeFirestore } from './firestore-fake.mjs';
import { setup as worldOf, WAKER, ZONE } from './world.mjs';

const CONTROLLER = 'https://dmtr-europe-west1-controller-123.europe-west1.run.app';
const isRead = ({ method, url }) => method === 'GET' || url.endsWith(':batchGet');

function firestoreWith(run) {
  const firestore = fakeFirestore();
  const store = createFirestoreStore({ google: { request: firestore.request }, project: 'p', database: 'dmtr-europe-west1' });
  firestore.docs.set('workloads/demo', { fields: toFields({ config: testConfig() }), updateTime: 't0' });
  firestore.docs.set('runs/demo', { fields: toFields(run), updateTime: 't0' });
  return { firestore, store, reads: () => firestore.calls.filter(isRead).length };
}

function wakerOn(run) {
  const clock = fakeClock();
  const { firestore, store, reads } = firestoreWith(typeof run === 'function' ? run(clock) : run);
  const handler = createCloudRunWaker({ store, tasks: { enqueue: async () => {} }, controllerUrl: CONTROLLER, now: clock.now, log: silentLog });
  return { firestore, handler, reads };
}

const request = ({ method = 'GET', url = '/_dormeto/waiting', headers = {} } = {}) => ({
  method,
  url,
  headers: { 'x-dormeto-workload': 'demo', 'x-forwarded-for': '1.2.3.4, 35.1.1.1', 'user-agent': 'Mozilla/5.0', ...headers },
});
const pageFetch = () => request();
const probe = () => request({ url: '/_dormeto/wake', headers: { accept: '*/*', 'x-dormeto-probe': '1' } });
const post = () => request({ method: 'POST', url: '/_dormeto/wake' });

const ASLEEP = { state: STATES.ASLEEP };
const NAPPING = { state: STATES.NAPPING };
const WAKING = (clock) => ({ state: STATES.WAKING, wakeId: 'w1', wakeStartedAt: clock.now() });
const AWAKE = { state: STATES.AWAKE, awakeSince: 1 };
const BACKED_OFF = (clock) => ({ state: STATES.FAILED, failedAt: clock.now(), consecutiveFailures: 1, failure: JSON.stringify({ kind: 'capacity' }) });

for (const [name, run, send, count] of [
  ['the page\'s fetch, ASLEEP', ASLEEP, pageFetch, 3],
  ['the page\'s fetch, NAPPING', NAPPING, pageFetch, 3],
  ['the page\'s fetch, FAILED', BACKED_OFF, pageFetch, 3],
  ['the page\'s fetch, WAKING', WAKING, pageFetch, 2],
  ['the page\'s fetch, AWAKE', AWAKE, pageFetch, 2],
  ['a probe that wakes', ASLEEP, probe, 4],
  ['a backed-off probe', BACKED_OFF, probe, 3],
  ['a probe, NAPPING', NAPPING, probe, 4],
  ['a probe, WAKING', WAKING, probe, 2],
  ['a probe, AWAKE', AWAKE, probe, 2],
  ['a POST, ASLEEP', ASLEEP, post, 4],
  ['a POST, backed off', BACKED_OFF, post, 3],
  ['a POST, NAPPING', NAPPING, post, 4],
]) {
  test(`Firestore reads: ${name}, ${count}`, async () => {
    const { handler, reads } = wakerOn(run);
    await handler(send());
    assert.equal(reads(), count);
  });
}

const scheduleReads = (firestore) => firestore.calls.filter((c) => c.method === 'GET' && c.url.includes('/schedules/')).length;

test('the schedule is read once per request, not once per waker: the next request reads it again', async () => {
  const { firestore, handler } = wakerOn(BACKED_OFF);
  await handler(probe());
  assert.equal(scheduleReads(firestore), 1);
  await handler(probe());
  assert.equal(scheduleReads(firestore), 2);
});

test('concurrent requests share no read of the schedule', async () => {
  const { firestore, handler } = wakerOn(BACKED_OFF);
  await Promise.all([handler(probe()), handler(probe()), handler(pageFetch())]);
  assert.equal(scheduleReads(firestore), 3);
});

test('a schedule that cannot be read is tried once in a request: the shared core and the page\'s words both count it as none', async () => {
  const clock = fakeClock();
  const { firestore, store } = firestoreWith(BACKED_OFF(clock));
  let tries = 0;
  const warned = [];
  store.getSchedule = async () => {
    tries += 1;
    throw new Error('Google: 503 firestore');
  };
  const handler = createCloudRunWaker({
    store, tasks: { enqueue: async () => {} }, controllerUrl: CONTROLLER, now: clock.now, log: { ...silentLog, warn: (event) => warned.push(event) },
  });
  const res = await handler(probe());
  assert.equal(res.statusCode, 202);
  assert.equal(tries, 1);
  assert.deepEqual(warned, ['ScheduleSkipped', 'ScheduleSkipped']);
  assert.equal(firestore.calls.some((c) => c.url.includes('/schedules/')), false);
});

test('a nap window: the probe reads it once, and says it', async () => {
  const { firestore, handler, reads } = wakerOn(ASLEEP);
  const schedule = { timeZone: 'UTC', windows: [{ kind: 'nap', days: ['tue'], start: '22:00', end: '23:00' }], by: 'ops', at: 1 };
  firestore.docs.set('schedules/demo', { fields: toFields({ schedule }), updateTime: 't0' });
  const res = await handler(probe());
  assert.equal(res.multiValueHeaders['x-dormeto-nap-until']?.[0], '2023-11-14T23:00:00.000Z');
  assert.equal(reads(), 3);
});

// The controller's Cloud Scheduler call: the pauses, the configurations and the schedules listed, then the workload's run.
test('Firestore reads: a check, one AWAKE workload, 4', async () => {
  const clock = fakeClock();
  const { reads, store } = firestoreWith({ state: STATES.AWAKE, version: 0, awakeSince: clock.now(), holders: 0, wakeCount: 0 });
  await store.putConfig('demo', {
    workloadId: 'demo', urlMap: 'lb', backendService: 'app', wakerBackendService: WAKER, backends: [{ kind: 'vm', location: ZONE, name: 'vm-a' }], idleMinutes: 15, wakeTimeoutSeconds: 600, failedRetrySeconds: 60, pollSeconds: 3,
  });
  const { core } = worldOf((w) => { w.store = store; });
  const out = await core.check();
  assert.deepEqual(out.map((r) => [r.workloadId, r.state]), [['demo', STATES.AWAKE]]);
  assert.equal(reads(), 4);
});
