// Cloud SQL (Admin API, REST, v1): a workload's companions (vision docs/specs/2026-10-30-google-cloud-coverage-design.md, section 9),
// which have no route of their own and must run for the application, as on AWS (lambda/src/lib/rds.mjs): down after it, up
// before it. An instance stops and starts by its activation policy; the router has no connection to it.
//
// None of this has been run against Google yet: what it answers is read from its reference, and what the measures may change is one
// function here each: statusOf, operationsOf and operationFailure (M6), isBusy (M6), refusedForCapacity (M6), tagRefusal (M7),
// companionGone and companionRead (M6, M7), companionProblem (M8).
//
// `CALLS` is each function's permissions (test/permissions.test.mjs): the feature `cloud-sql` of gcp/access.json. `update` needs the
// tag, `get` does not: it is granted on the project.
import { retryCapacity } from '../../lambda/src/lib/capacity.mjs';
import { failureError } from '../../lambda/src/lib/failures.mjs';

const SQLADMIN = 'https://sqladmin.googleapis.com/v1';
// Cloud SQL's starts take minutes: read this often during a wake, and tried again this often while another operation runs.
export const POLL_MS = 10_000;
const REPLICA = 'READ_REPLICA_INSTANCE';
// Google's: lower case letters, numbers and hyphens, from a letter, at most 98 characters.
export const INSTANCE_NAME = /^[a-z]([-a-z0-9]{0,96}[a-z0-9])?$/;
// As lib/failures.mjs reads Compute Engine's stockout, and not a 429's RESOURCE_EXHAUSTED: that is a rate.
const CAPACITY = /resource_pool_exhausted|stockout|insufficient.?capacity|not enough capacity|no capacity/i;
// What startDatabase and stopDatabase answer of an instance that no longer exists.
export const COMPANION_GONE = 'gone';

// Google's table of permissions, method by method.
export const CALLS = {
  get: ['cloudsql.instances.get'],
  setActivation: ['cloudsql.instances.get', 'cloudsql.instances.update'],
  getOperation: ['cloudsql.instances.get'],
  // Google's table names both for this method without saying that both are needed: held both; M6 tells whether `list` can go. Refused,
  // a wake goes by the state and the policy (operationsOf).
  listOperations: ['cloudsql.instances.get', 'cloudsql.instances.list'],
};

export const isCompanion = (backend) => backend.kind === 'cloudsql';

// 'running', 'stopped' or 'transitioning', from an instance and, when a wake read them, its operations, newest first.
export function statusOf(instance, operations = []) {
  // M6 pins this reading. Google says RUNNABLE is "running, or has been stopped by owner": the state alone cannot tell, and the policy
  // says what was asked. Any operation under way, whoever asked it, is not over yet, whatever those two read then. The newest ending in
  // an error says the policy may not have happened, an older one is history. That DONE means it takes connections is assumed: the
  // router has none to try.
  if (operations.some((op) => op.status !== 'DONE')) return 'transitioning';
  const policy = instance?.settings?.activationPolicy;
  if (policy === 'NEVER') return 'stopped';
  return policy === 'ALWAYS' && instance.state === 'RUNNABLE' && !operations[0]?.error ? 'running' : 'transitioning';
}

// M6: another operation on the instance, a 409 with this reason (spec section 12).
const isBusy = (err) => err?.code === 409 && err.reason === 'operationInProgress';

// M6: Google's word for a start it has no room for, in a refusal or in an operation's error; marked for the shared retries.
const refusedForCapacity = (err, words = err.reason) => (CAPACITY.test(`${words} ${err.message}`) ? Object.assign(err, { kind: 'capacity' }) : err);

// M7: `update` is granted on the tag, so a refusal is first of all a tag that is not there. First in the message: the failure keeps 300 characters.
const tagRefusal = (name, err) => failureError('permission', `Cloud SQL instance ${name}: Google refused the change of its activation policy: the router may change only an instance with the tag dormeto=managed: ${err.message}`);

// M6: an operation over, in an error, as the error to throw; else null. Its fields: Google's Operation.
function operationFailure(name, operation) {
  if (operation?.status !== 'DONE' || !operation.error) return null;
  const errors = operation.error.errors ?? [];
  const words = errors.map((e) => `${e.code}: ${e.message}`).join('; ') || 'no details';
  return refusedForCapacity(new Error(`Cloud SQL instance ${name}: operation ${operation.name} failed: ${words}`), words);
}

// Why an instance cannot be a companion, else null. A replica: Google's page says `NEVER` is not supported for one. A primary with
// replicas: assumed, that page says nothing of it, and M8 tells what Google does.
export function companionProblem({ name, masterInstanceName, instanceType, replicaNames = [] }) {
  if (masterInstanceName || instanceType === REPLICA) return `Cloud SQL instance ${name} is a read replica: Google cannot stop one, name its primary or none`;
  if (replicaNames.length) return `Cloud SQL instance ${name} has read replicas (${replicaNames.join(', ')}): assumed not to stop with its primary, not measured yet: remove them or leave the instance out`;
  return null;
}

// M6, M7: Google's answer of a read or a change of an instance that no longer exists, for a caller holding `get` on the project. Only
// that answer means gone. Assumed from its reference: if Google answers a 403 instead, a wake's refusal keeps visitors out as a role
// removed does, and this is the one line to change.
export const companionGone = (err) => err?.code === 404;

// The onboarding's read of an instance: `{ database?: { name, selfLink }, problem?, gone? }`, `gone` for one that does not exist. M6, M7: a
// 403 may be one too: Cloud SQL may hide one the caller cannot see, and a router without the feature reads the same.
export async function companionRead(cloudsql, name) {
  try {
    const instance = await cloudsql.get(name);
    const problem = companionProblem({ ...instance, name });
    return { database: { name, selfLink: instance.selfLink }, ...(problem ? { problem } : {}) };
  } catch (err) {
    if (companionGone(err)) return { gone: true, problem: `Cloud SQL instance ${name} not found: name an instance of this project` };
    if (err?.code === 403) return { problem: `the router cannot read Cloud SQL instance ${name}: it does not exist, or the router was installed without --with cloud-sql: ${err.message}` };
    throw err;
  }
}

// Why a nap must not count on an instance, else null, as a NEG gone stops one: nothing is stopped for an instance no wake could then
// read. What the onboarding refused an instance for is not asked again: that it has replicas now is M8's. Anything else thrown.
export async function companionLost(cloudsql, name) {
  const { database, gone, problem } = await companionRead(cloudsql, name);
  if (database) return null;
  return gone ? `Cloud SQL instance ${name} no longer exists: offboard and onboard again` : `${problem}: nothing is stopped, give the router its role back, or offboard and onboard again`;
}

const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

export function createCloudSql({ google, project, now = Date.now, sleep = pause }) {
  const base = `${SQLADMIN}/projects/${project}`;
  const e = encodeURIComponent;
  const instanceUrl = (name) => `${base}/instances/${e(name)}`;

  return {
    get: (name) => google.request('GET', instanceUrl(name)),
    getOperation: (name) => google.request('GET', `${base}/operations/${e(name)}`),
    // Google lists an instance's operations newest first, by their start: only the newest are of interest.
    listOperations: async (name) => (await google.request('GET', `${base}/operations?instance=${e(name)}&maxResults=10`)).items ?? [],
    // The operation's name, not waiting for it. While another operation runs, tried again until `deadline` (ms, as now()); none: one try.
    // `stillWanted()`, if any, is asked before each try: false, nothing is sent and the answer is null.
    setActivation: async (name, policy, deadline = 0, stillWanted = null) => {
      for (;;) {
        if (stillWanted && !(await stillWanted())) return null;
        try {
          return (await google.request('PATCH', instanceUrl(name), { settings: { activationPolicy: policy } })).name;
        } catch (err) {
          if (err?.code === 403) throw tagRefusal(name, err);
          if (!isBusy(err)) throw refusedForCapacity(err);
          if (now() >= deadline) throw failureError('timeout', `Cloud SQL instance ${name}: another operation was still running at the deadline: ${err.message}`);
        }
        await sleep(POLL_MS);
      }
    },
  };
}

// M6: what a wake reads of an instance's operations, whoever asked them and whichever request: a list, and what this request asked if
// the list does not show it yet. Refused with a 403 (`unread(err)` says so), the state and the policy alone decide, and the wake goes on.
// A 404 here says nothing of the instance: its own read decides that.
async function operationsOf(cloudsql, name, asked, unread) {
  const refused = (err) => {
    if (companionGone(err)) return null;
    if (err?.code !== 403) throw err;
    unread?.(err);
    return null;
  };
  const listed = (await cloudsql.listOperations(name).catch(refused)) ?? [];
  if (!asked || listed.some((op) => op.name === asked)) return listed;
  const own = await cloudsql.getOperation(asked).catch(refused);
  return own ? [own, ...listed] : listed;
}

// Running when this returns. A stopped one is asked to start, and one going down or starting is waited for, by its operation. Asked
// again if it reads stopped during the wait (a check that read the run before this wake), or if the last operation failed before this
// one read it (a wake before it, a capacity's retry); what it asked itself failing is thrown.
async function startOnce(cloudsql, name, { now, sleep, deadline, unread }) {
  let asked = null;
  for (;;) {
    const [instance, operations] = await Promise.all([cloudsql.get(name), operationsOf(cloudsql, name, asked, unread)]);
    const failure = operationFailure(name, operations.find((op) => op.name === asked));
    if (failure) throw failure;
    const status = statusOf(instance, operations);
    if (status === 'running') return;
    const over = operations.every((op) => op.status === 'DONE');
    if (status === 'stopped' || (over && operations[0]?.error)) asked = await cloudsql.setActivation(name, 'ALWAYS', deadline);
    if (now() >= deadline) throw failureError('timeout', `Cloud SQL instance ${name}: not running when the wake timed out`);
    await sleep(POLL_MS);
  }
}

// What an instance gone answers COMPANION_GONE, not to be thrown: no wake and no nap fails for it.
const unlessGone = (err) => {
  if (!companionGone(err)) throw err;
  return COMPANION_GONE;
};

// `timing`: `{ now, sleep, deadline, unread? }`. A start refused for capacity gets AWS's retries (lambda/src/lib/capacity.mjs). COMPANION_GONE, for
// an instance that no longer exists: there is nothing to wait for.
export const startDatabase = (cloudsql, name, timing) => retryCapacity(() => startOnce(cloudsql, name, timing), timing).catch(unlessGone);

// Asked to go, with no wait for it: a stop takes minutes and nothing depends on it. `stillGoing()`: asked before each try, false once
// the run is no longer the nap's, and nothing is sent. COMPANION_GONE, for an instance that no longer exists.
export async function stopDatabase(cloudsql, name, deadline, stillGoing) {
  try {
    if (statusOf(await cloudsql.get(name)) !== 'stopped') await cloudsql.setActivation(name, 'NEVER', deadline, stillGoing);
    return null;
  } catch (err) {
    return unlessGone(err);
  }
}
