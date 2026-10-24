// The Kubernetes proxy function (vision docs/specs/2026-10-24-private-eks-endpoints-design.md, sections 3, 4 and 10): attached
// to a private EKS cluster's VPC, it forwards the router's and discovery's calls to that one endpoint, verified against
// that one certificate authority. It has no AWS permission and no Kubernetes identity: the caller's token travels in the
// request. The token, the query and the bodies are never logged nor put in an error message.
import { isIP } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { request as httpsRequest } from 'node:https';

export const PROTOCOL = 1;
// A synchronous Lambda answer is at most 6 MB (6,291,456 bytes) once serialized as JSON, which escapes quotes: the
// answer's body is held to 5 MB, and the serialized answer to a limit safely below Lambda's.
export const LIMITS = { request: 1_000_000, answer: 5_000_000, serialized: 6_000_000 };
export const TIMEOUTS = { connect: 3_000, idle: 10_000 };

const METHODS = new Set(['GET', 'POST', 'PATCH', 'DELETE']);
const FORWARDED = ['authorization', 'accept', 'content-type'];
const NO_QUERY = new Set(['watch', 'follow']);
const TLS_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'CERT_UNTRUSTED', 'CERT_REVOKED', 'HOSTNAME_MISMATCH',
]);

class Failure extends Error {
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
}

const failed = (reason, message) => ({ v: PROTOCOL, status: 0, reason, message });
const isTls = (err) => TLS_CODES.has(err.code) || /^(ERR_TLS|ERR_SSL)/.test(err.code ?? '');

// env: DMT_CLUSTER, DMT_ENDPOINT, DMT_CA (PEM) and DMT_VERSION; log(event, fields); request and timeouts for the tests.
export function createKubeProxy({ env, request = httpsRequest, timeouts = TIMEOUTS, log = () => {} }) {
  // The configuration the install wrote, or why it is not usable (never its values: the CA is not a secret, but nothing
  // of the configuration is echoed).
  function misconfigured() {
    let url;
    const endpoint = env.DMT_ENDPOINT;
    try {
      url = new URL(endpoint);
    } catch {
      return 'DMT_ENDPOINT is missing or not a URL';
    }
    if (url.protocol !== 'https:') return 'DMT_ENDPOINT is not an https URL';
    if (!env.DMT_CA) return 'DMT_CA is missing';
    return undefined;
  }

  // Checks a request in the order of the spec's section 4; returns the call to make, or the answer that refuses it.
  const stale = (event) => (event.endpoint !== env.DMT_ENDPOINT
    ? failed('Stale', `the proxy points to an earlier endpoint of cluster ${env.DMT_CLUSTER}: set up its access again`) : undefined);

  function check(event) {
    const endpoint = env.DMT_ENDPOINT;
    if (stale(event)) return { answer: stale(event) };
    const { method, path, query = {}, headers = {}, body } = event;
    if (!METHODS.has(method)) return { answer: failed('Refused', `method ${String(method).slice(0, 20)} is not allowed`) };
    if (typeof path !== 'string' || !path.startsWith('/') || /[?#\\]/.test(path)) return { answer: failed('Refused', 'the path is not allowed') };
    // The normalized path decides: dot segments and encoded dots are resolved before the check.
    const url = new URL(path, endpoint);
    if (url.origin !== new URL(endpoint).origin) return { answer: failed('Refused', 'the path is not allowed') };
    const route = url.pathname;
    if (!(route.startsWith('/api/') || route.startsWith('/apis/') || route === '/version')) return { answer: failed('Refused', `path ${route} is not allowed`) };
    // The legacy watch form: /api/<version>/watch/... and /apis/<group>/<version>/watch/...
    const segments = route.split('/');
    if (segments[route.startsWith('/api/') ? 3 : 4] === 'watch' && route !== '/version') return { answer: failed('Refused', 'watch is not allowed') };
    if (query === null || typeof query !== 'object') return { answer: failed('Refused', 'the query is not allowed') };
    for (const [name, value] of Object.entries(query)) {
      if (NO_QUERY.has(name.toLowerCase())) return { answer: failed('Refused', `${name} is not allowed`) };
      url.searchParams.set(name, value);
    }
    if (body !== undefined && typeof body !== 'string') return { answer: failed('Refused', 'the body must be a string') };
    if (body !== undefined && Buffer.byteLength(body) > LIMITS.request) return { answer: failed('Refused', `the body exceeds ${LIMITS.request} bytes`) };
    const forwarded = {};
    for (const [name, value] of Object.entries(headers ?? {})) {
      if (FORWARDED.includes(name.toLowerCase()) && typeof value === 'string') forwarded[name.toLowerCase()] = value;
    }
    return { call: { method, url, route, headers: forwarded, body } };
  }

  const forward = ({ method, url, route, headers, body }) => new Promise((resolve, reject) => {
    const where = `${method} ${route}`;
    const req = request(url, {
      method, ca: env.DMT_CA, timeout: timeouts.idle,
      headers: { ...headers, ...(body === undefined ? {} : { 'content-length': Buffer.byteLength(body) }) },
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > LIMITS.answer) return req.destroy(new Failure('TooLarge', `${where}: the answer exceeds ${LIMITS.answer} bytes`));
        chunks.push(chunk);
      });
      res.on('error', (err) => req.destroy(err));
      res.on('end', () => resolve({ v: PROTOCOL, status: res.statusCode, contentType: res.headers['content-type'], body: Buffer.concat(chunks).toString() }));
    });
    req.on('socket', (socket) => {
      if (socket.authorized) return; // a kept-alive connection, already verified
      const timer = setTimeout(() => req.destroy(new Failure('Timeout', `${where}: no connection within ${timeouts.connect} ms`)), timeouts.connect);
      socket.once('secureConnect', () => clearTimeout(timer));
      socket.once('close', () => clearTimeout(timer));
    });
    req.on('timeout', () => req.destroy(new Failure('Timeout', `${where}: no answer for ${timeouts.idle} ms`)));
    req.on('error', (err) => {
      if (err instanceof Failure) return reject(err);
      // The error's code, never its message: a message may quote the request.
      reject(new Failure(isTls(err) ? 'TLS' : 'Network', `${where}: ${err.code ?? 'connection failed'}`));
    });
    req.end(body);
  });

  // A TLS connection to the endpoint, verified against the CA, closed at once: no HTTP request, no token. Reaching the
  // cluster's security group and its certificate is all a probe proves.
  const probe = () => new Promise((resolve, reject) => {
    const url = new URL(env.DMT_ENDPOINT);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const socket = tlsConnect({ host, port: Number(url.port) || 443, ca: env.DMT_CA, ...(isIP(host) ? {} : { servername: host }) });
    const timer = setTimeout(() => socket.destroy(new Failure('Timeout', `no connection within ${timeouts.connect} ms`)), timeouts.connect);
    socket.once('secureConnect', () => {
      clearTimeout(timer);
      socket.end();
      resolve();
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err instanceof Failure ? err : new Failure(isTls(err) ? 'TLS' : 'Network', `ping: ${err.code ?? 'connection failed'}`));
    });
  });

  async function ping(event) {
    const problem = misconfigured();
    if (problem) return failed('Refused', `the proxy is not configured: ${problem}`);
    const old = stale(event);
    if (old) return old;
    if (event.probe === true) {
      try {
        await probe();
      } catch (err) {
        return failed(err.reason ?? 'Network', err.message);
      }
    }
    return { v: PROTOCOL, version: env.DMT_VERSION, cluster: env.DMT_CLUSTER };
  }

  return async function proxy(event) {
    if (event === null || typeof event !== 'object') return failed('Refused', 'the request is not an object');
    if (event.v !== PROTOCOL) return failed('Refused', `unknown protocol ${event.v}`);
    if (event.ping === true) return ping(event);

    const started = Date.now();
    const problem = misconfigured();
    const checked = problem ? { answer: failed('Refused', `the proxy is not configured: ${problem}`) } : check(event);
    const done = (answer) => {
      log('KubeProxyCall', {
        method: String(event.method).slice(0, 20), path: typeof event.path === 'string' ? event.path.split(/[?#]/)[0] : undefined,
        status: answer.status, ...(answer.reason ? { reason: answer.reason } : {}), ms: Date.now() - started,
      });
      return answer;
    };
    if (checked.answer) return done(checked.answer);
    try {
      const answer = await forward(checked.call);
      // What Lambda carries is the serialized answer, whose escapes grow quote-heavy bodies.
      if (Buffer.byteLength(JSON.stringify(answer)) > LIMITS.serialized) {
        return done(failed('TooLarge', `${checked.call.method} ${checked.call.route}: the answer exceeds what a function can return`));
      }
      return done(answer);
    } catch (err) {
      return done(err instanceof Failure ? failed(err.reason, err.message) : failed('Network', `${checked.call.method} ${checked.call.route}: connection failed`));
    }
  };
}
