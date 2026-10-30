// The router's state on Google Cloud: the DynamoDB store's methods over Firestore's REST API (Native mode, one database
// per router). One document per workload and kind: `workloads/<id>` (the configuration), `runs/<id>` (the state
// machine), `schedules/<id>`, `pauses/<id>` (a workload's pause), `stats/<id>-<day>` (the day's counters); and the IP
// lists: `lists/<name>` (the meta) and `listParts/<name>-<version>-<index>` (the packed parts, 350 kB at most). A transition reads the run, checks its condition, and commits
// with the document's `updateTime` as precondition: the conditional write of DynamoDB.
import { STATES, matches, addStats, emptyStats, utcDay, DAY_MS } from '../../lambda/src/lib/state.mjs';

const BASE = 'https://firestore.googleapis.com/v1';
// Reads again after a lost precondition (another writer changed the run between the read and the commit).
const ATTEMPTS = 5;
const LIST_PAGE = 300;
// Parts weigh up to 350 kB: few per page and per batchGet (a response stays far below a hundred MB).
const PART_PAGE = 10;
const DELETE_BATCH = 100;
// Between two attempts: a random delay up to BACKOFF_MS times the attempt, so contending writers drift apart.
const BACKOFF_MS = 40;

export function toValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (value instanceof Uint8Array) return { bytesValue: Buffer.from(value).toString('base64') };
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
  if ('bytesValue' in value) return Buffer.from(value.bytesValue, 'base64');
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
  const partId = (name, version, index) => `listParts/${encodeURIComponent(name)}-${version}-${String(index).padStart(4, '0')}`;

  // Every document of a collection, as { name (the path below the root), fields }; `mask` limits the fields.
  async function listAll(collection, { pageSize = LIST_PAGE, mask = [] } = {}) {
    const documents = [];
    let pageToken;
    do {
      const query = new URLSearchParams({ pageSize: String(pageSize), ...(pageToken ? { pageToken } : {}) });
      for (const field of mask) query.append('mask.fieldPaths', field);
      const page = await google.request('GET', `${url(collection)}?${query}`);
      for (const doc of page.documents ?? []) documents.push({ name: doc.name.slice(root.length + 1), fields: fromFields(doc.fields) });
      pageToken = page.nextPageToken;
    } while (pageToken);
    return documents;
  }

  async function deleteDocuments(paths) {
    for (let i = 0; i < paths.length; i += DELETE_BATCH) await commit(paths.slice(i, i + DELETE_BATCH).map((path) => ({ delete: named(path) })));
  }

  const pauseOf = (workloadId, doc) => ({ workloadId, ...doc.value.pause });

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
      return (await listAll('workloads')).map((doc) => doc.fields.config);
    },

    // The configurations and the schedules (id → schedule), as the DynamoDB store's one pass.
    async listWorkloads() {
      const configs = await this.listConfigs();
      const schedules = new Map((await listAll('schedules')).map((doc) => [doc.name.slice('schedules/'.length), doc.fields.schedule]));
      return { configs, schedules };
    },

    // The workload's schedule, beside its configuration: `{...schedule, by, at}`.
    async getSchedule(workloadId) {
      return (await read(`schedules/${workloadId}`))?.value.schedule ?? null;
    },

    async putSchedule(workloadId, schedule) {
      await commit([{ update: { name: named(`schedules/${workloadId}`), fields: toFields({ schedule }) } }]);
    },

    // True when there was one.
    async deleteSchedule(workloadId) {
      if (!(await read(`schedules/${workloadId}`))) return false;
      await commit([{ delete: named(`schedules/${workloadId}`) }]);
      return true;
    },

    // A workload's pause (one per workload): [{ workloadId, by, at, reason, until?, keepAsleep }], expired ones included
    // (the controller filters them). A router-wide pause waits for the manager: none here.
    async getPauses(workloadId) {
      if (!workloadId) return [];
      const doc = await read(`pauses/${workloadId}`);
      return doc ? [pauseOf(workloadId, doc)] : [];
    },

    async listPauses() {
      return (await listAll('pauses')).map((doc) => ({ workloadId: doc.name.slice('pauses/'.length), ...doc.fields.pause }));
    },

    async addPause(workloadId, pause) {
      if (!workloadId) throw new Error('a pause is a workload\'s');
      await commit([{ update: { name: named(`pauses/${workloadId}`), fields: toFields({ pause, at: pause.at }) } }]);
    },

    // false when `at` is given and the pause changed meanwhile (a newer pause is kept), or when there was none.
    async removePauses(workloadId, { at } = {}) {
      for (let attempt = 1; ; attempt += 1) {
        const doc = await read(`pauses/${workloadId}`);
        if (!doc || (at !== undefined && doc.value.at !== at)) return false;
        try {
          await commit([{ delete: named(`pauses/${workloadId}`), currentDocument: { updateTime: doc.updateTime } }]);
          return true;
        } catch (err) {
          if (!lostPrecondition(err) || attempt >= ATTEMPTS) throw err;
        }
      }
    },

    async getRun(workloadId) {
      return (await read(`runs/${workloadId}`))?.value ?? null;
    },

    transition(workloadId, { cond, set = {}, remove = [], increment = [] }) {
      return modifyRun(workloadId, (run) => {
        if (!matches(run, cond)) return null;
        const counted = Object.fromEntries(increment.map((name) => [name, (run[name] ?? 0) + 1]));
        // A state change dates the run (`maintenanceDue` reads it); a caller that dates it itself is kept.
        const dated = set.state !== undefined && set.state !== run.state && !('stateAt' in set) ? { stateAt: now() } : {};
        return { set: { ...set, ...dated, ...counted, version: (run.version ?? 0) + 1, updatedAt: now() }, remove };
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

    // Offboarding: configuration, run, schedule and pause; the daily counters stay.
    async deleteWorkload(workloadId) {
      await commit(['workloads', 'runs', 'schedules', 'pauses'].map((kind) => ({ delete: named(`${kind}/${workloadId}`) })));
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

    // IP reputation lists: `lists/<name>` holds the meta, `listParts/<name>-<version>-<nnnn>` the packed parts.
    async getListMeta(name) {
      return (await read(`lists/${encodeURIComponent(name)}`))?.value ?? null;
    },

    // Fields set and fields removed in one write. When it points the meta at a version, the parts of the other versions
    // and the expired ones (no TTL policy: it needs one more permission) are deleted; before that, readers still have
    // the old version.
    async setListMeta(name, set, remove = []) {
      await commit([{
        update: { name: named(`lists/${encodeURIComponent(name)}`), fields: toFields(set) },
        updateMask: { fieldPaths: [...Object.keys(set), ...remove].map(fieldPath) },
      }]);
      if (set.version === undefined) return;
      const nowS = Math.floor(now() / 1000);
      const stale = (await listAll('listParts', { pageSize: PART_PAGE, mask: ['list', 'version', 'expiresAt'] }))
        .filter((part) => part.fields.list === name && (part.fields.version !== set.version || part.fields.expiresAt <= nowS));
      await deleteDocuments(stale.map((part) => part.name));
    },

    async putListPart(name, version, index, data, expiresAt) {
      await commit([{ update: { name: named(partId(name, version, index)), fields: toFields({ list: name, version, index, data, expiresAt }) } }]);
    },

    // The parts of a version, in order (they are numbered from 0: the first missing one ends them).
    async getListParts(name, version) {
      const parts = [];
      for (let from = 0; ; from += PART_PAGE) {
        const ids = Array.from({ length: PART_PAGE }, (_, i) => partId(name, version, from + i));
        const answers = await google.request('POST', `${BASE}/${root}:batchGet`, { documents: ids.map(named) });
        const found = new Map(answers.filter((a) => a.found).map((a) => [a.found.name, a.found]));
        for (const id of ids) {
          const doc = found.get(named(id));
          if (!doc) return parts;
          parts.push(fromFields(doc.fields).data);
        }
      }
    },
  };
}
