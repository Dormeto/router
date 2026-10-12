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
