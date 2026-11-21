// The controller on Cloud Run (vision docs/plans/2026-10-29-google-cloud.md, the controller API): the operator's calls, the
// tasks of Cloud Tasks and the check job. Cloud Run's IAM checks the caller. Errors are `{ error, reason }`: what is wrong,
// and a short reason for a program, with `problems` for refused settings (AWS's list); a failure is left to `serve`, which logs it
// and answers a 500. The manager's calls are AWS's controller actions on one route, `POST /v1/actions` (actions.mjs), answered as
// that module says.
import { response } from '../../lambda/src/lib/http.mjs';
import { logger } from '../../lambda/src/lib/log.mjs';
import { parseLists } from '../../lambda/src/lib/list-cache.mjs';
import { downloadText } from '../../lambda/src/lib/list-refresh.mjs';
import PACKAGE from '../../package.json' with { type: 'json' };
import { createActions } from './actions.mjs';
import { createCloudSql } from './cloudsql.mjs';
import { createCompute } from './compute.mjs';
import { createController } from './controller-core.mjs';
import { createFirestoreStore } from './firestore.mjs';
import { createGke } from './gke.mjs';
import { createGoogle, createIdentityTokens } from './google.mjs';
import { createLogs } from './logs.mjs';
import { createMonitoring } from './monitoring.mjs';
import { createIdleSignals } from './idle-signals.mjs';
import { createOnboarding, Refusal } from './onboarding.mjs';
import { customPagesOf } from './pages.mjs';
import { createReporter, readReport, withReports } from './report.mjs';
import { createTasks } from './tasks.mjs';
import { createUrlMaps } from './urlmaps.mjs';

const WORKLOADS = '/v1/workloads';
// The manager's: AWS's controller actions (G2 spec §5.1).
const ACTIONS = '/v1/actions';
// The router level of the settings (vision docs/specs/2026-11-08-google-cloud-router-features-design.md, section 4.5).
const SETTINGS = '/v1/settings';
// The router's waiting page, and a workload's under its verb (the design's section 5.2).
const WAITING_PAGE = '/v1/waiting-page';
const PAGE_VERB = 'waiting-page';
// The waiting page's operations by method: PUT's body is `{ page, by }`, DELETE's `{ by }` or none.
const PAGE_OPS = { GET: 'get', PUT: 'put', DELETE: 'delete' };
const WORKLOAD = /^\/v1\/workloads\/([^/]+)(?:\/([^/]+))?$/;
const MAX_BODY_BYTES = 1024 * 1024;
// The User-Agent Cloud Scheduler sends to an HTTP target.
const SCHEDULER = /^Google-Cloud-Scheduler/;

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

// `actions`: actions.mjs's `act`, the manager's route; none, the route is not there. `report()`: where the router's reports to the
// manager stand (report.mjs's readReport), in the health; none, the health has no `report`.
export function createControllerApi({ core, onboarding, config, actions, report }) {
  const TASKS = {
    wake: ({ workloadId, wakeId }) => {
      if (typeof wakeId !== 'string' || !wakeId) throw bad('a wake task needs its wakeId');
      return core.wake(workloadId, wakeId);
    },
    // `by`: who asked a nap of the manager's.
    nap: ({ workloadId, cause, requestedAt, until, by }) => core.nap(workloadId, { cause, requestedAt, until, by }),
    release: ({ workloadId }) => core.release(workloadId),
    refreshLists: ({ names }) => {
      if (!Array.isArray(names) || names.some((name) => typeof name !== 'string')) throw bad('a refreshLists task needs its names');
      return core.refreshLists(names);
    },
  };
  // The one action that belongs to no workload.
  const WORKLOADLESS = new Set(['refreshLists']);

  async function task(body) {
    if (!Object.hasOwn(TASKS, body.action ?? '')) throw bad('action must be wake, nap or release (or refreshLists, which has no workload)');
    if (!WORKLOADLESS.has(body.action)) await onboarding.find(body.workloadId);
    return TASKS[body.action](body);
  }

  // A level's waiting page, 'router' or { workloadId }; null for a method it has no operation for.
  async function waitingPage(level, request) {
    const op = PAGE_OPS[request.method];
    if (!op) return null;
    const { page, by } = op === 'get' ? {} : await bodyOf(request);
    return onboarding.waitingPage(level, { op, page, by });
  }

  // The route's answer, or null when there is none.
  async function route(request, path, query) {
    const { method } = request;
    if (path === '/v1/health' && method === 'GET') {
      return { version: PACKAGE.version, project: config.project, region: config.region, ...(report ? { report: await report() } : {}) };
    }
    // Cloud Scheduler's call (its job, the CLI's install) is the scheduled check, whose date the health reads; an operator's is not.
    if (path === '/v1/check' && method === 'POST') return { results: await core.check({ scheduled: SCHEDULER.test(request.headers?.['user-agent'] ?? '') }) };
    if (path === '/v1/tasks' && method === 'POST') return task(await bodyOf(request));
    if (path === SETTINGS && method === 'GET') return onboarding.routerSettings();
    if (path === SETTINGS && method === 'PUT') return onboarding.setRouterSettings(await bodyOf(request));
    if (path === '/v1/pause' && method === 'POST') return onboarding.pauseRouter(await bodyOf(request));
    if (path === '/v1/resume' && method === 'POST') return onboarding.resumeRouter(await bodyOf(request));
    if (path === WAITING_PAGE) return waitingPage('router', request);
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
    if (verb === 'settings' && method === 'PUT') return onboarding.setSettings(idOf(encoded), await bodyOf(request));
    if (verb === PAGE_VERB) return waitingPage({ workloadId: idOf(encoded) }, request);
    if (verb === 'pause' && method === 'POST') return onboarding.pause(idOf(encoded), await bodyOf(request));
    if (verb === 'resume' && method === 'POST') return onboarding.resume(idOf(encoded), await bodyOf(request));
    return null;
  }

  return async function handler(request) {
    const { pathname, searchParams } = new URL(request.url, 'http://controller');
    try {
      // An action answers its own status: AWS's answer, a refusal, or the REST error (actions.mjs).
      if (pathname === ACTIONS && request.method === 'POST' && actions) {
        const { status, body } = await actions(await bodyOf(request));
        return json(status, body);
      }
      const answer = await route(request, pathname, searchParams);
      if (answer === null) return json(404, { error: `no route for ${request.method} ${pathname}`, reason: 'not-found' });
      return json(200, answer);
    } catch (err) {
      if (err instanceof Refusal) return json(err.status, { error: err.message, reason: err.reason, ...(err.problems ? { problems: err.problems } : {}) });
      throw err;
    }
  };
}

// The handler of the `controller` role (server.mjs), on the router's environment. `DMT_LOG_VIEW`: the router's log view, set by the
// CLI's install (`projects/<p>/locations/global/buckets/_Default/views/dmtr-<region>-lb`); unset, the idle check reads no request log.
// `DMT_CUSTOM_PAGES=1`: the install turned custom waiting pages on (pages.mjs). `fetch` also reads the application's favicon at a nap.
export function fromEnvironment(env = process.env, { fetch, log = logger } = {}) {
  const google = createGoogle({ fetch });
  const project = env.DMT_PROJECT;
  const customPages = customPagesOf(env);
  const config = {
    project, region: env.DMT_REGION, wakerNeg: env.DMT_WAKER_NEG, controllerUrl: env.DMT_CONTROLLER_URL, version: PACKAGE.version, build: env.DMT_BUILD ?? null,
  };
  const firestore = createFirestoreStore({ google, project, database: env.DMT_DATABASE, region: env.DMT_REGION, log });
  // The reports to the manager (report.mjs): after each state change and each check, `Router checked` with the `list` action's rows.
  let actions = null;
  const reporter = createReporter({
    store: firestore, tokens: createIdentityTokens({ fetch }), fetch, project, region: config.region, log,
    rows: async () => (await actions({ action: 'list' })).body,
  });
  const store = withReports(firestore, reporter, { log });
  const lists = parseLists(env.DMT_IP_LISTS, (error) => log.error('IpListsUnreadable', { error }));
  const compute = createCompute({ google, project });
  const cloudsql = createCloudSql({ google, project });
  const gke = createGke({ google, project, fetch });
  const urlmaps = createUrlMaps({ google, project });
  const regionalUrlmaps = createUrlMaps({ google, project, region: env.DMT_REGION, scope: 'regional' });
  const core = createController({
    store,
    compute,
    cloudsql,
    gke,
    urlmaps,
    regionalUrlmaps,
    monitoring: createMonitoring({ google, project }),
    idleSignals: createIdleSignals({ google, project, log }),
    ...(env.DMT_LOG_VIEW ? { logs: createLogs({ google, view: env.DMT_LOG_VIEW, log }) } : {}),
    tasks: createTasks({ google, project, region: env.DMT_REGION, queue: env.DMT_QUEUE, serviceAccount: env.DMT_SERVICE_ACCOUNT }),
    config,
    lists,
    download: (url) => downloadText(url, { fetch }),
    sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
    fetch,
    customPages,
    reporter,
    log,
  });
  const onboarding = createOnboarding({ store, compute, cloudsql, gke, urlmaps, regionalUrlmaps, core, config, customPages, log });
  const router = { name: `dmtr-${config.region}`, version: config.version, build: config.build, project: config.project, region: config.region };
  actions = createActions({ controller: core, onboarding, store, router, lists, log });
  const handler = createControllerApi({ core, onboarding, config, actions, report: () => readReport(firestore) });
  // SIGTERM commits the buffered stats (server.mjs).
  handler.flush = () => store.flushStats();
  return handler;
}
