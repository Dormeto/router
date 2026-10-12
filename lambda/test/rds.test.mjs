import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverDatabases, isCompanion, rdsStatuses, startDatabases, stopDatabases } from '../src/lib/rds.mjs';
import { fakeClock, fakeRds, fakeRdsTagging, testConfig } from './fakes.mjs';

const TAG = { 'dormeto:workload': 'demo' };
const timing = () => { const c = fakeClock(); return { sleep: c.sleep, now: c.now, deadline: c.now() + 600_000 }; };

test('discovers tagged DB instances and clusters, skips cluster members and unsupported databases', async () => {
  const rds = fakeRds({
    instances: {
      app: { status: 'available', tags: TAG },
      'aurora-1': { status: 'available', cluster: 'aurora', tags: TAG },
      replica: { status: 'available', replicaSource: 'app', tags: TAG },
      other: { status: 'available', tags: { 'dormeto:workload': 'other' } },
    },
    clusters: { aurora: { status: 'available', tags: TAG }, v1: { status: 'available', engineMode: 'serverless', tags: TAG } },
  });
  const { backends, ignored } = await discoverDatabases({ rds, tagging: fakeRdsTagging(rds) }, testConfig());
  assert.deepEqual(backends, [{ kind: 'rds-instance', id: 'app' }, { kind: 'rds-cluster', id: 'aurora' }]);
  assert.deepEqual(ignored, [
    { id: 'replica', reason: 'read replica: cannot be stopped' },
    { id: 'v1', reason: 'Aurora Serverless v1: cannot be stopped' },
  ]);
  assert.equal(isCompanion(backends[0]), true);
  assert.equal(isCompanion({ kind: 'ecs', id: 'x' }), false);
});

test('database statuses', async () => {
  const rds = fakeRds({ instances: { a: { status: 'available' }, b: { status: 'stopped' }, c: { status: 'starting' } }, clusters: { k: { status: 'stopping' } } });
  const statuses = await rdsStatuses({ rds }, [{ kind: 'rds-instance', id: 'a' }, { kind: 'rds-instance', id: 'b' }, { kind: 'rds-instance', id: 'c' }, { kind: 'rds-cluster', id: 'k' }]);
  assert.deepEqual(statuses, { 'rds-instance:a': 'running', 'rds-instance:b': 'stopped', 'rds-instance:c': 'transitioning', 'rds-cluster:k': 'transitioning' });
});

test('stop stops available databases without waiting, and skips the others', async () => {
  const rds = fakeRds({ instances: { a: { status: 'available' }, b: { status: 'stopped' } }, clusters: { k: { status: 'available' } } });
  await stopDatabases({ rds }, [{ kind: 'rds-instance', id: 'a' }, { kind: 'rds-instance', id: 'b' }, { kind: 'rds-cluster', id: 'k' }]);
  assert.deepEqual(rds.state.calls, [['stop', 'a'], ['stop-cluster', 'k']]);
});

test('start waits for a stopping database, starts the stopped ones and waits until available', async () => {
  const rds = fakeRds({ instances: { a: { status: 'stopping' }, b: { status: 'available' } }, clusters: { k: { status: 'stopped' } } });
  await startDatabases({ rds }, [{ kind: 'rds-instance', id: 'a' }, { kind: 'rds-instance', id: 'b' }, { kind: 'rds-cluster', id: 'k' }], timing());
  assert.deepEqual(rds.state.calls, [['start-cluster', 'k'], ['start', 'a']]);
  assert.equal(rds.state.instances.a.status, 'available');
  assert.equal(rds.state.clusters.k.status, 'available');
});

test('start without waiting only issues the starts', async () => {
  const rds = fakeRds({ instances: { a: { status: 'stopped' } } });
  await startDatabases({ rds }, [{ kind: 'rds-instance', id: 'a' }], timing(), { wait: false });
  assert.deepEqual(rds.state.calls, [['start', 'a']]);
});

test('start reports a deadline when the databases are not available in time', async () => {
  const rds = fakeRds({ instances: { a: { status: 'stopped' } } });
  rds.startDBInstance = async () => { rds.state.instances.a.status = 'starting'; rds.state.instances.a.sticky = true; };
  const describe = rds.describeDBInstances;
  rds.describeDBInstances = async (input) => { const out = await describe(input); if (rds.state.instances.a.sticky) rds.state.instances.a.status = 'starting'; return out; };
  await assert.rejects(startDatabases({ rds }, [{ kind: 'rds-instance', id: 'a' }], timing()), (err) => err.code === 'DEADLINE');
});
