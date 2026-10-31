// The GKE adapter (gke.mjs): a cluster's address, the router's token on it, and what Google's answers are read to say. All assumed
// before M9 to M12, each in one function there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../../lambda/src/lib/failures.mjs';
import { CLUSTER_TTL_MS } from '../../lambda/src/lib/k8s.mjs';
import { fakeClock } from '../../lambda/test/fakes.mjs';
import { clusterProblem, clusterView, createGke, gkeMapRefusal, gkeProblems, isGkeNeg, negServiceOf } from '../src/gke.mjs';
import { GoogleError } from '../src/google.mjs';
import { NEG_READINGS } from './world.mjs';

const CLUSTER = { location: 'europe-west1-b', name: 'shop' };
const CLUSTER_URL = 'https://container.googleapis.com/v1/projects/p/locations/europe-west1-b/clusters/shop';
const ENDPOINT = 'shop-abcd.europe-west1-b.gke.goog';
const open = (extra = {}) => ({ autopilot: { enabled: true }, controlPlaneEndpointsConfig: { dnsEndpointConfig: { endpoint: ENDPOINT, allowExternalTraffic: true } }, ...extra });

function rig({ cluster = open(), answer = () => new Response('{"items":[]}', { status: 200 }) } = {}) {
  const clock = fakeClock();
  const t = { clock, cluster, reads: [], sent: [], tokens: ['first-token'] };
  const google = {
    request: async (method, url) => {
      t.reads.push(`${method} ${url}`);
      if (t.refused) throw t.refused;
      return structuredClone(t.cluster);
    },
    token: async () => t.tokens[0],
  };
  const fetch = async (url, init) => {
    t.sent.push({ url, ...init });
    return answer(url, init);
  };
  t.gke = createGke({ google, project: 'p', fetch, now: clock.now });
  return t;
}

test('kubernetesOf: the DNS endpoint over HTTPS, the router\'s token, redirects not followed', async () => {
  const t = rig();
  const k8s = await t.gke.kubernetesOf(CLUSTER);
  assert.deepEqual(await k8s.list('/api/v1/namespaces/shop/pods', { labelSelector: 'app=web' }), []);
  assert.deepEqual(t.reads, [`GET ${CLUSTER_URL}`]);
  assert.equal(t.sent[0].url, `https://${ENDPOINT}/api/v1/namespaces/shop/pods?labelSelector=app%3Dweb`);
  assert.equal(t.sent[0].headers.authorization, 'Bearer first-token');
  assert.equal(t.sent[0].redirect, 'manual');
  assert.equal(t.sent[0].method, 'GET');
  assert.ok(t.sent[0].signal, 'bounded');
});

test('kubernetesOf: a patch carries its body and its type', async () => {
  const t = rig();
  await (await t.gke.kubernetesOf(CLUSTER)).patch('/apis/apps/v1/namespaces/shop/deployments/web/scale', { spec: { replicas: 0 } });
  assert.equal(t.sent[0].url, `https://${ENDPOINT}/apis/apps/v1/namespaces/shop/deployments/web/scale?fieldManager=dormeto`);
  assert.equal(t.sent[0].method, 'PATCH');
  assert.equal(t.sent[0].headers['content-type'], 'application/merge-patch+json');
  assert.equal(t.sent[0].body, '{"spec":{"replicas":0}}');
});

test('kubernetesOf: the token is asked at each call: a client held through a long wait does not outlive it', async () => {
  const t = rig();
  const k8s = await t.gke.kubernetesOf(CLUSTER);
  await k8s.get('/a');
  t.tokens[0] = 'second-token';
  await k8s.get('/a');
  assert.deepEqual(t.sent.map((s) => s.headers.authorization), ['Bearer first-token', 'Bearer second-token']);
});

test('kubernetesOf: the cluster\'s view is kept for the TTL, per cluster, as k8s.mjs keeps EKS\'s', async () => {
  const t = rig();
  await t.gke.kubernetesOf(CLUSTER);
  await t.gke.kubernetesOf(CLUSTER);
  assert.equal(t.reads.length, 1);
  await t.gke.kubernetesOf({ location: 'europe-west1-c', name: 'shop' });
  assert.equal(t.reads.length, 2);
  t.clock.advance(CLUSTER_TTL_MS);
  await t.gke.kubernetesOf(CLUSTER);
  assert.equal(t.reads.length, 3);
});

test('kubernetesOf: a failed read is not kept, and neither is a cluster it cannot reach: turned on, it is reached at once', async () => {
  const t = rig();
  t.refused = new GoogleError('Google: 500', { code: 500 });
  await assert.rejects(t.gke.kubernetesOf(CLUSTER), /500/);
  t.refused = null;
  t.cluster = open({ controlPlaneEndpointsConfig: {} });
  await assert.rejects(t.gke.kubernetesOf(CLUSTER), (err) => err.kind === 'configuration' && /enable-dns-access/.test(err.message));
  t.cluster = open();
  await t.gke.kubernetesOf(CLUSTER);
  assert.equal(t.reads.length, 3);
});

test('getCluster reads Google each time: what a dry run says is not 15 minutes old', async () => {
  const t = rig();
  assert.deepEqual(await t.gke.getCluster(CLUSTER), { endpoint: ENDPOINT, open: true, autopilot: true });
  t.cluster = open({ autopilot: {} });
  assert.equal((await t.gke.getCluster(CLUSTER)).autopilot, false);
  assert.equal(t.reads.length, 2);
});

test('M11, the reading: autopilot is a boolean whatever Google leaves out', () => {
  assert.deepEqual(clusterView({}), { endpoint: null, open: false, autopilot: false });
  assert.equal(clusterView({ autopilot: { enabled: true } }).autopilot, true);
  assert.equal(clusterView({ autopilot: { enabled: false } }).autopilot, false);
});

for (const [name, config] of [
  ['no DNS endpoint', {}],
  ['a DNS endpoint closed to the outside', { dnsEndpointConfig: { endpoint: ENDPOINT, allowExternalTraffic: false } }],
  ['allowExternalTraffic unsaid', { dnsEndpointConfig: { endpoint: ENDPOINT } }],
]) {
  test(`M11: ${name} says what to turn on, and no IP endpoint is tried`, async () => {
    const problem = clusterProblem(CLUSTER, clusterView({ controlPlaneEndpointsConfig: config }));
    assert.match(problem, /^GKE cluster europe-west1-b\/shop has no DNS endpoint open to traffic from outside its network/);
    assert.match(problem, /gcloud container clusters update shop --location europe-west1-b --enable-dns-access/);
    const t = rig({ cluster: { endpoint: '34.1.2.3', controlPlaneEndpointsConfig: config } });
    await assert.rejects(t.gke.kubernetesOf(CLUSTER), /no DNS endpoint/);
    assert.deepEqual(t.sent, []);
  });
}

test('M11: an endpoint not under gke.goog: the router\'s token is not sent there', async () => {
  const t = rig({ cluster: open({ controlPlaneEndpointsConfig: { dnsEndpointConfig: { endpoint: 'evil.example.com', allowExternalTraffic: true } } }) });
  await assert.rejects(t.gke.kubernetesOf(CLUSTER), /evil\.example\.com.*not a host under gke\.goog/);
  assert.deepEqual(t.sent, []);
});

test('failures: a 403 reads as permission, unreachable as timeout, as spec section 12 says', async () => {
  const refused = rig({ answer: () => new Response(JSON.stringify({ kind: 'Status', reason: 'Forbidden', message: 'deployments.apps "web" is forbidden' }), { status: 403 }) });
  await assert.rejects((await refused.gke.kubernetesOf(CLUSTER)).get('/a'), (err) => {
    assert.deepEqual(classify(err), { kind: 'permission', message: 'deployments.apps "web" is forbidden' });
    return true;
  });
  const endpointRefused = rig({ answer: () => new Response('<html>denied</html>', { status: 403 }) });
  await assert.rejects((await endpointRefused.gke.kubernetesOf(CLUSTER)).get('/a'), (err) => classify(err).kind === 'permission');
  for (const failure of [new TypeError('fetch failed'), Object.assign(new Error('timed out'), { name: 'TimeoutError' })]) {
    const unreachable = rig({ answer: () => { throw failure; } });
    await assert.rejects((await unreachable.gke.kubernetesOf(CLUSTER)).get('/api/v1/x'), (err) => {
      assert.equal(err.name, 'KubernetesError');
      assert.equal(err.status, 0);
      assert.equal(classify(err).kind, 'timeout');
      assert.match(err.message, /GET \/api\/v1\/x/);
      return true;
    });
  }
});

test('a redirect is an answer, never followed: the token stays where it was sent', async () => {
  const t = rig({ answer: () => new Response('', { status: 302, headers: { location: 'https://elsewhere.example/' } }) });
  await assert.rejects((await t.gke.kubernetesOf(CLUSTER)).get('/a'), (err) => err.status === 302);
  assert.equal(t.sent.length, 1);
});

test('M12: a NEG names its Service in its description, or in its annotations', () => {
  const asked = { namespace: 'shop', service: 'web', clusterUid: 'c0ffee' };
  assert.deepEqual(negServiceOf(NEG_READINGS.description('shop', 'web')), asked);
  assert.deepEqual(negServiceOf(NEG_READINGS.annotations('shop', 'web')), asked);
});

for (const [name, neg] of [
  ['nothing', {}],
  ['a description that is not JSON', { description: 'made by hand' }],
  ['a description that is JSON and no object', { description: '"shop/web"' }],
  ['no Service', { description: '{"cluster-uid":"c","namespace":"shop"}' }],
  ['no namespace', { description: '{"cluster-uid":"c","service-name":"web"}' }],
  ['a name that is not one', { description: '{"namespace":"shop/../..","service-name":"web"}' }],
  ['a name of another type', { description: '{"namespace":1,"service-name":"web"}' }],
  ['annotations of another form', { annotations: { 'cluster-name': 'c' } }],
]) {
  test(`M12: ${name} reads as null: nothing is guessed`, () => assert.equal(negServiceOf(neg), null));
}

test('M12: a NEG is GKE\'s by its name, its description or its annotations; a VMs\' is not', () => {
  assert.equal(isGkeNeg({ name: 'k8s1-a-b', ...NEG_READINGS.none() }), true);
  assert.equal(isGkeNeg({ name: 'web', ...NEG_READINGS.description('shop', 'web') }), true);
  assert.equal(isGkeNeg({ name: 'web', ...NEG_READINGS.annotations('shop', 'web') }), true);
  assert.equal(isGkeNeg({ name: 'web', description: 'our VMs' }), false);
});

test('M10: the maps GKE owns are told by their names', () => {
  for (const name of ['k8s2-um-a', 'gkegw1-a', 'gkemcg1-a']) assert.match(gkeMapRefusal(name), /cloud\.google\.com\/neg/);
  for (const name of ['lb', 'k8s1-a', 'my-k8s2-map']) assert.equal(gkeMapRefusal(name), null);
});

const FULL = { cluster: CLUSTER, namespace: 'shop', service: 'web', owner: { kind: 'Deployment', name: 'web' } };
test('the request\'s gke: the dry run\'s cluster alone, or all of it', () => {
  assert.deepEqual(gkeProblems({ cluster: CLUSTER }), []);
  assert.deepEqual(gkeProblems(FULL), []);
  assert.deepEqual(gkeProblems({ ...FULL, owner: { kind: 'StatefulSet', name: 'web.v1' } }), []);
});

for (const [name, gke, words] of [
  ['not an object', 'shop', /gke: must be an object/],
  ['no cluster', {}, /gke\.cluster: must be/],
  ['a location that is not one', { cluster: { location: 'a/b', name: 'shop' } }, /gke\.cluster\.location/],
  ['a cluster name that is not one', { cluster: { location: 'europe-west1-b', name: 'Shop' } }, /gke\.cluster\.name/],
  ['a namespace with a path', { ...FULL, namespace: '../kube-system' }, /gke\.namespace/],
  ['a Service with a path', { ...FULL, service: 'a/b' }, /gke\.service/],
  ['an owner of another kind', { ...FULL, owner: { kind: 'Pod', name: 'web' } }, /gke\.owner\.kind: must be Deployment or StatefulSet/],
  ['an owner with a path', { ...FULL, owner: { kind: 'Deployment', name: 'a/../b' } }, /gke\.owner\.name/],
]) {
  test(`the request's gke: ${name} is a problem`, () => assert.match(gkeProblems(gke).join('; '), words));
}

test('M12: a NEG names its cluster as `cluster-uid`, where it says so', () => {
  assert.equal(negServiceOf(NEG_READINGS.description('shop', 'web')).clusterUid, 'c0ffee');
  assert.equal(negServiceOf(NEG_READINGS.annotations('shop', 'web')).clusterUid, 'c0ffee');
  assert.equal('clusterUid' in negServiceOf({ description: '{"namespace":"shop","service-name":"web"}' }), false);
});

for (const [name, answer] of [
  ['no answer', () => { throw new TypeError('fetch failed'); }],
  ['a 401', () => new Response('{}', { status: 401 })],
]) {
  test(`M11: after ${name} the cluster's view is read again: one recreated under its name has a new endpoint`, async () => {
    const t = rig({ answer });
    await assert.rejects((await t.gke.kubernetesOf(CLUSTER)).get('/a'));
    await t.gke.kubernetesOf(CLUSTER);
    assert.equal(t.reads.length, 2);
  });
}

for (const status of [200, 403, 404, 500]) {
  test(`M11: after a ${status} the cluster's view is kept: the endpoint answered`, async () => {
    const t = rig({ answer: () => new Response('{}', { status }) });
    await (await t.gke.kubernetesOf(CLUSTER)).get('/a').catch(() => {});
    await t.gke.kubernetesOf(CLUSTER);
    assert.equal(t.reads.length, 1);
  });
}
