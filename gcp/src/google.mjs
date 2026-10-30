// The router's one door to Google Cloud's REST APIs: the access token of the service account the Cloud Run service
// runs as (from the metadata server, cached until 60 s before it expires), JSON in and out, errors with the code, the
// status and the reason, and Compute Engine operations waited through their `wait` method.
const TOKEN_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const TOKEN_MARGIN_MS = 60_000;
// `wait` returns when the operation is done or after about 2 minutes.
const REQUEST_TIMEOUT_MS = 150_000;

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

export function createGoogle({ fetch = globalThis.fetch, now = Date.now } = {}) {
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
  async function request(method, url, body) {
    let answer = await send(method, url, body);
    if (answer.res.status === 401) {
      pending = null;
      current = null;
      answer = await send(method, url, body);
    }
    if (!answer.res.ok) throw errorOf(method, url, answer.res, answer.text);
    return answer.text ? JSON.parse(answer.text) : {};
  }

  // A Compute Engine operation, until it is done or `deadline` (ms, as now()) passes; a failed one throws.
  async function waitCompute(operation, deadline) {
    let op = operation;
    while (op.status !== 'DONE') {
      if (now() > deadline) throw new GoogleError(`Google: operation ${op.name} not done in time`);
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

  return { request, waitCompute };
}
