import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLUSTER_TTL_MS, KubernetesError, TIMEOUTS, clusterOf, createKubernetes, eksToken, kubernetesConnector, presignUrl } from '../src/lib/k8s.mjs';

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

test('clusterOf reads the endpoint, the decoded CA, the endpoint access, the authentication mode and the version', async () => {
  assert.deepEqual(await clusterOf(fakeEks({ 'eks-demo': CLUSTER }), 'eks-demo'), {
    endpoint: 'https://ABC.gr7.eu-west-1.eks.amazonaws.com', ca: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n',
    publicAccess: true, publicCidrs: ['0.0.0.0/0'], privateOnly: false, authMode: 'API', version: '1.36',
  });
  const restricted = { ...CLUSTER, resourcesVpcConfig: { endpointPublicAccess: false, endpointPrivateAccess: true }, accessConfig: undefined };
  const view = await clusterOf(fakeEks({ 'eks-demo': restricted }), 'eks-demo');
  assert.equal(view.publicAccess, false);
  assert.deepEqual(view.publicCidrs, []);
  assert.equal(view.privateOnly, true);
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
  assert.deepEqual(await (await kubernetesOf('eks-demo')).get('/version'), { gitVersion: 'v1.36.4' });
  assert.equal(api.seen[0].headers.authorization, `Bearer ${eksToken({ cluster: 'eks-demo', region: 'eu-west-1', credentials, now: NOW })}`);
});
