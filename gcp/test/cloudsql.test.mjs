import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeClock } from '../../lambda/test/fakes.mjs';
import { CALLS, createCloudSql, companionLost, companionProblem, companionRead, COMPANION_GONE, isCompanion, POLL_MS, startDatabase, statusOf, stopDatabase } from '../src/cloudsql.mjs';
import { GoogleError } from '../src/google.mjs';

const BASE = 'https://sqladmin.googleapis.com/v1/projects/p';
const busy = () => new GoogleError('Google: PATCH: 409 Operation failed because another operation was already in progress.', { code: 409, status: 'CONFLICT', reason: 'operationInProgress' });

function setup(answer = () => ({})) {
  const calls = [];
  const clock = fakeClock();
  const sleeps = [];
  const sleep = (ms) => {
    sleeps.push(ms);
    return clock.sleep(ms);
  };
  const google = {
    request: async (method, url, body) => {
      calls.push({ method, url, body });
      return answer(method, url, body, calls);
    },
  };
  return { calls, clock, sleeps, sleep, cloudsql: createCloudSql({ google, project: 'p', now: clock.now, sleep }) };
}

const instance = (activationPolicy, state = 'RUNNABLE') => ({ state, settings: { activationPolicy } });

const done = (extra = {}) => ({ name: 'op', status: 'DONE', ...extra });
const failed = done({ error: { errors: [{ code: 'X', message: 'y' }] } });

// M6 pins this reading: the state may stay RUNNABLE while stopped, and through a start.
for (const [title, read, operations, status] of [
  ['ALWAYS and RUNNABLE, none listed', instance('ALWAYS'), undefined, 'running'],
  ['ALWAYS and RUNNABLE, an empty list', instance('ALWAYS'), [], 'running'],
  ['ALWAYS and RUNNABLE, all done', instance('ALWAYS'), [done(), done()], 'running'],
  ['ALWAYS and RUNNABLE, one pending', instance('ALWAYS'), [{ status: 'PENDING' }], 'transitioning'],
  ['ALWAYS and RUNNABLE, one running', instance('ALWAYS'), [{ status: 'RUNNING' }], 'transitioning'],
  ['ALWAYS and RUNNABLE, an older one still running', instance('ALWAYS'), [done(), { status: 'RUNNING' }], 'transitioning'],
  ['ALWAYS and RUNNABLE, the newest in error', instance('ALWAYS'), [failed, done()], 'transitioning'],
  ['ALWAYS and RUNNABLE, an older one in error', instance('ALWAYS'), [done(), failed], 'running'],
  ['ALWAYS, in maintenance', instance('ALWAYS', 'MAINTENANCE'), [], 'transitioning'],
  ['ALWAYS, suspended by Google', instance('ALWAYS', 'SUSPENDED'), undefined, 'transitioning'],
  ['NEVER, though RUNNABLE, none listed', instance('NEVER'), undefined, 'stopped'],
  ['NEVER, all done', instance('NEVER'), [done()], 'stopped'],
  ['NEVER, the newest in error', instance('NEVER'), [failed], 'stopped'],
  ['NEVER, one running', instance('NEVER'), [{ status: 'RUNNING' }], 'transitioning'],
  ['no policy read', { state: 'RUNNABLE' }, undefined, 'transitioning'],
]) {
  test(`statusOf: ${title}: ${status}`, () => assert.equal(statusOf(read, operations), status));
}

test('isCompanion: a cloudsql backend, and no VM or group', () => {
  assert.equal(isCompanion({ kind: 'cloudsql', name: 'db' }), true);
  assert.equal(isCompanion({ kind: 'vm', location: 'z', name: 'db' }), false);
  assert.equal(isCompanion({ kind: 'mig', location: 'z', name: 'db' }), false);
});

test('companionProblem: a replica by its primary\'s name or its type, a primary with replicas, else none', () => {
  assert.match(companionProblem({ name: 'r', masterInstanceName: 'p:db' }), /^Cloud SQL instance r is a read replica/);
  assert.match(companionProblem({ name: 'r', instanceType: 'READ_REPLICA_INSTANCE' }), /^Cloud SQL instance r is a read replica/);
  assert.match(companionProblem({ name: 'db', replicaNames: ['r1', 'r2'] }), /^Cloud SQL instance db has read replicas \(r1, r2\): .*assumed/);
  assert.equal(companionProblem({ name: 'db', replicaNames: [], instanceType: 'CLOUD_SQL_INSTANCE' }), null);
  assert.equal(companionProblem({ name: 'db' }), null);
});

test('companionRead: a database, its problem, 404 and 403 in words; anything else thrown', async () => {
  const of = (answer) => companionRead(setup(answer).cloudsql, 'db');
  assert.deepEqual(await of(() => ({ selfLink: 'https://sql/db' })), { database: { name: 'db', selfLink: 'https://sql/db' } });
  const replica = await of(() => ({ selfLink: 'https://sql/db', masterInstanceName: 'p:x' }));
  assert.match(replica.problem, /is a read replica/);
  assert.deepEqual(replica.database, { name: 'db', selfLink: 'https://sql/db' });
  const thrower = (code) => () => { throw new GoogleError(`Google: GET: ${code} no`, { code }); };
  assert.deepEqual(await of(thrower(404)), { gone: true, problem: 'Cloud SQL instance db not found: name an instance of this project' });
  assert.match((await of(thrower(403))).problem, /^the router cannot read Cloud SQL instance db: it does not exist, or the router was installed without --with cloud-sql: .*403/);
  assert.equal((await of(thrower(403))).gone, undefined);
  await assert.rejects(of(thrower(500)), /500/);
});

test('companionLost: why a nap must not count on an instance: gone, or not to be read; a replica or a running one is no reason; anything else thrown', async () => {
  const of = (answer) => companionLost(setup(answer).cloudsql, 'db');
  const thrower = (code) => () => { throw new GoogleError(`Google: GET: ${code} no`, { code }); };
  assert.equal(await of(() => instance('ALWAYS')), null);
  assert.equal(await of(() => ({ ...instance('NEVER'), replicaNames: ['r'] })), null);
  assert.match(await of(thrower(404)), /^Cloud SQL instance db no longer exists: offboard and onboard again$/);
  assert.match(await of(thrower(403)), /^the router cannot read Cloud SQL instance db: .*: nothing is stopped, give the router its role back, or offboard and onboard again$/);
  await assert.rejects(of(thrower(500)), /500/);
});

test('get: GET the instance, its name encoded', async () => {
  const { calls, cloudsql } = setup(() => instance('ALWAYS'));
  assert.deepEqual(await cloudsql.get('db'), instance('ALWAYS'));
  await cloudsql.get('a/b');
  assert.deepEqual(calls[0], { method: 'GET', url: `${BASE}/instances/db`, body: undefined });
  assert.equal(calls[1].url, `${BASE}/instances/a%2Fb`);
});

test('getOperation: GET the operation of the project', async () => {
  const { calls, cloudsql } = setup(() => ({ name: 'op', status: 'RUNNING' }));
  assert.deepEqual(await cloudsql.getOperation('op'), { name: 'op', status: 'RUNNING' });
  assert.deepEqual(calls[0], { method: 'GET', url: `${BASE}/operations/op`, body: undefined });
});

test('listOperations: the instance\'s, the newest ten, as Google lists them; none: empty', async () => {
  const { calls, cloudsql } = setup(() => ({ items: [{ name: 'b' }, { name: 'a' }] }));
  assert.deepEqual(await cloudsql.listOperations('db'), [{ name: 'b' }, { name: 'a' }]);
  assert.deepEqual(calls[0], { method: 'GET', url: `${BASE}/operations?instance=db&maxResults=10`, body: undefined });
  await cloudsql.listOperations('a/b');
  assert.equal(calls[1].url, `${BASE}/operations?instance=a%2Fb&maxResults=10`);
  assert.deepEqual(await setup(() => ({})).cloudsql.listOperations('db'), []);
});

for (const policy of ['ALWAYS', 'NEVER']) {
  test(`setActivation ${policy}: the PATCH of the policy alone, its operation's name, no wait`, async () => {
    const { calls, sleeps, cloudsql } = setup(() => ({ name: 'op-1', status: 'PENDING' }));
    assert.equal(await cloudsql.setActivation('db', policy), 'op-1');
    assert.deepEqual(calls, [{ method: 'PATCH', url: `${BASE}/instances/db`, body: { settings: { activationPolicy: policy } } }]);
    assert.deepEqual(sleeps, []);
  });
}

test('setActivation: operationInProgress is tried again every 10 s, until it passes', async () => {
  const { calls, clock, sleeps, cloudsql } = setup((m, u, b, seen) => {
    if (seen.length < 4) throw busy();
    return { name: 'op-1' };
  });
  assert.equal(await cloudsql.setActivation('db', 'NEVER', clock.now() + 60_000), 'op-1');
  assert.equal(calls.length, 4);
  assert.deepEqual(sleeps, [POLL_MS, POLL_MS, POLL_MS]);
  assert.equal(POLL_MS, 10_000);
});

test('setActivation: operationInProgress up to the deadline: a timeout saying so; no deadline: one try', async () => {
  const { calls, clock, cloudsql } = setup(() => { throw busy(); });
  const deadline = clock.now() + 35_000;
  await assert.rejects(cloudsql.setActivation('db', 'ALWAYS', deadline), (err) => {
    assert.equal(err.kind, 'timeout');
    assert.match(err.message, /^Cloud SQL instance db: another operation was still running at the deadline/);
    return true;
  });
  assert.ok(clock.now() >= deadline && clock.now() < deadline + POLL_MS);
  assert.equal(calls.length, 5);

  const once = setup(() => { throw busy(); });
  await assert.rejects(once.cloudsql.setActivation('db', 'ALWAYS'), /another operation/);
  assert.equal(once.calls.length, 1);
});

test('setActivation: another 409 is not tried again', async () => {
  const failure = new GoogleError('Google: 409 other', { code: 409, reason: 'instanceAlreadyExists' });
  const { calls, clock, cloudsql } = setup(() => { throw failure; });
  await assert.rejects(cloudsql.setActivation('db', 'NEVER', clock.now() + 60_000), failure);
  assert.equal(calls.length, 1);
});

test('setActivation: a 403 is of kind permission, naming the tag first', async () => {
  const { calls, clock, cloudsql } = setup(() => { throw new GoogleError('Google: PATCH: 403 not authorized', { code: 403, reason: 'notAuthorized' }); });
  await assert.rejects(cloudsql.setActivation('db', 'NEVER', clock.now() + 60_000), (err) => {
    assert.equal(err.kind, 'permission');
    assert.match(err.message, /^Cloud SQL instance db: .*tag dormeto=managed.*403 not authorized/);
    return true;
  });
  assert.equal(calls.length, 1);
});

test('setActivation: a refusal for capacity is of kind capacity; another 5xx has no kind', async () => {
  const { clock, cloudsql } = setup(() => { throw new GoogleError('Google: PATCH: 503 no', { code: 503, reason: 'ZONE_RESOURCE_POOL_EXHAUSTED' }); });
  await assert.rejects(cloudsql.setActivation('db', 'ALWAYS', clock.now() + 60_000), (err) => err.kind === 'capacity');
  const other = setup(() => { throw new GoogleError('Google: PATCH: 503 no', { code: 503 }); });
  await assert.rejects(other.cloudsql.setActivation('db', 'ALWAYS', other.clock.now() + 60_000), (err) => err.kind === undefined);
});

// The instance as read, in turn; then as the last. `operation`: the status of the last one asked for, which the list shows.
const reads = (...answers) => {
  const operations = [];
  let i = 0;
  const answer = (method, url) => {
    if (method === 'PATCH') {
      operations.push(url);
      return { name: `op-${operations.length}` };
    }
    if (url.includes('/operations?')) {
      const { operation = 'DONE' } = answers[Math.min(i - 1, answers.length - 1)];
      return { items: operations.length ? [{ name: `op-${operations.length}`, status: operation }] : [] };
    }
    const read = answers[Math.min(i, answers.length - 1)];
    i += 1;
    return read;
  };
  return { answer, operations };
};

test('startDatabase: a stopped one: ALWAYS, then every 10 s until it runs, reading the list', async () => {
  const running = { ...instance('ALWAYS'), operation: 'RUNNING' };
  const { answer, operations } = reads(instance('NEVER'), running, running, { ...instance('ALWAYS'), operation: 'DONE' });
  const { calls, clock, sleeps, sleep, cloudsql } = setup(answer);
  await startDatabase(cloudsql, 'db', { now: clock.now, sleep, deadline: clock.now() + 600_000 });
  assert.equal(operations.length, 1);
  assert.deepEqual(sleeps, [POLL_MS, POLL_MS, POLL_MS]);
  assert.ok(calls.some((c) => c.url === `${BASE}/operations?instance=db&maxResults=10`));
  assert.equal(calls.some((c) => c.url === `${BASE}/operations/op-1`), false, 'the list showed it');
});

test('startDatabase: one running changes nothing and does not wait', async () => {
  const { calls, clock, sleeps, sleep, cloudsql } = setup(() => instance('ALWAYS'));
  await startDatabase(cloudsql, 'db', { now: clock.now, sleep, deadline: clock.now() + 600_000 });
  assert.equal(calls.some((c) => c.method !== 'GET'), false);
  assert.deepEqual(sleeps, []);
});

test('startDatabase in a new request, a start under way, the state RUNNABLE: waited for, nothing asked', async () => {
  let listed = 0;
  const { calls, clock, sleeps, sleep, cloudsql } = setup((method, url) => {
    if (url.includes('/operations?')) {
      listed += 1;
      return { items: [{ name: 'earlier', status: listed < 4 ? 'RUNNING' : 'DONE' }] };
    }
    return instance('ALWAYS');
  });
  await startDatabase(cloudsql, 'db', { now: clock.now, sleep, deadline: clock.now() + 600_000 });
  assert.deepEqual(sleeps, [POLL_MS, POLL_MS, POLL_MS]);
  assert.equal(calls.some((c) => c.method === 'PATCH'), false);
});

test('startDatabase: the newest operation in error, the policy ALWAYS, the state RUNNABLE: asked again, not read as running', async () => {
  let patches = 0;
  const { calls, clock, sleep, cloudsql } = setup((method, url) => {
    if (method === 'PATCH') {
      patches += 1;
      return { name: 'new' };
    }
    if (url.includes('/operations?')) return { items: [...(patches ? [{ name: 'new', status: 'DONE' }] : []), { name: 'old', status: 'DONE', error: { errors: [{ code: 'X', message: 'y' }] } }] };
    return instance('ALWAYS');
  });
  await startDatabase(cloudsql, 'db', { now: clock.now, sleep, deadline: clock.now() + 600_000 });
  assert.equal(patches, 1);
  assert.equal(calls.at(-1).method, 'GET');
});

test('startDatabase: what was asked and the list does not show yet is read by its name', async () => {
  let states = 0;
  const { calls, clock, sleeps, sleep, cloudsql } = setup((method, url) => {
    if (method === 'PATCH') return { name: 'op-1' };
    if (url.includes('/operations?')) return { items: [] };
    if (url.includes('/operations/')) {
      states += 1;
      return { name: 'op-1', status: states < 3 ? 'RUNNING' : 'DONE' };
    }
    return states ? instance('ALWAYS') : instance('NEVER');
  });
  await startDatabase(cloudsql, 'db', { now: clock.now, sleep, deadline: clock.now() + 600_000 });
  assert.equal(calls.filter((c) => c.url === `${BASE}/operations/op-1`).length, 3);
  assert.deepEqual(sleeps, [POLL_MS, POLL_MS, POLL_MS]);
});

const refusal = () => new GoogleError('Google: GET: 403 not authorized', { code: 403, reason: 'notAuthorized' });

test('startDatabase: the list refused with a 403: the state and the policy decide, it says so at each read, the wake goes on', async () => {
  const unread = [];
  const { clock, sleep, cloudsql } = setup((method, url) => {
    if (url.includes('/operations')) throw refusal();
    return instance('ALWAYS');
  });
  await startDatabase(cloudsql, 'db', { now: clock.now, sleep, deadline: clock.now() + 600_000, unread: (err) => unread.push(err) });
  assert.equal(unread.length, 1);
  assert.equal(unread[0].code, 403);
});

test('startDatabase: the list and the operation refused with a 403 after asking: not a failed wake', async () => {
  let patched = false;
  const { clock, sleep, cloudsql } = setup((method, url) => {
    if (method === 'PATCH') {
      patched = true;
      return { name: 'op-1' };
    }
    if (url.includes('/operations')) throw refusal();
    return patched ? instance('ALWAYS') : instance('NEVER');
  });
  await startDatabase(cloudsql, 'db', { now: clock.now, sleep, deadline: clock.now() + 600_000, unread: () => {} });
  assert.equal(patched, true);
});

test('startDatabase: another failure of the list stays a failure', async () => {
  const failure = new GoogleError('Google: GET: 500', { code: 500 });
  const { clock, sleep, cloudsql } = setup((method, url) => {
    if (url.includes('/operations')) throw failure;
    return instance('ALWAYS');
  });
  await assert.rejects(startDatabase(cloudsql, 'db', { now: clock.now, sleep, deadline: clock.now() + 600_000, unread: () => {} }), failure);
});

test('startDatabase: never running: a timeout at the deadline, naming the instance', async () => {
  const { clock, sleep, cloudsql } = setup(() => instance('ALWAYS', 'MAINTENANCE'));
  const deadline = clock.now() + 100_000;
  await assert.rejects(startDatabase(cloudsql, 'db', { now: clock.now, sleep, deadline }), (err) => {
    assert.equal(err.kind, 'timeout');
    assert.match(err.message, /^Cloud SQL instance db: not running when the wake timed out/);
    return true;
  });
  assert.ok(clock.now() >= deadline);
});

test('startDatabase: stopped again during the wait: asked again', async () => {
  const { answer, operations } = reads(instance('NEVER'), instance('NEVER'), instance('ALWAYS'));
  const { clock, sleep, cloudsql } = setup(answer);
  await startDatabase(cloudsql, 'db', { now: clock.now, sleep, deadline: clock.now() + 600_000 });
  assert.equal(operations.length, 2);
});

test('startDatabase: what it asked ending in an error fails the wake in Google\'s words, at once', async () => {
  let asked = false;
  const { clock, sleeps, sleep, cloudsql } = setup((method, url) => {
    if (method === 'PATCH') {
      asked = true;
      return { name: 'op-1' };
    }
    if (url.includes('/operations?')) return { items: asked ? [{ name: 'op-1', status: 'DONE', error: { errors: [{ code: 'INTERNAL_ERROR', message: 'it broke' }] } }] : [] };
    return instance('NEVER');
  });
  await assert.rejects(startDatabase(cloudsql, 'db', { now: clock.now, sleep, deadline: clock.now() + 600_000 }), { message: 'Cloud SQL instance db: operation op-1 failed: INTERNAL_ERROR: it broke' });
  assert.deepEqual(sleeps, [POLL_MS]);
});

test('startDatabase: a start refused for capacity gets AWS\'s retries: 30 s, 60 s, then every 120 s', async () => {
  let patches = 0;
  const { clock, sleeps, sleep, cloudsql } = setup((method, url) => {
    if (url.includes('/operations?')) return { items: [] };
    if (url.includes('/operations/')) return { name: 'op', status: 'DONE' };
    if (method === 'GET') return patches > 4 ? instance('ALWAYS') : instance('NEVER');
    patches += 1;
    if (patches <= 4) throw new GoogleError('Google: 503 no', { code: 503, reason: 'ZONE_RESOURCE_POOL_EXHAUSTED' });
    return { name: 'op' };
  });
  await startDatabase(cloudsql, 'db', { now: clock.now, sleep, deadline: clock.now() + 1_000_000 });
  assert.deepEqual(sleeps.slice(0, 4), [30_000, 60_000, 120_000, 120_000]);
  assert.equal(patches, 5);
});

test('startDatabase: an operation failed for capacity gets the same retries; past the deadline, the refusal', async () => {
  let patches = 0;
  const { clock, sleeps, sleep, cloudsql } = setup((method, url) => {
    if (method === 'PATCH') {
      patches += 1;
      return { name: `op-${patches}` };
    }
    if (url.includes('/operations?')) return { items: patches ? [{ name: `op-${patches}`, status: 'DONE', error: { errors: [{ code: 'ZONE_RESOURCE_POOL_EXHAUSTED', message: 'none left' }] } }] : [] };
    return instance('NEVER');
  });
  await assert.rejects(startDatabase(cloudsql, 'db', { now: clock.now, sleep, deadline: clock.now() + 200_000 }), (err) => err.kind === 'capacity' && /none left/.test(err.message));
  assert.deepEqual(sleeps.filter((ms) => ms !== POLL_MS), [30_000, 60_000]);
  assert.ok(patches >= 2);
});

test('setActivation: no longer wanted: nothing sent, null', async () => {
  const { calls, clock, cloudsql } = setup();
  assert.equal(await cloudsql.setActivation('db', 'NEVER', clock.now() + 60_000, async () => false), null);
  assert.deepEqual(calls, []);
});

test('setActivation: no longer wanted after a 409: no other try, no timeout, null', async () => {
  let asks = 0;
  const { calls, clock, sleeps, cloudsql } = setup(() => { throw busy(); });
  const wanted = async () => {
    asks += 1;
    return asks < 3;
  };
  assert.equal(await cloudsql.setActivation('db', 'NEVER', clock.now() + 600_000, wanted), null);
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [POLL_MS, POLL_MS]);
});

const absentInstance = () => { throw new GoogleError('Google: GET: 404 The Cloud SQL instance does not exist.', { code: 404, status: 'NOT_FOUND' }); };

test('startDatabase: an instance gone: answered as gone, nothing asked, no wait', async () => {
  const { calls, clock, sleeps, sleep, cloudsql } = setup((method, url) => (url.includes('/operations') ? { items: [] } : absentInstance()));
  assert.equal(await startDatabase(cloudsql, 'db', { now: clock.now, sleep, deadline: clock.now() + 600_000 }), COMPANION_GONE);
  assert.equal(calls.some((c) => c.method === 'PATCH'), false);
  assert.deepEqual(sleeps, []);
});

test('startDatabase: an instance gone, its operations 404 as well: gone, whichever answers first', async () => {
  const { clock, sleep, cloudsql } = setup(() => absentInstance());
  assert.equal(await startDatabase(cloudsql, 'db', { now: clock.now, sleep, deadline: clock.now() + 600_000 }), COMPANION_GONE);
});

test('startDatabase: an instance deleted between its read and its PATCH: gone', async () => {
  const { clock, sleep, cloudsql } = setup((method, url) => {
    if (method === 'PATCH') absentInstance();
    return url.includes('/operations') ? { items: [] } : instance('NEVER');
  });
  assert.equal(await startDatabase(cloudsql, 'db', { now: clock.now, sleep, deadline: clock.now() + 600_000 }), COMPANION_GONE);
});

test('startDatabase: the operations alone answering 404 say nothing of the instance: it goes by its state', async () => {
  const { clock, sleep, cloudsql } = setup((method, url) => (url.includes('/operations') ? absentInstance() : instance('ALWAYS')));
  assert.notEqual(await startDatabase(cloudsql, 'db', { now: clock.now, sleep, deadline: clock.now() + 600_000 }), COMPANION_GONE);
});

test('stopDatabase: an instance gone: answered as gone, nothing sent; deleted before its PATCH too', async () => {
  const first = setup(() => absentInstance());
  assert.equal(await stopDatabase(first.cloudsql, 'db', first.clock.now() + 60_000), COMPANION_GONE);
  assert.equal(first.calls.some((c) => c.method === 'PATCH'), false);
  const second = setup((method) => (method === 'PATCH' ? absentInstance() : instance('ALWAYS')));
  assert.equal(await stopDatabase(second.cloudsql, 'db', second.clock.now() + 60_000), COMPANION_GONE);
  const running = setup((method) => (method === 'GET' ? instance('ALWAYS') : { name: 'op' }));
  assert.notEqual(await stopDatabase(running.cloudsql, 'db', running.clock.now() + 60_000), COMPANION_GONE);
});

test('stopDatabase: no longer wanted: nothing sent', async () => {
  const { calls, clock, cloudsql } = setup(() => instance('ALWAYS'));
  await stopDatabase(cloudsql, 'db', clock.now() + 60_000, async () => false);
  assert.equal(calls.some((c) => c.method === 'PATCH'), false);
});

test('stopDatabase: one that runs gets NEVER, no wait; one stopped nothing; one starting NEVER too', async () => {
  for (const [read, expected] of [[instance('ALWAYS'), 1], [instance('NEVER'), 0], [instance('ALWAYS', 'MAINTENANCE'), 1]]) {
    const { calls, clock, sleeps, cloudsql } = setup((method) => (method === 'GET' ? read : { name: 'op' }));
    await stopDatabase(cloudsql, 'db', clock.now() + 60_000);
    assert.equal(calls.filter((c) => c.method === 'PATCH').length, expected);
    assert.deepEqual(sleeps, []);
  }
});

test('CALLS: one entry per function, each with permissions', () => {
  const { cloudsql } = setup();
  assert.deepEqual(Object.keys(CALLS).sort(), Object.keys(cloudsql).sort());
  for (const permissions of Object.values(CALLS)) assert.ok(permissions.length > 0);
  // Google's table of permissions, method by method.
  assert.deepEqual(CALLS.setActivation, ['cloudsql.instances.get', 'cloudsql.instances.update']);
  assert.deepEqual(CALLS.get, ['cloudsql.instances.get']);
  assert.deepEqual(CALLS.getOperation, ['cloudsql.instances.get']);
  assert.deepEqual(CALLS.listOperations, ['cloudsql.instances.get', 'cloudsql.instances.list']);
});
