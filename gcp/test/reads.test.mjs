// What a request costs in Firestore reads, through the real store, on a workload with no schedule, no pause and no list. The
// schedule's read per request and the two lists per check were accepted rather than a "has a schedule" flag to keep in step:
// these counts keep them from growing. The router level (`router/settings`) is read at most once a minute per waker instance (the
// shared core's 60-second cache, which the configuration's fixed values read too): each count below is a new instance's first
// request, so it holds that read; the next requests of the minute don't. So are the waiting page's levels and the favicon (the router's
// page, the workload's, and its favicon while its icon is auto: waiting-pages.mjs's cache), read for a page only, never for a probe.
// A commit is no read; a run's transition reads the run first.
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
// No beat 90 s after its start: the resend's conditional write reads the run once more; once sent, the next minute's probes do not.
const STALE = (clock) => ({ state: STATES.WAKING, wakeId: 'w1', wakeStartedAt: clock.now() - 91_000 });
const RESENT = (clock) => ({ ...STALE(clock), resentAt: clock.now() - 30_000 });
const AWAKE = { state: STATES.AWAKE, awakeSince: 1 };
const BACKED_OFF = (clock) => ({ state: STATES.FAILED, failedAt: clock.now(), consecutiveFailures: 1, failure: JSON.stringify({ kind: 'capacity' }) });

for (const [name, run, send, count] of [
  ['the page\'s fetch, ASLEEP', ASLEEP, pageFetch, 7],
  ['the page\'s fetch, NAPPING', NAPPING, pageFetch, 7],
  ['the page\'s fetch, FAILED', BACKED_OFF, pageFetch, 7],
  ['the page\'s fetch, WAKING', WAKING, pageFetch, 6],
  ['the page\'s fetch, AWAKE', AWAKE, pageFetch, 6],
  ['a probe that wakes', ASLEEP, probe, 5],
  ['a backed-off probe', BACKED_OFF, probe, 4],
  ['a probe, NAPPING', NAPPING, probe, 5],
  ['a probe, WAKING', WAKING, probe, 3],
  ['a probe, WAKING with no beat', STALE, probe, 4],
  ['a probe, WAKING with no beat, sent again within the minute', RESENT, probe, 3],
  ['a probe, AWAKE', AWAKE, probe, 3],
  ['a POST, ASLEEP', ASLEEP, post, 5],
  ['a POST, backed off', BACKED_OFF, post, 4],
  ['a POST, NAPPING', NAPPING, post, 5],
]) {
  test(`Firestore reads: ${name}, ${count}`, async () => {
    const { handler, reads } = wakerOn(run);
    await handler(send());
    assert.equal(reads(), count);
  });
}

const routerReads = (firestore) => firestore.calls.filter((c) => c.method === 'GET' && c.url.endsWith('/router/settings')).length;

test('the router level is read once a minute per instance, whatever the requests: the page\'s fetches, the probes and the POSTs', async () => {
  const clock = fakeClock();
  const { firestore, store } = firestoreWith(ASLEEP);
  firestore.docs.set('router/settings', { fields: toFields({ defaults: { idleMinutes: 30 }, by: 'ops', at: 1 }), updateTime: 't0' });
  const handler = createCloudRunWaker({ store, tasks: { enqueue: async () => {} }, controllerUrl: CONTROLLER, now: clock.now, log: silentLog });
  await Promise.all([handler(pageFetch()), handler(probe()), handler(pageFetch())]);
  assert.equal(routerReads(firestore), 1);
  clock.advance(59_000);
  await handler(post());
  await handler(pageFetch());
  assert.equal(routerReads(firestore), 1);
  clock.advance(2_000);
  await handler(probe());
  assert.equal(routerReads(firestore), 2);
});

const pageReads = (firestore) => firestore.calls.filter((c) => c.method === 'GET' && /\/(router\/page|pages\/demo|favicons\/demo)$/.test(c.url)).length;

test('the waiting page\'s levels and favicon are read once a minute per instance, for a page only', async () => {
  const clock = fakeClock();
  const { firestore, store } = firestoreWith(ASLEEP);
  const handler = createCloudRunWaker({ store, tasks: { enqueue: async () => {} }, controllerUrl: CONTROLLER, now: clock.now, log: silentLog });
  await handler(probe());
  assert.equal(pageReads(firestore), 0);
  await handler(pageFetch());
  await handler(pageFetch());
  assert.equal(pageReads(firestore), 3);
  clock.advance(61_000);
  await handler(pageFetch());
  assert.equal(pageReads(firestore), 6);
});

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
  assert.equal(reads(), 4);
});

// The controller's Cloud Scheduler call: the pauses, the configurations and the schedules listed, the router level (router/settings),
// once for every workload, then the workload's run.
test('Firestore reads: a check, one AWAKE workload, 5; the first of the day 3 more, the router\'s sweep claimed, the counters and the events listed', async () => {
  const clock = fakeClock();
  const { reads, store } = firestoreWith({ state: STATES.AWAKE, version: 0, awakeSince: clock.now(), holders: 0, wakeCount: 0 });
  await store.putConfig('demo', {
    workloadId: 'demo', urlMap: 'lb', backendService: 'app', wakerBackendService: WAKER, backends: [{ kind: 'vm', location: ZONE, name: 'vm-a' }], idleMinutes: 15, wakeTimeoutSeconds: 600, failedRetrySeconds: 60, pollSeconds: 3,
  });
  const { core } = worldOf((w) => {
    w.store = store;
    w.services[WAKER] = { name: WAKER, backends: [] };
  });
  const out = await core.check();
  assert.deepEqual(out.map((r) => [r.workloadId, r.state]), [['demo', STATES.AWAKE]]);
  assert.equal(reads(), 8);
  await core.check();
  assert.equal(reads(), 13);
});

// Past 20 workloads, the naps in flight can pass their cap (F8): each run is read once more as the check starts, for the NAPPING ones.
test('Firestore reads: a check of 21 AWAKE workloads reads each run twice, the lists and the router level once, 46; of 20, each run once, 24', async () => {
  const clock = fakeClock();
  const awake = { state: STATES.AWAKE, version: 0, awakeSince: clock.now(), holders: 0, wakeCount: 0 };
  const { firestore, reads, store } = firestoreWith(awake);
  firestore.docs.delete('workloads/demo');
  firestore.docs.delete('runs/demo');
  for (const id of Array.from({ length: 21 }, (_, i) => `w${String(i).padStart(2, '0')}`)) {
    await store.putConfig(id, {
      workloadId: id, urlMap: 'lb', backendService: 'app', wakerBackendService: WAKER, backends: [{ kind: 'vm', location: ZONE, name: 'vm-a' }], idleMinutes: 15, wakeTimeoutSeconds: 600, failedRetrySeconds: 60, pollSeconds: 3,
    });
    firestore.docs.set(`runs/${id}`, { fields: toFields(awake), updateTime: 't0' });
  }
  const { core } = worldOf((w) => {
    w.store = store;
    w.services[WAKER] = { name: WAKER, backends: [] };
  });
  await core.check();
  let before = reads();
  await core.check();
  assert.equal(reads() - before, 4 + 2 * 21);
  firestore.docs.delete('workloads/w20');
  before = reads();
  await core.check();
  assert.equal(reads() - before, 4 + 20);
});
