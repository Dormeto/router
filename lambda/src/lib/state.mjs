export const STATES = Object.freeze({
  AWAKE: 'AWAKE',
  NAPPING: 'NAPPING',
  ASLEEP: 'ASLEEP',
  WAKING: 'WAKING',
  FAILED: 'FAILED',
});

const itemKey = (workloadId, sk) => ({ pk: { S: `WL#${workloadId}` }, sk: { S: sk } });

const DAY_MS = 86_400_000;
const STATS_TTL_DAYS = 35;
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

// Daily statistics item → { ignored: { reason: n }, deferred: n, wakes: { trigger: n } }, added into `into`.
function addStats(into, item) {
  for (const [name, attr] of Object.entries(item)) {
    if (!('N' in attr) || name === 'expiresAt') continue;
    const n = Number(attr.N);
    if (name === 'deferred') into.deferred += n;
    else if (name.startsWith('ignored:')) into.ignored[name.slice(8)] = (into.ignored[name.slice(8)] ?? 0) + n;
    else if (name.startsWith('wake:')) into.wakes[name.slice(5)] = (into.wakes[name.slice(5)] ?? 0) + n;
  }
  return into;
}
const emptyStats = () => ({ ignored: {}, deferred: 0, wakes: {} });

export function toValue(value) {
  if (typeof value === 'string') return { S: value };
  if (typeof value === 'number') return { N: String(value) };
  if (typeof value === 'boolean') return { BOOL: value };
  throw new TypeError(`unsupported value type: ${typeof value}`);
}

export function fromItem(item) {
  const out = {};
  for (const [name, attr] of Object.entries(item)) {
    if ('S' in attr) out[name] = attr.S;
    else if ('N' in attr) out[name] = Number(attr.N);
    else if ('BOOL' in attr) out[name] = attr.BOOL;
  }
  return out;
}

// Same semantics as the DynamoDB condition built by buildTransition (used by test fakes).
export function matches(run, cond) {
  if (![].concat(cond.state).includes(run.state)) return false;
  if (cond.wakeId !== undefined && run.wakeId !== cond.wakeId) return false;
  if (cond.pendingWake === false && run.pendingWake === true) return false;
  if (cond.olderThan && !(run[cond.olderThan.field] < cond.olderThan.ms)) return false;
  return true;
}

export function buildTransition({ table, workloadId, cond, set = {}, remove = [], increment = [], now }) {
  const names = { '#state': 'state', '#version': 'version', '#updatedAt': 'updatedAt' };
  const values = { ':one': { N: '1' }, ':zero': { N: '0' }, ':now': { N: String(now) } };

  const stateRefs = [].concat(cond.state).map((state, i) => {
    values[`:s${i}`] = { S: state };
    return `:s${i}`;
  });
  const conditions = [`#state IN (${stateRefs.join(', ')})`];
  if (cond.wakeId !== undefined) {
    names['#wakeId'] = 'wakeId';
    values[':cwakeId'] = { S: cond.wakeId };
    conditions.push('#wakeId = :cwakeId');
  }
  if (cond.pendingWake === false) {
    names['#pendingWake'] = 'pendingWake';
    values[':true'] = { BOOL: true };
    conditions.push('(attribute_not_exists(#pendingWake) OR #pendingWake <> :true)');
  }
  if (cond.olderThan) {
    names['#older'] = cond.olderThan.field;
    values[':older'] = { N: String(cond.olderThan.ms) };
    conditions.push('#older < :older');
  }

  const sets = ['#version = if_not_exists(#version, :zero) + :one', '#updatedAt = :now'];
  for (const [name, value] of Object.entries(set)) {
    names[`#${name}`] = name;
    values[`:v_${name}`] = toValue(value);
    sets.push(`#${name} = :v_${name}`);
  }
  for (const name of increment) {
    names[`#${name}`] = name;
    sets.push(`#${name} = if_not_exists(#${name}, :zero) + :one`);
  }
  let expression = `SET ${sets.join(', ')}`;
  if (remove.length) {
    for (const name of remove) names[`#${name}`] = name;
    expression += ` REMOVE ${remove.map((name) => `#${name}`).join(', ')}`;
  }

  return {
    TableName: table,
    Key: itemKey(workloadId, 'RUN'),
    UpdateExpression: expression,
    ConditionExpression: conditions.join(' AND '),
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
    ReturnValues: 'ALL_NEW',
  };
}

export function createStore({ dynamo, table, now = Date.now }) {
  async function update(input) {
    try {
      const out = await dynamo.updateItem(input);
      return out?.Attributes ? fromItem(out.Attributes) : {};
    } catch (err) {
      if (err?.name === 'ConditionalCheckFailedException') return null;
      throw err;
    }
  }

  async function get(workloadId, sk) {
    const { Item } = await dynamo.getItem({ TableName: table, Key: itemKey(workloadId, sk), ConsistentRead: true });
    return Item ?? null;
  }

  return {
    async getConfig(workloadId) {
      const item = await get(workloadId, 'CFG');
      return item ? JSON.parse(item.config.S) : null;
    },

    async listConfigs() {
      const configs = [];
      let ExclusiveStartKey;
      do {
        const page = await dynamo.scan({
          TableName: table,
          FilterExpression: '#sk = :cfg',
          ExpressionAttributeNames: { '#sk': 'sk' },
          ExpressionAttributeValues: { ':cfg': { S: 'CFG' } },
          ExclusiveStartKey,
        });
        for (const item of page.Items ?? []) configs.push(JSON.parse(item.config.S));
        ExclusiveStartKey = page.LastEvaluatedKey;
      } while (ExclusiveStartKey);
      return configs;
    },

    async getRun(workloadId) {
      const item = await get(workloadId, 'RUN');
      return item ? fromItem(item) : null;
    },

    transition(workloadId, change) {
      return update(buildTransition({ table, workloadId, now: now(), ...change }));
    },

    // Daily counter (`ignored:<reason>`, `deferred`, `wake:<trigger>`) in the WL#<id> / STATS#<yyyy-mm-dd> item.
    async count(workloadId, counter) {
      const t = now();
      const expires = (Math.floor(t / DAY_MS) + 1) * (DAY_MS / 1000) + STATS_TTL_DAYS * 86_400;
      await dynamo.updateItem({
        TableName: table,
        Key: itemKey(workloadId, `STATS#${utcDay(t)}`),
        UpdateExpression: 'ADD #c :one SET #exp = if_not_exists(#exp, :exp)',
        ExpressionAttributeNames: { '#c': counter, '#exp': 'expiresAt' },
        ExpressionAttributeValues: { ':one': { N: '1' }, ':exp': { N: String(expires) } },
      });
    },

    // Today and the last `days` days (today included), added up.
    async getStats(workloadId, days) {
      const t = now();
      const since = utcDay(t - (days - 1) * DAY_MS);
      const today = utcDay(t);
      const { Items = [] } = await dynamo.query({
        TableName: table,
        KeyConditionExpression: '#pk = :pk AND #sk BETWEEN :from AND :to',
        ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk' },
        ExpressionAttributeValues: { ':pk': { S: `WL#${workloadId}` }, ':from': { S: `STATS#${since}` }, ':to': { S: `STATS#${today}` } },
      });
      const total = emptyStats();
      const todayStats = emptyStats();
      for (const item of Items) {
        addStats(total, item);
        if (item.sk?.S === `STATS#${today}`) addStats(todayStats, item);
      }
      return { days, since, today: todayStats, total };
    },

    async setPendingWake(workloadId) {
      const out = await update({
        TableName: table,
        Key: itemKey(workloadId, 'RUN'),
        UpdateExpression: 'SET #pendingWake = :true',
        // Only the first request of a nap marks it: one log line and one counted wake per pending wake.
        ConditionExpression: '#state = :napping AND (attribute_not_exists(#pendingWake) OR #pendingWake <> :true)',
        ExpressionAttributeNames: { '#pendingWake': 'pendingWake', '#state': 'state' },
        ExpressionAttributeValues: { ':true': { BOOL: true }, ':napping': { S: STATES.NAPPING } },
      });
      return out !== null;
    },

    async tryAcquireHolder(workloadId, max) {
      const out = await update({
        TableName: table,
        Key: itemKey(workloadId, 'RUN'),
        UpdateExpression: 'ADD #holders :one',
        ConditionExpression: 'attribute_not_exists(#holders) OR #holders < :max',
        ExpressionAttributeNames: { '#holders': 'holders' },
        ExpressionAttributeValues: { ':one': { N: '1' }, ':max': { N: String(max) } },
      });
      return out !== null;
    },

    async releaseHolder(workloadId) {
      await update({
        TableName: table,
        Key: itemKey(workloadId, 'RUN'),
        UpdateExpression: 'ADD #holders :minus',
        ConditionExpression: '#holders > :zero',
        ExpressionAttributeNames: { '#holders': 'holders' },
        ExpressionAttributeValues: { ':minus': { N: '-1' }, ':zero': { N: '0' } },
      });
    },
  };
}
