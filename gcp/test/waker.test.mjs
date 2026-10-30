import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { clientIp, requestTarget } from '../../lambda/src/lib/http.mjs';
import { renderPage } from '../../lambda/src/lib/page.mjs';
import { STATES } from '../../lambda/src/lib/state.mjs';
import { fakeClock, fakeStore, silentLog, testConfig } from '../../lambda/test/fakes.mjs';
import { toFields } from '../src/firestore.mjs';
import { createTasks } from '../src/tasks.mjs';
import { createCloudRunWaker, eventOf, fromEnvironment, workloadIdOf } from '../src/waker.mjs';

const CONTROLLER = 'https://dmtr-europe-west1-controller-123.europe-west1.run.app';
const SERVICE_ACCOUNT = 'dmtr-europe-west1@p.iam.gserviceaccount.com';
const BROWSER = 'Mozilla/5.0';

function setup({ run = { state: STATES.ASLEEP }, cfg = testConfig(), enqueue } = {}) {
  const clock = fakeClock();
  const store = fakeStore({ config: cfg, run, clock });
  const created = [];
  const google = { request: async (method, url, body) => { created.push(body.task); return {}; } };
  const tasks = enqueue ? { enqueue } : createTasks({ google, project: 'p', region: 'europe-west1', queue: 'dmtr-europe-west1', serviceAccount: SERVICE_ACCOUNT });
  const logged = [];
  const log = { ...silentLog, error: (event, fields) => logged.push({ event, ...fields }) };
  const handler = createCloudRunWaker({ store, tasks, controllerUrl: CONTROLLER, now: clock.now, log });
  return { handler, store, clock, created, logged };
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
  // Whatever the fetch carries: no Accept here, an explicit wake's headers next.
  for (const headers of [{}, { accept: 'text/html', 'x-dormeto-probe': '1', 'x-dormeto-wake': '1' }]) {
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
  assert.equal(dispatchDeadline, '900s');
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

test('GET /_dormeto/wake that is no probe (a scanner, a link) → no task, whatever the workload\'s wake mode', async () => {
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

// The page's real script, in a sandbox with what it uses of a browser; `fetch` is what the waker answers.
function browse(html, respond, clock) {
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  const browser = { timers: [], reloads: 0, asked: [], answers: [], pending: Promise.resolve(), message: {} };
  const location = { href: 'https://app.example/orders?page=2', reload: () => { browser.reloads += 1; } };
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
  assert.deepEqual(browser.asked, [{ url: '/_dormeto/wake', headers: { 'x-dormeto-probe': '1' } }]);
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
