// The router's one door to Google Cloud's REST APIs: the access token of the service account the Cloud Run service
// runs as (from the metadata server, cached until 60 s before it expires), JSON in and out, errors with the code, the
// status and the reason, and Compute Engine operations waited through their `wait` method. `token()` is the access
// token itself, for what is not a Google API: a GKE cluster's (gke.mjs), and gcp/tools/probe.mjs.
const TOKEN_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const TOKEN_MARGIN_MS = 60_000;
// `wait` returns when the operation is done or after about 2 minutes.
const REQUEST_TIMEOUT_MS = 150_000;
// A read's tries: one 429, 5xx or lost connection among a wake's 20-odd calls must not fail it. A read that ran out of its
// time is not one of them: three times that would pass what its caller has left.
const READ_TRIES = 3;
const RETRY_PAUSE_MS = 1000;
// The POSTs that only read. Never a change or a commit: what the first try did is not known.
const READING_POST = /(\/(operations\/[^/]+\/wait|backendServices\/[^/]+\/getHealth|instanceGroupManagers\/[^/]+\/listManagedInstances|instanceGroups\/[^/]+\/listInstances|networkEndpointGroups\/[^/]+\/listNetworkEndpoints(\?[^/]*)?)|\/documents:batchGet)$/;

// A GoogleError's reason when `waitCompute` gives up: the operation goes on, whatever becomes of it.
export const OPERATION_NOT_DONE = 'OPERATION_NOT_DONE';

export class GoogleError extends Error {
  // code: the HTTP status (0: none); status: Google's (`PERMISSION_DENIED`); reason: `forbidden`, `RATE_LIMIT_EXCEEDED`...
  constructor(message, { code = 0, status = '', reason = '' } = {}) {
    super(message);
    this.name = 'GoogleError';
    this.code = code;
    this.status = status;
    this.reason = reason;
  }
}

function errorOf(method, url, res, text) {
  let error;
  try {
    error = JSON.parse(text).error;
  } catch { /* not JSON */ }
  const message = error?.message ?? (text.trim().slice(0, 300) || res.statusText);
  const reason = error?.errors?.[0]?.reason ?? error?.details?.find((d) => d.reason)?.reason ?? '';
  return new GoogleError(`Google: ${method} ${url}: ${res.status} ${message}`, { code: res.status, status: error?.status ?? '', reason });
}

const transient = (err) => err instanceof TypeError || (err instanceof GoogleError && (err.code === 429 || err.code >= 500));
const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

export function createGoogle({ fetch = globalThis.fetch, now = Date.now, sleep = pause } = {}) {
  let pending = null;
  let current = null;

  const token = () => {
    if (pending && (!current || now() < current.refreshAt)) return pending;
    const asked = (async () => {
      const res = await fetch(TOKEN_URL, { headers: { 'metadata-flavor': 'Google' }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new GoogleError(`Google: the metadata server refused the access token: ${res.status}`, { code: res.status });
      const { access_token: value, expires_in: expiresIn } = await res.json();
      if (pending === asked) current = { value, refreshAt: now() + expiresIn * 1000 - TOKEN_MARGIN_MS };
      return value;
    })();
    asked.catch(() => { if (pending === asked) pending = null; });
    pending = asked;
    current = null;
    return asked;
  };

  async function send(method, url, body) {
    const value = await token();
    const res = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${value}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return { res, text: await res.text(), value };
  }

  // The parsed JSON answer ({} when empty); a refusal throws a GoogleError. A 401 (the token was revoked) is sent
  // once more with a new token.
  async function once(method, url, body) {
    let answer = await send(method, url, body);
    if (answer.res.status === 401) {
      pending = null;
      current = null;
      answer = await send(method, url, body);
    }
    if (!answer.res.ok) throw errorOf(method, url, answer.res, answer.text);
    return answer.text ? JSON.parse(answer.text) : {};
  }

  // A read that failed for a moment is tried again.
  async function request(method, url, body) {
    const tries = method === 'GET' || (method === 'POST' && READING_POST.test(url)) ? READ_TRIES : 1;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await once(method, url, body);
      } catch (err) {
        if (attempt >= tries || !transient(err)) throw err;
        await sleep(RETRY_PAUSE_MS * 2 ** (attempt - 1));
      }
    }
  }

  // A Compute Engine operation, until it is done or `deadline` (ms, as now()) passes; a failed one throws.
  async function waitCompute(operation, deadline) {
    let op = operation;
    while (op.status !== 'DONE') {
      if (now() > deadline) throw new GoogleError(`Google: operation ${op.name} not done in time`, { reason: OPERATION_NOT_DONE });
      op = await request('POST', `${op.selfLink}/wait`);
    }
    if (op.error) {
      const errors = op.error.errors ?? [];
      throw new GoogleError(`Google: operation ${op.operationType} ${op.targetLink ?? ''}: ${errors.map((e) => `${e.code}: ${e.message}`).join('; ') || 'failed'}`, {
        code: op.httpErrorStatusCode ?? 0,
        reason: errors[0]?.code ?? '',
      });
    }
    return op;
  }

  return { request, waitCompute, token };
}
