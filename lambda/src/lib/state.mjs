export const STATES = Object.freeze({
  AWAKE: 'AWAKE',
  NAPPING: 'NAPPING',
  ASLEEP: 'ASLEEP',
  WAKING: 'WAKING',
  FAILED: 'FAILED',
});

const itemKey = (workloadId, sk) => ({ pk: { S: `WL#${workloadId}` }, sk: { S: sk } });
const listKey = (name, sk) => ({ pk: { S: `LIST#${name}` }, sk: { S: sk } });
// Pause of the router (workloadId null) or of a workload: PAUSE for an operator's pause, PAUSE#<id> for an exclusion's.
const pauseKey = (workloadId, exclusionId) => ({ pk: { S: workloadId ? `WL#${workloadId}` : 'ROUTER' }, sk: { S: exclusionId ? `PAUSE#${exclusionId}` : 'PAUSE' } });
const pauseOf = (item) => ({ workloadId: item.pk.S === 'ROUTER' ? null : item.pk.S.slice(3), ...JSON.parse(item.pause.S) });

const DAY_MS = 86_400_000;
const STATS_TTL_DAYS = 35;
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

// Daily statistics item → { ignored: { reason: n }, deferred: { reason: n }, wakes: { trigger: n } }, added into `into`.
function addStats(into, item) {
  for (const [name, attr] of Object.entries(item)) {
    if (!('N' in attr) || name === 'expiresAt') continue;
    const n = Number(attr.N);
    // `deferred` (router 0.8.0) counted browser-mode deferrals only.
    if (name === 'deferred') into.deferred['browser mode'] = (into.deferred['browser mode'] ?? 0) + n;
    else if (name.startsWith('deferred:')) into.deferred[name.slice(9)] = (into.deferred[name.slice(9)] ?? 0) + n;
    else if (name.startsWith('ignored:')) into.ignored[name.slice(8)] = (into.ignored[name.slice(8)] ?? 0) + n;
    else if (name.startsWith('wake:')) into.wakes[name.slice(5)] = (into.wakes[name.slice(5)] ?? 0) + n;
  }
  return into;
}
const emptyStats = () => ({ ignored: {}, deferred: {}, wakes: {} });

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
      return (await this.listWorkloads()).configs;
    },

    // The configurations and the schedules (id → schedule) in one scan: the check reads both without a second pass.
    async listWorkloads() {
      const configs = [];
      const schedules = new Map();
      let ExclusiveStartKey;
      do {
        const page = await dynamo.scan({
          TableName: table,
          FilterExpression: '#sk IN (:cfg, :schedule)',
          ExpressionAttributeNames: { '#sk': 'sk' },
          ExpressionAttributeValues: { ':cfg': { S: 'CFG' }, ':schedule': { S: 'SCHEDULE' } },
          ExclusiveStartKey,
        });
        for (const item of page.Items ?? []) {
          if (item.sk?.S === 'SCHEDULE') schedules.set(item.pk.S.slice(3), JSON.parse(item.schedule.S));
          else configs.push(JSON.parse(item.config.S));
        }
        ExclusiveStartKey = page.LastEvaluatedKey;
      } while (ExclusiveStartKey);
      return { configs, schedules };
    },

    // The workload's schedule (R12), beside its configuration: `{...schedule, by, at}`.
    async getSchedule(workloadId) {
      const item = await get(workloadId, 'SCHEDULE');
      return item ? JSON.parse(item.schedule.S) : null;
    },

    async putSchedule(workloadId, schedule) {
      await dynamo.updateItem({
        TableName: table,
        Key: itemKey(workloadId, 'SCHEDULE'),
        UpdateExpression: 'SET #schedule = :schedule',
        ExpressionAttributeNames: { '#schedule': 'schedule' },
        ExpressionAttributeValues: { ':schedule': { S: JSON.stringify(schedule) } },
      });
    },

    // True when there was one.
    async deleteSchedule(workloadId) {
      const { Attributes } = await dynamo.deleteItem({ TableName: table, Key: itemKey(workloadId, 'SCHEDULE'), ReturnValues: 'ALL_OLD' });
      return Boolean(Attributes);
    },

    async getRun(workloadId) {
      const item = await get(workloadId, 'RUN');
      return item ? fromItem(item) : null;
    },

    transition(workloadId, change) {
      return update(buildTransition({ table, workloadId, now: now(), ...change }));
    },

    // Daily counter (`ignored:<reason>`, `deferred:<reason>`, `wake:<trigger>`) in the WL#<id> / STATS#<yyyy-mm-dd> item.
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

    // Health of the idle check: the last check started by the schedule (manual checks do not count).
    async recordScheduledCheck(at) {
      await dynamo.updateItem({
        TableName: table,
        Key: { pk: { S: 'ROUTER' }, sk: { S: 'CHECK' } },
        UpdateExpression: 'SET #at = :at',
        ExpressionAttributeNames: { '#at': 'lastScheduledCheckAt' },
        ExpressionAttributeValues: { ':at': { N: String(at) } },
      });
    },

    // Onboarding (onboarder): the configuration item the workload module writes, and the initial runtime state. With
    // mustExist (a rename), false when the workload is gone: never written back after an offboarding.
    async putConfig(workloadId, config, { mustExist = false } = {}) {
      try {
        await dynamo.updateItem({
          TableName: table,
          Key: itemKey(workloadId, 'CFG'),
          UpdateExpression: 'SET #config = :config',
          ...(mustExist ? { ConditionExpression: 'attribute_exists(#pk)' } : {}),
          ExpressionAttributeNames: { '#config': 'config', ...(mustExist ? { '#pk': 'pk' } : {}) },
          ExpressionAttributeValues: { ':config': { S: JSON.stringify(config) } },
        });
        return true;
      } catch (err) {
        if (mustExist && err.name === 'ConditionalCheckFailedException') return false;
        throw err;
      }
    },

    // false when a runtime state exists already (the Lambdas own it).
    async initRun(workloadId, at) {
      const out = await update({
        TableName: table,
        Key: itemKey(workloadId, 'RUN'),
        UpdateExpression: 'SET #state = :awake, #version = :zero, #awakeSince = :at, #holders = :zero, #wakeCount = :zero',
        ConditionExpression: 'attribute_not_exists(#pk)',
        ExpressionAttributeNames: { '#pk': 'pk', '#state': 'state', '#version': 'version', '#awakeSince': 'awakeSince', '#holders': 'holders', '#wakeCount': 'wakeCount' },
        ExpressionAttributeValues: { ':awake': { S: STATES.AWAKE }, ':zero': { N: '0' }, ':at': { N: String(at) } },
      });
      return out !== null;
    },

    // Offboarding: configuration, runtime state and pauses; the daily statistics expire by their TTL.
    async deleteWorkload(workloadId) {
      const { Items = [] } = await dynamo.query({
        TableName: table,
        KeyConditionExpression: '#pk = :pk',
        ExpressionAttributeNames: { '#pk': 'pk' },
        ExpressionAttributeValues: { ':pk': { S: `WL#${workloadId}` } },
        ConsistentRead: true,
      });
      for (const item of Items.filter((i) => !i.sk.S.startsWith('STATS#'))) {
        await dynamo.deleteItem({ TableName: table, Key: { pk: item.pk, sk: item.sk } });
      }
    },

    // Drift events (R4c): what the onboarder repaired, kept 90 days (WL#<id> / DRIFT#<at>#<n>).
    async putDrift(workloadId, event) {
      const expires = Math.floor(Date.parse(event.at) / 1000) + 90 * 86_400;
      await dynamo.updateItem({
        TableName: table,
        Key: itemKey(workloadId, `DRIFT#${event.at}#${Math.random().toString(36).slice(2, 8)}`),
        UpdateExpression: 'SET #event = :event, #exp = :exp',
        ExpressionAttributeNames: { '#event': 'event', '#exp': 'expiresAt' },
        ExpressionAttributeValues: { ':event': { S: JSON.stringify(event) }, ':exp': { N: String(expires) } },
      });
    },

    async listDrift(workloadId, limit = 10) {
      const { Items = [] } = await dynamo.query({
        TableName: table,
        KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :prefix)',
        ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk' },
        ExpressionAttributeValues: { ':pk': { S: `WL#${workloadId}` }, ':prefix': { S: 'DRIFT#' } },
        ScanIndexForward: false,
        Limit: limit,
      });
      return Items.map((item) => JSON.parse(item.event.S));
    },

    // Pauses (router management): one JSON attribute, and its time for a deletion that must not remove a newer pause.
    async putPause(workloadId, pause) {
      await dynamo.updateItem({
        TableName: table,
        Key: pauseKey(workloadId, pause.exclusionId),
        UpdateExpression: 'SET #pause = :pause, #at = :at',
        ExpressionAttributeNames: { '#pause': 'pause', '#at': 'at' },
        ExpressionAttributeValues: { ':pause': { S: JSON.stringify(pause) }, ':at': { N: String(pause.at) } },
      });
    },

    async getPauses(workloadId) {
      const { Items = [] } = await dynamo.query({
        TableName: table,
        KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :pause)',
        ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk' },
        ExpressionAttributeValues: { ':pk': pauseKey(workloadId).pk, ':pause': { S: 'PAUSE' } },
        ConsistentRead: true,
      });
      return Items.map(pauseOf);
    },

    async listPauses() {
      const pauses = [];
      let ExclusiveStartKey;
      do {
        const page = await dynamo.scan({
          TableName: table,
          FilterExpression: 'begins_with(#sk, :pause)',
          ExpressionAttributeNames: { '#sk': 'sk' },
          ExpressionAttributeValues: { ':pause': { S: 'PAUSE' } },
          ConsistentRead: true,
          ExclusiveStartKey,
        });
        pauses.push(...(page.Items ?? []).map(pauseOf));
        ExclusiveStartKey = page.LastEvaluatedKey;
      } while (ExclusiveStartKey);
      return pauses;
    },

    // false when `at` is given and the pause changed meanwhile (a newer pause is kept).
    async deletePause(workloadId, { exclusionId, at } = {}) {
      try {
        await dynamo.deleteItem({
          TableName: table,
          Key: pauseKey(workloadId, exclusionId),
          ...(at === undefined ? {} : { ConditionExpression: '#at = :at', ExpressionAttributeNames: { '#at': 'at' }, ExpressionAttributeValues: { ':at': { N: String(at) } } }),
        });
        return true;
      } catch (err) {
        if (err?.name === 'ConditionalCheckFailedException') return false;
        throw err;
      }
    },

    // Health measured by the scheduled check (scale design §3): { at, lambda, queues, limit }.
    async getHealth() {
      const { Item } = await dynamo.getItem({ TableName: table, Key: { pk: { S: 'ROUTER' }, sk: { S: 'HEALTH' } }, ConsistentRead: true });
      return Item?.health?.S ? JSON.parse(Item.health.S) : null;
    },
    async putHealth(health) {
      await dynamo.updateItem({
        TableName: table, Key: { pk: { S: 'ROUTER' }, sk: { S: 'HEALTH' } },
        UpdateExpression: 'SET #health = :health', ExpressionAttributeNames: { '#health': 'health' }, ExpressionAttributeValues: { ':health': { S: JSON.stringify(health) } },
      });
    },

    // One check at a time (scale design §6): a lease on ROUTER / CHECK until the check ends, or expires (a check that died).
    async acquireCheckLease(holder, until, now) {
      try {
        await dynamo.updateItem({
          TableName: table, Key: { pk: { S: 'ROUTER' }, sk: { S: 'CHECK' } },
          UpdateExpression: 'SET #holder = :holder, #until = :until',
          ConditionExpression: 'attribute_not_exists(#holder) OR #until < :now',
          ExpressionAttributeNames: { '#holder': 'leaseHolder', '#until': 'leaseUntil' },
          ExpressionAttributeValues: { ':holder': { S: holder }, ':until': { N: String(until) }, ':now': { N: String(now) } },
        });
        return true;
      } catch (err) {
        if (err?.name === 'ConditionalCheckFailedException') return false;
        throw err;
      }
    },

    async releaseCheckLease(holder) {
      try {
        await dynamo.updateItem({
          TableName: table, Key: { pk: { S: 'ROUTER' }, sk: { S: 'CHECK' } },
          UpdateExpression: 'REMOVE #holder, #until', ConditionExpression: '#holder = :holder',
          ExpressionAttributeNames: { '#holder': 'leaseHolder', '#until': 'leaseUntil' }, ExpressionAttributeValues: { ':holder': { S: holder } },
        });
      } catch (err) {
        if (err?.name !== 'ConditionalCheckFailedException') throw err;
      }
    },

    // Where a check stopped at its time budget: the next one starts after it (null: it reached every workload).
    async setCheckCursor(cursor) {
      await dynamo.updateItem({
        TableName: table, Key: { pk: { S: 'ROUTER' }, sk: { S: 'CHECK' } },
        UpdateExpression: cursor ? 'SET #cursor = :cursor' : 'REMOVE #cursor',
        ExpressionAttributeNames: { '#cursor': 'cursor' }, ...(cursor ? { ExpressionAttributeValues: { ':cursor': { S: cursor } } } : {}),
      });
    },

    async getCheck() {
      const { Item } = await dynamo.getItem({ TableName: table, Key: { pk: { S: 'ROUTER' }, sk: { S: 'CHECK' } }, ConsistentRead: true });
      return Item ? fromItem(Item) : null;
    },

    // IP reputation lists: LIST#<name> / META and LIST#<name> / PART#<version>#<nnnn> (gzip chunks).
    async getListMeta(name) {
      const { Item } = await dynamo.getItem({ TableName: table, Key: listKey(name, 'META'), ConsistentRead: true });
      return Item ? fromItem(Item) : null;
    },

    async setListMeta(name, set, remove = []) {
      const fields = Object.entries(set);
      const names = {};
      const values = {};
      fields.forEach(([field, value], i) => { names[`#f${i}`] = field; values[`:f${i}`] = toValue(value); });
      remove.forEach((field, i) => { names[`#r${i}`] = field; });
      const clauses = [];
      if (fields.length) clauses.push(`SET ${fields.map((_, i) => `#f${i} = :f${i}`).join(', ')}`);
      if (remove.length) clauses.push(`REMOVE ${remove.map((_, i) => `#r${i}`).join(', ')}`);
      await dynamo.updateItem({
        TableName: table,
        Key: listKey(name, 'META'),
        UpdateExpression: clauses.join(' '),
        ExpressionAttributeNames: names,
        ...(fields.length ? { ExpressionAttributeValues: values } : {}),
      });
    },

    async putListPart(name, version, index, data, expiresAt) {
      await dynamo.updateItem({
        TableName: table,
        Key: listKey(name, `PART#${version}#${String(index).padStart(4, '0')}`),
        UpdateExpression: 'SET #data = :data, #exp = :exp',
        ExpressionAttributeNames: { '#data': 'data', '#exp': 'expiresAt' },
        ExpressionAttributeValues: { ':data': { B: data }, ':exp': { N: String(expiresAt) } },
      });
    },

    async getListParts(name, version) {
      const parts = [];
      let ExclusiveStartKey;
      do {
        const page = await dynamo.query({
          TableName: table,
          KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :prefix)',
          ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk' },
          ExpressionAttributeValues: { ':pk': { S: `LIST#${name}` }, ':prefix': { S: `PART#${version}#` } },
          ExclusiveStartKey,
        });
        for (const item of page.Items ?? []) parts.push(item.data.B);
        ExclusiveStartKey = page.LastEvaluatedKey;
      } while (ExclusiveStartKey);
      return parts;
    },

    // The kinds of a workload's backends, as the idle check found them ('instance', 'asg,rds-instance'): written apart from
    // the transitions (no version change).
    async setBackendKinds(workloadId, kinds) {
      return (await update({
        TableName: table,
        Key: itemKey(workloadId, 'RUN'),
        UpdateExpression: 'SET #kinds = :kinds',
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeNames: { '#kinds': 'backendKinds' },
        ExpressionAttributeValues: { ':kinds': { S: kinds } },
      })) !== null;
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
