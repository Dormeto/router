// measure.mjs's commands run whole, on their context: Google's answers and the load balancer's from the test, the time
// virtual. Whoever waits is woken in time order, once everything that can run has run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { parseArgs } from '../tools/measure-core.mjs';
import { createGoogle, runGke, runSql } from '../tools/measure.mjs';

function virtualTime() {
  let clock = 0;
  let waiting = [];
  const wait = (ms) => new Promise((resolve) => { waiting.push({ at: clock + ms, resolve }); });
  return {
    now: () => clock,
    wait,
    every: (fn, ms) => {
      let stopped = false;
      (async () => {
        for (;;) {
          await wait(ms);
          if (stopped) return;
          fn();
        }
      })();
      return () => { stopped = true; };
    },
    // Until the promise settles.
    async drive(promise) {
      let settled = false;
      const end = () => { settled = true; };
      promise.then(end, end);
      for (;;) {
        await new Promise((resolve) => { setImmediate(resolve); });
        if (settled) return promise;
        waiting.sort((a, b) => a.at - b.at);
        const next = waiting.shift();
        if (next) {
          clock = Math.max(clock, next.at);
          next.resolve();
        }
      }
    },
  };
}

// The context of a command line, and what it asked of Google in order: 'METHOD url'. `google(method, url, body, t)` answers.
function contextOf(argv, { google, answer = () => ({ kind: 'http 503' }) }) {
  const time = virtualTime();
  const { command, action, options } = parseArgs(argv);
  const lines = [];
  const asked = [];
  const ctx = {
    command,
    action,
    options,
    request: async (method, url, body) => {
      asked.push({ method, url, body, t: time.now() });
      return structuredClone(await google(method, url, body, time.now()));
    },
    at: time.now,
    log: (what, value, t = time.now()) => lines.push({ t, what, value }),
    wait: time.wait,
    every: time.every,
    probe: async () => answer(time.now()),
    interrupted: () => false,
  };
  return { ctx, lines, asked, time, said: (what) => lines.filter((l) => l.what === what).map((l) => l.value) };
}

const unexpected = (method, url) => { throw new Error(`unexpected ${method} ${url}`); };

// --- sql stop|start: the operation the PATCH returns ---------------------------------------------------------------------

const SQL = 'https://sqladmin.googleapis.com/v1/projects/dormeto-dev';
const INSTANCE = `${SQL}/instances/dmt-demo-sql`;
const OPERATION = `${SQL}/operations/op-1`;

// Cloud SQL's states as Google documents them: RUNNABLE is "running, or has been stopped by owner", SUSPENDED is for billing
// and the like. So a stop reads RUNNABLE from the start to the end, and its operation alone tells that it ended.
function sqlWorld({ from, to, doneAt = 40_000, operation = {}, readFails = () => false }) {
  let sentAt = null;
  const policy = () => (sentAt === null ? from : to);
  return (method, url, body, t) => {
    if (method === 'GET' && url === INSTANCE) {
      return { state: 'RUNNABLE', databaseVersion: 'POSTGRES_16', settings: { activationPolicy: policy(), tier: 'db-f1-micro', dataDiskType: 'PD_HDD', dataDiskSizeGb: '10' } };
    }
    if (method === 'PATCH' && url === INSTANCE) {
      assert.deepEqual(body, { settings: { activationPolicy: to } });
      sentAt = t;
      return { kind: 'sql#operation', name: 'op-1', operationType: 'UPDATE', status: 'PENDING' };
    }
    if (method === 'GET' && url === OPERATION) {
      if (readFails(t - sentAt)) throw new Error('Google: 503 unavailable');
      if (t - sentAt < doneAt) return { name: 'op-1', status: t - sentAt < 5000 ? 'PENDING' : 'RUNNING' };
      return { name: 'op-1', status: 'DONE', insertTime: '2026-11-02T10:00:00.000Z', endTime: '2026-11-02T10:00:38.500Z', ...operation };
    }
    return unexpected(method, url);
  };
}

test('sql stop: RUNNABLE all along, the operation\'s end is the time, and each sample prints the state, the policy and the operation', async () => {
  const { ctx, said, time } = contextOf(['sql', 'stop'], { google: sqlWorld({ from: 'ALWAYS', to: 'NEVER' }) });
  assert.equal(await time.drive(runSql(ctx)), 0);
  assert.deepEqual(said('state'), [
    'dmt-demo-sql RUNNABLE NEVER, operation PENDING',
    'dmt-demo-sql RUNNABLE NEVER, operation RUNNING',
    'dmt-demo-sql RUNNABLE NEVER, operation RUNNING',
    'dmt-demo-sql RUNNABLE NEVER, operation RUNNING',
    'dmt-demo-sql RUNNABLE NEVER, operation DONE',
  ]);
  assert.deepEqual(said('done'), ['+40.0s after the request; Google: 38.5 s from insertTime to endTime']);
  assert.deepEqual(said('policy'), ['NEVER, +0.0s after the request']);
});

test('sql start: the operation\'s end whichever state the instance reads', async () => {
  const { ctx, said, time } = contextOf(['sql', 'start'], { google: sqlWorld({ from: 'NEVER', to: 'ALWAYS', doneAt: 20_000 }) });
  assert.equal(await time.drive(runSql(ctx)), 0);
  assert.equal(said('state').at(-1), 'dmt-demo-sql RUNNABLE ALWAYS, operation DONE');
  assert.deepEqual(said('done'), ['+20.0s after the request; Google: 38.5 s from insertTime to endTime']);
});

test('sql: an operation that fails says Google\'s words and exits 1', async () => {
  const operation = { error: { kind: 'sql#operationErrors', errors: [{ code: 'INTERNAL_ERROR', message: 'an internal error' }] } };
  const { ctx, said, time } = contextOf(['sql', 'stop'], { google: sqlWorld({ from: 'ALWAYS', to: 'NEVER', operation }) });
  assert.equal(await time.drive(runSql(ctx)), 1);
  assert.deepEqual(said('done'), ['no: INTERNAL_ERROR: an internal error']);
});

test('sql: an operation not done in time exits 1, and an unread sample does not end it', async () => {
  const { ctx, said, time, lines } = contextOf(['sql', 'stop', '--timeout', '60'], {
    google: sqlWorld({ from: 'ALWAYS', to: 'NEVER', doneAt: 3_600_000, readFails: (ms) => ms >= 10_000 && ms < 20_000 }),
  });
  assert.equal(await time.drive(runSql(ctx)), 1);
  assert.deepEqual(said('done'), ['no: not within 60 s']);
  assert.equal(lines.filter((l) => l.what === 'error').length, 1);
  assert.ok(said('state').length > 3);
});

test('sql: the policy already set is refused before any change', async () => {
  const { ctx, asked, time } = contextOf(['sql', 'stop'], { google: sqlWorld({ from: 'NEVER', to: 'NEVER' }) });
  await assert.rejects(time.drive(runSql(ctx)), /has the activation policy NEVER already/);
  assert.deepEqual(asked.map((a) => a.method), ['GET']);
});

// --- gke scale: pods behind a standalone NEG --------------------------------------------------------------------------------

const COMPUTE = 'https://compute.googleapis.com/compute/v1/projects/dormeto-dev';
const CLUSTER = 'https://container.googleapis.com/v1/projects/dormeto-dev/locations/europe-west1-b/clusters/dmt-demo-gke';
const HOST = 'gke-abc123.europe-west1-b.gke.goog';
const DEPLOYMENT = `https://${HOST}/apis/apps/v1/namespaces/default/deployments/dmt-demo-gke`;
const NEG = `${COMPUTE}/zones/europe-west1-b/networkEndpointGroups/dmt-demo-gke`;
const BACKEND = `${COMPUTE}/global/backendServices/dmt-demo-gke`;
const NODE = `${COMPUTE}/zones/europe-west1-b/instances/gke-dmt-demo-gke-node-1`;

// What Google and the cluster say, by the time since the scale: `pods`: [{ ip, health }] as getHealth has them, all on one
// node as the demo's one-node pool; `endpoints`: the addresses in the NEG; `deployment`: its status.
function gkeWorld({ replicas, later }) {
  let scaledAt = null;
  let wanted = replicas;
  const now = (t) => later(scaledAt === null ? -1 : t - scaledAt);
  return {
    google: (method, url, body, t) => {
      if (method === 'GET' && url === CLUSTER) {
        return { name: 'dmt-demo-gke', autopilot: {}, controlPlaneEndpointsConfig: { dnsEndpointConfig: { endpoint: HOST } } };
      }
      if (method === 'GET' && url === DEPLOYMENT) return { spec: { replicas: wanted }, status: now(t).status };
      if (method === 'GET' && url === `${DEPLOYMENT}/scale`) return { kind: 'Scale', metadata: { name: 'dmt-demo-gke', resourceVersion: '7' }, spec: { replicas: wanted } };
      if (method === 'PUT' && url === `${DEPLOYMENT}/scale`) {
        assert.equal(body.metadata.resourceVersion, '7');
        scaledAt = t;
        wanted = body.spec.replicas;
        return body;
      }
      if (method === 'GET' && url === BACKEND) return { name: 'dmt-demo-gke', selfLink: BACKEND, backends: [{ group: NEG }] };
      if (method === 'POST' && url === `${NEG}/listNetworkEndpoints`) {
        return { kind: 'compute#networkEndpointGroupsListNetworkEndpoints', items: now(t).endpoints.map((ip) => ({ healthStatus: {}, networkEndpoint: { instance: NODE, ipAddress: ip, port: 8080 } })) };
      }
      if (method === 'POST' && url === `${BACKEND}/getHealth`) {
        assert.deepEqual(body, { group: NEG });
        const healthStatus = now(t).health.map(([ip, healthState]) => ({ instance: NODE, ipAddress: ip, port: 8080, healthState }));
        return { kind: 'compute#backendServiceGroupHealth', ...(healthStatus.length ? { healthStatus } : {}) };
      }
      return unexpected(method, url);
    },
    // The load balancer's answers follow the same time.
    answer: (kind) => () => ({ status: 200, kind, instance: null, boot: null, error: null }),
    scaledAt: () => scaledAt,
  };
}

const gkeArgs = (replicas, more = []) => ['gke', 'scale', '--replicas', String(replicas), '--url', 'http://203.0.113.9/', '--settle', '3', ...more];
const secondsOf = (value) => Number(value.match(/\+([0-9.]+)s/)[1]);

test('gke scale to 1: one healthy pod is the healthy time, by the pods\' addresses, not the Deployment\'s name', async () => {
  const world = gkeWorld({
    replicas: 0,
    later: (ms) => {
      if (ms < 12_000) return { status: {}, endpoints: ms < 8000 ? [] : ['10.20.0.5'], health: ms < 8000 ? [] : [['10.20.0.5', 'UNHEALTHY']] };
      return { status: { replicas: 1, readyReplicas: 1 }, endpoints: ['10.20.0.5'], health: [['10.20.0.5', 'HEALTHY']] };
    },
  });
  const { ctx, said, time } = contextOf(gkeArgs(1), {
    google: world.google,
    answer: (t) => ({ status: 200, kind: world.scaledAt() !== null && t - world.scaledAt() >= 13_000 ? 'app' : 'http 503', instance: null, boot: null, error: null }),
  });
  assert.equal(await time.drive(runGke(ctx)), 0);
  const healthy = said('healthy');
  assert.equal(healthy.length, 1);
  assert.ok(secondsOf(healthy[0]) >= 12 && secondsOf(healthy[0]) <= 14, healthy[0]);
  assert.ok(said('health').includes('10.20.0.5:8080 HEALTHY'), said('health').join(', '));
  assert.ok(said('settled')[0].startsWith('3 app answers in a row from +'));
  assert.ok(said('running')[0].includes('after the request'), said('running')[0]);
});

test('gke scale: two pods on one node, one healthy, are healthy, whichever getHealth lists last', async () => {
  for (const health of [[['10.20.0.5', 'HEALTHY'], ['10.20.0.6', 'UNHEALTHY']], [['10.20.0.5', 'UNHEALTHY'], ['10.20.0.6', 'HEALTHY']]]) {
    const world = gkeWorld({
      replicas: 0,
      later: (ms) => (ms < 0 ? { status: {}, endpoints: [], health: [] } : { status: { replicas: 2, readyReplicas: 2 }, endpoints: ['10.20.0.5', '10.20.0.6'], health }),
    });
    const { ctx, said, time } = contextOf(gkeArgs(2), { google: world.google, answer: world.answer('app') });
    assert.equal(await time.drive(runGke(ctx)), 0);
    assert.notEqual(said('healthy')[0], 'no');
  }
});

test('gke scale to 0: none healthy only once an endpoint has gone, not at the first sample', async () => {
  const world = gkeWorld({
    replicas: 1,
    later: (ms) => {
      if (ms < 0) return { status: { replicas: 1, readyReplicas: 1 }, endpoints: ['10.20.0.5'], health: [['10.20.0.5', 'HEALTHY']] };
      // Just after the scale, a read with nothing in it: the endpoint is still in the NEG, and the pod still serves.
      if (ms < 3000) return { status: { replicas: 1, readyReplicas: 1 }, endpoints: ['10.20.0.5'], health: [] };
      if (ms < 9000) return { status: { replicas: 1, readyReplicas: 1 }, endpoints: ['10.20.0.5'], health: [['10.20.0.5', 'HEALTHY']] };
      return { status: ms < 30_000 ? { replicas: 1 } : {}, endpoints: [], health: [] };
    },
  });
  const { ctx, said, time } = contextOf(gkeArgs(0), {
    google: world.google,
    answer: (t) => ({ status: 200, kind: world.scaledAt() !== null && t - world.scaledAt() >= 9000 ? 'http 503' : 'app', instance: null, boot: null, error: null }),
  });
  assert.equal(await time.drive(runGke(ctx)), 0);
  const unhealthy = said('unhealthy');
  assert.equal(unhealthy.length, 1);
  assert.ok(secondsOf(unhealthy[0]) >= 9 && secondsOf(unhealthy[0]) <= 11.5, unhealthy[0]);
  assert.ok(secondsOf(said('stopped')[0]) >= 30, said('stopped')[0]);
});

test('gke scale to 0: an endpoint still there is not "none healthy", so the scale is not done', async () => {
  const world = gkeWorld({
    replicas: 1,
    later: (ms) => (ms < 0 ? { status: { replicas: 1, readyReplicas: 1 }, endpoints: ['10.20.0.5'], health: [['10.20.0.5', 'HEALTHY']] } : { status: {}, endpoints: ['10.20.0.5'], health: [] }),
  });
  const { ctx, said, time } = contextOf(gkeArgs(0, ['--timeout', '60']), { google: world.google, answer: world.answer('http 503') });
  assert.equal(await time.drive(runGke(ctx)), 1);
  assert.deepEqual(said('unhealthy'), ['no']);
  assert.deepEqual(said('done'), ['no: not within 60 s']);
});

test('gke scale to 0 of a Deployment with no endpoint: nothing to lose, none healthy from the request', async () => {
  const world = gkeWorld({
    replicas: 1,
    later: () => ({ status: {}, endpoints: [], health: [] }),
  });
  const { ctx, said, time } = contextOf(gkeArgs(0), { google: world.google, answer: world.answer('http 503') });
  assert.equal(await time.drive(runGke(ctx)), 0);
  assert.notEqual(said('unhealthy')[0], 'no');
});

test('a refusal from the cluster shows the Kubernetes Status\'s message, at its top', async (t) => {
  const server = http.createServer((req, res) => {
    res.statusCode = 403;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ kind: 'Status', apiVersion: 'v1', status: 'Failure', message: 'deployments.apps "dmt-demo-gke" is forbidden: User cannot get', reason: 'Forbidden', code: 403 }));
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const request = createGoogle({ get: async () => 'token', drop: () => {} });
  await assert.rejects(request('GET', `http://127.0.0.1:${server.address().port}/`), /403 GET .*: deployments\.apps "dmt-demo-gke" is forbidden: User cannot get/);
});
