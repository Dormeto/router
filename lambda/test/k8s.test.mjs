import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { kubeProxyName } from '../src/lib/kube-proxy-name.mjs';
import { CLUSTER_TTL_MS, KubernetesError, TIMEOUTS, UNREACHABLE, clusterOf, createKubernetes, eksToken, kubernetesConnector, pingProxy, presignUrl, proxyTransport, reachOf } from '../src/lib/k8s.mjs';

// SigV4 by hand (the router imports nothing but Node and AWS SDK clients): checked against AWS's documented presigned URL
// and against botocore 1.43, the signer of the AWS CLI's `aws eks get-token`.
test('presignUrl reproduces the presigned URL of the S3 documentation byte for byte', () => {
  const url = presignUrl({
    host: 'examplebucket.s3.amazonaws.com', path: '/test.txt', region: 'us-east-1', service: 's3',
    credentials: { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
    now: Date.UTC(2013, 4, 24), expires: 86400, payloadHash: 'UNSIGNED-PAYLOAD',
  });
  assert.equal(url, 'https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256'
    + '&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z'
    + '&X-Amz-Expires=86400&X-Amz-SignedHeaders=host'
    + '&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
});

const NOW = Date.UTC(2026, 9, 11, 9, 30, 0);
const SECRET = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
const decode = (token) => new URL(Buffer.from(token.slice('k8s-aws-v1.'.length), 'base64url').toString());

test('eksToken equals the AWS CLI token for long-term credentials', () => {
  const token = eksToken({ cluster: 'eks-demo', region: 'eu-west-1', credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: SECRET }, now: NOW });
  assert.equal(token, 'k8s-aws-v1.aHR0cHM6Ly9zdHMuZXUtd2VzdC0xLmFtYXpvbmF3cy5jb20vP0FjdGlvbj1HZXRDYWxsZXJJZGVudGl0eSZWZXJzaW9uPTIwMTEtMDYtMTUmWC1BbXotQWxnb3JpdGhtPUFXUzQtSE1BQy1TSEEyNTYmWC1BbXotQ3JlZGVudGlhbD1BS0lERVhBTVBMRSUyRjIwMjYxMDExJTJGZXUtd2VzdC0xJTJGc3RzJTJGYXdzNF9yZXF1ZXN0JlgtQW16LURhdGU9MjAyNjEwMTFUMDkzMDAwWiZYLUFtei1FeHBpcmVzPTYwJlgtQW16LVNpZ25lZEhlYWRlcnM9aG9zdCUzQngtazhzLWF3cy1pZCZYLUFtei1TaWduYXR1cmU9ZmJkMDc3ZDUzNjdlY2Q1OTZjZjI2YjA3NWNiOGVmMDExMjhhMjk0MjlhOWU4ZTIwNDg2YzlkMjk1NzE0YmM5Zg');
});

test('eksToken equals the AWS CLI token for a role session, its token signed', () => {
  const token = eksToken({
    cluster: 'eks-demo', region: 'eu-west-1', now: NOW,
    credentials: { accessKeyId: 'ASIAEXAMPLE', secretAccessKey: SECRET, sessionToken: 'IQoJb3JpZ2luX2VjEExample/+token==' },
  });
  assert.equal(token, 'k8s-aws-v1.aHR0cHM6Ly9zdHMuZXUtd2VzdC0xLmFtYXpvbmF3cy5jb20vP0FjdGlvbj1HZXRDYWxsZXJJZGVudGl0eSZWZXJzaW9uPTIwMTEtMDYtMTUmWC1BbXotQWxnb3JpdGhtPUFXUzQtSE1BQy1TSEEyNTYmWC1BbXotQ3JlZGVudGlhbD1BU0lBRVhBTVBMRSUyRjIwMjYxMDExJTJGZXUtd2VzdC0xJTJGc3RzJTJGYXdzNF9yZXF1ZXN0JlgtQW16LURhdGU9MjAyNjEwMTFUMDkzMDAwWiZYLUFtei1FeHBpcmVzPTYwJlgtQW16LVNpZ25lZEhlYWRlcnM9aG9zdCUzQngtazhzLWF3cy1pZCZYLUFtei1TZWN1cml0eS1Ub2tlbj1JUW9KYjNKcFoybHVYMlZqRUV4YW1wbGUlMkYlMkJ0b2tlbiUzRCUzRCZYLUFtei1TaWduYXR1cmU9Njc2YzBmMmZmNDEzNDUwNTEwMzlkYjk3OWNkZmJhMmU1ODE5NzI4ZjlhNDUyNDdhZWI2ZmRlYmFiOWFjOGIyMA');
});

test('an EKS token is an STS GetCallerIdentity URL of the region, valid 60 seconds from now, the cluster signed', () => {
  const token = eksToken({ cluster: 'prod-1', region: 'eu-west-3', credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: SECRET }, now: NOW });
  assert.match(token, /^k8s-aws-v1\.[A-Za-z0-9_-]+$/, 'base64url without padding');
  const url = decode(token);
  assert.equal(url.origin, 'https://sts.eu-west-3.amazonaws.com');
  assert.equal(url.searchParams.get('Action'), 'GetCallerIdentity');
  assert.equal(url.searchParams.get('X-Amz-Date'), '20261011T093000Z');
  assert.equal(url.searchParams.get('X-Amz-Expires'), '60');
  assert.equal(url.searchParams.get('X-Amz-Credential'), 'AKIDEXAMPLE/20261011/eu-west-3/sts/aws4_request');
  assert.equal(url.searchParams.get('X-Amz-SignedHeaders'), 'host;x-k8s-aws-id');
  const other = eksToken({ cluster: 'prod-2', region: 'eu-west-3', credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: SECRET }, now: NOW });
  assert.notEqual(decode(other).searchParams.get('X-Amz-Signature'), url.searchParams.get('X-Amz-Signature'), 'the cluster name is signed');
});

// A fake API server: a self-signed certificate stands for the cluster's certificate authority.
let dir;
let ca;
let key;
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'k8s-test-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
    '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });
  ca = readFileSync(join(dir, 'cert.pem'), 'utf8');
  key = readFileSync(join(dir, 'key.pem'), 'utf8');
});
after(() => rmSync(dir, { recursive: true, force: true }));

// Starts an HTTPS server answering with handler(req, body, res); returns its endpoint, the requests seen and close().
async function apiServer(handler, options = {}) {
  const seen = [];
  const server = createHttpsServer({ cert: ca, key, ...options }, (req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body, peer: req.socket.getPeerCertificate?.() });
      handler(req, body, res);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { endpoint: `https://127.0.0.1:${server.address().port}`, seen, close: () => { server.closeAllConnections(); server.close(); } };
}

const json = (res, status, value) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
};
const status = (code, reason, message) => ({ kind: 'Status', apiVersion: 'v1', status: 'Failure', code, reason, message });

test('a call trusts the cluster CA, sends the bearer token and returns the parsed answer', async (t) => {
  const api = await apiServer((req, body, res) => json(res, 200, { kind: 'Deployment', metadata: { name: 'web' } }));
  t.after(api.close);
  const k8s = createKubernetes({ endpoint: api.endpoint, ca, token: 'k8s-aws-v1.abc' });
  assert.deepEqual(await k8s.get('/apis/apps/v1/namespaces/demo/deployments/web'), { kind: 'Deployment', metadata: { name: 'web' } });
  assert.equal(api.seen[0].method, 'GET');
  assert.equal(api.seen[0].url, '/apis/apps/v1/namespaces/demo/deployments/web');
  assert.equal(api.seen[0].headers.authorization, 'Bearer k8s-aws-v1.abc');
  assert.equal(api.seen[0].headers.accept, 'application/json');
});

test('a server whose certificate the cluster CA did not sign is refused, nothing sent', async (t) => {
  const api = await apiServer((req, body, res) => json(res, 200, {}));
  t.after(api.close);
  const k8s = createKubernetes({ endpoint: api.endpoint, ca: undefined, token: 'secret' });
  await assert.rejects(k8s.get('/api/v1/namespaces'), (err) => err instanceof KubernetesError && err.status === 0 && /certificate/i.test(err.message));
  assert.equal(api.seen.length, 0);
});

test('403 and 404 answers are KubernetesErrors with the status, the reason and the message of the API', async (t) => {
  const api = await apiServer((req, body, res) => (req.url.includes('forbidden')
    ? json(res, 403, status(403, 'Forbidden', 'deployments.apps "web" is forbidden: User "dormeto" cannot get resource'))
    : json(res, 404, status(404, 'NotFound', 'deployments.apps "gone" not found'))));
  t.after(api.close);
  const k8s = createKubernetes({ endpoint: api.endpoint, ca, token: 't' });
  await assert.rejects(k8s.get('/forbidden'), { name: 'KubernetesError', status: 403, reason: 'Forbidden', message: 'deployments.apps "web" is forbidden: User "dormeto" cannot get resource' });
  await assert.rejects(k8s.get('/gone'), { name: 'KubernetesError', status: 404, reason: 'NotFound', message: 'deployments.apps "gone" not found' });
});

test('an error answer that is not a Kubernetes Status keeps the HTTP status and its text', async (t) => {
  const api = await apiServer((req, body, res) => { res.writeHead(502, { 'content-type': 'text/html' }); res.end('<html>bad gateway</html>'); });
  t.after(api.close);
  const k8s = createKubernetes({ endpoint: api.endpoint, ca, token: 't' });
  await assert.rejects(k8s.get('/healthz'), { name: 'KubernetesError', status: 502, reason: 'Bad Gateway' });
});

test('list passes the query and follows continue tokens, returning every item', async (t) => {
  const api = await apiServer((req, body, res) => {
    const url = new URL(req.url, 'https://x');
    if (url.searchParams.get('continue') === 'page2') json(res, 200, { kind: 'PodList', metadata: {}, items: [{ n: 3 }] });
    else json(res, 200, { kind: 'PodList', metadata: { continue: 'page2' }, items: [{ n: 1 }, { n: 2 }] });
  });
  t.after(api.close);
  const k8s = createKubernetes({ endpoint: api.endpoint, ca, token: 't' });
  assert.deepEqual(await k8s.list('/api/v1/namespaces/demo/pods', { labelSelector: 'app=web,tier in (a,b)' }), [{ n: 1 }, { n: 2 }, { n: 3 }]);
  assert.equal(api.seen.length, 2);
  const first = new URL(api.seen[0].url, 'https://x');
  assert.equal(first.pathname, '/api/v1/namespaces/demo/pods');
  assert.equal(first.searchParams.get('labelSelector'), 'app=web,tier in (a,b)');
  assert.equal(first.searchParams.has('limit'), false, 'direct lists keep the API\'s pages');
  assert.equal(new URL(api.seen[1].url, 'https://x').searchParams.get('labelSelector'), 'app=web,tier in (a,b)');
});

test('patch sends the content type of its kind (merge by default) and names Dormeto as the field manager', async (t) => {
  const api = await apiServer((req, body, res) => json(res, 200, { ok: true }));
  t.after(api.close);
  const k8s = createKubernetes({ endpoint: api.endpoint, ca, token: 't' });
  await k8s.patch('/apis/apps/v1/namespaces/demo/deployments/web/scale', { spec: { replicas: 0 } });
  await k8s.patch('/apis/networking.k8s.io/v1/namespaces/demo/ingresses/solo', [{ op: 'remove', path: '/metadata/annotations/x' }], 'json');
  await k8s.patch('/apis/apps/v1/namespaces/demo/deployments/web', { metadata: { labels: { a: 'b' } } }, 'strategic');
  assert.deepEqual(api.seen.map((s) => [s.method, s.headers['content-type']]), [
    ['PATCH', 'application/merge-patch+json'], ['PATCH', 'application/json-patch+json'], ['PATCH', 'application/strategic-merge-patch+json'],
  ]);
  assert.deepEqual(JSON.parse(api.seen[0].body), { spec: { replicas: 0 } });
  assert.equal(new URL(api.seen[0].url, 'https://x').searchParams.get('fieldManager'), 'dormeto');
  await assert.rejects(k8s.patch('/x', {}, 'apply'), /patch type/);
});

test('create posts the object, remove deletes it', async (t) => {
  const api = await apiServer((req, body, res) => json(res, req.method === 'POST' ? 201 : 200, { kind: 'Ingress' }));
  t.after(api.close);
  const k8s = createKubernetes({ endpoint: api.endpoint, ca, token: 't' });
  await k8s.create('/apis/networking.k8s.io/v1/namespaces/demo/ingresses', { kind: 'Ingress', metadata: { name: 'dormeto-web' } });
  await k8s.remove('/apis/networking.k8s.io/v1/namespaces/demo/ingresses/dormeto-web');
  assert.deepEqual(api.seen.map((s) => [s.method, new URL(s.url, 'https://x').pathname]), [
    ['POST', '/apis/networking.k8s.io/v1/namespaces/demo/ingresses'],
    ['DELETE', '/apis/networking.k8s.io/v1/namespaces/demo/ingresses/dormeto-web'],
  ]);
  assert.equal(api.seen[0].headers['content-type'], 'application/json');
  assert.equal(JSON.parse(api.seen[0].body).metadata.name, 'dormeto-web');
});

test('rulesReview asks what the caller may do in a namespace', async (t) => {
  const rules = { resourceRules: [{ verbs: ['get'], apiGroups: ['apps'], resources: ['deployments'] }], nonResourceRules: [], incomplete: false };
  const api = await apiServer((req, body, res) => json(res, 201, { kind: 'SelfSubjectRulesReview', spec: JSON.parse(body).spec, status: rules }));
  t.after(api.close);
  const k8s = createKubernetes({ endpoint: api.endpoint, ca, token: 't' });
  assert.deepEqual(await k8s.rulesReview('demo'), rules);
  assert.equal(api.seen[0].method, 'POST');
  assert.equal(api.seen[0].url, '/apis/authorization.k8s.io/v1/selfsubjectrulesreviews');
  assert.deepEqual(JSON.parse(api.seen[0].body), { apiVersion: 'authorization.k8s.io/v1', kind: 'SelfSubjectRulesReview', spec: { namespace: 'demo' } });
});

test('accessReview asks whether the caller may do one thing, whatever authorizer grants it', async (t) => {
  const api = await apiServer((req, body, res) => json(res, 201, { kind: 'SelfSubjectAccessReview', status: { allowed: JSON.parse(body).spec.resourceAttributes.verb === 'get' } }));
  t.after(api.close);
  const k8s = createKubernetes({ endpoint: api.endpoint, ca, token: 't' });
  assert.equal(await k8s.accessReview({ namespace: 'demo', verb: 'get', group: 'apps', resource: 'deployments', subresource: 'scale' }), true);
  assert.equal(await k8s.accessReview({ verb: 'delete', group: 'networking.k8s.io', resource: 'ingresses' }), false);
  assert.equal(api.seen[0].url, '/apis/authorization.k8s.io/v1/selfsubjectaccessreviews');
  assert.deepEqual(JSON.parse(api.seen[0].body), {
    apiVersion: 'authorization.k8s.io/v1', kind: 'SelfSubjectAccessReview',
    spec: { resourceAttributes: { namespace: 'demo', verb: 'get', group: 'apps', resource: 'deployments', subresource: 'scale' } },
  });
});

test('impersonation sends the user and one header per group', async (t) => {
  const api = await apiServer((req, body, res) => json(res, 200, { groups: req.headersDistinct['impersonate-group'] }));
  t.after(api.close);
  const k8s = createKubernetes({ endpoint: api.endpoint, ca, token: 't', impersonate: { user: 'dormeto-test', groups: ['dormeto:router', 'system:authenticated'] } });
  assert.deepEqual(await k8s.get('/api/v1/namespaces'), { groups: ['dormeto:router', 'system:authenticated'] });
  assert.equal(api.seen[0].headers['impersonate-user'], 'dormeto-test');
});

test('a client certificate authenticates instead of a token (kind clusters)', async (t) => {
  const api = await apiServer((req, body, res) => json(res, 200, {}), { requestCert: true, rejectUnauthorized: true, ca });
  t.after(api.close);
  const k8s = createKubernetes({ endpoint: api.endpoint, ca, cert: ca, key });
  await k8s.get('/api/v1/namespaces');
  assert.equal(api.seen[0].peer.subject.CN, 'localhost');
  assert.equal(api.seen[0].headers.authorization, undefined);
});

test('the client connects within 3 seconds and fails after 10 seconds of silence (the AWS calls\' bounds)', () => {
  assert.deepEqual(TIMEOUTS, { connect: 3_000, idle: 10_000 });
});

test('a server silent after the request fails the call with a timeout once the idle bound passes', async (t) => {
  const api = await apiServer(() => {});
  t.after(api.close);
  const k8s = createKubernetes({ endpoint: api.endpoint, ca, token: 't', timeouts: { connect: 1_000, idle: 200 } });
  const started = Date.now();
  await assert.rejects(k8s.get('/api/v1/pods'), { name: 'KubernetesError', status: 0, reason: 'Timeout' });
  assert.ok(Date.now() - started < 2_000);
});

test('an endpoint that never completes the TLS handshake fails the call once the connect bound passes', async (t) => {
  const sockets = [];
  const server = createNetServer((socket) => sockets.push(socket));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { sockets.forEach((s) => s.destroy()); server.close(); });
  const k8s = createKubernetes({ endpoint: `https://127.0.0.1:${server.address().port}`, ca, token: 't', timeouts: { connect: 200, idle: 5_000 } });
  const started = Date.now();
  await assert.rejects(k8s.get('/api/v1/pods'), { name: 'KubernetesError', status: 0, reason: 'Timeout' });
  assert.ok(Date.now() - started < 2_000);
});

test('a refused connection is a KubernetesError with the network error\'s code', async () => {
  const server = createNetServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  const k8s = createKubernetes({ endpoint: `https://127.0.0.1:${port}`, ca, token: 't' });
  await assert.rejects(k8s.get('/api'), { name: 'KubernetesError', status: 0, reason: 'ECONNREFUSED' });
});

// Through the proxy function (vision docs/specs/2026-10-24-private-eks-endpoints-design.md, section 3): the client invokes
// it with the request and turns its answer into what the direct client returns.
const ENDPOINT = 'https://ABC.gr7.eu-west-1.eks.amazonaws.com';
const PROXY = 'dmtr-dev-kube-eks-demo';
// A fake Lambda invoke: answers with answer(payload, n), or throws what it returns when it is an Error; records the calls.
const fakeInvoke = (answer) => {
  const calls = [];
  const invoke = async (functionName, payload) => {
    calls.push({ functionName, payload });
    const value = answer(payload, calls.length);
    if (value instanceof Error) throw value;
    return value;
  };
  return Object.assign(invoke, { calls });
};
const answered = (status, value, contentType = 'application/json') => ({ v: 1, status, contentType, body: typeof value === 'string' ? value : JSON.stringify(value) });
const awsError = (name, message = name) => Object.assign(new Error(message), { name });
const proxied = (invoke, options = {}) => createKubernetes({ endpoint: ENDPOINT, token: 'k8s-aws-v1.abc', ...options, transport: proxyTransport({ invoke, functionName: PROXY, endpoint: ENDPOINT, version: '0.33.0' }) });

test('through the proxy, a call invokes the cluster\'s proxy function with the request and returns the parsed body', async () => {
  const invoke = fakeInvoke(() => answered(200, { kind: 'Deployment', metadata: { name: 'web' } }));
  assert.deepEqual(await proxied(invoke).get('/apis/apps/v1/namespaces/demo/deployments/web'), { kind: 'Deployment', metadata: { name: 'web' } });
  assert.deepEqual(invoke.calls, [{
    functionName: PROXY,
    payload: {
      v: 1, endpoint: ENDPOINT, method: 'GET', path: '/apis/apps/v1/namespaces/demo/deployments/web', query: {},
      headers: { accept: 'application/json', authorization: 'Bearer k8s-aws-v1.abc' },
    },
  }]);
});

test('through the proxy, a write sends its body as text with its content type and the field manager in the query', async () => {
  const invoke = fakeInvoke(() => answered(200, { ok: true }));
  await proxied(invoke).patch('/apis/apps/v1/namespaces/demo/deployments/web/scale', { spec: { replicas: 0 } });
  const { payload } = invoke.calls[0];
  assert.equal(payload.method, 'PATCH');
  assert.deepEqual(payload.query, { fieldManager: 'dormeto' });
  assert.equal(payload.headers['content-type'], 'application/merge-patch+json');
  assert.equal(payload.body, '{"spec":{"replicas":0}}');
});

test('through the proxy, only the three forwarded headers travel (impersonation is the kind tests\' own)', async () => {
  const invoke = fakeInvoke(() => answered(201, {}));
  await proxied(invoke, { impersonate: { user: 'u', groups: ['g'] } }).create('/apis/networking.k8s.io/v1/namespaces/demo/ingresses', { kind: 'Ingress' });
  assert.deepEqual(Object.keys(invoke.calls[0].payload.headers).sort(), ['accept', 'authorization', 'content-type']);
});

test('through the proxy, an error answer is the same KubernetesError as directly: a Status, or the HTTP status and its text', async (t) => {
  const api = await apiServer((req, body, res) => (req.url === '/gone'
    ? json(res, 404, status(404, 'NotFound', 'deployments.apps "gone" not found'))
    : (res.writeHead(502, { 'content-type': 'text/html' }), res.end('<html>bad gateway</html>'))));
  t.after(api.close);
  const direct = createKubernetes({ endpoint: api.endpoint, ca, token: 't' });
  const invoke = fakeInvoke(({ path }) => (path === '/gone'
    ? answered(404, status(404, 'NotFound', 'deployments.apps "gone" not found'))
    : answered(502, '<html>bad gateway</html>', 'text/html')));
  const errorOf = (promise) => promise.then(() => assert.fail('expected an error'), ({ name, status: code, reason, message }) => ({ name, status: code, reason, message }));
  for (const path of ['/gone', '/healthz']) {
    const viaProxy = await errorOf(proxied(invoke).get(path));
    assert.deepEqual(viaProxy, await errorOf(direct.get(path)), path);
  }
  assert.deepEqual(await errorOf(proxied(invoke).get('/gone')), { name: 'KubernetesError', status: 404, reason: 'NotFound', message: 'deployments.apps "gone" not found' });
});

test('through the proxy, a call it could not make is a KubernetesError with status 0 and the proxy\'s reason and message', async () => {
  const invoke = fakeInvoke(() => ({ v: 1, status: 0, reason: 'Timeout', message: 'GET /api/v1/pods: no answer for 10000 ms' }));
  await assert.rejects(proxied(invoke).get('/api/v1/pods'), (err) => err instanceof KubernetesError
    && err.status === 0 && err.reason === 'Timeout' && err.message === 'GET /api/v1/pods: no answer for 10000 ms');
});

test('through the proxy, a list asks pages of 100 and follows continue tokens, the query kept', async () => {
  const invoke = fakeInvoke(({ query }) => (query.continue === 'page2'
    ? answered(200, { kind: 'PodList', metadata: {}, items: [{ n: 3 }] })
    : answered(200, { kind: 'PodList', metadata: { continue: 'page2' }, items: [{ n: 1 }, { n: 2 }] })));
  assert.deepEqual(await proxied(invoke).list('/api/v1/namespaces/demo/pods', { labelSelector: 'app=web' }), [{ n: 1 }, { n: 2 }, { n: 3 }]);
  assert.deepEqual(invoke.calls.map((c) => c.payload.query), [
    { labelSelector: 'app=web', limit: '100' },
    { labelSelector: 'app=web', limit: '100', continue: 'page2' },
  ]);
});

test('through the proxy, an invocation that fails says what to do: no proxy (named), a proxy becoming active again, a throttled proxy', async () => {
  const cases = [
    ['ResourceNotFoundException', 'NoProxy', "the cluster's endpoint is private and its proxy dmtr-dev-kube-eks-demo is not set up: upgrade the router or set up its cluster access (Terraform: module kubernetes-proxy)"],
    ['ResourceNotReadyException', 'ProxyNotReady', 'the proxy dmtr-dev-kube-eks-demo is becoming active again (unused for 14 days): retry in a minute'],
    ['TooManyRequestsException', 'Throttled', "the proxy dmtr-dev-kube-eks-demo was throttled (the account's Lambda concurrency)"],
  ];
  for (const [name, reason, message] of cases) {
    const invoke = fakeInvoke(() => awsError(name, 'Function not found: arn:aws:lambda:eu-west-1:123456789012:function:dmtr-dev-kube-eks-demo'));
    await assert.rejects(proxied(invoke).get('/api/v1/pods'), { name: 'KubernetesError', status: 0, reason, message });
  }
  const denied = fakeInvoke(() => awsError('AccessDeniedException', 'User: arn:aws:sts::123456789012:assumed-role/r/s is not authorized to perform: lambda:InvokeFunction'));
  await assert.rejects(proxied(denied).get('/api/v1/pods'), (err) => err instanceof KubernetesError && err.status === 0
    && err.reason === 'AccessDeniedException' && err.message.includes('dmtr-dev-kube-eks-demo') && err.message.includes('lambda:InvokeFunction'));
  await assert.rejects(proxied(fakeInvoke(() => null)).get('/api/v1/pods'), { name: 'KubernetesError', status: 0, reason: 'ProxyFailed' });
});

test('through the proxy, a proxy older than the router (a protocol it does not know) says to apply the module of the router\'s version', async () => {
  const invoke = fakeInvoke(() => ({ v: 1, status: 0, reason: 'Refused', message: 'unknown protocol 2' }));
  await assert.rejects(proxied(invoke).get('/api/v1/pods'), {
    name: 'KubernetesError', status: 0, reason: 'Refused',
    message: 'the proxy dmtr-dev-kube-eks-demo is older than router 0.33.0: apply the module kubernetes-proxy of router 0.33.0',
  });
  // Any other refusal keeps the proxy's reason and message.
  const refused = fakeInvoke(() => ({ v: 1, status: 0, reason: 'Refused', message: 'watch is not allowed' }));
  await assert.rejects(proxied(refused).get('/api/v1/pods'), { status: 0, reason: 'Refused', message: 'watch is not allowed' });
});

test('review: no error message carries the token or the query, through the proxy or directly', async (t) => {
  const token = 'k8s-aws-v1.SECRET-TOKEN';
  const query = { labelSelector: 'app=secret-selector' };
  const leaks = (err) => err.message.includes('SECRET-TOKEN') || err.message.includes('secret-selector');
  const answers = [
    () => awsError('ResourceNotFoundException'), () => awsError('TooManyRequestsException'),
    () => awsError('ServiceException', 'Lambda was unable to complete the request'), () => awsError('Error', 'socket hang up'),
    () => ({ v: 1, status: 0, reason: 'Refused', message: 'watch is not allowed' }),
    () => ({ v: 1, status: 0, reason: 'Refused', message: 'unknown protocol 2' }),
    () => ({ v: 1, status: 0, reason: 'Timeout', message: 'GET /api/v1/namespaces/demo/pods: no answer for 10000 ms' }),
    () => answered(500, 'internal error', 'text/plain'), () => 'not an answer',
  ];
  for (const answer of answers) {
    const k8s = proxied(fakeInvoke(answer), { token });
    await assert.rejects(k8s.list('/api/v1/namespaces/demo/pods', query), (err) => err instanceof KubernetesError && !leaks(err));
  }
  const api = await apiServer(() => {});
  t.after(api.close);
  const direct = createKubernetes({ endpoint: api.endpoint, ca, token, timeouts: { connect: 1_000, idle: 100 } });
  await assert.rejects(direct.list('/api/v1/namespaces/demo/pods', query), (err) => err instanceof KubernetesError && err.reason === 'Timeout' && !leaks(err));
});

test('pingProxy asks the proxy its version and cluster, without any call to the cluster; its failures read as a call\'s', async () => {
  const invoke = fakeInvoke(() => ({ v: 1, version: '0.33.0', cluster: 'eks-demo' }));
  assert.deepEqual(await pingProxy(invoke, PROXY), { version: '0.33.0', cluster: 'eks-demo' });
  assert.deepEqual(invoke.calls, [{ functionName: PROXY, payload: { v: 1, ping: true } }]);
  const probed = fakeInvoke(() => ({ v: 1, version: '0.33.0', cluster: 'eks-demo' }));
  await pingProxy(probed, PROXY, { endpoint: 'https://ABC.eks', probe: true });
  await pingProxy(probed, PROXY, { endpoint: 'https://ABC.eks' });
  assert.deepEqual(probed.calls.map((c) => c.payload), [{ v: 1, ping: true, endpoint: 'https://ABC.eks', probe: true }, { v: 1, ping: true, endpoint: 'https://ABC.eks' }]);
  await assert.rejects(pingProxy(fakeInvoke(() => awsError('ResourceNotFoundException')), PROXY), { name: 'KubernetesError', status: 0, reason: 'NoProxy', message: /its proxy dmtr-dev-kube-eks-demo is not set up/ });
  await assert.rejects(pingProxy(fakeInvoke(() => awsError('ResourceNotReadyException')), PROXY), { reason: 'ProxyNotReady' });
  await assert.rejects(pingProxy(fakeInvoke(() => ({ v: 1, status: 0, reason: 'Refused', message: 'unknown protocol 1' })), PROXY, { version: '0.33.0' }), {
    reason: 'Refused', message: 'the proxy dmtr-dev-kube-eks-demo is older than router 0.33.0: apply the module kubernetes-proxy of router 0.33.0',
  });
});

const CLUSTER = {
  name: 'eks-demo', version: '1.36', endpoint: 'https://ABC.gr7.eu-west-1.eks.amazonaws.com',
  certificateAuthority: { data: Buffer.from('-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n').toString('base64') },
  resourcesVpcConfig: { endpointPublicAccess: true, endpointPrivateAccess: false, publicAccessCidrs: ['0.0.0.0/0'] },
  accessConfig: { authenticationMode: 'API' },
};

const fakeEks = (clusters) => {
  const calls = [];
  return {
    calls,
    describeCluster: async ({ name }) => {
      calls.push(name);
      const cluster = typeof clusters === 'function' ? clusters(name, calls.length) : clusters[name];
      if (!cluster) throw Object.assign(new Error(`No cluster found for name: ${name}.`), { name: 'ResourceNotFoundException' });
      return { cluster };
    },
  };
};

// The choice of transport (vision docs/specs/2026-10-24-private-eks-endpoints-design.md, section 2).
test('reachOf: a public endpoint open to every address is called directly, else through the proxy when private access is on, else not at all', () => {
  assert.equal(reachOf({ endpointPublicAccess: true, publicAccessCidrs: ['0.0.0.0/0'], endpointPrivateAccess: false }), 'direct');
  assert.equal(reachOf({ endpointPublicAccess: true, publicAccessCidrs: ['0.0.0.0/0'], endpointPrivateAccess: true }), 'direct', 'the clusters onboarded today keep direct calls');
  assert.equal(reachOf({ endpointPublicAccess: true, publicAccessCidrs: ['203.0.113.7/32'], endpointPrivateAccess: true }), 'proxy');
  assert.equal(reachOf({ endpointPublicAccess: false, endpointPrivateAccess: true }), 'proxy');
  assert.equal(reachOf({ endpointPublicAccess: true, publicAccessCidrs: ['203.0.113.7/32'], endpointPrivateAccess: false }), 'none');
  assert.equal(reachOf({}), 'none');
});

test('UNREACHABLE says why a limited public endpoint without private access is not reached, and what to do (spec section 8)', () => {
  assert.equal(UNREACHABLE, "the cluster's public endpoint is limited to some addresses and its private access is off: turn on private access, and Dormeto reaches it from inside its VPC");
});

test('clusterOf reads the endpoint, the decoded CA, the endpoint access, the authentication mode and the version', async () => {
  assert.deepEqual(await clusterOf(fakeEks({ 'eks-demo': CLUSTER }), 'eks-demo'), {
    endpoint: 'https://ABC.gr7.eu-west-1.eks.amazonaws.com', ca: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n',
    publicAccess: true, publicCidrs: ['0.0.0.0/0'], privateOnly: false, privateAccess: false, authMode: 'API', version: '1.36',
  });
  const restricted = { ...CLUSTER, resourcesVpcConfig: { endpointPublicAccess: false, endpointPrivateAccess: true }, accessConfig: undefined };
  const view = await clusterOf(fakeEks({ 'eks-demo': restricted }), 'eks-demo');
  assert.equal(view.publicAccess, false);
  assert.deepEqual(view.publicCidrs, []);
  assert.equal(view.privateOnly, true);
  assert.equal(view.privateAccess, true);
  assert.equal(view.authMode, 'CONFIG_MAP', 'a cluster without accessConfig predates access entries');
});

test('clusterOf keeps a cluster 15 minutes per EKS client and name, and does not keep a failure', async () => {
  assert.equal(CLUSTER_TTL_MS, 15 * 60_000);
  const eks = fakeEks({ 'eks-demo': CLUSTER, other: CLUSTER });
  await clusterOf(eks, 'eks-demo', NOW);
  await clusterOf(eks, 'eks-demo', NOW + CLUSTER_TTL_MS - 1);
  await clusterOf(eks, 'other', NOW);
  assert.deepEqual(eks.calls, ['eks-demo', 'other']);
  await clusterOf(eks, 'eks-demo', NOW + CLUSTER_TTL_MS);
  assert.deepEqual(eks.calls, ['eks-demo', 'other', 'eks-demo']);
  await clusterOf(fakeEks({ 'eks-demo': CLUSTER }), 'eks-demo', NOW);

  const flaky = fakeEks((name, n) => (n === 1 ? undefined : CLUSTER));
  await assert.rejects(clusterOf(flaky, 'eks-demo', NOW), { name: 'ResourceNotFoundException' });
  assert.equal((await clusterOf(flaky, 'eks-demo', NOW)).version, '1.36');
  assert.equal(flaky.calls.length, 2);
});

test('kubernetesConnector gives a cluster\'s client: its endpoint and CA from EKS, a token signed with the caller\'s credentials', async (t) => {
  const api = await apiServer((req, body, res) => json(res, 200, { gitVersion: 'v1.36.4' }));
  t.after(api.close);
  const credentials = { accessKeyId: 'ASIAEXAMPLE', secretAccessKey: SECRET, sessionToken: 'session' };
  const eks = {
    describeCluster: async ({ name }) => ({ cluster: { ...CLUSTER, name, endpoint: api.endpoint, certificateAuthority: { data: Buffer.from(ca).toString('base64') } } }),
    credentials: async () => credentials,
  };
  const kubernetesOf = kubernetesConnector({ eks, region: 'eu-west-1', now: () => NOW });
  const client = await kubernetesOf('eks-demo');
  assert.deepEqual(await client.get('/version'), { gitVersion: 'v1.36.4' });
  assert.equal(api.seen[0].headers.authorization, `Bearer ${eksToken({ cluster: 'eks-demo', region: 'eu-west-1', credentials, now: NOW })}`);
  assert.equal(client.via, 'direct');
  assert.equal('proxy' in client, false);
});

const CREDENTIALS = { accessKeyId: 'ASIAEXAMPLE', secretAccessKey: SECRET, sessionToken: 'session' };
const LIMITED = { endpointPublicAccess: true, publicAccessCidrs: ['203.0.113.7/32'], endpointPrivateAccess: true };
const eksOf = (vpcOf) => ({
  calls: 0,
  async describeCluster({ name }) {
    this.calls += 1;
    return { cluster: { ...CLUSTER, name, resourcesVpcConfig: typeof vpcOf === 'function' ? vpcOf(this.calls) : vpcOf } };
  },
  credentials: async () => CREDENTIALS,
});

test('kubernetesConnector reaches a private cluster through its proxy: the function named after the router\'s prefix, the endpoint and token of a direct call', async () => {
  const invoke = fakeInvoke(() => answered(200, { gitVersion: 'v1.36.4' }));
  const kubernetesOf = kubernetesConnector({ eks: eksOf(LIMITED), region: 'eu-west-1', now: () => NOW, lambda: { invoke }, proxyPrefix: 'dmtr-dev-kube-', version: '0.33.0' });
  const client = await kubernetesOf('eks-demo');
  assert.deepEqual(await client.get('/version'), { gitVersion: 'v1.36.4' });
  assert.equal(client.via, 'proxy');
  assert.equal(client.proxy, 'dmtr-dev-kube-eks-demo');
  assert.equal(invoke.calls[0].functionName, 'dmtr-dev-kube-eks-demo');
  assert.equal(invoke.calls[0].payload.endpoint, CLUSTER.endpoint);
  assert.equal(invoke.calls[0].payload.headers.authorization, `Bearer ${eksToken({ cluster: 'eks-demo', region: 'eu-west-1', credentials: CREDENTIALS, now: NOW })}`);

  const long = 'a-cluster-name-long-enough-to-overflow-the-sixty-four-characters';
  const other = await kubernetesConnector({ eks: eksOf({ endpointPublicAccess: false, endpointPrivateAccess: true }), region: 'eu-west-1', now: () => NOW, lambda: { invoke }, proxyPrefix: 'dmtr-dev-kube-' })(long);
  assert.equal(other.proxy, kubeProxyName('dmtr-dev-kube-', long));
  assert.ok(other.proxy.length <= 64);
  // A proxy older than the router: the message names the router's version.
  const older = fakeInvoke(() => ({ v: 1, status: 0, reason: 'Refused', message: 'unknown protocol 1' }));
  const client2 = await kubernetesConnector({ eks: eksOf(LIMITED), region: 'eu-west-1', now: () => NOW, lambda: { invoke: older }, proxyPrefix: 'dmtr-dev-kube-', version: '0.33.0' })('eks-demo');
  await assert.rejects(client2.get('/version'), { message: 'the proxy dmtr-dev-kube-eks-demo is older than router 0.33.0: apply the module kubernetes-proxy of router 0.33.0' });
});

test('kubernetesConnector refuses a cluster it cannot reach: Unreachable when private access is off, NoProxy without the proxy\'s name or Lambda', async () => {
  const invoke = fakeInvoke(() => answered(200, {}));
  const closed = kubernetesConnector({ eks: eksOf({ ...LIMITED, endpointPrivateAccess: false }), region: 'eu-west-1', now: () => NOW, lambda: { invoke }, proxyPrefix: 'dmtr-dev-kube-' });
  await assert.rejects(closed('eks-demo'), { name: 'KubernetesError', status: 0, reason: 'Unreachable', message: UNREACHABLE });
  // A router without DMT_KUBE_PROXY_PREFIX (its Terraform module not applied yet): direct clusters only.
  const unnamed = kubernetesConnector({ eks: eksOf(LIMITED), region: 'eu-west-1', now: () => NOW, lambda: { invoke } });
  await assert.rejects(unnamed('eks-demo'), {
    name: 'KubernetesError', status: 0, reason: 'NoProxy',
    message: "the cluster's endpoint is private and its proxy is not set up: upgrade the router or set up its cluster access (Terraform: module kubernetes-proxy)",
  });
  // The manager's discovery before it passes Lambda: the same, naming the function.
  const noLambda = kubernetesConnector({ eks: eksOf(LIMITED), region: 'eu-west-1', now: () => NOW, proxyPrefix: 'dmtr-dev-kube-' });
  await assert.rejects(noLambda('eks-demo'), { name: 'KubernetesError', status: 0, reason: 'NoProxy', message: /its proxy dmtr-dev-kube-eks-demo is not set up/ });
  assert.equal(invoke.calls.length, 0);
});

test('review: a cluster limited after onboarding moves to its proxy once its view expires (15 minutes), and fails with NoProxy until the proxy exists', async () => {
  let at = NOW;
  const eks = eksOf((n) => (n === 1 ? CLUSTER.resourcesVpcConfig : LIMITED));
  const missing = fakeInvoke(() => awsError('ResourceNotFoundException', 'Function not found'));
  const kubernetesOf = kubernetesConnector({ eks, region: 'eu-west-1', now: () => at, lambda: { invoke: missing }, proxyPrefix: 'dmtr-dev-kube-' });
  assert.equal((await kubernetesOf('eks-demo')).via, 'direct');
  at = NOW + CLUSTER_TTL_MS - 1;
  assert.equal((await kubernetesOf('eks-demo')).via, 'direct', 'the view is kept 15 minutes');
  assert.equal(eks.calls, 1);
  at = NOW + CLUSTER_TTL_MS;
  const client = await kubernetesOf('eks-demo');
  assert.equal(eks.calls, 2, 'DescribeCluster read again');
  assert.equal(client.via, 'proxy');
  await assert.rejects(client.get('/apis/apps/v1/namespaces/demo/deployments/web'), { reason: 'NoProxy', message: /its proxy dmtr-dev-kube-eks-demo is not set up/ });
});
