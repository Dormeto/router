// The waker on Cloud Run: one service behind the load balancer for every workload, which the backend service names in
// `x-dormeto-workload`. It answers the error response's fetch with the waiting page, and wakes as the shared core decides
// (vision docs/specs/2026-11-08-google-cloud-router-features-design.md, sections 4.3 and 4.4): the request filters, the no-wake
// and wake rules of every level and the wake mode, resolved through the levels with what Google Cloud fixes (levels.mjs). It
// holds nothing and redirects nothing: once the VMs are healthy, the load balancer sends the next request to them.
//
// Behind a policy (a global load balancer) it never answers a 503. The fetch must succeed for the load balancer to serve the
// page (Google: a failed fetch gets a generic error), and its policy's override gives the visitor the 503. On `/_dormeto/wake`,
// a 503 would be replaced by the page: the nap's policy applies to all the matcher's traffic, and the waker is a backend of it.
// The fetch carries neither the visitor's path nor its method: it is decided with no path (no path condition or scanner path
// matches it) in wake mode browser: only a wake rule or an explicit wake's header wakes there, and the page's probe then does.
//
// Behind a swap (a regional or classic one, which `x-dormeto-switch: swap` says, as Firestore may not be readable), it gets the
// visitor's real request with no policy to override its code, and a 200 would tell an API client it succeeded: the page is a 503,
// whatever the method and for any path but `/_dormeto/*`. That request is decided in the workload's wake mode: in `any`, one
// the filters let through wakes; in `browser`, only the page's probe, an explicit wake or a wake rule does.
// `/_dormeto/wake` is as behind a policy; `/_dormeto/backend/*` goes to the application and never comes here.
//
// The page's probe sends the visitor's path in `x-dormeto-path`, and its rules see that path; a POST keeps `/_dormeto/wake`.
// A forged one bypasses nothing a client couldn't by asking for another path.
//
// A nap window: the page and `/_dormeto/wake` say when it ends. Pauses mean nothing here: `keepAsleep` holds the scheduled and
// maintenance wakes only, and a visitor still wakes the workload (vision docs/specs/2026-10-30-google-cloud-coverage-design.md,
// section 5).
//
// A wake whose task was lost, or whose request died, no longer beats on its run (heartbeat.mjs): a visitor's poll of it sends it
// again with its wakeId, as the check does, one resend a minute between them and every instance of this waker.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createListCache, parseLists } from '../../lambda/src/lib/list-cache.mjs';
import { failureKind, nextAttemptAt } from '../../lambda/src/lib/failures.mjs';
import { WAKE_HEADER, header, response } from '../../lambda/src/lib/http.mjs';
import { logger } from '../../lambda/src/lib/log.mjs';
import { createJoinLevelsCache } from '../../lambda/src/lib/manager-settings.mjs';
import { renderPage } from '../../lambda/src/lib/page.mjs';
import { napEndHeader, napEndOf, occurrenceAt } from '../../lambda/src/lib/schedule.mjs';
import { STATES } from '../../lambda/src/lib/state.mjs';
import { createWaker } from '../../lambda/src/lib/waker-core.mjs';
import { createFirestoreStore } from './firestore.mjs';
import { createGoogle } from './google.mjs';
import { resendStale } from './heartbeat.mjs';
import { wakerConfigOf } from './levels.mjs';
import { SWITCH_HEADER, WORKLOAD_HEADER, WORKLOAD_ID } from './names.mjs';
import { createTasks } from './tasks.mjs';
import { WAITING_PATH } from './urlmaps.mjs';

const WAKE_PATH = '/_dormeto/wake';
const NAMESPACE = '/_dormeto/';
const PROBE_HEADER = 'x-dormeto-probe';
// The visitor's path, which the page's probe sends (lambda/src/lib/page.mjs).
const PATH_HEADER = 'x-dormeto-path';
const CLOUD = 'Google Cloud';
const UNKNOWN_POLL_SECONDS = 10;
// The run could not be read: nothing is claimed, the page says it wakes.
const UNREAD_STATE = 'UNKNOWN';
const NAP_UNTIL_HEADER = 'x-dormeto-nap-until';
// What a nap window can keep a workload in, as the shared code reads it.
const KEPT_BY_NAP = [STATES.ASLEEP, STATES.NAPPING, STATES.FAILED];

// A `node:http` request as the shared code reads an ALB event. The query string stays encoded, as the ALB passes it. The
// load balancer appends the client's address and then its own to X-Forwarded-For: its entry is dropped, so that the last
// one is the client's, as on AWS.
export function eventOf({ method, url, headers }) {
  const [path, query] = splitAt(url, '?');
  const parameters = new Map();
  for (const pair of query.split('&').filter(Boolean)) {
    const [name, value] = splitAt(pair, '=');
    parameters.set(name, [...(parameters.get(name) ?? []), value]);
  }
  const forwarded = (headers['x-forwarded-for'] ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
  return {
    httpMethod: method,
    path,
    multiValueQueryStringParameters: Object.fromEntries(parameters),
    headers: { ...headers, 'x-forwarded-for': forwarded.slice(0, -1).join(', ') },
  };
}

function splitAt(text, separator) {
  const at = text.indexOf(separator);
  return at < 0 ? [text, ''] : [text.slice(0, at), text.slice(at + 1)];
}

// The header's last value is the load balancer's; a client's own comes before it. Undefined when it is not an ID: it
// goes into Firestore's document paths.
export function workloadIdOf(event) {
  const id = (header(event, WORKLOAD_HEADER) ?? '').split(',').at(-1).trim();
  return WORKLOAD_ID.test(id) ? id : undefined;
}

// As the workload's: the header's last value is the load balancer's.
const underSwap = (event) => (header(event, SWITCH_HEADER) ?? '').split(',').at(-1).trim() === 'swap';

export function createCloudRunWaker({ store, tasks, controllerUrl, lists = [], now = Date.now, log }) {
  // A request names one workload, and both the shared code and this file's words ask for its nap window: one read per
  // request, a failed one included.
  const thisRequest = new AsyncLocalStorage();
  const getSchedule = (workloadId) => {
    const memo = thisRequest.getStore();
    memo.schedule ??= store.getSchedule(workloadId);
    return memo.schedule;
  };
  // So are its configuration and its run, which the shared decision and the page both read. The run is then the last one the
  // decision wrote, so that the page says the state it left; after a transition another instance won, it is read again.
  const readConfig = (workloadId) => (thisRequest.getStore().config ??= store.getConfig(workloadId));
  const readRun = (workloadId) => (thisRequest.getStore().run ??= store.getRun(workloadId));

  // The levels above the workload's, kept 60 s by the instance in the cache the shared core reads too: a request reads one record
  // of them, so that the values Google Cloud fixes below and the core's resolution agree. Never throws.
  const levels = createJoinLevelsCache({ router: () => store.getRouterSettings?.(), manager: () => store.getManagerSettings?.(), now, log });
  const levelsCache = { ...levels, records: (fields) => (thisRequest.getStore().levels ??= levels.records(fields)) };

  const enqueue = (body) => tasks.enqueue({ url: `${controllerUrl}/v1/tasks`, body });
  const core = createWaker({
    // Whatever the levels say, what Google Cloud fixes: no request is held, and the wake mode is browser behind the policy and on
    // its fetch. The rest the core resolves.
    store: {
      ...store,
      getConfig: async (workloadId) => {
        const [cfg, { router }] = await Promise.all([readConfig(workloadId), levelsCache.records({ workloadId })]);
        return cfg && wakerConfigOf(cfg, { router, policyFetch: thisRequest.getStore().policyFetch });
      },
      getRun: readRun,
      transition: async (workloadId, change) => {
        const next = await store.transition(workloadId, change);
        thisRequest.getStore().run = next ? Promise.resolve(next) : undefined;
        return next;
      },
      getSchedule,
    },
    // Only the wake: the route `/_dormeto/*` stays while awake, so reaching the waker then is no drift to repair.
    invokeController: async (payload) => {
      if (payload.action === 'wake') await enqueue(payload);
    },
    // A stale wake, sent again with its wakeId; nothing else is read for a run that beats.
    onWaking: (workloadId, run) => resendStale({ store, enqueue, now, log }, workloadId, run, 'waker'),
    workloadIdOf,
    // The lists' data is read from the store; one that cannot be read counts as none (the cache logs it) and wakes go on.
    listCache: lists.length ? createListCache({ store, lists, now, log }) : null,
    levelsCache,
    now,
    log,
  });

  // The end of the nap window active now, as the page says it, or null. A schedule that cannot be read counts as none: the
  // page is served all the same.
  async function napUntilOf(workloadId, state) {
    if (!KEPT_BY_NAP.includes(state)) return null;
    try {
      const schedule = await getSchedule(workloadId);
      const t = now();
      const occurrence = occurrenceAt(schedule, t);
      if (occurrence?.kind !== 'nap') return null;
      return napEndOf(occurrence, schedule.timeZone, t);
    } catch (err) {
      log.warn('ScheduleSkipped', { workloadId, error: err.message });
      return null;
    }
  }

  // The shared code reads the nap window for what it might wake. A request it filters before that (a rule, a bot, a list)
  // read the page all the same, which says the window to everyone here: its probe must not go back to "Waking up". An
  // explicit wake is its own answer: a window that allows one has woken the workload.
  async function sayingNapEnd(res, event, workloadId, state) {
    if (event.httpMethod === 'POST' || res.multiValueHeaders[NAP_UNTIL_HEADER]) return res;
    const napUntil = await napUntilOf(workloadId, state);
    if (!napUntil) return res;
    return {
      ...res,
      multiValueHeaders: { ...res.multiValueHeaders, [NAP_UNTIL_HEADER]: [napEndHeader(napUntil)] },
      ...(res.body ? { body: JSON.stringify({ ...JSON.parse(res.body), napUntil }) } : {}),
    };
  }

  // Asked by the page's script or an API client, answered in headers and JSON. A POST is an explicit wake, decided on its own
  // path; the page's probe is decided on the visitor's, which it sends. Not awake, the shared code's 503 is a 202, the rest as it
  // is. Awake, it answers a redirect, or a 503 in AWS's route grace: here, plainly `AWAKE`.
  async function wake(event, workloadId) {
    const post = event.httpMethod === 'POST';
    const path = !post && header(event, PROBE_HEADER) === '1' ? header(event, PATH_HEADER) : undefined;
    const res = await core({
      ...event,
      ...(path ? { path } : {}),
      headers: { ...event.headers, accept: 'application/json', ...(post ? { [WAKE_HEADER]: '1' } : {}) },
    });
    const state = res.multiValueHeaders['x-dormeto-state']?.[0];
    if (res.statusCode !== 307 && state !== STATES.AWAKE) {
      return sayingNapEnd(res.statusCode === 503 ? { ...res, statusCode: 202, statusDescription: '202 Accepted' } : res, event, workloadId, state);
    }
    const headers = { 'cache-control': 'no-store', 'x-dormeto-state': STATES.AWAKE, 'content-type': 'application/json' };
    return event.httpMethod === 'HEAD' ? response(200, headers) : response(200, headers, JSON.stringify({ status: 'awake' }));
  }

  // A visitor's request under a swap, or the policy's fetch: the shared core decides first, on this request's reads (the filters,
  // the rules, the wake mode, a wake, the stats and the logs), and the page answers whatever it decided. A workload that can't be
  // read, or isn't configured, is the page's to say.
  async function decide(event, workloadId) {
    const read = await Promise.all([readConfig(workloadId), readRun(workloadId), levelsCache.records({ workloadId })]).catch(() => null);
    if (!read?.[0] || !read[1]) return;
    try {
      await core(event);
    } catch (err) {
      log.warn('WakeDecisionFailed', { workloadId, error: err.message });
    }
  }

  // The error response's fetch, which may carry nothing of the visitor's request, or under a swap that request itself: the page
  // whatever the path, method and headers, once the wake is decided, with the state the decision left.
  async function waiting(event, workloadId) {
    const statusCode = underSwap(event) && !event.path.startsWith(NAMESPACE) ? 503 : 200;
    const read = await Promise.all([readConfig(workloadId), readRun(workloadId)]).catch((err) => {
      log.error('WaitingPageUnread', { workloadId, error: err.message });
      return null;
    });
    const [cfg, run] = read ?? [];
    if (read && (!cfg || !run)) log.error('WorkloadNotConfigured', { workloadId });
    const state = cfg && run ? run.state : read ? STATES.FAILED : UNREAD_STATE;
    const pollSeconds = cfg && run ? cfg.pollSeconds : UNKNOWN_POLL_SECONDS;
    const retryAt = cfg && run ? nextAttemptAt(cfg, run) : null;
    const failed = retryAt === null ? {} : { failure: failureKind(run), retryInMs: Math.max(0, retryAt - now()) };
    const napUntil = cfg && run ? await napUntilOf(workloadId, state) : null;
    const headers = {
      ...(napUntil ? { [NAP_UNTIL_HEADER]: napEndHeader(napUntil) } : {}),
      'cache-control': 'no-store', 'retry-after': String(pollSeconds), 'x-dormeto-state': state, 'content-type': 'text/html; charset=utf-8',
    };
    if (event.httpMethod === 'HEAD') return response(statusCode, headers);
    return response(statusCode, headers, renderPage({ state, pollSeconds, ...failed, napUntil, probeUrl: WAKE_PATH, cloud: CLOUD }));
  }

  return async function handler(request) {
    const event = eventOf(request);
    const workloadId = workloadIdOf(event);
    if (!workloadId) {
      return response(400, { 'cache-control': 'no-store', 'content-type': 'application/json' }, JSON.stringify({ error: 'bad request', reason: `${WORKLOAD_HEADER} names no workload` }));
    }
    // The policy's fetch carries none of the visitor's path: it is decided with none, in wake mode browser.
    const policyFetch = !underSwap(event) && event.path === WAITING_PATH;
    return thisRequest.run({ policyFetch }, async () => {
      if (event.path === WAKE_PATH) return wake(event, workloadId);
      if (policyFetch) await decide({ ...event, path: '' }, workloadId);
      else if (underSwap(event) && !event.path.startsWith(NAMESPACE)) await decide(event, workloadId);
      return waiting(event, workloadId);
    });
  };
}

// The handler of the `waker` role (server.mjs), on the router's environment.
export function fromEnvironment(env = process.env, { fetch, log = logger } = {}) {
  const google = createGoogle({ fetch });
  const store = createFirestoreStore({ google, project: env.DMT_PROJECT, database: env.DMT_DATABASE, log });
  const handler = createCloudRunWaker({
    store,
    tasks: createTasks({ google, project: env.DMT_PROJECT, region: env.DMT_REGION, queue: env.DMT_QUEUE, serviceAccount: env.DMT_SERVICE_ACCOUNT }),
    controllerUrl: env.DMT_CONTROLLER_URL,
    lists: parseLists(env.DMT_IP_LISTS, (error) => log.error('IpListsUnreadable', { error })),
    log,
  });
  // SIGTERM commits the buffered stats (server.mjs).
  handler.flush = () => store.flushStats();
  return handler;
}
