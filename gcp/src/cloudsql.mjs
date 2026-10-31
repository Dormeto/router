// Cloud SQL (Admin API, REST, v1): a workload's companions (vision docs/specs/2026-10-30-google-cloud-coverage-design.md, section 9),
// which have no route of their own and must run for the application, as on AWS (lambda/src/lib/rds.mjs): down after it, up
// before it. An instance stops and starts by its activation policy; the router has no connection to it.
//
// None of this has been run against Google yet: what it answers is read from its reference, and what the measures may change is one
// function here each: statusOf and operationFailure (M6), isBusy (M6), refusedForCapacity (M6), tagRefusal (M7), companionProblem (M8).
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

export const CALLS = {
  get: ['cloudsql.instances.get'],
  setActivation: ['cloudsql.instances.update'],
  // Assumed readable with `get` alone (M6).
  getOperation: ['cloudsql.instances.get'],
};

export const isCompanion = (backend) => backend.kind === 'cloudsql';

// 'running', 'stopped' or 'transitioning', from an instance and the operation this request asked for, if any.
export function statusOf(instance, operation) {
  // M6 pins this reading. Google says RUNNABLE is "running, or has been stopped by owner": the state alone cannot tell, the policy
  // says what was asked, and only the operation that a wake holds says it is over. A new request knows none: the state and the policy decide.
  if (operation && operation.status !== 'DONE') return 'transitioning';
  const policy = instance?.settings?.activationPolicy;
  if (policy === 'NEVER') return 'stopped';
  return policy === 'ALWAYS' && instance.state === 'RUNNABLE' ? 'running' : 'transitioning';
}

// M6: another operation on the instance, a 409 with this reason (spec section 12).
const isBusy = (err) => err?.code === 409 && err.reason === 'operationInProgress';

// M6: Google's word for a start it has no room for, in a refusal or in an operation's error; marked for the shared retries.
const refusedForCapacity = (err, words = err.reason) => (CAPACITY.test(`${words} ${err.message}`) ? Object.assign(err, { kind: 'capacity' }) : err);

// M7: `update` is granted on the tag, so a refusal is first of all a tag that is not there. First in the message: the failure keeps 300 characters.
const tagRefusal = (name, err) => failureError('permission', `Cloud SQL instance ${name}: Google refused the change of its activation policy: the router may change only an instance with the tag dormeto=managed: ${err.message}`);

// M6: an operation over, in an error, as the error to throw; else null.
function operationFailure(name, operation) {
  if (operation?.status !== 'DONE' || !operation.error) return null;
  const errors = operation.error.errors ?? [];
  const words = errors.map((e) => `${e.code}: ${e.message}`).join('; ') || 'no details';
  return refusedForCapacity(new Error(`Cloud SQL instance ${name}: operation ${operation.name} failed: ${words}`), words);
}

// Why an instance cannot be a companion, else null. M8 confirms the second: Google's words say a replica cannot be stopped with its primary.
export function companionProblem({ name, masterInstanceName, instanceType, replicaNames = [] }) {
  if (masterInstanceName || instanceType === REPLICA) return `Cloud SQL instance ${name} is a read replica: Google cannot stop one, name its primary or none`;
  if (replicaNames.length) return `Cloud SQL instance ${name} has read replicas (${replicaNames.join(', ')}): a replica cannot be stopped with its primary, remove them or leave the instance out`;
  return null;
}

const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

export function createCloudSql({ google, project, now = Date.now, sleep = pause }) {
  const base = `${SQLADMIN}/projects/${project}`;
  const e = encodeURIComponent;
  const instanceUrl = (name) => `${base}/instances/${e(name)}`;

  return {
    get: (name) => google.request('GET', instanceUrl(name)),
    getOperation: (name) => google.request('GET', `${base}/operations/${e(name)}`),
    // The operation's name, not waiting for it. While another operation runs, tried again until `deadline` (ms, as now()); none: one try.
    setActivation: async (name, policy, deadline = 0) => {
      for (;;) {
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

// Running when this returns. A stopped one is asked to start, and one going down is waited for: its stop's operation refuses the start
// until it is over. Asked again if it reads stopped later on (a check that read the run before this wake).
async function startOnce(cloudsql, name, { now, sleep, deadline }) {
  let asked = null;
  for (;;) {
    const [instance, operation] = await Promise.all([cloudsql.get(name), asked ? cloudsql.getOperation(asked) : null]);
    const failure = operationFailure(name, operation);
    if (failure) throw failure;
    const status = statusOf(instance, operation);
    if (status === 'running') return;
    if (status === 'stopped') asked = await cloudsql.setActivation(name, 'ALWAYS', deadline);
    if (now() >= deadline) throw failureError('timeout', `Cloud SQL instance ${name}: not running when the wake timed out`);
    await sleep(POLL_MS);
  }
}

// `timing`: `{ now, sleep, deadline }`. A start refused for capacity gets AWS's retries (lambda/src/lib/capacity.mjs).
export const startDatabase = (cloudsql, name, timing) => retryCapacity(() => startOnce(cloudsql, name, timing), timing);

// Asked to go, with no wait for it: a stop takes minutes and nothing depends on it.
export async function stopDatabase(cloudsql, name, deadline) {
  if (statusOf(await cloudsql.get(name)) !== 'stopped') await cloudsql.setActivation(name, 'NEVER', deadline);
}
