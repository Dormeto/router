// The controller on Cloud Run (vision docs/plans/2026-10-29-google-cloud.md, the controller API): the operator's calls, the
// tasks of Cloud Tasks and the check job. Cloud Run's IAM checks the caller. Errors are `{ error, reason }`: what is wrong,
// and a short reason for a program; a failure is left to `serve`, which logs it and answers a 500.
import { response } from '../../lambda/src/lib/http.mjs';
import { logger } from '../../lambda/src/lib/log.mjs';
import PACKAGE from '../../package.json' with { type: 'json' };
import { createCompute } from './compute.mjs';
import { createController } from './controller-core.mjs';
import { createFirestoreStore } from './firestore.mjs';
import { createGoogle } from './google.mjs';
import { createMonitoring } from './monitoring.mjs';
import { createOnboarding, Refusal } from './onboarding.mjs';
import { createTasks } from './tasks.mjs';
import { createUrlMaps } from './urlmaps.mjs';

const WORKLOADS = '/v1/workloads';
const WORKLOAD = /^\/v1\/workloads\/([^/]+)(?:\/([^/]+))?$/;
const MAX_BODY_BYTES = 1024 * 1024;

const bad = (message) => new Refusal(400, 'bad-request', message);
const json = (statusCode, body) => response(statusCode, { 'cache-control': 'no-store', 'content-type': 'application/json' }, JSON.stringify(body));

// The request's JSON object; none: an empty one.
async function bodyOf(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw bad(`the body is larger than ${MAX_BODY_BYTES} bytes`);
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString();
  if (!text.trim()) return {};
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw bad('the body is not JSON');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw bad('the body is not a JSON object');
  return body;
}

function idOf(encoded) {
  try {
    return decodeURIComponent(encoded);
  } catch {
    throw bad('the workload ID is badly encoded');
  }
}

function forceOf(query) {
  const force = query.get('force');
  if (force !== null && force !== 'true') throw bad('force can only be true');
  return force === 'true';
}

export function createControllerApi({ core, onboarding, config }) {
  const TASKS = {
    wake: ({ workloadId, wakeId }) => {
      if (typeof wakeId !== 'string' || !wakeId) throw bad('a wake task needs its wakeId');
      return core.wake(workloadId, wakeId);
    },
    nap: ({ workloadId, cause, requestedAt, until }) => core.nap(workloadId, { cause, requestedAt, until }),
    release: ({ workloadId }) => core.release(workloadId),
  };

  async function task(body) {
    if (!Object.hasOwn(TASKS, body.action ?? '')) throw bad('action must be wake, nap or release');
    await onboarding.find(body.workloadId);
    return TASKS[body.action](body);
  }

  // The route's answer, or null when there is none.
  async function route(request, path, query) {
    const { method } = request;
    if (path === '/v1/health' && method === 'GET') return { version: PACKAGE.version, project: config.project, region: config.region };
    if (path === '/v1/check' && method === 'POST') return { results: await core.check() };
    if (path === '/v1/tasks' && method === 'POST') return task(await bodyOf(request));
    if (path === WORKLOADS && method === 'GET') return onboarding.list();
    if (path === WORKLOADS && method === 'POST') {
      const body = await bodyOf(request);
      return query.get('dryRun') === 'true' ? onboarding.dryRun(body) : onboarding.onboard(body);
    }
    const [, encoded, verb] = WORKLOAD.exec(path) ?? [];
    if (!encoded) return null;
    if (!verb && method === 'GET') return onboarding.show(idOf(encoded));
    if (!verb && method === 'DELETE') return onboarding.offboard(idOf(encoded), { force: forceOf(query) });
    if (verb === 'nap' && method === 'POST') return onboarding.nap(idOf(encoded));
    if (verb === 'wake' && method === 'POST') return onboarding.wake(idOf(encoded));
    if (verb === 'schedule' && method === 'GET') return onboarding.showSchedule(idOf(encoded));
    if (verb === 'schedule' && method === 'PUT') return onboarding.setSchedule(idOf(encoded), await bodyOf(request));
    if (verb === 'schedule' && method === 'DELETE') return onboarding.clearSchedule(idOf(encoded));
    if (verb === 'pause' && method === 'POST') return onboarding.pause(idOf(encoded), await bodyOf(request));
    if (verb === 'resume' && method === 'POST') return onboarding.resume(idOf(encoded), await bodyOf(request));
    return null;
  }

  return async function handler(request) {
    const { pathname, searchParams } = new URL(request.url, 'http://controller');
    try {
      const answer = await route(request, pathname, searchParams);
      if (answer === null) return json(404, { error: `no route for ${request.method} ${pathname}`, reason: 'not-found' });
      return json(200, answer);
    } catch (err) {
      if (err instanceof Refusal) return json(err.status, { error: err.message, reason: err.reason });
      throw err;
    }
  };
}

// The handler of the `controller` role (server.mjs), on the router's environment.
export function fromEnvironment(env = process.env, { fetch, log = logger } = {}) {
  const google = createGoogle({ fetch });
  const project = env.DMT_PROJECT;
  const config = { project, region: env.DMT_REGION, wakerNeg: env.DMT_WAKER_NEG, controllerUrl: env.DMT_CONTROLLER_URL };
  const store = createFirestoreStore({ google, project, database: env.DMT_DATABASE, log });
  const compute = createCompute({ google, project });
  const urlmaps = createUrlMaps({ google, project });
  const core = createController({
    store,
    compute,
    urlmaps,
    monitoring: createMonitoring({ google, project }),
    tasks: createTasks({ google, project, region: env.DMT_REGION, queue: env.DMT_QUEUE, serviceAccount: env.DMT_SERVICE_ACCOUNT }),
    config,
    sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
    log,
  });
  return createControllerApi({ core, onboarding: createOnboarding({ store, compute, urlmaps, core, config, log }), config });
}
