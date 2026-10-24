import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKubeProxy, LIMITS } from '../src/lib/kube-proxy-core.mjs';
import { handler } from '../src/kube-proxy.mjs';

// Two certificate authorities, each a self-signed certificate of the loopback server: the configured one and another.
let dir;
const pems = {};
function makeAuthority(name) {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
    '-subj', `/CN=${name}`, '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
    '-keyout', join(dir, `${name}.key`), '-out', join(dir, `${name}.crt`)], { stdio: 'ignore' });
  pems[name] = { cert: readFileSync(join(dir, `${name}.crt`), 'utf8'), key: readFileSync(join(dir, `${name}.key`), 'utf8') };
}
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'kube-proxy-test-'));
  makeAuthority('cluster');
  makeAuthority('other');
});
after(() => rmSync(dir, { recursive: true, force: true }));

const TOKEN = 'k8s-aws-v1.SECRET-TOKEN-VALUE';

// An HTTPS server answering with handler(req, body, res), signed by the named authority.
async function apiServer(handler, authority = 'cluster') {
  const seen = [];
  const server = createHttpsServer(pems[authority], (req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      handler(req, body, res);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { endpoint: `https://127.0.0.1:${server.address().port}`, seen, close: () => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); } };
}

const json = (status, value) => (req, body, res) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
};

function proxyFor(endpoint, extra = {}) {
  const logs = [];
  const proxy = createKubeProxy({
    env: { DMT_CLUSTER: 'prod', DMT_ENDPOINT: endpoint, DMT_CA: pems.cluster.cert, DMT_VERSION: '0.33.0' },
    log: (event, fields) => logs.push({ event, ...fields }),
    ...extra,
  });
  return { proxy, logs };
}

const get = (endpoint, extra = {}) => ({ v: 1, endpoint, method: 'GET', path: '/api/v1/namespaces', headers: { authorization: `Bearer ${TOKEN}`, accept: 'application/json' }, ...extra });

test('a GET is forwarded and answered with its status, content type and body', async () => {
  const api = await apiServer(json(200, { items: [1] }));
  try {
    const { proxy } = proxyFor(api.endpoint);
    const answer = await proxy(get(api.endpoint, { query: { limit: '100' } }));
    assert.deepEqual(answer, { v: 1, status: 200, contentType: 'application/json', body: '{"items":[1]}' });
    assert.equal(api.seen[0].method, 'GET');
    assert.equal(api.seen[0].url, '/api/v1/namespaces?limit=100');
  } finally { await api.close(); }
});

test('only authorization, accept and content-type are forwarded', async () => {
  const api = await apiServer(json(200, {}));
  try {
    const { proxy } = proxyFor(api.endpoint);
    await proxy(get(api.endpoint, {
      method: 'PATCH', path: '/apis/apps/v1/namespaces/x/deployments/y', body: '{"spec":{}}',
      headers: { Authorization: `Bearer ${TOKEN}`, accept: 'application/json', 'Content-Type': 'application/merge-patch+json', 'impersonate-user': 'admin', 'x-other': '1' },
    }));
    const headers = api.seen[0].headers;
    assert.equal(headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(headers.accept, 'application/json');
    assert.equal(headers['content-type'], 'application/merge-patch+json');
    assert.equal(headers['impersonate-user'], undefined);
    assert.equal(headers['x-other'], undefined);
    assert.equal(api.seen[0].body, '{"spec":{}}');
    assert.equal(api.seen[0].method, 'PATCH');
  } finally { await api.close(); }
});

test('POST and DELETE are forwarded, /version too, and an error status is passed on', async () => {
  const api = await apiServer(json(404, { kind: 'Status', reason: 'NotFound' }));
  try {
    const { proxy } = proxyFor(api.endpoint);
    assert.equal((await proxy(get(api.endpoint, { method: 'POST', path: '/apis/x/v1/y', body: '{}' }))).status, 404);
    assert.equal((await proxy(get(api.endpoint, { method: 'DELETE', path: '/api/v1/namespaces/x/pods/y' }))).status, 404);
    const version = await proxy(get(api.endpoint, { path: '/version' }));
    assert.equal(version.status, 404);
    assert.equal(version.body, '{"kind":"Status","reason":"NotFound"}');
    assert.deepEqual(api.seen.map((s) => s.method), ['POST', 'DELETE', 'GET']);
  } finally { await api.close(); }
});

test('an endpoint other than the configured one is Stale, before any connection', async () => {
  const { proxy } = proxyFor('https://127.0.0.1:1');
  const answer = await proxy(get('https://elsewhere.example.com'));
  assert.deepEqual(answer, { v: 1, status: 0, reason: 'Stale', message: 'the proxy points to an earlier endpoint of cluster prod: set up its access again' });
});

const refused = async (request, message) => {
  const api = await apiServer(json(200, {}));
  try {
    const { proxy } = proxyFor(api.endpoint);
    const answer = await proxy({ ...get(api.endpoint), ...request });
    assert.equal(answer.reason, 'Refused', JSON.stringify(answer));
    assert.equal(answer.status, 0);
    assert.equal(answer.v, 1);
    if (message) assert.match(answer.message, message);
    assert.equal(api.seen.length, 0, 'nothing was sent to the API');
    return answer;
  } finally { await api.close(); }
};

test('a PUT is Refused', () => refused({ method: 'PUT', body: '{}' }, /PUT/));
test('a path outside /api/, /apis/ and /version is Refused', async () => {
  await refused({ path: '/healthz' });
  await refused({ path: '/metrics' });
  await refused({ path: '/apiary' });
  await refused({ path: '/version/x' });
});
test('a path that leaves /api/ by dot segments or reaches another host is Refused', async () => {
  await refused({ path: '/api/../healthz' });
  await refused({ path: '/api/%2e%2e/healthz' });
  await refused({ path: '//evil.example.com/api/v1' });
  await refused({ path: '/api/v1?watch=true' });
});
test('the legacy watch path forms are Refused', async () => {
  await refused({ path: '/api/v1/watch/namespaces' });
  await refused({ path: '/apis/apps/v1/watch/namespaces/x/deployments' });
});
test('a watch is Refused', () => refused({ query: { watch: 'true' } }));
test('a follow is Refused', () => refused({ path: '/api/v1/namespaces/x/pods/y/log', query: { follow: 'true' } }));
test('a body of more than 1 MB is Refused, one of exactly 1 MB is not', async () => {
  await refused({ method: 'POST', body: 'x'.repeat(LIMITS.request + 1) });
  const api = await apiServer(json(200, {}));
  try {
    const { proxy } = proxyFor(api.endpoint);
    assert.equal((await proxy(get(api.endpoint, { method: 'POST', body: 'x'.repeat(LIMITS.request) }))).status, 200);
  } finally { await api.close(); }
});
test('a protocol version other than 1 is Refused with the version', async () => {
  const { proxy } = proxyFor('https://127.0.0.1:1');
  assert.deepEqual(await proxy({ v: 2, ping: true }), { v: 1, status: 0, reason: 'Refused', message: 'unknown protocol 2' });
  assert.deepEqual(await proxy({ endpoint: 'x' }), { v: 1, status: 0, reason: 'Refused', message: 'unknown protocol undefined' });
});
test('a request that is not an object is Refused', async () => {
  const { proxy } = proxyFor('https://127.0.0.1:1');
  assert.equal((await proxy(null)).reason, 'Refused');
  assert.equal((await proxy('x')).reason, 'Refused');
});

test('an answer of more than 5 MB is TooLarge, one of exactly 5 MB is not', async () => {
  const api = await apiServer((req, body, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('x'.repeat(req.url.includes('big') ? LIMITS.answer + 1 : LIMITS.answer));
  });
  try {
    const { proxy } = proxyFor(api.endpoint);
    const big = await proxy(get(api.endpoint, { path: '/api/v1/big' }));
    assert.equal(big.reason, 'TooLarge');
    assert.equal(big.status, 0);
    assert.match(big.message, /GET \/api\/v1\/big/);
    const exact = await proxy(get(api.endpoint, { path: '/api/v1/exact' }));
    assert.equal(exact.status, 200);
    assert.equal(exact.body.length, LIMITS.answer);
  } finally { await api.close(); }
});

test('a server certificate of another authority is a TLS failure', async () => {
  const api = await apiServer(json(200, {}), 'other');
  try {
    const { proxy } = proxyFor(api.endpoint);
    const answer = await proxy(get(api.endpoint));
    assert.equal(answer.reason, 'TLS', JSON.stringify(answer));
    assert.equal(answer.status, 0);
    assert.equal(api.seen.length, 0);
    assert.ok(!JSON.stringify(answer).includes(TOKEN));
  } finally { await api.close(); }
});

test('no connection to a closed port is Network', async () => {
  const api = await apiServer(json(200, {}));
  const { endpoint } = api;
  await api.close();
  const { proxy } = proxyFor(endpoint);
  const answer = await proxy(get(endpoint));
  assert.equal(answer.reason, 'Network', JSON.stringify(answer));
});

test('a server that never answers is a Timeout after the idle time', async () => {
  const api = await apiServer(() => {});
  try {
    const { proxy } = proxyFor(api.endpoint, { timeouts: { connect: 1000, idle: 150 } });
    const started = Date.now();
    const answer = await proxy(get(api.endpoint));
    assert.equal(answer.reason, 'Timeout');
    assert.match(answer.message, /no answer for 150 ms/);
    assert.ok(Date.now() - started < 1000);
  } finally { await api.close(); }
});

test('a server that accepts but never completes the handshake is a Timeout after the connect time', async () => {
  const sockets = [];
  const server = createNetServer((socket) => { sockets.push(socket); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const endpoint = `https://127.0.0.1:${server.address().port}`;
    const { proxy } = proxyFor(endpoint, { timeouts: { connect: 150, idle: 5000 } });
    const answer = await proxy(get(endpoint));
    assert.equal(answer.reason, 'Timeout');
    assert.match(answer.message, /no connection within 150 ms/);
  } finally {
    sockets.forEach((s) => s.destroy());
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a ping answers the version and the cluster without any connection', async () => {
  const { proxy, logs } = proxyFor('https://127.0.0.1:1');
  assert.deepEqual(await proxy({ v: 1, ping: true }), { v: 1, version: '0.33.0', cluster: 'prod' });
  assert.deepEqual(logs, []);
});

test('the log lines hold the method, path, status and duration, never the token, the query or the body', async () => {
  const api = await apiServer(json(200, { secret: 'in-the-answer' }));
  try {
    const { proxy, logs } = proxyFor(api.endpoint);
    await proxy(get(api.endpoint, { method: 'POST', path: '/apis/x/v1/things', query: { fieldManager: 'QUERY-VALUE' }, body: '{"password":"BODY-VALUE"}' }));
    assert.equal(logs.length, 1);
    assert.equal(logs[0].method, 'POST');
    assert.equal(logs[0].path, '/apis/x/v1/things');
    assert.equal(logs[0].status, 200);
    assert.equal(typeof logs[0].ms, 'number');
    // A failure and a refusal are logged the same way.
    await proxy(get(api.endpoint, { path: '/healthz', query: { x: 'QUERY-VALUE' }, body: 'BODY-VALUE' }));
    const text = JSON.stringify(logs);
    for (const secret of [TOKEN, 'SECRET-TOKEN', 'QUERY-VALUE', 'BODY-VALUE', 'in-the-answer']) assert.ok(!text.includes(secret), secret);
  } finally { await api.close(); }
});

test('no error message carries the token, the query or the body', async () => {
  const api = await apiServer(json(200, {}), 'other');
  try {
    const { proxy } = proxyFor(api.endpoint);
    const answer = await proxy(get(api.endpoint, { query: { q: 'QUERY-VALUE' }, body: undefined }));
    const text = JSON.stringify(answer);
    assert.ok(!text.includes('QUERY-VALUE') && !text.includes('SECRET-TOKEN'));
  } finally { await api.close(); }
});

test('the handler answers a ping from its environment', async () => {
  process.env.DMT_VERSION = '9.9.9';
  process.env.DMT_CLUSTER = 'c1';
  assert.deepEqual(await handler({ v: 1, ping: true }), { v: 1, version: '9.9.9', cluster: 'c1' });
});

test('the limits are decimal megabytes', () => {
  assert.equal(LIMITS.request, 1_000_000);
  assert.equal(LIMITS.answer, 5_000_000);
});

test('a body under 5 MB whose JSON form exceeds what a Lambda answer can carry is TooLarge', async () => {
  const api = await apiServer((req, body, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('"'.repeat(4_900_000));
  });
  try {
    const { proxy } = proxyFor(api.endpoint);
    const answer = await proxy(get(api.endpoint));
    assert.equal(answer.reason, 'TooLarge', JSON.stringify(answer).slice(0, 200));
    assert.equal(answer.status, 0);
  } finally { await api.close(); }
});

test('a missing or malformed configuration is answered Refused, never thrown, and never matches an absent endpoint', async () => {
  const cases = [
    {},
    { DMT_ENDPOINT: 'not a url', DMT_CA: 'pem' },
    { DMT_ENDPOINT: 'http://127.0.0.1:1', DMT_CA: 'pem' },
    { DMT_ENDPOINT: 'https://127.0.0.1:1' },
  ];
  for (const env of cases) {
    const proxy = createKubeProxy({ env: { DMT_CLUSTER: 'prod', ...env } });
    for (const request of [{ v: 1, method: 'GET', path: '/api/v1/namespaces' }, get('https://127.0.0.1:1')]) {
      const answer = await proxy(request);
      assert.equal(answer.reason, 'Refused', JSON.stringify(env));
      assert.match(answer.message, /^the proxy is not configured: /);
      assert.ok(!answer.message.includes('pem'));
    }
  }
});

test('a ping still answers when the configuration is missing', async () => {
  const proxy = createKubeProxy({ env: { DMT_CLUSTER: 'prod', DMT_VERSION: '1' } });
  assert.deepEqual(await proxy({ v: 1, ping: true }), { v: 1, version: '1', cluster: 'prod' });
});
