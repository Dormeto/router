// The router's state on Google Cloud: the DynamoDB store's methods over Firestore's REST API (Native mode, one database
// per router). One document per workload and kind: `workloads/<id>` (the configuration), `runs/<id>` (the state
// machine), `stats/<id>-<day>` (the day's counters). A transition reads the run, checks its condition, and commits
// with the document's `updateTime` as precondition: the conditional write of DynamoDB.
import { STATES, matches, addStats, emptyStats, utcDay, DAY_MS } from '../../lambda/src/lib/state.mjs';

const BASE = 'https://firestore.googleapis.com/v1';
// Reads again after a lost precondition (another writer changed the run between the read and the commit).
const ATTEMPTS = 5;
const LIST_PAGE = 300;
// Between two attempts: a random delay up to BACKOFF_MS times the attempt, so contending writers drift apart.
const BACKOFF_MS = 40;

export function toValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(toValue) } };
  if (typeof value === 'object') return { mapValue: { fields: toFields(value) } };
  throw new TypeError(`unsupported value type: ${typeof value}`);
}

export function fromValue(value) {
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('nullValue' in value) return null;
  if ('arrayValue' in value) return (value.arrayValue.values ?? []).map(fromValue);
  if ('mapValue' in value) return fromFields(value.mapValue.fields);
  if ('timestampValue' in value) return value.timestampValue;
  throw new TypeError(`unsupported Firestore value: ${Object.keys(value).join(', ')}`);
}

export function toFields(object) {
  return Object.fromEntries(Object.entries(object).map(([name, value]) => [name, toValue(value)]));
}

export function fromFields(fields = {}) {
  return Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, fromValue(value)]));
}

// A field path in an update mask or a transform: names with other characters than letters, digits and `_` (the
// counters `ignored:bot`) are quoted with backticks.
const fieldPath = (name) => (/^[A-Za-z_][A-Za-z_0-9]*$/.test(name) ? name : `\`${name.replace(/[\\`]/g, '\\$&')}\``);

// Firestore documents read and written (roles/datastore.user, on the router's database).
const READ = ['datastore.entities.get', 'datastore.entities.list'];
const WRITE = ['datastore.entities.create', 'datastore.entities.update', 'datastore.entities.delete'];
export const CALLS = {
  read: READ,
  write: WRITE,
};

const lostPrecondition = (err) => err?.status === 'FAILED_PRECONDITION' || err?.status === 'ABORTED';
const isStatus = (status) => (err) => err?.status === status;

export function createFirestoreStore({ google, project, database, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), log = null }) {
  const root = `projects/${project}/databases/${database}/documents`;
  const url = (path) => `${BASE}/${root}/${path}`;
  const commit = (writes) => google.request('POST', `${BASE}/${root}:commit`, { writes });
  const named = (path) => `${root}/${path}`;

  // The document, or null: { fields (as objects), updateTime }.
  async function read(path) {
    try {
      const doc = await google.request('GET', url(path));
      return { value: fromFields(doc.fields), updateTime: doc.updateTime };
    } catch (err) {
      if (err?.status === 'NOT_FOUND' || err?.code === 404) return null;
      throw err;
    }
  }

  // Read-decide-commit on a run, under the `updateTime` precondition. `decide(run)` returns { set, remove } or null (no
  // write); the answer is the new run, or null when there is no run or nothing to do.
  async function modifyRun(workloadId, decide) {
    const path = `runs/${workloadId}`;
    for (let attempt = 1; ; attempt += 1) {
      const doc = await read(path);
      if (!doc) return null;
      const change = decide(doc.value);
      if (!change) return null;
      const next = { ...doc.value, ...change.set };
      for (const name of change.remove ?? []) delete next[name];
      const names = [...Object.keys(change.set), ...(change.remove ?? [])];
      try {
        await commit([{
          update: { name: named(path), fields: toFields(change.set) },
          updateMask: { fieldPaths: names.map(fieldPath) },
          currentDocument: { updateTime: doc.updateTime },
        }]);
        return next;
      } catch (err) {
        if (!lostPrecondition(err) || attempt >= ATTEMPTS) throw err;
        await sleep(Math.random() * BACKOFF_MS * attempt);
      }
    }
  }

  return {
    async getConfig(workloadId) {
      return (await read(`workloads/${workloadId}`))?.value.config ?? null;
    },

    async listConfigs() {
      return (await this.listWorkloads()).configs;
    },

    // The configurations and the schedules (id → schedule; none in G1), as the DynamoDB store's one pass.
    async listWorkloads() {
      const configs = [];
      let pageToken;
      do {
        const query = new URLSearchParams({ pageSize: String(LIST_PAGE), ...(pageToken ? { pageToken } : {}) });
        const page = await google.request('GET', `${url('workloads')}?${query}`);
        for (const doc of page.documents ?? []) configs.push(fromFields(doc.fields).config);
        pageToken = page.nextPageToken;
      } while (pageToken);
      return { configs, schedules: new Map() };
    },

    // No schedules in G1.
    async getSchedule() {
      return null;
    },

    async getRun(workloadId) {
      return (await read(`runs/${workloadId}`))?.value ?? null;
    },

    transition(workloadId, { cond, set = {}, remove = [], increment = [] }) {
      return modifyRun(workloadId, (run) => {
        if (!matches(run, cond)) return null;
        const counted = Object.fromEntries(increment.map((name) => [name, (run[name] ?? 0) + 1]));
        return { set: { ...set, ...counted, version: (run.version ?? 0) + 1, updatedAt: now() }, remove };
      });
    },

    // Daily counter (`ignored:<reason>`, `deferred:<reason>`, `wake:<trigger>`) in `stats/<id>-<day>`: a field transform,
    // so concurrent requests add up without a precondition.
    async count(workloadId, counter) {
      await commit([{
        update: { name: named(`stats/${workloadId}-${utcDay(now())}`) },
        updateMask: { fieldPaths: [] },
        updateTransforms: [{ fieldPath: fieldPath(counter), increment: { integerValue: '1' } }],
      }]);
    },

    // Today and the last `days` days (today included), added up.
    async getStats(workloadId, days) {
      const t = now();
      const since = utcDay(t - (days - 1) * DAY_MS);
      const today = utcDay(t);
      const names = Array.from({ length: days }, (_, i) => `${workloadId}-${utcDay(t - i * DAY_MS)}`);
      const answers = await google.request('POST', `${BASE}/${root}:batchGet`, { documents: names.map((name) => named(`stats/${name}`)) });
      const total = emptyStats();
      const todayStats = emptyStats();
      for (const { found } of answers) {
        if (!found) continue;
        // addStats reads DynamoDB's { N: } attributes.
        const item = Object.fromEntries(Object.entries(fromFields(found.fields)).map(([name, n]) => [name, { N: String(n) }]));
        addStats(total, item);
        if (found.name.endsWith(`/stats/${workloadId}-${today}`)) addStats(todayStats, item);
      }
      return { days, since, today: todayStats, total };
    },

    // Onboarding: the configuration document, and the initial run. With mustExist (a rename), false when the workload
    // is gone: never written back after an offboarding.
    async putConfig(workloadId, config, { mustExist = false } = {}) {
      try {
        await commit([{
          update: { name: named(`workloads/${workloadId}`), fields: toFields({ config }) },
          ...(mustExist ? { currentDocument: { exists: true } } : {}),
        }]);
        return true;
      } catch (err) {
        if (mustExist && isStatus('NOT_FOUND')(err)) return false;
        throw err;
      }
    },

    // false when a run exists already (the controller owns it).
    async initRun(workloadId, at) {
      try {
        await commit([{
          update: { name: named(`runs/${workloadId}`), fields: toFields({ state: STATES.AWAKE, version: 0, awakeSince: at, holders: 0, wakeCount: 0 }) },
          currentDocument: { exists: false },
        }]);
        return true;
      } catch (err) {
        if (isStatus('ALREADY_EXISTS')(err)) return false;
        throw err;
      }
    },

    // Offboarding: configuration and run; the daily counters stay.
    async deleteWorkload(workloadId) {
      await commit([{ delete: named(`workloads/${workloadId}`) }, { delete: named(`runs/${workloadId}`) }]);
    },

    // The kinds of a workload's backends, written apart from the transitions (no version change).
    async setBackendKinds(workloadId, kinds) {
      return (await modifyRun(workloadId, () => ({ set: { backendKinds: kinds } }))) !== null;
    },

    // What a nap suspended or stopped; only a wake that reaches AWAKE removes it. On an existing run only.
    async setHibernated(workloadId, { ids, at }) {
      return (await modifyRun(workloadId, () => ({ set: { hibernated: JSON.stringify({ ids, at }) } }))) !== null;
    },

    async setPendingWake(workloadId) {
      // Only the first request of a nap marks it: one log line and one counted wake per pending wake.
      return (await modifyRun(workloadId, (run) => (run.state === STATES.NAPPING && run.pendingWake !== true ? { set: { pendingWake: true } } : null))) !== null;
    },

    async tryAcquireHolder(workloadId, max) {
      try {
        return (await modifyRun(workloadId, (run) => ((run.holders ?? 0) < max ? { set: { holders: (run.holders ?? 0) + 1 } } : null))) !== null;
      } catch (err) {
        if (!lostPrecondition(err)) throw err;
        // Too many writers on the run: refused, as when the maximum is reached.
        log?.warn('HolderContended', { workloadId, error: err.message });
        return false;
      }
    },

    async releaseHolder(workloadId) {
      try {
        await modifyRun(workloadId, (run) => ((run.holders ?? 0) > 0 ? { set: { holders: run.holders - 1 } } : null));
      } catch (err) {
        if (!lostPrecondition(err)) throw err;
        log?.warn('HolderReleaseContended', { workloadId, error: err.message });
      }
    },
  };
}
