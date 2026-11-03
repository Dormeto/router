import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATES, buildTransition, createStore, fromItem, matches, toValue } from '../src/lib/state.mjs';

test('toValue and fromItem convert strings, numbers and booleans', () => {
  assert.deepEqual(toValue('a'), { S: 'a' });
  assert.deepEqual(toValue(3), { N: '3' });
  assert.deepEqual(toValue(true), { BOOL: true });
  assert.throws(() => toValue({}), TypeError);
  assert.deepEqual(fromItem({ state: { S: 'AWAKE' }, version: { N: '4' }, pendingWake: { BOOL: true } }),
    { state: 'AWAKE', version: 4, pendingWake: true });
});

test('matches evaluates state, wakeId, pendingWake and olderThan', () => {
  const run = { state: 'WAKING', wakeId: 'w1', wakeStartedAt: 100 };
  assert.equal(matches(run, { state: 'WAKING' }), true);
  assert.equal(matches(run, { state: ['ASLEEP', 'WAKING'] }), true);
  assert.equal(matches(run, { state: 'ASLEEP' }), false);
  assert.equal(matches(run, { state: 'WAKING', wakeId: 'w2' }), false);
  assert.equal(matches({ ...run, pendingWake: true }, { state: 'WAKING', pendingWake: false }), false);
  assert.equal(matches(run, { state: 'WAKING', pendingWake: false }), true);
  assert.equal(matches(run, { state: 'WAKING', olderThan: { field: 'wakeStartedAt', ms: 101 } }), true);
  assert.equal(matches(run, { state: 'WAKING', olderThan: { field: 'wakeStartedAt', ms: 100 } }), false);
  assert.equal(matches(run, { state: 'WAKING', olderThan: { field: 'missing', ms: 100 } }), false);
});

test('buildTransition builds a conditional update with version increment', () => {
  const input = buildTransition({
    table: 't', workloadId: 'demo', now: 42,
    cond: { state: [STATES.ASLEEP, STATES.FAILED], wakeId: 'w0', pendingWake: false, olderThan: { field: 'failedAt', ms: 10 } },
    set: { state: STATES.WAKING, wakeId: 'w1', wakeStartedAt: 42 },
    remove: ['failedAt'],
    increment: ['wakeCount'],
  });
  assert.equal(input.TableName, 't');
  assert.deepEqual(input.Key, { pk: { S: 'WL#demo' }, sk: { S: 'RUN' } });
  assert.equal(input.ReturnValues, 'ALL_NEW');
  assert.equal(input.ConditionExpression,
    '#state IN (:s0, :s1) AND #wakeId = :cwakeId AND (attribute_not_exists(#pendingWake) OR #pendingWake <> :true) AND #older < :older');
  assert.equal(input.UpdateExpression,
    'SET #version = if_not_exists(#version, :zero) + :one, #updatedAt = :now, #state = :v_state, #wakeId = :v_wakeId, #wakeStartedAt = :v_wakeStartedAt, #wakeCount = if_not_exists(#wakeCount, :zero) + :one REMOVE #failedAt');
  assert.deepEqual(input.ExpressionAttributeValues[':s1'], { S: 'FAILED' });
  assert.deepEqual(input.ExpressionAttributeValues[':v_wakeStartedAt'], { N: '42' });
  assert.deepEqual(input.ExpressionAttributeValues[':older'], { N: '10' });
  assert.equal(input.ExpressionAttributeNames['#older'], 'failedAt');
  assert.equal(input.ExpressionAttributeNames['#failedAt'], 'failedAt');
});

function fakeDynamo(handlers) {
  const calls = [];
  const wrap = (name) => async (input) => { calls.push([name, input]); return handlers[name](input); };
  return { calls, getItem: wrap('getItem'), updateItem: wrap('updateItem'), scan: wrap('scan'), query: wrap('query'), deleteItem: wrap('deleteItem') };
}

test('store reads config and run items with strong consistency', async () => {
  const dynamo = fakeDynamo({
    getItem: async ({ Key }) => (Key.sk.S === 'CFG'
      ? { Item: { config: { S: '{"workloadId":"demo","waitSeconds":20}' } } }
      : { Item: { state: { S: 'AWAKE' }, version: { N: '1' } } }),
  });
  const store = createStore({ dynamo, table: 't' });
  assert.deepEqual(await store.getConfig('demo'), { workloadId: 'demo', waitSeconds: 20 });
  assert.deepEqual(await store.getRun('demo'), { state: 'AWAKE', version: 1 });
  assert.ok(dynamo.calls.every(([, input]) => input.ConsistentRead === true));
});

test('store returns null for missing items', async () => {
  const store = createStore({ dynamo: fakeDynamo({ getItem: async () => ({}) }), table: 't' });
  assert.equal(await store.getConfig('x'), null);
  assert.equal(await store.getRun('x'), null);
});

test('store lists configs across scan pages', async () => {
  let page = 0;
  const dynamo = fakeDynamo({
    scan: async () => (page++ === 0
      ? { Items: [{ config: { S: '{"workloadId":"a"}' } }], LastEvaluatedKey: { pk: { S: 'x' } } }
      : { Items: [{ config: { S: '{"workloadId":"b"}' } }] }),
  });
  const configs = await createStore({ dynamo, table: 't' }).listConfigs();
  assert.deepEqual(configs.map((c) => c.workloadId), ['a', 'b']);
});

test('store transition returns the new run, or null when the condition fails', async () => {
  let fail = false;
  const dynamo = fakeDynamo({
    updateItem: async () => {
      if (fail) throw Object.assign(new Error('nope'), { name: 'ConditionalCheckFailedException' });
      return { Attributes: { state: { S: 'WAKING' }, version: { N: '2' } } };
    },
  });
  const store = createStore({ dynamo, table: 't', now: () => 7 });
  assert.deepEqual(await store.transition('demo', { cond: { state: 'ASLEEP' }, set: { state: 'WAKING' } }), { state: 'WAKING', version: 2 });
  assert.deepEqual(dynamo.calls[0][1].ExpressionAttributeValues[':now'], { N: '7' });
  fail = true;
  assert.equal(await store.transition('demo', { cond: { state: 'ASLEEP' }, set: { state: 'WAKING' } }), null);
});

test('store transition rethrows other errors', async () => {
  const dynamo = fakeDynamo({ updateItem: async () => { throw new Error('throttled'); } });
  await assert.rejects(createStore({ dynamo, table: 't' }).transition('demo', { cond: { state: 'AWAKE' } }), /throttled/);
});

test('store backend kinds are set on an existing run, its version untouched', async () => {
  const dynamo = fakeDynamo({ updateItem: async () => ({}) });
  assert.equal(await createStore({ dynamo, table: 't' }).setBackendKinds('demo', 'asg,rds-instance'), true);
  const [[, input]] = dynamo.calls;
  assert.deepEqual(input.Key, { pk: { S: 'WL#demo' }, sk: { S: 'RUN' } });
  assert.equal(input.UpdateExpression, 'SET #kinds = :kinds');
  assert.equal(input.ConditionExpression, 'attribute_exists(pk)');
  assert.deepEqual(input.ExpressionAttributeValues, { ':kinds': { S: 'asg,rds-instance' } });
});

test('store hibernated: what a nap hibernated, written on an existing run at once whatever its state, its version untouched', async () => {
  const dynamo = fakeDynamo({ updateItem: async () => ({}) });
  assert.equal(await createStore({ dynamo, table: 't' }).setHibernated('demo', { ids: ['i-0123456789abcdef0'], at: 5 }), true);
  const [[, input]] = dynamo.calls;
  assert.deepEqual(input.Key, { pk: { S: 'WL#demo' }, sk: { S: 'RUN' } });
  assert.equal(input.UpdateExpression, 'SET #hibernated = :hibernated');
  assert.equal(input.ConditionExpression, 'attribute_exists(pk)');
  assert.deepEqual(input.ExpressionAttributeNames, { '#hibernated': 'hibernated' });
  assert.deepEqual(JSON.parse(input.ExpressionAttributeValues[':hibernated'].S), { ids: ['i-0123456789abcdef0'], at: 5 });
});

test('store hibernated: a run offboarded meanwhile is not recorded, never recreated, never throwing; other errors throw', async () => {
  const conditional = Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' });
  const gone = fakeDynamo({ updateItem: async () => { throw conditional; } });
  assert.equal(await createStore({ dynamo: gone, table: 't' }).setHibernated('demo', { ids: ['i-0123456789abcdef0'], at: 5 }), false);
  const throttled = fakeDynamo({ updateItem: async () => { throw Object.assign(new Error('slow down'), { name: 'ThrottlingException' }); } });
  await assert.rejects(createStore({ dynamo: throttled, table: 't' }).setHibernated('demo', { ids: [], at: 5 }), /slow down/);
});

test('store pendingWake and holder updates are conditional', async () => {
  const outcomes = [{}, Object.assign(new Error('c'), { name: 'ConditionalCheckFailedException' })];
  const dynamo = fakeDynamo({ updateItem: async () => { const o = outcomes.shift() ?? {}; if (o instanceof Error) throw o; return o; } });
  const store = createStore({ dynamo, table: 't' });
  assert.equal(await store.setPendingWake('demo'), true);
  assert.equal(await store.tryAcquireHolder('demo', 5), false);
  await store.releaseHolder('demo');
  const [pending, acquire, release] = dynamo.calls.map(([, i]) => i);
  assert.equal(pending.ConditionExpression, '#state = :napping AND (attribute_not_exists(#pendingWake) OR #pendingWake <> :true)');
  assert.equal(acquire.ConditionExpression, 'attribute_not_exists(#holders) OR #holders < :max');
  assert.deepEqual(acquire.ExpressionAttributeValues[':max'], { N: '5' });
  assert.equal(release.UpdateExpression, 'ADD #holders :minus');
  assert.equal(release.ConditionExpression, '#holders > :zero');
});

const DAY = Date.UTC(2026, 9, 4, 13, 30); // 2026-10-04T13:30:00Z

test('store count adds to the daily statistics item, with a TTL', async () => {
  const dynamo = fakeDynamo({ updateItem: async () => ({}) });
  const store = createStore({ dynamo, table: 't', now: () => DAY });
  await store.count('demo', 'ignored:bot user agent');
  const [[, input]] = dynamo.calls;
  assert.deepEqual(input.Key, { pk: { S: 'WL#demo' }, sk: { S: 'STATS#2026-10-04' } });
  assert.equal(input.UpdateExpression, 'ADD #c :one SET #exp = if_not_exists(#exp, :exp)');
  assert.deepEqual(input.ExpressionAttributeNames, { '#c': 'ignored:bot user agent', '#exp': 'expiresAt' });
  assert.deepEqual(input.ExpressionAttributeValues[':one'], { N: '1' });
  // Kept 35 days after the end of the day.
  assert.deepEqual(input.ExpressionAttributeValues[':exp'], { N: String(Date.UTC(2026, 9, 5) / 1000 + 35 * 86400) });
});

test('store getStats queries the day range and adds the counters up', async () => {
  const dynamo = fakeDynamo({
    query: async () => ({
      Items: [
        { sk: { S: 'STATS#2026-10-04' }, 'ignored:HEAD': { N: '2' }, 'wake:probe': { N: '1' }, deferred: { N: '3' }, 'deferred:list ipsum': { N: '1' }, expiresAt: { N: '1' } },
        { sk: { S: 'STATS#2026-10-01' }, 'ignored:HEAD': { N: '5' }, 'ignored:rule office': { N: '4' }, 'wake:normal': { N: '2' } },
      ],
    }),
  });
  const stats = await createStore({ dynamo, table: 't', now: () => DAY }).getStats('demo', 7);
  const [[, input]] = dynamo.calls;
  assert.equal(input.KeyConditionExpression, '#pk = :pk AND #sk BETWEEN :from AND :to');
  assert.deepEqual(input.ExpressionAttributeValues[':from'], { S: 'STATS#2026-09-28' });
  assert.deepEqual(input.ExpressionAttributeValues[':to'], { S: 'STATS#2026-10-04' });
  assert.deepEqual(stats, {
    days: 7,
    since: '2026-09-28',
    today: { ignored: { HEAD: 2 }, deferred: { 'browser mode': 3, 'list ipsum': 1 }, wakes: { probe: 1 } },
    total: { ignored: { HEAD: 7, 'rule office': 4 }, deferred: { 'browser mode': 3, 'list ipsum': 1 }, wakes: { probe: 1, normal: 2 } },
  });
});

test('store list metadata and versioned parts use the LIST#<name> partition', async () => {
  const pages = [
    { Items: [{ sk: { S: 'PART#v1#0000' }, data: { B: Buffer.from('a') } }], LastEvaluatedKey: { pk: { S: 'x' } } },
    { Items: [{ sk: { S: 'PART#v1#0001' }, data: { B: Buffer.from('b') } }] },
  ];
  const dynamo = fakeDynamo({
    getItem: async () => ({ Item: { version: { S: 'v1' }, parts: { N: '2' }, url: { S: 'https://x' } } }),
    updateItem: async () => ({}),
    query: async () => pages.shift(),
  });
  const store = createStore({ dynamo, table: 't' });
  assert.deepEqual(await store.getListMeta('ipsum'), { version: 'v1', parts: 2, url: 'https://x' });
  await store.setListMeta('ipsum', { version: 'v2', entries: 10 }, ['error']);
  await store.putListPart('ipsum', 'v2', 1, Buffer.from('zz'), 99);
  const parts = await store.getListParts('ipsum', 'v1');
  assert.deepEqual(parts.map((p) => Buffer.from(p).toString()), ['a', 'b']);
  const [[, get], [, meta], [, part], [, query]] = dynamo.calls;
  assert.deepEqual(get.Key, { pk: { S: 'LIST#ipsum' }, sk: { S: 'META' } });
  assert.equal(meta.UpdateExpression, 'SET #f0 = :f0, #f1 = :f1 REMOVE #r0');
  assert.deepEqual(meta.ExpressionAttributeNames, { '#f0': 'version', '#f1': 'entries', '#r0': 'error' });
  assert.deepEqual(part.Key, { pk: { S: 'LIST#ipsum' }, sk: { S: 'PART#v2#0001' } });
  assert.deepEqual(part.ExpressionAttributeValues[':data'], { B: Buffer.from('zz') });
  assert.equal(query.KeyConditionExpression, '#pk = :pk AND begins_with(#sk, :prefix)');
  assert.deepEqual(query.ExpressionAttributeValues[':prefix'], { S: 'PART#v1#' });
});

test('store records the last scheduled check in the ROUTER / CHECK item', async () => {
  const dynamo = fakeDynamo({ updateItem: async () => ({}), getItem: async () => ({ Item: { lastScheduledCheckAt: { N: '42' } } }) });
  const store = createStore({ dynamo, table: 't' });
  await store.recordScheduledCheck(42);
  assert.deepEqual(await store.getCheck(), { lastScheduledCheckAt: 42 });
  const [[, update], [, get]] = dynamo.calls;
  assert.deepEqual(update.Key, { pk: { S: 'ROUTER' }, sk: { S: 'CHECK' } });
  assert.equal(update.UpdateExpression, 'SET #at = :at');
  assert.deepEqual(get.Key, { pk: { S: 'ROUTER' }, sk: { S: 'CHECK' } });
});

test('store leases the check (one at a time, until it ends or the lease expires) and keeps where it stopped', async () => {
  let held = false;
  const dynamo = fakeDynamo({
    updateItem: async (input) => {
      if (input.ConditionExpression?.startsWith('attribute_not_exists(#holder)') && held) throw Object.assign(new Error('held'), { name: 'ConditionalCheckFailedException' });
      if (input.ConditionExpression?.startsWith('attribute_not_exists(#holder)')) held = true;
      return {};
    },
  });
  const store = createStore({ dynamo, table: 't' });
  assert.equal(await store.acquireCheckLease('c1', 900_000, 0), true);
  assert.equal(await store.acquireCheckLease('c2', 900_100, 100), false);
  await store.releaseCheckLease('c1');
  await store.setCheckCursor('w0420');
  await store.setCheckCursor(null);
  const [[, lease], , [, release], [, cursor], [, cleared]] = dynamo.calls;
  assert.deepEqual(lease.Key, { pk: { S: 'ROUTER' }, sk: { S: 'CHECK' } });
  assert.equal(lease.ConditionExpression, 'attribute_not_exists(#holder) OR #until < :now');
  assert.equal(lease.UpdateExpression, 'SET #holder = :holder, #until = :until');
  assert.deepEqual([lease.ExpressionAttributeValues[':holder'], lease.ExpressionAttributeValues[':until'], lease.ExpressionAttributeValues[':now']], [{ S: 'c1' }, { N: '900000' }, { N: '0' }]);
  assert.equal(release.ConditionExpression, '#holder = :holder');
  assert.equal(release.UpdateExpression, 'REMOVE #holder, #until');
  assert.equal(cursor.UpdateExpression, 'SET #cursor = :cursor');
  assert.equal(cleared.UpdateExpression, 'REMOVE #cursor');
});

// --- Pauses ---------------------------------------------------------------------------------------------------------

test('store writes a pause as one JSON attribute: PAUSE for an operator, PAUSE#<exclusion> for an exclusion', async () => {
  const dynamo = fakeDynamo({ updateItem: async () => ({}) });
  const store = createStore({ dynamo, table: 't' });
  await store.putPause('demo', { by: 'ops@example.com', at: 42, reason: 'incident', keepAsleep: false });
  await store.putPause(null, { by: 'ops@example.com', at: 43, reason: 'freeze', until: 99, keepAsleep: true });
  await store.putPause('demo', { by: 'ops@example.com', at: 44, reason: 'excluded: migration', keepAsleep: false, exclusionId: 'x1' });
  const [[, workload], [, router], [, exclusion]] = dynamo.calls;
  assert.deepEqual(workload.Key, { pk: { S: 'WL#demo' }, sk: { S: 'PAUSE' } });
  assert.equal(workload.UpdateExpression, 'SET #pause = :pause, #at = :at');
  assert.deepEqual(JSON.parse(workload.ExpressionAttributeValues[':pause'].S), { by: 'ops@example.com', at: 42, reason: 'incident', keepAsleep: false });
  assert.deepEqual(workload.ExpressionAttributeValues[':at'], { N: '42' });
  assert.deepEqual(router.Key, { pk: { S: 'ROUTER' }, sk: { S: 'PAUSE' } });
  assert.deepEqual(exclusion.Key, { pk: { S: 'WL#demo' }, sk: { S: 'PAUSE#x1' } });
});

test('store reads the pauses of a workload and of the router, and lists them all', async () => {
  const item = (pk, sk, pause) => ({ pk: { S: pk }, sk: { S: sk }, pause: { S: JSON.stringify(pause) }, at: { N: String(pause.at) } });
  const pages = [
    { Items: [item('WL#demo', 'PAUSE', { at: 1, reason: 'a' }), item('ROUTER', 'PAUSE', { at: 2, reason: 'b' })], LastEvaluatedKey: { pk: { S: 'x' } } },
    { Items: [item('WL#other', 'PAUSE#x1', { at: 3, reason: 'c', exclusionId: 'x1' })] },
  ];
  const dynamo = fakeDynamo({
    query: async ({ ExpressionAttributeValues }) => ({ Items: ExpressionAttributeValues[':pk'].S === 'ROUTER' ? [item('ROUTER', 'PAUSE', { at: 2, reason: 'b' })] : [item('WL#demo', 'PAUSE', { at: 1, reason: 'a' })] }),
    scan: async () => pages.shift(),
  });
  const store = createStore({ dynamo, table: 't' });
  assert.deepEqual(await store.getPauses('demo'), [{ workloadId: 'demo', at: 1, reason: 'a' }]);
  assert.deepEqual(await store.getPauses(null), [{ workloadId: null, at: 2, reason: 'b' }]);
  assert.deepEqual(await store.listPauses(), [
    { workloadId: 'demo', at: 1, reason: 'a' }, { workloadId: null, at: 2, reason: 'b' }, { workloadId: 'other', at: 3, reason: 'c', exclusionId: 'x1' },
  ]);
  const [[, workload], [, router], [, scan]] = dynamo.calls;
  assert.equal(workload.KeyConditionExpression, '#pk = :pk AND begins_with(#sk, :pause)');
  assert.deepEqual(workload.ExpressionAttributeValues, { ':pk': { S: 'WL#demo' }, ':pause': { S: 'PAUSE' } });
  assert.equal(workload.ConsistentRead, true);
  assert.deepEqual(router.ExpressionAttributeValues[':pk'], { S: 'ROUTER' });
  assert.equal(scan.FilterExpression, 'begins_with(#sk, :pause)');
});

test('store deletes a pause, only if it is still the same one when its time is given', async () => {
  const dynamo = fakeDynamo({
    deleteItem: async ({ ConditionExpression }) => {
      if (ConditionExpression) throw Object.assign(new Error('changed'), { name: 'ConditionalCheckFailedException' });
      return {};
    },
  });
  const store = createStore({ dynamo, table: 't' });
  assert.equal(await store.deletePause('demo'), true);
  assert.equal(await store.deletePause(null, { exclusionId: 'x1', at: 42 }), false);
  const [[, plain], [, conditional]] = dynamo.calls;
  assert.deepEqual(plain.Key, { pk: { S: 'WL#demo' }, sk: { S: 'PAUSE' } });
  assert.equal(plain.ConditionExpression, undefined);
  assert.deepEqual(conditional.Key, { pk: { S: 'ROUTER' }, sk: { S: 'PAUSE#x1' } });
  assert.equal(conditional.ConditionExpression, '#at = :at');
  assert.deepEqual(conditional.ExpressionAttributeValues, { ':at': { N: '42' } });
});

// --- Onboarding --------------------------------------------------------------------------------------------------------

test('store writes a workload configuration and its initial runtime state only once', async () => {
  const dynamo = fakeDynamo({
    updateItem: async ({ ConditionExpression }) => {
      if (ConditionExpression) throw Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' });
      return {};
    },
  });
  const store = createStore({ dynamo, table: 't' });
  await store.putConfig('shop', { workloadId: 'shop', idleMinutes: 15 });
  assert.equal(await store.initRun('shop', 42), false);
  const [[, cfg], [, run]] = dynamo.calls;
  assert.deepEqual(cfg.Key, { pk: { S: 'WL#shop' }, sk: { S: 'CFG' } });
  assert.equal(cfg.UpdateExpression, 'SET #config = :config');
  assert.deepEqual(JSON.parse(cfg.ExpressionAttributeValues[':config'].S), { workloadId: 'shop', idleMinutes: 15 });
  assert.deepEqual(run.Key, { pk: { S: 'WL#shop' }, sk: { S: 'RUN' } });
  assert.equal(run.ConditionExpression, 'attribute_not_exists(#pk)');
  assert.equal(run.UpdateExpression, 'SET #state = :awake, #version = :zero, #awakeSince = :at, #holders = :zero, #wakeCount = :zero');
  assert.deepEqual(run.ExpressionAttributeValues[':at'], { N: '42' });
});

test('store deletes every item of a workload but its statistics (they expire)', async () => {
  const dynamo = fakeDynamo({
    query: async () => ({ Items: ['CFG', 'RUN', 'PAUSE', 'PAUSE#x1', 'STATS#2026-10-05'].map((sk) => ({ pk: { S: 'WL#shop' }, sk: { S: sk } })) }),
    deleteItem: async () => ({}),
  });
  await createStore({ dynamo, table: 't' }).deleteWorkload('shop');
  const deleted = dynamo.calls.filter(([name]) => name === 'deleteItem').map(([, input]) => input.Key.sk.S);
  assert.deepEqual(deleted, ['CFG', 'RUN', 'PAUSE', 'PAUSE#x1']);
  assert.deepEqual(dynamo.calls[0][1].ExpressionAttributeValues, { ':pk': { S: 'WL#shop' } });
});

test('store records drift events of a workload, kept 90 days, and lists the newest first', async () => {
  const dynamo = fakeDynamo({ updateItem: async () => ({}), query: async () => ({ Items: [{ event: { S: '{"kind":"shadow created"}' } }] }) });
  const store = createStore({ dynamo, table: 't', now: () => 1_000_000 });
  await store.putDrift('shop', { at: '2026-10-05T12:00:00.000Z', kind: 'shadow created', by: 'event' });
  assert.deepEqual(await store.listDrift('shop', 10), [{ kind: 'shadow created' }]);
  const [[, put], [, query]] = dynamo.calls;
  assert.equal(put.Key.pk.S, 'WL#shop');
  assert.match(put.Key.sk.S, /^DRIFT#2026-10-05T12:00:00.000Z#/);
  assert.deepEqual(put.ExpressionAttributeValues[':exp'], { N: String(Math.floor(Date.parse('2026-10-05T12:00:00.000Z') / 1000) + 90 * 86400) });
  assert.equal(query.ScanIndexForward, false);
  assert.equal(query.Limit, 10);
  assert.deepEqual(query.ExpressionAttributeValues[':prefix'], { S: 'DRIFT#' });
});

test('store putConfig can require the configuration to exist (false when it does not)', async () => {
  let fail = false;
  const dynamo = fakeDynamo({ updateItem: async () => { if (fail) throw Object.assign(new Error('nope'), { name: 'ConditionalCheckFailedException' }); return {}; } });
  const store = createStore({ dynamo, table: 't' });
  assert.equal(await store.putConfig('demo', { workloadId: 'demo' }, { mustExist: true }), true);
  assert.equal(dynamo.calls[0][1].ConditionExpression, 'attribute_exists(#pk)');
  assert.equal(dynamo.calls[0][1].ExpressionAttributeNames['#pk'], 'pk');
  fail = true;
  assert.equal(await store.putConfig('demo', { workloadId: 'demo' }, { mustExist: true }), false);
  await store.putConfig('demo', { workloadId: 'demo' }).catch(() => {});
  assert.equal(dynamo.calls[2][1].ConditionExpression, undefined, 'onboarding creates it');
});

test('store schedules: written beside the workload, read, deleted (true only when one was there)', async () => {
  let stored = null;
  const dynamo = fakeDynamo({
    updateItem: async (input) => { stored = input; return {}; },
    getItem: async () => (stored ? { Item: { schedule: stored.ExpressionAttributeValues[':schedule'] } } : {}),
    deleteItem: async () => ({ Attributes: { schedule: { S: '{}' } } }),
  });
  const store = createStore({ dynamo, table: 't' });
  await store.putSchedule('demo', { maxNapDays: 7, by: 'me', at: 5 });
  assert.deepEqual(stored.Key, { pk: { S: 'WL#demo' }, sk: { S: 'SCHEDULE' } });
  assert.deepEqual(await store.getSchedule('demo'), { maxNapDays: 7, by: 'me', at: 5 });
  assert.equal(await store.deleteSchedule('demo'), true);
  assert.equal(dynamo.calls.at(-1)[1].ReturnValues, 'ALL_OLD');
  const none = createStore({ dynamo: fakeDynamo({ deleteItem: async () => ({}), getItem: async () => ({}) }), table: 't' });
  assert.equal(await none.deleteSchedule('demo'), false);
  assert.equal(await none.getSchedule('demo'), null);
});

test('store schedules: replaced or removed only when still as read, a save since kept', async () => {
  const calls = [];
  let changed = false;
  const failing = async (input) => {
    calls.push(input);
    if (changed) throw Object.assign(new Error('changed'), { name: 'ConditionalCheckFailedException' });
    return {};
  };
  const store = createStore({ dynamo: fakeDynamo({ updateItem: failing, deleteItem: failing }), table: 't' });
  const from = { timeZone: 'UTC', windows: [], maxNapDays: 7, by: 'me', at: 5 };
  assert.equal(await store.replaceSchedule('demo', from, { ...from, maxNapDays: 8 }), true);
  assert.equal(calls[0].ConditionExpression, '#schedule = :from');
  assert.deepEqual(calls[0].ExpressionAttributeValues, { ':from': { S: JSON.stringify(from) }, ':next': { S: JSON.stringify({ ...from, maxNapDays: 8 }) } });
  assert.equal(await store.replaceSchedule('demo', from, null), true);
  assert.deepEqual(calls[1].Key, { pk: { S: 'WL#demo' }, sk: { S: 'SCHEDULE' } });
  assert.equal(calls[1].ConditionExpression, '#schedule = :from');
  changed = true;
  assert.equal(await store.replaceSchedule('demo', from, null), false);
  const broken = createStore({ dynamo: fakeDynamo({ updateItem: async () => { throw new Error('throttled'); } }), table: 't' });
  await assert.rejects(broken.replaceSchedule('demo', from, from), /throttled/);
});

test('one scan lists the configurations and the schedules; listConfigs keeps answering the configurations only', async () => {
  const items = [
    { pk: { S: 'WL#a' }, sk: { S: 'CFG' }, config: { S: '{"workloadId":"a"}' } },
    { pk: { S: 'WL#a' }, sk: { S: 'SCHEDULE' }, schedule: { S: '{"maxNapDays":3}' } },
    { pk: { S: 'WL#b' }, sk: { S: 'CFG' }, config: { S: '{"workloadId":"b"}' } },
  ];
  const dynamo = fakeDynamo({ scan: async () => ({ Items: items }) });
  const store = createStore({ dynamo, table: 't' });
  const { configs, schedules } = await store.listWorkloads();
  assert.deepEqual(configs.map((c) => c.workloadId), ['a', 'b']);
  assert.deepEqual([...schedules], [['a', { maxNapDays: 3 }]]);
  assert.match(dynamo.calls[0][1].FilterExpression, /IN/);
  assert.deepEqual((await store.listConfigs()).map((c) => c.workloadId), ['a', 'b']);
});

test('a schedule item that cannot be read is logged and skipped: the scan goes on, the workload listed without one', async () => {
  const items = [
    { pk: { S: 'WL#a' }, sk: { S: 'CFG' }, config: { S: '{"workloadId":"a"}' } },
    { pk: { S: 'WL#a' }, sk: { S: 'SCHEDULE' }, schedule: { S: '{"maxNapDays":' } },
    { pk: { S: 'WL#b' }, sk: { S: 'CFG' }, config: { S: '{"workloadId":"b"}' } },
    { pk: { S: 'WL#b' }, sk: { S: 'SCHEDULE' }, schedule: { S: '{"maxNapDays":3}' } },
  ];
  const logged = [];
  const log = { info() {}, warn: (event, data) => logged.push([event, data]), error() {} };
  const store = createStore({ dynamo: fakeDynamo({ scan: async () => ({ Items: items }) }), table: 't', log });
  const { configs, schedules } = await store.listWorkloads();
  assert.deepEqual(configs.map((c) => c.workloadId), ['a', 'b']);
  assert.deepEqual([...schedules], [['b', { maxNapDays: 3 }]]);
  assert.deepEqual(logged.map(([event, data]) => [event, data.workloadId]), [['ScheduleSkipped', 'a']]);
  assert.match(logged[0][1].error, /JSON/);
});

test('router settings and the manager settings copy are ROUTER items; neither hibernate nor joinMinutes deletes the settings', async () => {
  const items = new Map();
  const expressions = [];
  const key = (k) => `${k.pk.S}/${k.sk.S}`;
  const dynamo = fakeDynamo({
    getItem: async ({ Key }) => ({ Item: items.get(key(Key)) }),
    updateItem: async ({ Key, UpdateExpression, ExpressionAttributeNames: n, ExpressionAttributeValues: v }) => {
      expressions.push(UpdateExpression);
      const item = {};
      for (const [name, attr] of Object.entries(n)) if (v[`:${name.slice(1)}`]) item[attr] = v[`:${name.slice(1)}`];
      items.set(key(Key), item);
    },
    deleteItem: async ({ Key }) => { items.delete(key(Key)); },
  });
  const store = createStore({ dynamo, table: 't' });
  assert.equal(await store.getRouterSettings(), null);
  assert.equal(await store.getManagerSettings(), null);
  await store.putRouterSettings({ hibernate: false, by: 'ana', at: 5 });
  assert.deepEqual(await store.getRouterSettings(), { hibernate: false, by: 'ana', at: 5 });
  assert.ok(items.has('ROUTER/SETTINGS'));
  await store.putRouterSettings({ by: 'ana', at: 6 });
  assert.equal(await store.getRouterSettings(), null);
  await store.putRouterSettings({ hibernate: true, by: 'ana', at: 7 });
  await store.putRouterSettings({ hibernate: null, by: 'ana', at: 8 });
  assert.equal(await store.getRouterSettings(), null);
  // Either one keeps the item, and the one unset is removed from it.
  await store.putRouterSettings({ joinMinutes: 30, by: 'ana', at: 9 });
  assert.deepEqual(await store.getRouterSettings(), { joinMinutes: 30, by: 'ana', at: 9 });
  assert.equal(expressions.at(-1), 'SET #joinMinutes = :joinMinutes, #by = :by, #at = :at REMOVE #hibernate, #defaults');
  await store.putRouterSettings({ joinMinutes: 0, hibernate: null, by: 'ana', at: 10 });
  assert.deepEqual(await store.getRouterSettings(), { joinMinutes: 0, by: 'ana', at: 10 });
  await store.putRouterSettings({ hibernate: true, joinMinutes: 15, by: 'ana', at: 11 });
  // Settings at scale: the router's defaults, as JSON, alone enough to keep the item.
  await store.putRouterSettings({ defaults: { idleMinutes: 30, noWakeRules: [{ name: 'h', pathPrefixes: ['/health'] }] }, by: 'ana', at: 12 });
  assert.deepEqual(await store.getRouterSettings(), { defaults: { idleMinutes: 30, noWakeRules: [{ name: 'h', pathPrefixes: ['/health'] }] }, by: 'ana', at: 12 });
  await store.putRouterSettings({ defaults: {}, by: 'ana', at: 13 });
  assert.equal(await store.getRouterSettings(), null);
  await store.putRouterSettings({ hibernate: true, joinMinutes: 15, by: 'ana', at: 11 });
  assert.deepEqual(await store.getRouterSettings(), { hibernate: true, joinMinutes: 15, by: 'ana', at: 11 });
  assert.equal(expressions.at(-1), 'SET #hibernate = :hibernate, #joinMinutes = :joinMinutes, #by = :by, #at = :at REMOVE #defaults');
  await store.putRouterSettings({ hibernate: false, joinMinutes: null, by: 'ana', at: 12 });
  assert.deepEqual(await store.getRouterSettings(), { hibernate: false, by: 'ana', at: 12 });
  assert.equal(expressions.at(-1), 'SET #hibernate = :hibernate, #by = :by, #at = :at REMOVE #joinMinutes, #defaults');
  await store.putRouterSettings({ hibernate: null, joinMinutes: null, by: 'ana', at: 13 });
  assert.equal(await store.getRouterSettings(), null);
  assert.equal(items.has('ROUTER/SETTINGS'), false);
  assert.deepEqual(await store.getKubeProxies(), {});
  const pings = { 'c-1': { name: 'dmt-kube-c-1', ok: true, version: '0.33.0', at: 5 } };
  await store.putKubeProxies(pings);
  assert.deepEqual(await store.getKubeProxies(), pings);
  assert.ok(items.has('ROUTER/KUBE-PROXIES'));
  const copy = { hibernate: true, etag: '"e1"', readAt: 7, error: null };
  await store.putManagerSettings(copy);
  assert.deepEqual(await store.getManagerSettings(), copy);
  await store.putManagerSettings({ hibernate: false, etag: null, readAt: 8, error: 'S3 SlowDown' });
  assert.deepEqual(await store.getManagerSettings(), { hibernate: false, etag: null, readAt: 8, error: 'S3 SlowDown' });
  assert.ok(items.has('ROUTER/MANAGER-SETTINGS'));
});

// --- The waiting page's items (branded waiting page design §5, §6) ----------------------------------------------------

test('the waiting page levels have their own items: WL#<id>/PAGE and ROUTER/PAGE, each field its own string attribute, written with who and when', async () => {
  const dynamo = fakeDynamo({ updateItem: async () => ({}) });
  const store = createStore({ dynamo, table: 't' });
  const page = { mode: 'template', title: 'Acme', description: 'Sleeps.\nWakes.' };
  await store.putWaitingPage({ workloadId: 'shop' }, page, { by: 'ana', at: 5 });
  await store.putWaitingPage('router', page, { by: 'ana', at: 6 });
  assert.deepEqual(dynamo.calls.map(([, input]) => input.Key), [
    { pk: { S: 'WL#shop' }, sk: { S: 'PAGE' } }, { pk: { S: 'ROUTER' }, sk: { S: 'PAGE' } }
  ]);
  const [, put] = dynamo.calls[0];
  assert.equal(put.UpdateExpression, 'SET #mode = :mode, #title = :title, #description = :description, #by = :by, #at = :at REMOVE #icon, #html');
  const values = put.ExpressionAttributeValues;
  assert.deepEqual([values[':mode'], values[':title'], values[':description'], values[':by'], values[':at']],
    [{ S: 'template' }, { S: 'Acme' }, { S: 'Sleeps.\nWakes.' }, { S: 'ana' }, { N: '5' }]);
  assert.ok(Object.values(values).every((v) => 'S' in v || 'N' in v), 'nothing nested');
  // A workload named like a level is still a workload.
  await store.putWaitingPage({ workloadId: 'router' }, page, { by: 'ana', at: 8 });
  assert.deepEqual(dynamo.calls[2][1].Key, { pk: { S: 'WL#router' }, sk: { S: 'PAGE' } });
  await assert.rejects(store.putWaitingPage('demo', page, { by: 'ana', at: 9 }), TypeError);
  // The organization's page is never a table item.
  await assert.rejects(store.putWaitingPage('organization', page, { by: 'ana', at: 9 }), TypeError);
  await assert.rejects(store.getWaitingPage('organization'), TypeError);
});

test('the largest page, with the characters that used to expand, stays under DynamoDB\'s 400 KB item (attribute names and values counted)', async () => {
  // What DynamoDB counts: the key and every attribute's name and value in bytes.
  const sizeOf = (input) => {
    let bytes = Buffer.byteLength(input.Key.pk.S) + Buffer.byteLength(input.Key.sk.S) + 4;
    for (const [reference, value] of Object.entries(input.ExpressionAttributeValues)) bytes += Buffer.byteLength(input.ExpressionAttributeNames[`#${reference.slice(1)}`]) + Buffer.byteLength(value.S ?? value.N);
    return bytes;
  };
  for (const filler of ['<td>x</td>', '"\\', '\n\t', 'é€😀', '\u0001', '<>&']) {
    const html = filler.repeat(Math.ceil(256 * 1024 / Buffer.byteLength(filler)));
    const cut = Buffer.from(html).subarray(0, 256 * 1024).toString('utf8').replaceAll('\uFFFD', '');
    const dynamo = fakeDynamo({ updateItem: async () => ({}) });
    await createStore({ dynamo, table: 't' }).putWaitingPage({ workloadId: 'shop' }, { mode: 'custom', html: cut }, { by: 'ana', at: 5 });
    const size = sizeOf(dynamo.calls[0][1]);
    assert.ok(size > 255 * 1024 && size < 257 * 1024 + 512, `${JSON.stringify(filler)}: ${size} bytes`);
  }
});

test('putWaitingPage leaves no trace of a nested `page` attribute: no such item exists', async () => {
  const dynamo = fakeDynamo({ updateItem: async () => ({}) });
  await createStore({ dynamo, table: 't' }).putWaitingPage({ workloadId: 'shop' }, { mode: 'template', title: 'T' }, { by: 'ana', at: 5 });
  const input = dynamo.calls[0][1];
  assert.ok(!/#page\b/.test(input.UpdateExpression), input.UpdateExpression);
  assert.ok(!('#page' in input.ExpressionAttributeNames));
});

test('getWaitingPage reads { page, by, at } from the attributes (no by: written by Terraform), eventually consistent on request; an item with no mode reads as none', async () => {
  const items = {
    'WL#a/PAGE': { mode: { S: 'template' }, title: { S: 'A' }, by: { S: 'ana' }, at: { N: '5' } },
    'WL#b/PAGE': { mode: { S: 'custom' }, html: { S: '<p>x</p>' } },
    'WL#c/PAGE': { title: { S: 'no mode' } },
  };
  const dynamo = fakeDynamo({ getItem: async ({ Key }) => ({ Item: items[`${Key.pk.S}/${Key.sk.S}`] }) });
  const store = createStore({ dynamo, table: 't' });
  assert.deepEqual(await store.getWaitingPage({ workloadId: 'a' }), { page: { mode: 'template', title: 'A' }, by: 'ana', at: 5 });
  assert.deepEqual(await store.getWaitingPage({ workloadId: 'b' }), { page: { mode: 'custom', html: '<p>x</p>' }, by: null, at: null });
  assert.deepEqual(await store.getWaitingPage({ workloadId: 'c' }), { page: null, by: null, at: null });
  assert.equal(await store.getWaitingPage({ workloadId: 'none' }), null);
  assert.equal(dynamo.calls[0][1].ConsistentRead, true);
  await store.getWaitingPage({ workloadId: 'a' }, { eventual: true });
  assert.equal(dynamo.calls.at(-1)[1].ConsistentRead, false);
});

test('deleteWaitingPage tells whether there was one; the favicon item keeps { icon, fetchedAt, error } in WL#<id>/FAVICON', async () => {
  let stored;
  const dynamo = fakeDynamo({
    deleteItem: async () => ({ Attributes: { pk: { S: 'x' } } }),
    updateItem: async (input) => { stored = input; return {}; },
    getItem: async () => ({ Item: { favicon: { S: stored.ExpressionAttributeValues[':favicon'].S } } }),
  });
  const store = createStore({ dynamo, table: 't' });
  assert.equal(await store.deleteWaitingPage('router'), true);
  assert.deepEqual(dynamo.calls[0][1].Key, { pk: { S: 'ROUTER' }, sk: { S: 'PAGE' } });
  const favicon = { icon: 'data:image/png;base64,AA==', fetchedAt: 9, error: null };
  await store.putFavicon('shop', favicon);
  assert.deepEqual(stored.Key, { pk: { S: 'WL#shop' }, sk: { S: 'FAVICON' } });
  assert.deepEqual(await store.getFavicon('shop'), favicon);
  assert.equal(dynamo.calls.at(-1)[1].ConsistentRead, true);
  await store.getFavicon('shop', { eventual: true });
  assert.equal(dynamo.calls.at(-1)[1].ConsistentRead, false);
});

test('the check\'s scan reads configurations and schedules only: PAGE and FAVICON items (up to 256 KiB) are never listed, and offboarding removes them', async () => {
  const dynamo = fakeDynamo({
    scan: async () => ({ Items: [{ pk: { S: 'WL#a' }, sk: { S: 'CFG' }, config: { S: '{"workloadId":"a"}' } }] }),
    query: async () => ({ Items: ['CFG', 'RUN', 'PAGE', 'FAVICON', 'STATS#2026-10-05'].map((sk) => ({ pk: { S: 'WL#shop' }, sk: { S: sk } })) }),
    deleteItem: async () => ({}),
  });
  const store = createStore({ dynamo, table: 't' });
  await store.listWorkloads();
  assert.deepEqual(dynamo.calls[0][1].ExpressionAttributeValues, { ':cfg': { S: 'CFG' }, ':schedule': { S: 'SCHEDULE' } });
  assert.equal(dynamo.calls[0][1].FilterExpression, '#sk IN (:cfg, :schedule)');
  await store.deleteWorkload('shop');
  assert.deepEqual(dynamo.calls.filter(([name]) => name === 'deleteItem').map(([, input]) => input.Key.sk.S), ['CFG', 'RUN', 'PAGE', 'FAVICON']);
});

test('offboarding reads every page of the workload\'s items: a custom page and the run beyond the first page are deleted too', async () => {
  const pk = { S: 'WL#shop' };
  const pages = [
    { Items: ['CFG', 'DRIFT#1', 'FAVICON'].map((sk) => ({ pk, sk: { S: sk } })), LastEvaluatedKey: { pk, sk: { S: 'FAVICON' } } },
    { Items: ['PAGE', 'PAUSE', 'RUN', 'SCHEDULE', 'STATS#2026-10-05'].map((sk) => ({ pk, sk: { S: sk } })) },
  ];
  const dynamo = fakeDynamo({ query: async (input) => (input.ExclusiveStartKey ? pages[1] : pages[0]), deleteItem: async () => ({}) });
  await createStore({ dynamo, table: 't' }).deleteWorkload('shop');
  assert.deepEqual(dynamo.calls.filter(([name]) => name === 'deleteItem').map(([, input]) => input.Key.sk.S), ['CFG', 'DRIFT#1', 'FAVICON', 'PAGE', 'PAUSE', 'RUN', 'SCHEDULE']);
  assert.deepEqual(dynamo.calls.filter(([name]) => name === 'query').map(([, input]) => input.ExclusiveStartKey), [undefined, { pk, sk: { S: 'FAVICON' } }]);
});

test('a favicon item that cannot be parsed reads as none', async () => {
  const dynamo = fakeDynamo({ getItem: async () => ({ Item: { favicon: { S: '{"icon":' } } }) });
  assert.equal(await createStore({ dynamo, table: 't' }).getFavicon('shop'), null);
});
