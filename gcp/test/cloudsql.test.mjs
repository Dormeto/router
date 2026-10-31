import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeClock } from '../../lambda/test/fakes.mjs';
import { CALLS, createCloudSql, companionProblem, isCompanion, POLL_MS, startDatabase, statusOf, stopDatabase } from '../src/cloudsql.mjs';
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

// M6 pins this reading (ruling 2 of the task): the state may stay RUNNABLE while stopped.
for (const [title, read, operation, status] of [
  ['ALWAYS and RUNNABLE, no operation', instance('ALWAYS'), undefined, 'running'],
  ['ALWAYS and RUNNABLE, our operation done', instance('ALWAYS'), { status: 'DONE' }, 'running'],
  ['ALWAYS and RUNNABLE, our operation pending', instance('ALWAYS'), { status: 'PENDING' }, 'transitioning'],
  ['ALWAYS and RUNNABLE, our operation running', instance('ALWAYS'), { status: 'RUNNING' }, 'transitioning'],
  ['ALWAYS, in maintenance', instance('ALWAYS', 'MAINTENANCE'), undefined, 'transitioning'],
  ['ALWAYS, suspended by Google', instance('ALWAYS', 'SUSPENDED'), undefined, 'transitioning'],
  ['NEVER, though RUNNABLE, no operation', instance('NEVER'), undefined, 'stopped'],
  ['NEVER, our operation done', instance('NEVER'), { status: 'DONE' }, 'stopped'],
  ['NEVER, our operation running', instance('NEVER'), { status: 'RUNNING' }, 'transitioning'],
  ['no policy read', { state: 'RUNNABLE' }, undefined, 'transitioning'],
]) {
  test(`statusOf: ${title}: ${status}`, () => assert.equal(statusOf(read, operation), status));
}

test('isCompanion: a cloudsql backend, and no VM or group', () => {
  assert.equal(isCompanion({ kind: 'cloudsql', name: 'db' }), true);
  assert.equal(isCompanion({ kind: 'vm', location: 'z', name: 'db' }), false);
  assert.equal(isCompanion({ kind: 'mig', location: 'z', name: 'db' }), false);
});

test('companionProblem: a replica by its primary\'s name or its type, a primary with replicas, else none', () => {
  assert.match(companionProblem({ name: 'r', masterInstanceName: 'p:db' }), /^Cloud SQL instance r is a read replica/);
  assert.match(companionProblem({ name: 'r', instanceType: 'READ_REPLICA_INSTANCE' }), /^Cloud SQL instance r is a read replica/);
  assert.match(companionProblem({ name: 'db', replicaNames: ['r1', 'r2'] }), /^Cloud SQL instance db has read replicas \(r1, r2\)/);
  assert.equal(companionProblem({ name: 'db', replicaNames: [], instanceType: 'CLOUD_SQL_INSTANCE' }), null);
  assert.equal(companionProblem({ name: 'db' }), null);
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

// The instance as read, in turn; then as the last.
const reads = (...answers) => {
  const operations = [];
  let i = 0;
  const answer = (method, url) => {
    if (method === 'PATCH') {
      operations.push(url);
      return { name: `op-${operations.length}` };
    }
    if (url.includes('/operations/')) return { name: 'op', status: answers[Math.min(i - 1, answers.length - 1)].operation ?? 'DONE' };
    const read = answers[Math.min(i, answers.length - 1)];
    i += 1;
    return read;
  };
  return { answer, operations };
};

test('startDatabase: a stopped one: ALWAYS, then every 10 s until it runs, reading the operation', async () => {
  const { answer, operations } = reads(
    instance('NEVER'),
    { ...instance('ALWAYS'), operation: 'RUNNING' },
    { ...instance('ALWAYS'), operation: 'RUNNING' },
    { ...instance('ALWAYS'), operation: 'DONE' },
  );
  const { calls, clock, sleeps, sleep, cloudsql } = setup(answer);
  await startDatabase(cloudsql, 'db', { now: clock.now, sleep, deadline: clock.now() + 600_000 });
  assert.equal(operations.length, 1);
  assert.deepEqual(sleeps, [POLL_MS, POLL_MS, POLL_MS]);
  assert.ok(calls.some((c) => c.url === `${BASE}/operations/op-1`));
});

test('startDatabase: one running changes nothing and does not wait', async () => {
  const { calls, clock, sleeps, sleep, cloudsql } = setup(() => instance('ALWAYS'));
  await startDatabase(cloudsql, 'db', { now: clock.now, sleep, deadline: clock.now() + 600_000 });
  assert.deepEqual(calls.map((c) => c.method), ['GET']);
  assert.deepEqual(sleeps, []);
});

test('startDatabase in a new request: no operation known, the state and the policy decide; nothing asked twice', async () => {
  const { calls, clock, sleep, cloudsql } = setup(((n) => () => {
    n += 1;
    return n < 3 ? instance('ALWAYS', 'MAINTENANCE') : instance('ALWAYS');
  })(0));
  await startDatabase(cloudsql, 'db', { now: clock.now, sleep, deadline: clock.now() + 600_000 });
  assert.deepEqual([...new Set(calls.map((c) => c.method))], ['GET']);
  assert.equal(calls.some((c) => c.url.includes('/operations/')), false);
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

test('startDatabase: an operation that ends in an error fails the wake in Google\'s words, at once', async () => {
  const { clock, sleeps, sleep, cloudsql } = setup((method, url) => {
    if (method === 'PATCH') return { name: 'op-1' };
    if (url.includes('/operations/')) return { name: 'op-1', status: 'DONE', error: { errors: [{ code: 'INTERNAL_ERROR', message: 'it broke' }] } };
    return instance('NEVER');
  });
  await assert.rejects(startDatabase(cloudsql, 'db', { now: clock.now, sleep, deadline: clock.now() + 600_000 }), { message: 'Cloud SQL instance db: operation op-1 failed: INTERNAL_ERROR: it broke' });
  assert.deepEqual(sleeps, [POLL_MS]);
});

test('startDatabase: a start refused for capacity gets AWS\'s retries: 30 s, 60 s, then every 120 s', async () => {
  let patches = 0;
  const { clock, sleeps, sleep, cloudsql } = setup((method, url) => {
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
    if (url.includes('/operations/')) return { name: 'op', status: 'DONE', error: { errors: [{ code: 'ZONE_RESOURCE_POOL_EXHAUSTED', message: 'none left' }] } };
    return instance('NEVER');
  });
  await assert.rejects(startDatabase(cloudsql, 'db', { now: clock.now, sleep, deadline: clock.now() + 200_000 }), (err) => err.kind === 'capacity' && /none left/.test(err.message));
  assert.deepEqual(sleeps.filter((ms) => ms !== POLL_MS), [30_000, 60_000]);
  assert.ok(patches >= 2);
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
  assert.deepEqual(CALLS.setActivation, ['cloudsql.instances.update']);
  assert.deepEqual(CALLS.get, ['cloudsql.instances.get']);
  assert.deepEqual(CALLS.getOperation, ['cloudsql.instances.get']);
});
