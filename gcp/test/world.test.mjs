// The fake of Compute Engine (world.mjs): what Google refuses and what Google reads, so that a test passing on it says something.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATES } from '../../lambda/src/lib/state.mjs';
import { INPUT, REGION, V1, WAKER, ZONE, classic, regional, regionalUrl, serviceUrl, setup, unmanagedUrl } from './world.mjs';

const GROUP = unmanagedUrl('ig');
const SCOPES = [
  ['global', () => {}, (w) => w.urlMaps, serviceUrl, regionalUrl, (t) => t.urlmaps],
  ['regional', regional, (w) => w.regions[REGION].urlMaps, regionalUrl, serviceUrl, (t) => t.regionalUrlmaps],
];

for (const [scope, world, mapsOf, ownUrl, otherUrl, adapterOf] of SCOPES) {
  const named = (url) => (map) => ({ map: { ...map, defaultService: url }, paths: ['defaultService'] });

  test(`the fake, ${scope} URL map: each write changes the fingerprint`, async () => {
    const t = setup(world);
    await adapterOf(t).modify('lb', named(ownUrl('other')));
    const first = mapsOf(t.w).lb.fingerprint;
    assert.notEqual(first, 'f1');
    await adapterOf(t).modify('lb', named(ownUrl('app')));
    assert.notEqual(mapsOf(t.w).lb.fingerprint, first);
  });

  test(`the fake, ${scope} URL map: a write on a stale fingerprint is a 412, and the adapter reads the map again`, async () => {
    const t = setup(world);
    const stale = structuredClone(mapsOf(t.w).lb);
    await adapterOf(t).modify('lb', named(ownUrl('other')));
    await assert.rejects(t.google.request('PUT', `${V1}/${scope === 'global' ? 'global' : `regions/${REGION}`}/urlMaps/lb`, stale), (err) => err.code === 412);

    const path = `PUT ${scope === 'global' ? 'global' : `regions/${REGION}`}/urlMaps/lb`;
    let raced = false;
    t.w.on[path] = () => {
      if (!raced) mapsOf(t.w).lb = { ...mapsOf(t.w).lb, fingerprint: 'another-write' };
      raced = true;
    };
    const before = t.w.changes.length;
    await adapterOf(t).modify('lb', named(ownUrl('app')));
    assert.equal(t.w.changes.length, before + 1);
    assert.equal(mapsOf(t.w).lb.defaultService, ownUrl('app'));
  });

  test(`the fake, ${scope} URL map: a backend service that is not there, or of another scope, is a 400, wherever the map names it`, async () => {
    const t = setup(world);
    const refusedWith = async (change) => assert.rejects(adapterOf(t).modify('lb', (map) => ({ map: change(structuredClone(map)), paths: ['x'] })), (err) => err.code === 400);
    await refusedWith((map) => ({ ...map, defaultService: ownUrl('gone') }));
    await refusedWith((map) => ({ ...map, defaultService: otherUrl('other') }));
    await refusedWith((map) => {
      map.pathMatchers[0].pathRules = [{ paths: ['/a'], service: ownUrl('gone') }];
      return map;
    });
    await refusedWith((map) => {
      map.pathMatchers[0].routeRules = [{ priority: 1, routeAction: { weightedBackendServices: [{ backendService: ownUrl('gone'), weight: 1 }] } }];
      return map;
    });
    await refusedWith((map) => {
      map.pathMatchers[0].defaultCustomErrorResponsePolicy = { errorService: ownUrl('gone') };
      return map;
    });
    assert.deepEqual(t.w.changes, []);
  });
}

test('the fake: a map update naming the waker fails once its waker is deleted, as a nap in flight finds at a forced offboarding', async () => {
  const t = setup();
  await t.onboarding.onboard(INPUT);
  delete t.w.services[WAKER];
  await assert.rejects(t.urlmaps.modify('lb', (map) => ({ map: { ...map }, paths: ['x'] })), (err) => err.code === 400);
});

test('the fake: a regional service\'s health follows its group and its NEG, as a global one\'s', async () => {
  const t = setup((w) => {
    regional(w);
    w.negs.neg = { endpoints: ['neg-vm'] };
    w.vms['neg-vm'] = { id: '4', status: 'TERMINATED' };
  });
  const negUrl = `${V1}/zones/${ZONE}/networkEndpointGroups/neg`;
  const level = async () => (await t.compute.getRegionBackendServiceHealth(REGION, 'app', negUrl)).healthStatus[0].healthState;
  assert.equal(t.w.vms['vm-a'].status, 'RUNNING');
  assert.equal(await level(), 'UNHEALTHY');
  t.w.vms['neg-vm'].status = 'RUNNING';
  assert.equal(await level(), 'HEALTHY');
  assert.deepEqual([...new Set(t.w.healthGroups)], [negUrl]);
});

test('the fake: a classic service reads no status while its VM is down (M3), a global one unhealthy', async () => {
  const down = (w) => { w.vms['vm-a'].status = 'TERMINATED'; };
  const onClassic = setup((w) => {
    classic(w);
    down(w);
  });
  assert.equal((await onClassic.compute.getBackendServiceHealth('app', GROUP)).healthStatus, undefined);
  onClassic.w.vms['vm-a'].status = 'RUNNING';
  assert.equal((await onClassic.compute.getBackendServiceHealth('app', GROUP)).healthStatus[0].healthState, 'HEALTHY');

  const onGlobal = setup(down);
  assert.equal((await onGlobal.compute.getBackendServiceHealth('app', GROUP)).healthStatus[0].healthState, 'UNHEALTHY');
});

test('a classic workload whose service reads no status: none healthy, so a VM stopped by hand is an external stop, under the swap', async () => {
  const t = setup(classic);
  await t.onboarding.onboard(INPUT);
  t.w.vms['vm-a'].status = 'TERMINATED';
  const [result] = await t.core.check();
  assert.equal(result.state, STATES.ASLEEP);
  assert.ok(t.w.logs.some((l) => l.event === 'ExternalStop'));
  assert.equal(t.w.urlMaps.lb.pathMatchers[0].defaultService, `${V1}/global/backendServices/${WAKER}`);
});

test('a classic wake waits through no status, and ends healthy: a VM not yet read is none healthy', async () => {
  const t = setup(classic);
  await t.onboarding.onboard(INPUT);
  assert.equal((await t.core.nap('demo')).state, STATES.ASLEEP);
  const wakeId = await t.core.beginWake('demo', STATES.ASLEEP, 'operator');
  let reads = 0;
  const { w } = t;
  w.on[`POST global/backendServices/app/getHealth`] = () => {
    reads += 1;
    w.vms['vm-a'].status = reads < 3 ? 'STAGING' : 'RUNNING';
  };
  assert.equal((await t.core.wake('demo', wakeId)).state, STATES.AWAKE);
  assert.equal(reads, 3);
});

test('a regional workload\'s NEG decides its health, not another VM of the project: a NEG\'s VM stopped by hand is an external stop', async () => {
  const t = setup((w) => {
    regional(w);
    w.negs.neg = { endpoints: ['neg-vm'] };
    w.vms['neg-vm'] = { id: '4', status: 'RUNNING' };
    w.vms.other = { id: '5', status: 'RUNNING' };
    w.regions[REGION].services.app.backends = [{ group: `${V1}/zones/${ZONE}/networkEndpointGroups/neg` }];
  });
  await t.onboarding.onboard(INPUT);
  t.w.vms['neg-vm'].status = 'TERMINATED';
  const [result] = await t.core.check();
  assert.equal(result.state, STATES.ASLEEP);
  assert.ok(t.w.logs.some((l) => l.event === 'ExternalStop'));
});

// What the fake holds of Cloud SQL is task R10's assumption, before M6: the state stays RUNNABLE, the policy says what was asked, the operation when it is over.
test('Cloud SQL in the fake: the policy at once, the operation until its time, a 409 meanwhile, a 404 for none', async () => {
  const { clock, cloudsql, w } = setup((world) => { world.sql.db = {}; });
  assert.equal((await cloudsql.get('db')).settings.activationPolicy, 'ALWAYS');
  const op = await cloudsql.setActivation('db', 'NEVER');
  const during = await cloudsql.get('db');
  assert.deepEqual([during.state, during.settings.activationPolicy], ['RUNNABLE', 'NEVER']);
  assert.equal((await cloudsql.getOperation(op)).status, 'RUNNING');
  await assert.rejects(cloudsql.setActivation('db', 'ALWAYS'), /another operation/);
  clock.advance(w.sqlTakes.NEVER);
  assert.equal((await cloudsql.getOperation(op)).status, 'DONE');
  await cloudsql.setActivation('db', 'ALWAYS');
  assert.deepEqual(w.changes, ['sql db NEVER', 'sql db ALWAYS']);
  await assert.rejects(cloudsql.get('none'), (err) => err.code === 404);
});

test('Cloud SQL in the fake: the list is the instance\'s, newest first, from when the reading shows it', async () => {
  const { clock, cloudsql, w } = setup((world) => {
    world.sql.db = {};
    world.sql.other = {};
    world.sqlReading.listLagMs = 5_000;
  });
  await cloudsql.setActivation('other', 'NEVER');
  const first = await cloudsql.setActivation('db', 'NEVER');
  assert.deepEqual(await cloudsql.listOperations('db'), []);
  clock.advance(w.sqlTakes.NEVER);
  const second = await cloudsql.setActivation('db', 'ALWAYS');
  clock.advance(5_000);
  assert.deepEqual((await cloudsql.listOperations('db')).map((op) => [op.name, op.status]), [[second, 'RUNNING'], [first, 'DONE']]);
});

test('Cloud SQL in the fake: a second reading: the policy at the operation\'s end, the state during it, an error changing it', async () => {
  const { clock, cloudsql, w } = setup((world) => {
    world.sql.db = {};
    world.sqlReading = { ...world.sqlReading, policy: 'at-end', stateDuring: 'MAINTENANCE', failedPolicy: 'changed' };
    world.sqlOperationErrors.push({ errors: [{ code: 'X', message: 'y' }] });
  });
  await cloudsql.setActivation('db', 'NEVER');
  const during = await cloudsql.get('db');
  assert.deepEqual([during.state, during.settings.activationPolicy], ['MAINTENANCE', 'ALWAYS']);
  clock.advance(w.sqlTakes.NEVER);
  const after = await cloudsql.get('db');
  assert.deepEqual([after.state, after.settings.activationPolicy], ['RUNNABLE', 'NEVER']);
});

test('Cloud SQL in the fake: an operation ending in an error leaves the policy as it was', async () => {
  const { clock, cloudsql, w } = setup((world) => {
    world.sql.db = { settings: { activationPolicy: 'NEVER' } };
    world.sqlOperationErrors.push({ errors: [{ code: 'X', message: 'y' }] });
  });
  const op = await cloudsql.setActivation('db', 'ALWAYS');
  clock.advance(w.sqlTakes.ALWAYS);
  assert.deepEqual((await cloudsql.getOperation(op)).error, { errors: [{ code: 'X', message: 'y' }] });
  assert.equal((await cloudsql.get('db')).settings.activationPolicy, 'NEVER');
});
