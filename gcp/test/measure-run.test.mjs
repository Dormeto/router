// measure.mjs's commands run whole, on their context: Google's answers and the load balancer's from the test, the time
// virtual. Whoever waits is woken in time order, once everything that can run has run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { parseArgs } from '../tools/measure-core.mjs';
import { GoogleError, createGoogle, runGke, runSql, runSwitch, runTag } from '../tools/measure.mjs';

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

// --- switch --hold: M3 ---------------------------------------------------------------------------------------------------

const VM = `${COMPUTE}/zones/europe-west1-b/instances/dmt-demo`;
const GROUP = `${COMPUTE}/zones/europe-west1-b/instanceGroups/dmt-demo`;
const CLASSIC_APP = 'dmt-demo-classic-app';
const CLASSIC_STANDIN = 'dmt-demo-classic-standin';
const service = (scope, name) => `${COMPUTE}/${scope}/backendServices/${name}`;
const classicMap = () => ({ kind: 'compute#urlMap', id: '12', name: 'dmt-dev-classic', fingerprint: 'f0=', defaultService: service('global', CLASSIC_APP) });

// A VM behind both backend services of a map. Its health follows its status with a delay; `level(status, reads)` overrides.
function holdWorld({ scope = 'global', urlMap = 'dmt-dev-classic', from = CLASSIC_APP, to = CLASSIC_STANDIN, map = classicMap(), vm = 'RUNNING', reads = null, refuse = {} } = {}) {
  const world = { map: structuredClone(map), vm, events: [], puts: [], putAt: null, changedAt: -Infinity, versions: 0 };
  const LAG_MS = 6000;
  world.google = (method, url, body, t) => {
    const refused = refuse[`${method} ${url}`];
    if (refused) throw refused(world);
    if (method === 'GET' && (url === service(scope, from) || url === service(scope, to))) {
      const isFrom = url === service(scope, from);
      return { name: isFrom ? from : to, portName: isFrom ? 'app' : 'standin', selfLink: url, backends: [{ group: GROUP }] };
    }
    if (method === 'POST' && (url === `${service(scope, from)}/getHealth` || url === `${service(scope, to)}/getHealth`)) {
      assert.deepEqual(body, { group: GROUP });
      if (reads && url.includes(`/${from}/`)) return reads(world, t);
      const settled = t - world.changedAt >= LAG_MS ? world.vm : (world.vm === 'RUNNING' ? 'TERMINATED' : 'RUNNING');
      return { healthStatus: [{ instance: VM, ipAddress: '10.10.0.2', port: 80, healthState: settled === 'RUNNING' ? 'HEALTHY' : 'UNHEALTHY' }] };
    }
    const mapUrl = `${COMPUTE}/${scope}/urlMaps/${urlMap}`;
    if (method === 'GET' && url === mapUrl) return world.map;
    if (method === 'PUT' && url === mapUrl) {
      assert.equal(body.fingerprint, world.map.fingerprint, 'a stale fingerprint is refused');
      world.versions += 1;
      world.map = { ...structuredClone(body), fingerprint: `f${world.versions}=` };
      world.puts.push(structuredClone(body));
      world.putAt ??= t;
      world.events.push('map');
      return { status: 'DONE' };
    }
    if (method === 'GET' && url === VM) return { name: 'dmt-demo', status: world.vm };
    if (method === 'POST' && (url === `${VM}/stop` || url === `${VM}/start`)) {
      const action = url.slice(url.lastIndexOf('/') + 1);
      world.vm = action === 'stop' ? 'TERMINATED' : 'RUNNING';
      world.changedAt = t;
      world.events.push(action);
      return { status: 'DONE' };
    }
    return unexpected(method, url);
  };
  // The load balancer: the app, then the stand-in 3 s after the update, nothing while the VM is down.
  world.answer = (t) => {
    if (world.vm !== 'RUNNING') return { status: 503, kind: 'http 503', instance: null, boot: null, error: null };
    return { status: 200, kind: world.putAt !== null && t - world.putAt >= 3000 ? 'stand-in' : 'app', instance: 'dmt-demo', boot: 'b', error: null };
  };
  return world;
}

const holdArgs = (more = []) => ['switch', '--hold', '--url-map', 'dmt-dev-classic', '--url', 'http://203.0.113.7/', '--from', CLASSIC_APP, '--to', CLASSIC_STANDIN, '--settle', '3', '--baseline', '1', ...more];
const holdRun = (world, argv = holdArgs()) => {
  const run = contextOf(argv, { google: world.google, answer: world.answer });
  return { ...run, code: run.time.drive(runSwitch(run.ctx)) };
};

test('switch --hold on a classic map: the swap and the hold route written, the VM stopped and started under getHealth, the map restored', async () => {
  const world = holdWorld();
  const { code, said } = holdRun(world);
  assert.equal(await code, 0);
  assert.deepEqual(world.events, ['map', 'stop', 'start', 'map']);
  assert.deepEqual(world.puts[0], {
    ...classicMap(),
    defaultService: service('global', CLASSIC_STANDIN),
    hostRules: [{ hosts: ['*'], pathMatcher: 'dormeto-hold' }],
    pathMatchers: [{
      name: 'dormeto-hold',
      defaultService: service('global', CLASSIC_STANDIN),
      pathRules: [{ paths: ['/_dormeto/backend/*'], service: service('global', CLASSIC_APP) }],
    }],
  });
  assert.deepEqual(world.puts[1], { ...classicMap(), fingerprint: 'f1=' });
  assert.ok(said('hold route')[0].includes('/_dormeto/backend/* to dmt-demo-classic-app'), said('hold route')[0]);
  assert.deepEqual(said('health').filter((h) => /^\S+ (un)?healthy$/.test(h) && h.startsWith(CLASSIC_APP)), [`${CLASSIC_APP} healthy`, `${CLASSIC_APP} unhealthy`, `${CLASSIC_APP} healthy`]);
  assert.ok(secondsOf(said('hold unhealthy')[0]) >= 6 && secondsOf(said('hold unhealthy')[0]) < 9, said('hold unhealthy')[0]);
  assert.ok(secondsOf(said('hold healthy')[0]) >= 6 && secondsOf(said('hold healthy')[0]) < 9, said('hold healthy')[0]);
  assert.match(said('hold reads')[0], /^dmt-demo-classic-app since the update: \d+ healthy, \d+ unhealthy, 0 no status$/);
  assert.equal(said('restore').at(-1).startsWith('done: dmt-dev-classic as it was'), true, said('restore').join(', '));
});

test('switch --hold on the regional map: the same, in its region', async () => {
  const from = 'dmt-demo-regional-app';
  const to = 'dmt-demo-regional-standin';
  const scope = 'regions/europe-west1';
  const map = { name: 'dmt-dev-regional', fingerprint: 'f0=', defaultService: service(scope, from) };
  const world = holdWorld({ scope, urlMap: 'dmt-dev-regional', from, to, map });
  const { code } = holdRun(world, ['switch', '--hold', '--region', 'europe-west1', '--url-map', 'dmt-dev-regional', '--url', 'http://regional.gcp.dev.dormeto.com/', '--from', from, '--to', to, '--settle', '3', '--baseline', '1']);
  assert.equal(await code, 0);
  assert.deepEqual(world.events, ['map', 'stop', 'start', 'map']);
  assert.equal(world.puts[0].pathMatchers[0].pathRules[0].service, service(scope, from));
  assert.deepEqual(world.puts[1], { ...map, fingerprint: 'f1=' });
});

test('switch --hold: a backend service with no status through the swap is M3\'s failure: exit 1, the VM back, the map restored', async () => {
  const world = holdWorld({ reads: () => ({ kind: 'compute#backendServiceGroupHealth' }) });
  const { code, said } = holdRun(world, holdArgs(['--timeout', '40']));
  assert.equal(await code, 1);
  assert.deepEqual(world.events, ['map', 'stop', 'start', 'map']);
  assert.deepEqual(said('hold unhealthy'), ['no: dmt-demo-classic-app not read as unhealthy within 40 s of the stop']);
  assert.deepEqual(said('hold healthy'), ['no: dmt-demo-classic-app not read as healthy within 40 s of the start']);
  assert.match(said('hold reads')[0], /0 healthy, 0 unhealthy, [1-9]\d* no status$/);
  assert.equal(world.vm, 'RUNNING');
  assert.deepEqual(world.puts.at(-1), { ...classicMap(), fingerprint: 'f1=' });
});

test('switch --hold: a refused stop still restores the map, and the refusal is what the command ends on', async () => {
  const world = holdWorld({ refuse: { [`POST ${VM}/stop`]: () => new Error('Google: 403 forbidden') } });
  const { code } = holdRun(world);
  await assert.rejects(code, /403 forbidden/);
  assert.deepEqual(world.events, ['map', 'map']);
  assert.deepEqual(world.puts.at(-1), { ...classicMap(), fingerprint: 'f1=' });
});

test('switch --hold: a swap that does not settle stops no VM, and restores the map', async () => {
  const world = holdWorld();
  const { answer } = world;
  world.answer = (t) => ({ ...answer(t), kind: 'app' });
  const { code, said } = holdRun(world, holdArgs(['--timeout', '20']));
  assert.equal(await code, 1);
  assert.deepEqual(world.events, ['map', 'map']);
  assert.match(said('settled')[0], /^no: not 3 stand-in in a row within 20 s/);
});

test('switch --hold: interrupted with the VM stopped, the map restored and the VM said to be down', async () => {
  const world = holdWorld();
  const run = contextOf(holdArgs(), { google: world.google, answer: world.answer });
  run.ctx.interrupted = () => world.vm === 'TERMINATED';
  assert.equal(await run.time.drive(runSwitch(run.ctx)), 1);
  assert.deepEqual(world.events, ['map', 'stop', 'map']);
  assert.deepEqual(run.said('vm'), ['dmt-demo is still stopped: node gcp/tools/measure.mjs vm start']);
});

test('switch --hold: a map that cannot be restored says so, by name, and exits 1', async () => {
  const world = holdWorld();
  const mapUrl = `${COMPUTE}/global/urlMaps/dmt-dev-classic`;
  const put = world.google;
  world.google = (method, url, body, t) => {
    if (method === 'PUT' && url === mapUrl && world.events.includes('start')) throw new Error('Google: 503 unavailable');
    return put(method, url, body, t);
  };
  const { code, said } = holdRun(world);
  assert.equal(await code, 1);
  assert.match(said('restore').at(-1), /^failed: Google: 503 unavailable: dmt-dev-classic stays swapped/);
});

test('switch --hold refuses before any change: the VM not running, a hold route already there, or route rules', async () => {
  const notRunning = holdWorld({ vm: 'TERMINATED' });
  await assert.rejects(holdRun(notRunning).code, /dmt-demo is TERMINATED: --hold stops and starts a running VM/);
  assert.deepEqual(notRunning.events, []);

  const hold = { name: 'm', defaultService: service('global', CLASSIC_APP), pathRules: [{ paths: ['/_dormeto/backend/*'], service: service('global', CLASSIC_APP) }] };
  const already = holdWorld({ map: { ...classicMap(), hostRules: [{ hosts: ['*'], pathMatcher: 'm' }], pathMatchers: [hold] } });
  await assert.rejects(holdRun(already).code, /already has \/_dormeto\/backend\/\*/);
  assert.deepEqual(already.events, []);

  const routed = { name: 'm', defaultService: service('global', CLASSIC_APP), routeRules: [{ priority: 1, matchRules: [{ prefixMatch: '/a' }], service: service('global', CLASSIC_APP) }] };
  const rules = holdWorld({ map: { ...classicMap(), hostRules: [{ hosts: ['a.example'], pathMatcher: 'm' }], pathMatchers: [routed] } });
  await assert.rejects(holdRun(rules).code, /route rules/);
  assert.deepEqual(rules.events, []);
});

test('switch without --hold: the map stays swapped, no VM is touched', async () => {
  const world = holdWorld();
  const { code } = holdRun(world, ['switch', '--url-map', 'dmt-dev-classic', '--url', 'http://203.0.113.7/', '--from', CLASSIC_APP, '--to', CLASSIC_STANDIN, '--settle', '3', '--baseline', '1']);
  assert.equal(await code, 0);
  assert.deepEqual(world.events, ['map']);
  assert.equal(world.map.defaultService, service('global', CLASSIC_STANDIN));
  assert.equal(world.map.hostRules, undefined);
});

// --- tag bind|unbind: M7 ---------------------------------------------------------------------------------------------------

const TAG_BASE = 'https://europe-west1-cloudresourcemanager.googleapis.com/v3';
const TAG_VALUE = 'https://cloudresourcemanager.googleapis.com/v3/tagValues/namespaced?name=dormeto-dev%2Fdormeto%2Fmanaged';
const PARENT = '//sqladmin.googleapis.com/projects/dormeto-dev/instances/dmt-demo-sql';
const LISTED = `${TAG_BASE}/tagBindings?parent=${encodeURIComponent(PARENT)}`;
const BINDING = `tagBindings/${encodeURIComponent(PARENT)}/tagValues/281`;

// Resource Manager's tag endpoints, as the CLI's tests have them: a binding is a long-running operation at the regional endpoint.
function tagWorld({ bindings = [], operationReads = 1, refuse = {} } = {}) {
  const world = { bindings: [...bindings], changes: [] };
  let reads = 0;
  world.google = (method, url, body) => {
    if (refuse[`${method} ${url}`]) throw refuse[`${method} ${url}`];
    if (method === 'GET' && url === INSTANCE) return { name: 'dmt-demo-sql', region: 'europe-west1', state: 'RUNNABLE' };
    if (method === 'GET' && url === TAG_VALUE) return { name: 'tagValues/281', namespacedName: 'dormeto-dev/dormeto/managed' };
    if (method === 'POST' && url === `${TAG_BASE}/tagBindings`) {
      assert.deepEqual(body, { parent: PARENT, tagValue: 'tagValues/281' });
      world.changes.push('bind');
      world.bindings.push({ name: BINDING, parent: PARENT, tagValue: 'tagValues/281' });
      return { name: 'operations/rctb.bind-1' };
    }
    if (method === 'GET' && url === LISTED) return { tagBindings: world.bindings };
    if (method === 'DELETE' && url.startsWith(`${TAG_BASE}/tagBindings/`)) {
      const name = url.slice(`${TAG_BASE}/`.length);
      world.changes.push(`unbind ${name}`);
      world.bindings = world.bindings.filter((b) => b.name !== name);
      return { name: 'operations/rcub.unbind-1' };
    }
    if (method === 'GET' && url.startsWith(`${TAG_BASE}/operations/`)) {
      reads += 1;
      return reads < operationReads ? { name: url.slice(TAG_BASE.length + 1) } : { name: url.slice(TAG_BASE.length + 1), done: true, ...world.operationResult };
    }
    return unexpected(method, url);
  };
  return world;
}
const tagRun = (world, action, more = []) => {
  const run = contextOf(['tag', action, ...more], { google: world.google });
  return { ...run, code: run.time.drive(runTag(run.ctx)) };
};

test('tag bind: dormeto=managed on the instance, at its region\'s endpoint, followed to its end, and said', async () => {
  const world = tagWorld({ operationReads: 3 });
  const { code, said, asked } = tagRun(world, 'bind');
  assert.equal(await code, 0);
  assert.deepEqual(world.changes, ['bind']);
  assert.deepEqual(said('parent'), [PARENT]);
  assert.deepEqual(said('tag value'), ['dormeto-dev/dormeto/managed tagValues/281']);
  assert.deepEqual(said('bind'), [`sent to ${TAG_BASE}`, 'done: dmt-demo-sql has dormeto=managed']);
  assert.equal(asked.filter((a) => a.url === `${TAG_BASE}/operations/rctb.bind-1`).length, 3);
});

test('tag bind: bound already says so and exits 0, nothing to undo', async () => {
  const world = tagWorld({ refuse: { [`POST ${TAG_BASE}/tagBindings`]: new GoogleError(409, 'POST: the binding exists', 'ALREADY_EXISTS') } });
  const { code, said } = tagRun(world, 'bind', ['--instance', 'dmt-demo-sql']);
  assert.equal(await code, 0);
  assert.deepEqual(said('bind').at(-1), 'dmt-demo-sql has dormeto=managed already: nothing done');
});

test('tag bind: another 409 bound nothing and stays a refusal; so does a failed operation', async () => {
  const aborted = tagWorld({ refuse: { [`POST ${TAG_BASE}/tagBindings`]: new GoogleError(409, 'POST: aborted', 'ABORTED') } });
  await assert.rejects(tagRun(aborted, 'bind').code, /aborted/);
  const failed = tagWorld();
  failed.operationResult = { error: { code: 7, message: 'refused' } };
  await assert.rejects(tagRun(failed, 'bind').code, /operations\/rctb\.bind-1: 7 refused/);
});

test('tag bind: an operation not done in time is an error', async () => {
  const world = tagWorld({ operationReads: Infinity });
  await assert.rejects(tagRun(world, 'bind', ['--timeout', '10']).code, /operations\/rctb\.bind-1 not done within 10 s/);
});

test('tag unbind: only the binding of dormeto=managed goes, by the name Google gives it, escaped as it is', async () => {
  const other = { name: `tagBindings/${encodeURIComponent(PARENT)}/tagValues/999`, parent: PARENT, tagValue: 'tagValues/999' };
  const world = tagWorld({ bindings: [other, { name: BINDING, parent: PARENT, tagValue: 'tagValues/281' }] });
  const { code, said } = tagRun(world, 'unbind');
  assert.equal(await code, 0);
  assert.deepEqual(world.changes, [`unbind ${BINDING}`]);
  assert.deepEqual(world.bindings, [other]);
  assert.deepEqual(said('unbind'), [`sent to ${TAG_BASE}: ${BINDING}`, 'done: dmt-demo-sql no longer has dormeto=managed']);
});

test('tag unbind: none bound says so and exits 0', async () => {
  const world = tagWorld();
  const { code, said } = tagRun(world, 'unbind');
  assert.equal(await code, 0);
  assert.deepEqual(world.changes, []);
  assert.deepEqual(said('unbind'), ['dmt-demo-sql has no dormeto=managed: nothing done']);
});

test('tag: no such tag says what makes it: the install, not this tool', async () => {
  for (const code of [403, 404]) {
    const world = tagWorld({ refuse: { [`GET ${TAG_VALUE}`]: new GoogleError(code, 'GET: not there', code === 403 ? 'PERMISSION_DENIED' : 'NOT_FOUND') } });
    await assert.rejects(tagRun(world, 'bind').code, /no tag dormeto-dev\/dormeto\/managed: dormeto gcp install makes it/);
    assert.deepEqual(world.changes, []);
  }
});
