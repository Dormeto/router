// The waker on Cloud Run: one service behind the load balancer for every workload, which the backend service names in
// `x-dormeto-workload`. It answers the error response's fetch with the waiting page, and wakes through the `/_dormeto/wake`
// that the page probes, after the shared request filters. It holds nothing and redirects nothing: once the VMs are
// healthy, the load balancer sends the next request to them.
//
// It never answers a 503. The fetch must succeed for the load balancer to serve the page (Google: a failed fetch gets a
// generic error), and its policy's override gives the visitor the 503. On `/_dormeto/wake`, a 503 would be replaced by the
// page: the nap's policy applies to all the matcher's traffic, and the waker is a backend of it.
import { failureKind, nextAttemptAt } from '../../lambda/src/lib/failures.mjs';
import { WAKE_HEADER, header, response } from '../../lambda/src/lib/http.mjs';
import { logger } from '../../lambda/src/lib/log.mjs';
import { renderPage } from '../../lambda/src/lib/page.mjs';
import { STATES } from '../../lambda/src/lib/state.mjs';
import { createWaker } from '../../lambda/src/lib/waker-core.mjs';
import { createFirestoreStore } from './firestore.mjs';
import { createGoogle } from './google.mjs';
import { WORKLOAD_HEADER, WORKLOAD_ID } from './names.mjs';
import { createTasks } from './tasks.mjs';

const WAKE_PATH = '/_dormeto/wake';
const CLOUD = 'Google Cloud';
const UNKNOWN_POLL_SECONDS = 10;
// The run could not be read: nothing is claimed, the page says it wakes.
const UNREAD_STATE = 'UNKNOWN';

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

export function createCloudRunWaker({ store, tasks, controllerUrl, now = Date.now, log }) {
  const core = createWaker({
    // Whatever the configuration says: no request is held, and only the page's probe and explicit wakes wake.
    store: {
      ...store,
      getConfig: async (workloadId) => {
        const cfg = await store.getConfig(workloadId);
        return cfg && { ...cfg, waitSeconds: 0, wakeMode: 'browser' };
      },
    },
    // Only the wake: the route `/_dormeto/*` stays while awake, so reaching the waker then is no drift to repair.
    invokeController: async (payload) => {
      if (payload.action === 'wake') await tasks.enqueue({ url: `${controllerUrl}/v1/tasks`, body: payload });
    },
    workloadIdOf,
    now,
    log,
  });

  // Asked by the page's script or an API client, answered in headers and JSON. A POST is an explicit wake. Not awake, the
  // shared code's 503 is a 202, the rest as it is. Awake, it answers a redirect, or a 503 in AWS's route grace: here,
  // plainly `AWAKE`.
  async function wake(event) {
    const res = await core({
      ...event,
      headers: { ...event.headers, accept: 'application/json', ...(event.httpMethod === 'POST' ? { [WAKE_HEADER]: '1' } : {}) },
    });
    if (res.statusCode !== 307 && res.multiValueHeaders['x-dormeto-state']?.[0] !== STATES.AWAKE) {
      return res.statusCode === 503 ? { ...res, statusCode: 202, statusDescription: '202 Accepted' } : res;
    }
    const headers = { 'cache-control': 'no-store', 'x-dormeto-state': STATES.AWAKE, 'content-type': 'application/json' };
    return event.httpMethod === 'HEAD' ? response(200, headers) : response(200, headers, JSON.stringify({ status: 'awake' }));
  }

  // The error response's fetch, which may carry nothing of the visitor's request: the page whatever the path, method and
  // headers, never a wake (every scanner's request would wake the workload).
  async function waiting(event, workloadId) {
    const read = await Promise.all([store.getConfig(workloadId), store.getRun(workloadId)]).catch((err) => {
      log.error('WaitingPageUnread', { workloadId, error: err.message });
      return null;
    });
    const [cfg, run] = read ?? [];
    if (read && (!cfg || !run)) log.error('WorkloadNotConfigured', { workloadId });
    const state = cfg && run ? run.state : read ? STATES.FAILED : UNREAD_STATE;
    const pollSeconds = cfg && run ? cfg.pollSeconds : UNKNOWN_POLL_SECONDS;
    const retryAt = cfg && run ? nextAttemptAt(cfg, run) : null;
    const failed = retryAt === null ? {} : { failure: failureKind(run), retryInMs: Math.max(0, retryAt - now()) };
    const headers = { 'cache-control': 'no-store', 'retry-after': String(pollSeconds), 'x-dormeto-state': state, 'content-type': 'text/html; charset=utf-8' };
    if (event.httpMethod === 'HEAD') return response(200, headers);
    return response(200, headers, renderPage({ state, pollSeconds, ...failed, probeUrl: WAKE_PATH, cloud: CLOUD }));
  }

  return async function handler(request) {
    const event = eventOf(request);
    const workloadId = workloadIdOf(event);
    if (!workloadId) {
      return response(400, { 'cache-control': 'no-store', 'content-type': 'application/json' }, JSON.stringify({ error: 'bad request', reason: `${WORKLOAD_HEADER} names no workload` }));
    }
    return event.path === WAKE_PATH ? wake(event) : waiting(event, workloadId);
  };
}

// The handler of the `waker` role (server.mjs), on the router's environment.
export function fromEnvironment(env = process.env, { fetch, log = logger } = {}) {
  const google = createGoogle({ fetch });
  return createCloudRunWaker({
    store: createFirestoreStore({ google, project: env.DMT_PROJECT, database: env.DMT_DATABASE, log }),
    tasks: createTasks({ google, project: env.DMT_PROJECT, region: env.DMT_REGION, queue: env.DMT_QUEUE, serviceAccount: env.DMT_SERVICE_ACCOUNT }),
    controllerUrl: env.DMT_CONTROLLER_URL,
    log,
  });
}
