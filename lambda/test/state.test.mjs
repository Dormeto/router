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
  return { calls, getItem: wrap('getItem'), updateItem: wrap('updateItem'), scan: wrap('scan') };
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
  assert.equal(pending.ConditionExpression, '#state = :napping');
  assert.equal(acquire.ConditionExpression, 'attribute_not_exists(#holders) OR #holders < :max');
  assert.deepEqual(acquire.ExpressionAttributeValues[':max'], { N: '5' });
  assert.equal(release.UpdateExpression, 'ADD #holders :minus');
  assert.equal(release.ConditionExpression, '#holders > :zero');
});
