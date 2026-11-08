import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { clientIp, requestTarget } from '../../lambda/src/lib/http.mjs';
import { renderPage } from '../../lambda/src/lib/page.mjs';
import { STATES } from '../../lambda/src/lib/state.mjs';
import { FORMAT, dropReserved, packList, parseList } from '../../lambda/src/lib/ip-lists.mjs';
import { fakeClock, fakeStore, silentLog, testConfig } from '../../lambda/test/fakes.mjs';
import { toFields } from '../src/firestore.mjs';
import { createTasks } from '../src/tasks.mjs';
import { createCloudRunWaker, eventOf, fromEnvironment, workloadIdOf } from '../src/waker.mjs';
import { heartbeatStore } from './world.mjs';

const CONTROLLER = 'https://dmtr-europe-west1-controller-123.europe-west1.run.app';
const SERVICE_ACCOUNT = 'dmtr-europe-west1@p.iam.gserviceaccount.com';
const BROWSER = 'Mozilla/5.0';

function setup({ run = { state: STATES.ASLEEP }, cfg = testConfig(), enqueue, lists = [], seed } = {}) {
  const clock = fakeClock();
  const store = fakeStore({ config: cfg, run, clock });
  Object.assign(store, heartbeatStore(() => store.state.run, clock.now));
  const created = [];
  const google = { request: async (method, url, body) => { created.push(body.task); return {}; } };
  const tasks = enqueue ? { enqueue } : createTasks({ google, project: 'p', region: 'europe-west1', queue: 'dmtr-europe-west1', serviceAccount: SERVICE_ACCOUNT });
  const logged = [];
  const warned = [];
  const log = { ...silentLog, error: (event, fields) => logged.push({ event, ...fields }), warn: (event, fields) => warned.push({ event, ...fields }) };
  const handler = createCloudRunWaker({ store: seed ? seed(store) : store, tasks, controllerUrl: CONTROLLER, lists, now: clock.now, log });
  return { handler, store, clock, created, logged, warned };
}

const request = ({ method = 'GET', url = '/_dormeto/waiting', headers = {} } = {}) => ({
  method,
  url,
  headers: { 'x-dormeto-workload': 'demo', 'x-forwarded-for': '1.2.3.4, 35.1.1.1', 'user-agent': BROWSER, ...headers },
});
const probe = (headers = {}) => request({ url: '/_dormeto/wake', headers: { accept: '*/*', 'x-dormeto-probe': '1', ...headers } });
const headerOf = (res, name) => res.multiValueHeaders[name]?.[0];
const decoded = (task) => JSON.parse(Buffer.from(task.httpRequest.body, 'base64').toString());

test('the load balancer\'s entry is dropped: 1.2.3.4, 35.1.1.1 → the client is 1.2.3.4', () => {
  assert.equal(clientIp(eventOf(request())), '1.2.3.4');
  assert.equal(clientIp(eventOf(request({ headers: { 'x-forwarded-for': '35.1.1.1' } }))), '');
  assert.equal(clientIp(eventOf({ method: 'GET', url: '/', headers: {} })), '');
});

test('a client-sent 9.9.9.9 stays first, never last', () => {
  const event = eventOf(request({ headers: { 'x-forwarded-for': '9.9.9.9, 1.2.3.4, 35.1.1.1' } }));
  assert.equal(clientIp(event), '1.2.3.4');
  assert.equal(event.headers['x-forwarded-for'], '9.9.9.9, 1.2.3.4');
});

test('the request filters read the client: a forged address neither escapes nor triggers a source rule', async () => {
  const cfg = testConfig({ noWakeRules: [{ name: 'office', sourceIps: ['1.2.3.4'] }] });
  const filtered = setup({ cfg });
  await filtered.handler(probe({ 'x-forwarded-for': '9.9.9.9, 1.2.3.4, 35.1.1.1' }));
  assert.equal(filtered.created.length, 0);
  const forged = setup({ cfg });
  await forged.handler(probe({ 'x-forwarded-for': '1.2.3.4, 9.9.9.9, 35.1.1.1' }));
  assert.equal(forged.created.length, 1);
});

test('x-dormeto-workload: b, a → a, the load balancer\'s value', async () => {
  const named = (value) => workloadIdOf(eventOf(request({ headers: { 'x-dormeto-workload': value } })));
  assert.equal(named('b, a'), 'a');
  assert.equal(named('a'), 'a');
  const { handler, created } = setup();
  await handler(probe({ 'x-dormeto-workload': 'other, demo' }));
  assert.equal(created.length, 1);
  assert.equal(decoded(created[0]).workloadId, 'demo');
});

test('no x-dormeto-workload, or none that is an ID → 400, nothing read', async () => {
  const { handler, store, created } = setup();
  store.getConfig = store.getRun = () => assert.fail('nothing to read');
  for (const headers of [{ 'x-dormeto-workload': undefined }, { 'x-dormeto-workload': '' }, { 'x-dormeto-workload': 'demo, ' }, { 'x-dormeto-workload': '../demo' }, { 'x-dormeto-workload': 'Demo' }]) {
    const res = await handler(request({ headers }));
    assert.equal(res.statusCode, 400, JSON.stringify(headers));
    assert.equal(JSON.parse(res.body).reason, 'x-dormeto-workload names no workload');
  }
  assert.equal(created.length, 0);
});

test('the query string stays encoded', () => {
  const event = eventOf(request({ url: '/_dormeto/wake?next=%2Forders%3Fa%3D1&q=a%20b&q=c+d&flag&__proto__=x' }));
  assert.equal(event.path, '/_dormeto/wake');
  assert.deepEqual(event.multiValueQueryStringParameters, Object.fromEntries([['next', ['%2Forders%3Fa%3D1']], ['q', ['a%20b', 'c+d']], ['flag', ['']], ['__proto__', ['x']]]));
  assert.equal(requestTarget(event), '/_dormeto/wake?next=%2Forders%3Fa%3D1&q=a%20b&q=c+d&flag&__proto__=x');
  assert.deepEqual(eventOf(request({ url: '/_dormeto/wake' })).multiValueQueryStringParameters, {});
});

test('HEAD → no body and no task: 200 at the error response\'s fetch, 202 at the wake', async () => {
  const { handler, created } = setup();
  for (const [url, status] of [['/_dormeto/waiting', 200], ['/_dormeto/wake', 202]]) {
    const res = await handler(request({ method: 'HEAD', url, headers: { accept: 'text/html', 'x-dormeto-probe': '1' } }));
    assert.equal(res.statusCode, status, url);
    assert.equal(res.body, '', url);
    assert.equal(headerOf(res, 'retry-after'), '3', url);
  }
  assert.equal(created.length, 0);
});

// The load balancer may take a 5xx for a failed fetch, and serve a generic error instead: its overrideResponseCode gives the
// visitor the 503 (G0 measured an error service answering 200).
test('the error response\'s fetch → the waiting page, 200, Retry-After, and no task', async () => {
  const { handler, store, created } = setup();
  // No Accept here, a browser's next.
  for (const headers of [{}, { accept: 'text/html' }]) {
    const res = await handler(request({ headers }));
    assert.equal(res.statusCode, 200);
    assert.equal(headerOf(res, 'retry-after'), '3');
    assert.equal(headerOf(res, 'cache-control'), 'no-store');
    assert.equal(headerOf(res, 'x-dormeto-state'), STATES.ASLEEP);
    assert.match(headerOf(res, 'content-type'), /text\/html/);
    assert.match(res.body, /Waking up the application/);
    assert.match(res.body, /fetch\("\/_dormeto\/wake", /);
  }
  assert.equal(created.length, 0);
  assert.equal(store.state.run.state, STATES.ASLEEP);
});

// The fetch goes through the shared decision (G5's design, section 4.3): an explicit wake wakes in wake mode browser, as on AWS.
test('the error response\'s fetch with an explicit wake\'s header → one task, and the page, 200', async () => {
  const { handler, created } = setup();
  const res = await handler(request({ headers: { accept: 'text/html', 'x-dormeto-wake': '1' } }));
  assert.equal(res.statusCode, 200);
  assert.equal(headerOf(res, 'x-dormeto-state'), STATES.WAKING);
  assert.match(res.body, /Waking up the application/);
  assert.equal(created.length, 1);
});

test('any other path gets the waiting page too, never a wake', async () => {
  const { handler, created } = setup();
  const res = await handler(request({ method: 'POST', url: '/orders', headers: { 'x-dormeto-wake': '1' } }));
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /Waking up the application/);
  assert.equal(created.length, 0);
});

test('the waiting page of a workload not configured says it failed and logs it', async () => {
  const { handler, logged } = setup();
  const res = await handler(request({ headers: { 'x-dormeto-workload': 'other' } }));
  assert.equal(res.statusCode, 200);
  assert.equal(headerOf(res, 'retry-after'), '10');
  assert.equal(headerOf(res, 'x-dormeto-state'), STATES.FAILED);
  assert.match(res.body, /could not be started/);
  assert.deepEqual(logged, [{ event: 'WorkloadNotConfigured', workloadId: 'other' }]);
});

test('the waiting page when Firestore cannot be read: the page all the same, 200, no state claimed, logged', async () => {
  for (const broken of ['getConfig', 'getRun']) {
    const { handler, store, logged, created } = setup();
    store[broken] = async () => { throw new Error('Google: 503 firestore'); };
    const res = await handler(request()).catch((err) => ({ statusCode: err.message }));
    assert.equal(res.statusCode, 200, broken);
    assert.equal(headerOf(res, 'x-dormeto-state'), 'UNKNOWN');
    assert.equal(headerOf(res, 'retry-after'), '10');
    assert.match(res.body, /<h1[^>]*>Waking up the application/);
    assert.deepEqual(logged, [{ event: 'WaitingPageUnread', workloadId: 'demo', error: 'Google: 503 firestore' }]);
    assert.equal(created.length, 0);
  }
});

// --- Under a swap (the coverage design's section 7): the waker gets the visitor's real request, with no policy to override its code --

const SWAPPED = { 'x-dormeto-switch': 'swap' };
const visitor = ({ headers = {}, ...rest } = {}) => request({ url: '/orders?id=1', ...rest, headers: { ...SWAPPED, ...headers } });
// A workload behind a regional load balancer, as the onboarding writes it.
const REGIONAL = { kind: 'regional', region: 'europe-west1' };
const swapped = (more = {}) => testConfig({ lb: REGIONAL, ...more });

test('under a swap, a POST with a body to an application path → the page, 503, Retry-After, and in wake mode browser no wake', async () => {
  const { handler, store, created } = setup({ cfg: swapped({ wakeMode: 'browser' }) });
  const res = await handler({ ...visitor({ method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '11' } }), body: '{"order":1}' });
  assert.equal(res.statusCode, 503);
  assert.equal(res.statusDescription, '503 Service Unavailable');
  assert.equal(headerOf(res, 'retry-after'), '3');
  assert.equal(headerOf(res, 'cache-control'), 'no-store');
  assert.equal(headerOf(res, 'x-dormeto-state'), STATES.ASLEEP);
  assert.match(headerOf(res, 'content-type'), /text\/html/);
  assert.match(res.body, /Waking up the application/);
  assert.match(res.body, /fetch\("\/_dormeto\/wake", /);
  assert.equal(created.length, 0);
  assert.equal(store.state.run.state, STATES.ASLEEP);
});

test('under a swap, a plain GET → the page, 503, and in wake mode browser no wake', async () => {
  const { handler, store, created } = setup({ cfg: swapped({ wakeMode: 'browser' }) });
  const res = await handler(visitor({ headers: { accept: 'text/html' } }));
  assert.equal(res.statusCode, 503);
  assert.match(res.body, /Waking up the application/);
  assert.equal(created.length, 0);
  assert.equal(store.state.run.state, STATES.ASLEEP);
});

test('under a swap, the page is a 503 whatever the method, and an explicit wake\'s header wakes there, as on AWS', async () => {
  const { handler, created } = setup();
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const res = await handler(visitor({ method, headers: { 'x-dormeto-wake': '1', 'x-dormeto-probe': '1' } }));
    assert.equal(res.statusCode, 503, method);
    assert.match(res.body, /Waking up the application/, method);
  }
  const head = await handler(visitor({ method: 'HEAD' }));
  assert.equal(head.statusCode, 503);
  assert.equal(head.body, '');
  assert.equal(headerOf(head, 'retry-after'), '3');
  assert.equal(created.length, 1, 'the first woke it; the next found it waking');
});

test('x-dormeto-switch: its last value says, as x-dormeto-workload\'s; none, or another, is the policy\'s 200', async () => {
  const { handler } = setup();
  for (const [value, status] of [['swap', 503], ['other, swap', 503], ['swap, other', 200], ['other', 200], ['', 200], [undefined, 200]]) {
    const res = await handler(request({ url: '/orders', headers: { 'x-dormeto-switch': value } }));
    assert.equal(res.statusCode, status, String(value));
  }
});

test('under a swap, Firestore unreadable: still the page, 503, Retry-After, no state claimed, no wake', async () => {
  for (const broken of ['getConfig', 'getRun']) {
    const { handler, store, logged, created } = setup();
    store[broken] = async () => { throw new Error('Google: 503 firestore'); };
    const res = await handler(visitor({ method: 'POST' }));
    assert.equal(res.statusCode, 503, broken);
    assert.equal(headerOf(res, 'retry-after'), '10');
    assert.equal(headerOf(res, 'x-dormeto-state'), 'UNKNOWN');
    assert.match(res.body, /Waking up the application/);
    assert.equal(logged[0].event, 'WaitingPageUnread');
    assert.equal(created.length, 0);
  }
});

test('under a swap, a workload not configured, and a failed one: the page says so, 503', async () => {
  const clock = fakeClock();
  const unknown = await setup().handler(visitor({ headers: { 'x-dormeto-workload': 'other' } }));
  assert.equal(unknown.statusCode, 503);
  assert.equal(headerOf(unknown, 'x-dormeto-state'), STATES.FAILED);
  const failed = await setup({ run: { state: STATES.FAILED, failedAt: clock.now(), consecutiveFailures: 1, failure: JSON.stringify({ kind: 'capacity' }) } }).handler(visitor());
  assert.equal(failed.statusCode, 503);
  assert.match(failed.body, /Google Cloud has no capacity/);
});

test('under a swap, /_dormeto/wake as with the policy: 202 and one task for a probe or a POST, 200 once awake, never a 503', async () => {
  const asleep = setup();
  const probed = await asleep.handler(probe(SWAPPED));
  assert.equal(probed.statusCode, 202);
  assert.equal(headerOf(probed, 'x-dormeto-state'), STATES.WAKING);
  assert.equal(asleep.created.length, 1);
  assert.equal((await asleep.handler(probe(SWAPPED))).statusCode, 202, 'waking, its wait included');

  const posted = setup();
  const res = await posted.handler(request({ method: 'POST', url: '/_dormeto/wake', headers: SWAPPED }));
  assert.equal(res.statusCode, 202);
  assert.equal(posted.created.length, 1);

  const plain = setup();
  assert.equal((await plain.handler(request({ url: '/_dormeto/wake', headers: { ...SWAPPED, accept: 'text/html' } }))).statusCode, 202);
  assert.equal(plain.created.length, 0);

  const awake = setup({ run: { state: STATES.AWAKE, awakeSince: fakeClock().now() } });
  assert.equal((await awake.handler(probe(SWAPPED))).statusCode, 200);
  const unknown = setup();
  assert.equal((await unknown.handler(probe({ ...SWAPPED, 'x-dormeto-workload': 'other' }))).statusCode, 202);
});

test('under a swap, the namespace is not the application: another /_dormeto/ path is the 200 it always was; /_dormeto alone is a visitor\'s', async () => {
  const { handler, created } = setup();
  assert.equal((await handler(request({ url: '/_dormeto/waiting', headers: SWAPPED }))).statusCode, 200);
  assert.equal((await handler(request({ url: '/_dormeto', headers: SWAPPED }))).statusCode, 503);
  assert.equal((await handler(request({ url: '/_dormetofoo', headers: SWAPPED }))).statusCode, 503);
  assert.equal(created.length, 0);
});

// --- The wake decision (G5's design, sections 4.3 and 4.4): the wake mode resolved through the levels, and the rules --------

test('under a swap in wake mode any, a GET / from a browser → one wake task, and the page as a 503 that says it wakes', async () => {
  const { handler, store, created } = setup({ cfg: swapped({ wakeMode: 'any' }) });
  const res = await handler(visitor({ url: '/', headers: { accept: 'text/html' } }));
  assert.equal(res.statusCode, 503);
  assert.equal(res.statusDescription, '503 Service Unavailable');
  assert.equal(headerOf(res, 'retry-after'), '3');
  assert.equal(headerOf(res, 'cache-control'), 'no-store');
  assert.match(headerOf(res, 'content-type'), /text\/html/);
  assert.match(res.body, /fetch\("\/_dormeto\/wake", /);
  assert.equal(headerOf(res, 'x-dormeto-state'), STATES.WAKING);
  assert.deepEqual(created.map(decoded), [{ action: 'wake', workloadId: 'demo', wakeId: store.state.run.wakeId }]);
  assert.equal(store.state.stats['wake:normal'], 1);
  await handler(visitor({ url: '/' }));
  assert.equal(created.length, 1, 'the next request finds it waking');
});

test('under a swap in wake mode any, a GET /.env → no task: the filters come first', async () => {
  const { handler, store, created } = setup({ cfg: swapped({ wakeMode: 'any' }) });
  const res = await handler(visitor({ url: '/.env' }));
  assert.equal(res.statusCode, 503);
  assert.equal(headerOf(res, 'x-dormeto-state'), STATES.ASLEEP);
  assert.equal(created.length, 0);
  assert.equal(store.state.stats['ignored:scanner path'], 1);
});

test('under a swap in wake mode browser, a GET / from a browser → no task, and the page whose probe wakes it', async () => {
  const { handler, store, created } = setup({ cfg: swapped({ wakeMode: 'browser' }) });
  const res = await handler(visitor({ url: '/', headers: { accept: 'text/html' } }));
  assert.equal(res.statusCode, 503);
  assert.equal(headerOf(res, 'x-dormeto-state'), STATES.ASLEEP);
  assert.equal(created.length, 0);
  assert.equal(store.state.stats['deferred:browser mode'], 1);
  await handler(probe({ ...SWAPPED, 'x-dormeto-path': '/' }));
  assert.equal(created.length, 1);
});

test('the policy\'s fetch goes through the decision in wake mode browser, whatever the levels say: no task; a wake rule on the user agent → a task, the page a 200', async () => {
  const plain = setup();
  plain.store.state.routerSettings = { defaults: { wakeMode: 'any' }, by: 'ops', at: 1 };
  const res = await plain.handler(request());
  assert.equal(res.statusCode, 200);
  assert.equal(plain.created.length, 0);
  assert.equal(plain.store.state.stats['deferred:browser mode'], 1);

  const ruled = setup({ cfg: testConfig({ wakeRules: [{ name: 'browsers', userAgentPattern: '^Mozilla/' }] }) });
  const woken = await ruled.handler(request());
  assert.equal(woken.statusCode, 200);
  assert.equal(headerOf(woken, 'retry-after'), '3');
  assert.match(woken.body, /Waking up the application/);
  assert.equal(headerOf(woken, 'x-dormeto-state'), STATES.WAKING);
  assert.equal(ruled.created.length, 1);
  assert.equal(ruled.store.state.stats['wake:rule browsers'], 1);
});

test('the policy\'s fetch carries no path: no path condition matches it, not even its own /_dormeto/waiting', async () => {
  const everywhere = setup({ cfg: testConfig({ noWakeRules: [{ name: 'all', pathPrefixes: ['/'] }], wakeRules: [{ name: 'browsers', userAgentPattern: '^Mozilla/' }] }) });
  await everywhere.handler(request());
  assert.equal(everywhere.created.length, 1);
  const waiting = setup({ cfg: testConfig({ wakeRules: [{ name: 'waiting', pathPrefixes: ['/_dormeto/waiting'] }] }) });
  await waiting.handler(request());
  assert.equal(waiting.created.length, 0);
});

test('a probe is classified on the visitor\'s path it sends: from /health, a no-wake rule on /health → no task; from /orders → a task', async () => {
  const cfg = testConfig({ noWakeRules: [{ name: 'health', pathPrefixes: ['/health'] }] });
  const health = setup({ cfg });
  const res = await health.handler(probe({ 'x-dormeto-path': '/health' }));
  assert.equal(res.statusCode, 202);
  assert.equal(health.created.length, 0);
  assert.equal(health.store.state.stats['ignored:rule health'], 1);
  const orders = setup({ cfg });
  await orders.handler(probe({ 'x-dormeto-path': '/orders' }));
  assert.equal(orders.created.length, 1);
});

test('POST /_dormeto/wake keeps its own path: a no-wake rule on the path it sends does not stop it', async () => {
  const { handler, created } = setup({ cfg: testConfig({ noWakeRules: [{ name: 'health', pathPrefixes: ['/health'] }] }) });
  const res = await handler(request({ method: 'POST', url: '/_dormeto/wake', headers: { 'x-dormeto-probe': '1', 'x-dormeto-path': '/health' } }));
  assert.equal(res.statusCode, 202);
  assert.equal(created.length, 1);
});

test('a configuration that leaves waitSeconds, maxHolders and wakeMode to the levels still gets Google Cloud\'s: no hold, and behind the policy no wake on a plain request', async () => {
  const cfg = testConfig({ inherits: ['waitSeconds', 'maxHolders', 'wakeMode', 'drainSeconds'] });
  const posted = setup({ cfg });
  const start = posted.clock.now();
  const res = await posted.handler(request({ method: 'POST', url: '/_dormeto/wake' }));
  assert.equal(res.statusCode, 202);
  assert.equal(posted.created.length, 1);
  assert.equal(posted.clock.now(), start, 'no hold');
  const linked = setup({ cfg });
  await linked.handler(request({ url: '/_dormeto/wake', headers: { accept: 'text/html' } }));
  assert.equal(linked.created.length, 0);
});

test('the router level: its wake mode applies under a swap; unreadable, its last value stays, and before any read the built-ins; never a 500', async () => {
  const cfg = swapped({ inherits: ['wakeMode'] });
  const { handler, store, clock, created, warned } = setup({ cfg });
  store.state.routerSettings = { defaults: { wakeMode: 'browser' }, by: 'ops', at: 1 };
  assert.equal((await handler(visitor())).statusCode, 503);
  assert.equal(created.length, 0, 'the router\'s browser mode');
  clock.advance(61_000);
  store.getRouterSettings = async () => { throw new Error('Google: 503 firestore'); };
  assert.equal((await handler(visitor())).statusCode, 503);
  assert.equal(created.length, 0, 'its last value');
  assert.deepEqual(warned.filter((w) => w.event === 'JoinLevelUnreadable').map((w) => [w.workloadId, w.level, w.error]), [['demo', 'router', 'Google: 503 firestore']]);

  const fresh = setup({ cfg });
  fresh.store.getRouterSettings = store.getRouterSettings;
  assert.equal((await fresh.handler(request())).statusCode, 200);
  assert.equal(fresh.created.length, 0, 'the policy\'s fetch: browser');
  const res = await fresh.handler(visitor());
  assert.equal(res.statusCode, 503);
  assert.equal(fresh.created.length, 1, 'the built-in any');
  assert.equal((await fresh.handler(probe(SWAPPED))).statusCode, 202);
});

test('a decision that fails past its reads (a transition refused): the page all the same, logged', async () => {
  const { handler, store, created, warned } = setup({ cfg: swapped({ wakeMode: 'any' }) });
  store.transition = async () => { throw new Error('Google: 503 firestore'); };
  const res = await handler(visitor());
  assert.equal(res.statusCode, 503);
  assert.equal(headerOf(res, 'x-dormeto-state'), STATES.ASLEEP);
  assert.match(res.body, /Waking up the application/);
  assert.equal(created.length, 0);
  assert.deepEqual(warned.filter((w) => w.event === 'WakeDecisionFailed'), [{ event: 'WakeDecisionFailed', workloadId: 'demo', error: 'Google: 503 firestore' }]);
});

test('the waiting page of a failed workload says why and when, in Google Cloud\'s words', async () => {
  const clock = fakeClock();
  const run = { state: STATES.FAILED, failedAt: clock.now(), consecutiveFailures: 1, failure: JSON.stringify({ kind: 'capacity' }) };
  const { handler, created } = setup({ run });
  const res = await handler(request());
  assert.equal(headerOf(res, 'x-dormeto-state'), STATES.FAILED);
  assert.match(res.body, /<h1[^>]*>Google Cloud has no capacity for this application right now: the start is retried, next attempt in 1 minute\.<\/h1>/);
  assert.doesNotMatch(res.body, /AWS/);
  assert.equal(created.length, 0);
});

test('a probe from a browser → one task for the controller: service account, audience', async () => {
  const { handler, store, created } = setup();
  const res = await handler(probe());
  assert.equal(res.statusCode, 202);
  assert.equal(headerOf(res, 'x-dormeto-state'), STATES.WAKING);
  assert.equal(created.length, 1);
  const [{ httpRequest, dispatchDeadline }] = created;
  assert.equal(dispatchDeadline, '1800s');
  assert.equal(httpRequest.url, `${CONTROLLER}/v1/tasks`);
  assert.deepEqual(httpRequest.oidcToken, { serviceAccountEmail: SERVICE_ACCOUNT, audience: CONTROLLER });
  assert.deepEqual(decoded(created[0]), { action: 'wake', workloadId: 'demo', wakeId: store.state.run.wakeId });
  assert.equal(store.state.run.state, STATES.WAKING);
});

test('concurrent probes, and the next ones, make one task', async () => {
  const { handler, created } = setup();
  await Promise.all(Array.from({ length: 10 }, () => handler(probe())));
  await handler(probe());
  assert.equal(created.length, 1);
});

test('a bot\'s probe → no task', async () => {
  const { handler, store, created } = setup();
  const res = await handler(probe({ 'user-agent': 'Googlebot/2.1' }));
  assert.equal(res.statusCode, 202);
  assert.equal(created.length, 0);
  assert.equal(store.state.run.state, STATES.ASLEEP);
  assert.equal(store.state.stats['ignored:bot user agent'], 1);
});

// A matcher's policy applies to all its traffic, and the waker is a backend: a 503 here would be replaced by the waiting
// page, with an API client's JSON and these headers lost.
test('POST /_dormeto/wake → 202, one task, at once: no hold', async () => {
  const { handler, clock, created, store } = setup({ cfg: testConfig({ waitSeconds: 20 }) });
  const start = clock.now();
  const res = await handler(request({ method: 'POST', url: '/_dormeto/wake', headers: { 'user-agent': 'curl/8.7.1', accept: '*/*' } }));
  assert.equal(res.statusCode, 202);
  assert.equal(res.statusDescription, '202 Accepted');
  assert.deepEqual(JSON.parse(res.body), { status: 'waking', retryAfter: 3 });
  assert.equal(headerOf(res, 'retry-after'), '3');
  assert.equal(headerOf(res, 'x-dormeto-state'), STATES.WAKING);
  assert.equal(created.length, 1);
  assert.equal(store.state.run.state, STATES.WAKING);
  assert.equal(clock.now(), start);
});

test('POST /_dormeto/wake goes through the filters: a bot and a no-wake rule get no task', async () => {
  const bot = setup();
  const bots = await bot.handler(request({ method: 'POST', url: '/_dormeto/wake', headers: { 'user-agent': 'UptimeRobot/2.0' } }));
  assert.equal(bots.statusCode, 202);
  assert.equal(bot.created.length, 0);
  assert.equal(bot.store.state.stats['ignored:bot user agent'], 1);
  const ruled = setup({ cfg: testConfig({ noWakeRules: [{ name: 'office', sourceIps: ['1.2.3.0/24'] }] }) });
  const rules = await ruled.handler(request({ method: 'POST', url: '/_dormeto/wake' }));
  assert.equal(rules.statusCode, 202);
  assert.equal(ruled.created.length, 0);
  assert.equal(ruled.store.state.stats['ignored:rule office'], 1);
});

test('GET /_dormeto/wake that is no probe (a scanner, a link) behind the policy → no task, whatever the configuration\'s wake mode', async () => {
  const { handler, created, store } = setup({ cfg: testConfig({ wakeMode: 'traffic' }) });
  const res = await handler(request({ url: '/_dormeto/wake', headers: { accept: 'text/html' } }));
  assert.equal(res.statusCode, 202);
  assert.match(headerOf(res, 'content-type'), /application\/json/);
  assert.equal(created.length, 0);
  assert.equal(store.state.run.state, STATES.ASLEEP);
});

test('awake: no redirect, no hold and no task, whichever way /_dormeto/wake is asked, right after the wake or later', async () => {
  const { handler, clock, created } = setup({ run: { state: STATES.AWAKE, awakeSince: fakeClock().now() } });
  for (const elapsed of [0, 60_000]) {
    clock.advance(elapsed);
    for (const req of [probe(), request({ method: 'POST', url: '/_dormeto/wake' })]) {
      const res = await handler(req);
      assert.equal(res.statusCode, 200);
      assert.equal(headerOf(res, 'x-dormeto-state'), STATES.AWAKE);
      assert.equal(headerOf(res, 'cache-control'), 'no-store');
      assert.equal(headerOf(res, 'location'), undefined);
      assert.equal(headerOf(res, 'set-cookie'), undefined);
      assert.deepEqual(JSON.parse(res.body), { status: 'awake' });
    }
  }
  assert.equal(created.length, 0);
  const head = await handler(request({ method: 'HEAD', url: '/_dormeto/wake' }));
  assert.equal(head.statusCode, 200);
  assert.equal(head.body, '');
});

test('a failed workload\'s POST /_dormeto/wake keeps what it says: 202, its state, its failure and the next attempt', async () => {
  const clock = fakeClock();
  const run = { state: STATES.FAILED, failedAt: clock.now(), consecutiveFailures: 1, failure: JSON.stringify({ kind: 'capacity' }) };
  const { handler, created } = setup({ run });
  const res = await handler(request({ method: 'POST', url: '/_dormeto/wake' }));
  assert.equal(res.statusCode, 202);
  assert.equal(headerOf(res, 'x-dormeto-state'), STATES.FAILED);
  assert.equal(headerOf(res, 'x-dormeto-failure'), 'capacity');
  assert.equal(headerOf(res, 'x-dormeto-retry-at'), new Date(clock.now() + 60_000).toISOString());
  assert.equal(created.length, 0);
});

test('a task refused by Cloud Tasks → the run fails with a retry, not a crash', async () => {
  const { handler, store } = setup({ enqueue: async () => { throw new Error('Google: 403 denied'); } });
  const res = await handler(probe());
  assert.equal(res.statusCode, 202);
  assert.equal(headerOf(res, 'x-dormeto-state'), STATES.FAILED);
  assert.equal(store.state.run.state, STATES.FAILED);
});

// F5: a wake whose task was lost, or whose request died, no longer beats on its run. A visitor's poll sends it again with its
// wakeId, as the check does, one resend a minute between them (`resentAt`).
const T = 1_700_000_000_000;
const WAKING_SINCE = (ms, more = {}) => ({ state: STATES.WAKING, wakeId: 'w1', wakeStartedAt: T - ms, wakeCount: 1, ...more });

test('a poll of a WAKING run with no beat for 3 minutes sends its wakeId again; another poll within the minute does not', async () => {
  const { handler, store, clock, created, warned } = setup({ run: WAKING_SINCE(3 * 60_000) });
  const res = await handler(probe());
  assert.equal(res.statusCode, 202);
  assert.equal(headerOf(res, 'x-dormeto-state'), STATES.WAKING);
  assert.deepEqual(created.map(decoded), [{ action: 'wake', workloadId: 'demo', wakeId: 'w1' }]);
  assert.equal(created[0].httpRequest.url, `${CONTROLLER}/v1/tasks`);
  assert.equal(store.state.run.resentAt, T);
  assert.deepEqual(warned.filter((w) => w.event === 'WakeResent'), [{ event: 'WakeResent', workloadId: 'demo', wakeId: 'w1', by: 'waker', reason: 'no heartbeat 90 s after it started' }]);
  clock.advance(30_000);
  await handler(probe());
  assert.equal(created.length, 1);
  clock.advance(30_001);
  await handler(probe());
  assert.equal(created.length, 2);
  // The same wake all along: no new wakeId, nothing counted twice.
  assert.equal(store.state.run.wakeId, 'w1');
  assert.equal(store.state.run.wakeCount, 1);
});

test('a poll of a WAKING run that beats, or not yet 90 s old, or sent again by the check within the minute: no task', async () => {
  for (const run of [
    WAKING_SINCE(9 * 60_000, { beatAt: T - 30_000 }),
    WAKING_SINCE(90_000),
    WAKING_SINCE(4 * 60_000, { resentAt: T - 30_000 }),
  ]) {
    const { handler, created, store } = setup({ run });
    const res = await handler(probe());
    assert.equal(headerOf(res, 'x-dormeto-state'), STATES.WAKING);
    assert.equal(created.length, 0, JSON.stringify(run));
    assert.equal(store.state.run.resentAt, run.resentAt);
  }
});

test('a poll of a stale WAKING run sent again twice already: no task, the deadline alone acts', async () => {
  const run = WAKING_SINCE(5 * 60_000, { resentAt: T - 2 * 60_000, resends: { wakeId: 'w1', count: 2 } });
  const { handler, created, store, warned } = setup({ run });
  const res = await handler(probe());
  assert.equal(headerOf(res, 'x-dormeto-state'), STATES.WAKING);
  assert.equal(created.length, 0);
  assert.equal(store.state.run.resentAt, run.resentAt);
  assert.deepEqual(warned.filter((w) => w.event === 'WakeResent'), []);
});

test('a WAKING run past its timeout: the shared code\'s new wake, as before, not a resend', async () => {
  const { handler, store, created, warned } = setup({ run: WAKING_SINCE(11 * 60_000) });
  await handler(probe());
  assert.equal(created.length, 1);
  assert.notEqual(decoded(created[0]).wakeId, 'w1');
  assert.equal(decoded(created[0]).wakeId, store.state.run.wakeId);
  assert.equal(warned.filter((w) => w.event === 'WakeResent').length, 0);
  assert.equal(warned.filter((w) => w.event === 'WakeStuck').length, 1);
});

test('a resend the queue refuses: the poll answered all the same, said, the run still WAKING; a bot\'s poll sends nothing', async () => {
  const { handler, store, warned } = setup({ run: WAKING_SINCE(3 * 60_000), enqueue: async () => { throw new Error('Google: 503 tasks'); } });
  const res = await handler(probe());
  assert.equal(res.statusCode, 202);
  assert.equal(headerOf(res, 'x-dormeto-state'), STATES.WAKING);
  assert.equal(store.state.run.state, STATES.WAKING);
  assert.deepEqual(warned.filter((w) => w.event === 'WakeResendFailed').map((w) => w.error), ['Google: 503 tasks']);

  const bot = setup({ run: WAKING_SINCE(3 * 60_000) });
  await bot.handler(probe({ 'user-agent': 'Googlebot/2.1' }));
  assert.equal(bot.created.length, 0);
});

// The page's real script, in a sandbox with what it uses of a browser; `fetch` is what the waker answers.
function browse(html, respond, clock) {
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  const browser = { timers: [], reloads: 0, asked: [], answers: [], pending: Promise.resolve(), message: {} };
  const location = { href: 'https://app.example/orders?page=2', pathname: '/orders', reload: () => { browser.reloads += 1; } };
  vm.runInNewContext(script, {
    location,
    document: { getElementById: (id) => (id === 'message' ? browser.message : {}) },
    Date: { now: clock.now, parse: Date.parse },
    Math,
    setInterval: () => {},
    setTimeout: (fn, ms) => { browser.timers.push({ fn, ms }); },
    fetch: (url, init) => {
      browser.asked.push({ url, headers: { ...init.headers } });
      const answer = respond(url, init).then((res) => {
        browser.answers.push(res.statusCode);
        return { type: 'basic', status: res.statusCode, ok: res.statusCode < 300, headers: { get: (name) => res.multiValueHeaders[name]?.[0] ?? null } };
      });
      browser.pending = answer;
      return answer;
    },
  });
  browser.address = () => location.href;
  // The probe under way, up to its next timer.
  browser.settled = async () => {
    await browser.pending;
    await new Promise((resolve) => setImmediate(resolve));
  };
  browser.nextTimer = () => browser.timers.shift();
  return browser;
}

const wakerAnswers = (handler) => async (url, init) => handler(request({ url, headers: { accept: '*/*', ...init.headers } }));

test('the page\'s script: its probe wakes, and it reloads the visitor\'s address once the run is AWAKE', async () => {
  const { handler, store, clock, created } = setup();
  const page = await handler(request());
  const browser = browse(page.body, wakerAnswers(handler), clock);
  await browser.settled();
  assert.deepEqual(browser.asked, [{ url: '/_dormeto/wake', headers: { 'x-dormeto-probe': '1', 'x-dormeto-path': '/orders' } }]);
  assert.deepEqual(browser.answers, [202], 'not a 503, which the nap\'s policy would replace');
  assert.equal(created.length, 1);
  assert.equal(browser.reloads, 0);

  // Still waking: it keeps probing.
  clock.advance(3000);
  browser.nextTimer().fn();
  await browser.settled();
  assert.equal(browser.reloads, 0);
  assert.equal(created.length, 1);

  // Awake: the load balancer now sends the visitor's address to the VMs. The page has waited longer than a poll.
  store.state.run.state = STATES.AWAKE;
  store.state.run.awakeSince = clock.now();
  clock.advance(3000);
  browser.nextTimer().fn();
  await browser.settled();
  const reload = browser.nextTimer();
  assert.equal(reload.ms, 0);
  reload.fn();
  assert.equal(browser.reloads, 1);
  assert.equal(browser.address(), 'https://app.example/orders?page=2');
  assert.equal(browser.timers.length, 0, 'no probe after the reload');
});

test('the page\'s script: a 202 with FAILED says why and when, keeps probing, and does not reload', async () => {
  const clock = fakeClock();
  const run = { state: STATES.FAILED, failedAt: clock.now(), consecutiveFailures: 1, failure: JSON.stringify({ kind: 'capacity' }) };
  const { handler } = setup({ run });
  const page = await handler(request());
  const browser = browse(page.body, wakerAnswers(handler), clock);
  await browser.settled();
  assert.deepEqual(browser.answers, [202]);
  assert.equal(browser.message.textContent, 'Google Cloud has no capacity for this application right now: the start is retried, next attempt in 1 minute.');
  assert.equal(browser.reloads, 0);
  assert.equal(browser.nextTimer().ms, 3000);
});

test('the page\'s script: a page served once awake reloads after one poll, not in a loop', async () => {
  const { handler, clock } = setup({ run: { state: STATES.AWAKE, awakeSince: fakeClock().now() - 60_000 } });
  const page = await handler(request());
  assert.equal(page.statusCode, 200);
  assert.equal(headerOf(page, 'x-dormeto-state'), STATES.AWAKE);
  const browser = browse(page.body, wakerAnswers(handler), clock);
  await browser.settled();
  assert.equal(browser.reloads, 0);
  const reload = browser.nextTimer();
  assert.equal(reload.ms, 3000);
  reload.fn();
  assert.equal(browser.reloads, 1);
});

test('the page\'s script: a probe answered by something else (the waker\'s 500, a missing route) reloads after one poll, not in a loop', async () => {
  const { handler, clock } = setup();
  const page = await handler(request());
  const browser = browse(page.body, async () => ({ multiValueHeaders: {} }), clock);
  await browser.settled();
  assert.equal(browser.reloads, 0);
  const reload = browser.nextTimer();
  assert.equal(reload.ms, 3000);
  reload.fn();
  assert.equal(browser.reloads, 1);
});

test('AWS\'s page, without probeUrl: its probe\'s 503 keeps probing, AWAKE too, only a redirect reloads', async () => {
  const clock = fakeClock();
  const answers = browse(renderPage({ state: 'WAKING', pollSeconds: 3 }), async () => ({ statusCode: 503, multiValueHeaders: { 'x-dormeto-state': [STATES.WAKING] } }), clock);
  await answers.settled();
  assert.deepEqual(answers.answers, [503]);
  assert.equal(answers.reloads, 0);
  assert.equal(answers.nextTimer().ms, 3000);

  let answer = { multiValueHeaders: { 'x-dormeto-state': [STATES.AWAKE] } };
  const browser = browse(renderPage({ state: 'WAKING', pollSeconds: 3 }), async () => answer, clock);
  await browser.settled();
  assert.equal(browser.asked[0].url, 'https://app.example/orders?page=2');
  assert.equal(browser.reloads, 0);
  answer = { multiValueHeaders: {} };
  browser.nextTimer().fn();
  await browser.settled();
  assert.equal(browser.reloads, 1);
});

// --- Schedules ---------------------------------------------------------------------------------------------------------

// The fake clock starts on Tuesday 2023-11-14 at 22:13 UTC.
const windowed = (more = {}) => ({ timeZone: 'UTC', windows: [{ kind: 'nap', days: ['tue'], start: '22:00', end: '23:00', ...more }], by: 'ops', at: 1 });
const NAP_UNTIL = { at: '2023-11-14T23:00:00.000Z', local: 'Tue 23:00', timeZone: 'UTC' };
const napping = ({ schedule = windowed(), ...options } = {}) => {
  const world = setup(options);
  world.store.state.schedules.demo = schedule;
  return world;
};

test('a nap window: the page says its end, whatever state it keeps the workload in, and the fetch wakes nothing', async () => {
  const clock = fakeClock();
  for (const run of [{ state: STATES.ASLEEP }, { state: STATES.NAPPING }, { state: STATES.FAILED, failedAt: clock.now(), consecutiveFailures: 1, failure: JSON.stringify({ kind: 'capacity' }) }]) {
    const { handler, created } = napping({ run });
    const res = await handler(request());
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /<h1[^>]*>Napping on schedule until Tue 23:00 \(UTC\)\.<\/h1>/, run.state);
    assert.equal(headerOf(res, 'x-dormeto-nap-until'), NAP_UNTIL.at);
    assert.equal(headerOf(res, 'x-dormeto-state'), run.state);
    assert.equal(created.length, 0);
  }
});

test('the page says no nap when none keeps the workload: waking or awake in the window, or asleep out of it', async () => {
  for (const [run, words] of [[{ state: STATES.WAKING }, /Waking up/], [{ state: STATES.AWAKE, awakeSince: 1 }, /Almost there/]]) {
    const res = await napping({ run }).handler(request());
    assert.match(res.body, words);
    assert.equal(headerOf(res, 'x-dormeto-nap-until'), undefined);
  }
  const out = await napping({ schedule: windowed({ days: ['mon'] }) }).handler(request());
  assert.match(out.body, /<h1[^>]*>Waking up/);
  const awakeWindow = await napping({ schedule: { timeZone: 'UTC', windows: [{ kind: 'awake', days: ['tue'], start: '22:00', end: '23:00' }] } }).handler(request());
  assert.match(awakeWindow.body, /<h1[^>]*>Waking up/);
});

test('a nap with no end known: the page and the probe say so, with no date', async () => {
  // A nap every day that joins the next: 22:13 UTC on the fake clock, in Tuesday's occurrence, going on past the horizon.
  const schedule = { timeZone: 'UTC', windows: [{ kind: 'nap', start: '00:00', end: '23:45', repeat: { pattern: 'daily' } }], by: 'ops', at: 1 };
  const { handler } = napping({ schedule });
  const page = await handler(request());
  assert.match(page.body, /<h1[^>]*>Napping on schedule\.<\/h1>/);
  assert.equal(headerOf(page, 'x-dormeto-nap-until'), 'unknown');
  const head = await handler(request({ method: 'HEAD' }));
  assert.equal(headerOf(head, 'x-dormeto-nap-until'), 'unknown');
  const probed = await handler(probe());
  assert.equal(headerOf(probed, 'x-dormeto-nap-until'), 'unknown');
  assert.deepEqual(JSON.parse(probed.body).napUntil, { at: null, local: null, timeZone: 'UTC' });
  // A probe a filter settles before the shared code reads the window.
  const bot = await handler(probe({ 'user-agent': 'Googlebot/2.1' }));
  assert.equal(headerOf(bot, 'x-dormeto-nap-until'), 'unknown');
  assert.deepEqual(JSON.parse(bot.body).napUntil, { at: null, local: null, timeZone: 'UTC' });
});

test('a known end more than 6 days away reads with its date at the fetch', async () => {
  const schedule = { timeZone: 'UTC', windows: [{ kind: 'nap', repeat: { pattern: 'cron', cron: '0 22 14 11 *', minutes: 10080 } }], by: 'ops', at: 1 };
  const page = await napping({ schedule }).handler(request());
  assert.match(page.body, /<h1[^>]*>Napping on schedule until Tue 2023-11-21 22:00 \(UTC\)\.<\/h1>/);
});

test('a HEAD at the fetch says the end in its headers', async () => {
  const res = await napping().handler(request({ method: 'HEAD' }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, '');
  assert.equal(headerOf(res, 'x-dormeto-nap-until'), NAP_UNTIL.at);
});

test('a schedule that cannot be read: the page all the same, as with none, logged', async () => {
  const unread = napping();
  unread.store.getSchedule = async () => { throw new Error('Google: 503 firestore'); };
  const zone = napping({ schedule: { ...windowed(), timeZone: 'Nowhere/Land' } });
  for (const { handler } of [unread, zone]) {
    const res = await handler(request());
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /<h1[^>]*>Waking up/);
  }
  const logged = [];
  const clock = fakeClock();
  const store = fakeStore({ config: testConfig(), run: { state: STATES.ASLEEP }, clock });
  store.getSchedule = unread.store.getSchedule;
  const handler = createCloudRunWaker({ store, tasks: {}, controllerUrl: CONTROLLER, now: clock.now, log: { ...silentLog, warn: (event, fields) => logged.push({ event, ...fields }) } });
  await handler(request());
  // The shared decision's and the page's, of one read, as a probe's (reads.test.mjs).
  const skipped = { event: 'ScheduleSkipped', workloadId: 'demo', error: 'Google: 503 firestore' };
  assert.deepEqual(logged, [skipped, skipped]);
});

test('a visitor\'s probe in a nap window wakes nothing, and says the same as the page', async () => {
  const { handler, store, created } = napping();
  const res = await handler(probe());
  assert.equal(res.statusCode, 202);
  assert.equal(headerOf(res, 'x-dormeto-nap-until'), NAP_UNTIL.at);
  assert.equal(headerOf(res, 'x-dormeto-state'), STATES.ASLEEP);
  assert.deepEqual(JSON.parse(res.body).napUntil, NAP_UNTIL);
  assert.equal(created.length, 0);
  assert.equal(store.state.run.state, STATES.ASLEEP);
  assert.equal(store.state.stats['ignored:schedule'], 1);
});

test('a probe no filter lets through says the end too: the page it came from said it to every visitor', async () => {
  const { handler, created } = napping({ cfg: testConfig({ noWakeRules: [{ name: 'office', sourceIps: ['1.2.3.0/24'] }] }) });
  const res = await handler(probe());
  assert.equal(res.statusCode, 202);
  assert.equal(headerOf(res, 'x-dormeto-nap-until'), NAP_UNTIL.at);
  assert.deepEqual(JSON.parse(res.body).napUntil, NAP_UNTIL);
  assert.equal(created.length, 0);
  const head = await napping().handler(request({ method: 'HEAD', url: '/_dormeto/wake' }));
  assert.equal(head.statusCode, 202);
  assert.equal(head.body, '');
  assert.equal(headerOf(head, 'x-dormeto-nap-until'), NAP_UNTIL.at);
});

test('the page\'s script in a nap window: it keeps saying when the nap ends, keeps probing, and wakes nothing', async () => {
  const { handler, clock, created } = napping();
  const page = await handler(request());
  const browser = browse(page.body, wakerAnswers(handler), clock);
  await browser.settled();
  assert.equal(browser.message.textContent, undefined, 'the message of the page stays');
  assert.equal(browser.reloads, 0);
  assert.equal(browser.nextTimer().ms, 3000);
  assert.equal(created.length, 0);
});

test('a window that allows it: a POST to /_dormeto/wake wakes, a probe does not', async () => {
  const { handler, store, created } = napping({ schedule: windowed({ wake: 'header' }) });
  const refused = await handler(probe());
  assert.equal(headerOf(refused, 'x-dormeto-nap-until'), NAP_UNTIL.at);
  assert.equal(created.length, 0);
  const res = await handler(request({ method: 'POST', url: '/_dormeto/wake' }));
  assert.equal(res.statusCode, 202);
  assert.equal(headerOf(res, 'x-dormeto-state'), STATES.WAKING);
  assert.equal(headerOf(res, 'x-dormeto-nap-until'), undefined);
  assert.equal(created.length, 1);
  assert.equal(store.state.run.state, STATES.WAKING);
});

test('a window that does not allow it: a POST to /_dormeto/wake wakes nothing, and says why', async () => {
  const { handler, created } = napping();
  const res = await handler(request({ method: 'POST', url: '/_dormeto/wake' }));
  assert.equal(res.statusCode, 202);
  assert.equal(headerOf(res, 'x-dormeto-nap-until'), NAP_UNTIL.at);
  assert.equal(created.length, 0);
});

test('with keepAsleep, a visitor\'s probe still wakes: the pause holds scheduled and maintenance wakes only', async () => {
  const { handler, store, created } = setup();
  await store.putPause('demo', { by: 'ops', at: 1, reason: 'load test', keepAsleep: true });
  const res = await handler(probe());
  assert.equal(res.statusCode, 202);
  assert.equal(headerOf(res, 'x-dormeto-state'), STATES.WAKING);
  assert.equal(created.length, 1);
  assert.equal(store.state.run.state, STATES.WAKING);
});

test('fromEnvironment wires the store and the queue on the environment\'s names', async () => {
  const calls = [];
  const documents = 'https://firestore.googleapis.com/v1/projects/p/databases/dmtr-europe-west1/documents';
  const stored = {
    [`${documents}/workloads/demo`]: { config: testConfig() },
    [`${documents}/runs/demo`]: { state: STATES.ASLEEP },
  };
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined });
    if (url.includes('metadata.google.internal')) return Response.json({ access_token: 'token', expires_in: 3600 });
    if (stored[url]) return Response.json({ fields: toFields(stored[url]), updateTime: '2026-10-30T00:00:00Z' });
    return Response.json({});
  };
  const handler = fromEnvironment({
    DMT_PROJECT: 'p', DMT_REGION: 'europe-west1', DMT_DATABASE: 'dmtr-europe-west1', DMT_QUEUE: 'dmtr-europe-west1',
    DMT_CONTROLLER_URL: CONTROLLER, DMT_SERVICE_ACCOUNT: SERVICE_ACCOUNT,
  }, { fetch, log: silentLog });
  const res = await handler(probe());
  assert.equal(headerOf(res, 'x-dormeto-state'), STATES.WAKING);
  const tasks = calls.filter((call) => call.url === 'https://cloudtasks.googleapis.com/v2/projects/p/locations/europe-west1/queues/dmtr-europe-west1/tasks');
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].body.task.httpRequest.url, `${CONTROLLER}/v1/tasks`);
  assert.equal(tasks[0].body.task.httpRequest.oidcToken.serviceAccountEmail, SERVICE_ACCOUNT);
  assert.ok(calls.some((call) => call.url === `${documents}:commit`));
});

// --- IP lists -------------------------------------------------------------------------------------------------------------

const LISTED = [{ name: 'scanners', url: 'https://lists.example/scanners.txt', action: 'ignore', refreshHours: 24 }];

async function stored(store, name, text) {
  const parts = packList(dropReserved(parseList(text).entries).kept);
  for (const [index, part] of parts.entries()) await store.putListPart(name, '1', index, part, 0);
  await store.setListMeta(name, { version: '1', format: FORMAT, parts: parts.length, entries: 1, url: LISTED[0].url, fetchedAt: 0 });
}

test('a listed ignore address: its probe makes no task and answers a 202; its POST wakes; another address wakes', async () => {
  const t = setup({ lists: LISTED });
  await stored(t.store, 'scanners', '1.2.3.4\n');
  const probed = await t.handler(probe());
  assert.equal(probed.statusCode, 202);
  assert.equal(t.created.length, 0);
  const explicit = await t.handler(request({ method: 'POST', url: '/_dormeto/wake', headers: { accept: '*/*' } }));
  assert.equal(explicit.statusCode, 202);
  assert.equal(t.created.length, 1);
  assert.equal(decoded(t.created[0]).action, 'wake');
  const other = setup({ lists: LISTED });
  await stored(other.store, 'scanners', '1.2.3.4\n');
  await other.handler(probe({ 'x-forwarded-for': '5.6.7.8, 35.1.1.1' }));
  assert.equal(other.created.length, 1);
});

test('lists that cannot be read count as none: logged, the wake goes on', async () => {
  const t = setup({ lists: LISTED, seed: (store) => ({ ...store, getListMeta: async () => { throw new Error('firestore down'); } }) });
  const res = await t.handler(probe());
  assert.equal(res.statusCode, 202);
  assert.equal(t.created.length, 1);
  assert.deepEqual(t.warned.map((w) => [w.event, w.name, w.error]), [['ListLoadFailed', 'scanners', 'firestore down']]);
});

test('DMT_IP_LISTS names the lists of the waker; unreadable, none and logged', () => {
  const logged = [];
  const log = { ...silentLog, error: (event, fields) => logged.push({ event, ...fields }) };
  assert.equal(typeof fromEnvironment({ DMT_PROJECT: 'p', DMT_REGION: 'r', DMT_QUEUE: 'q', DMT_IP_LISTS: 'not json' }, { fetch: async () => ({}), log }), 'function');
  assert.equal(logged[0].event, 'IpListsUnreadable');
});
