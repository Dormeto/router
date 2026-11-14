// The Google Cloud router's reports to the manager (vision docs/specs/2026-11-14-google-cloud-router-push-design.md, §4): the journal
// after each state change and each check, then the check's `Router checked`, sent to the manager's API with the service account's
// identity token; the cursor in router/report, moved on a 200 only. Over the real store on a Firestore fake, the manager's API faked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATES } from '../../lambda/src/lib/state.mjs';
import { createFirestoreStore } from '../src/firestore.mjs';
import { ATTEMPTS, REPORT_BUDGET_MS, SEND_MS, createReporter, readReport, withReports } from '../src/report.mjs';
import { fakeFirestore } from './firestore-fake.mjs';

const EVENTS = { url: 'https://api.example.com/routers/events', audience: 'https://api.example.com' };
const START = Date.parse('2026-11-14T10:00:00Z');
const ROUTER = { name: 'dmtr-europe-west1', version: '0.41.0', build: 'b1', checkSchedule: 'rate(5 minutes)', lastScheduledCheckAt: null, pauses: [] };
const OK = { status: 200, body: { accepted: 1, managerSettings: { etag: '"e1"' } } };

const logs = () => {
  const lines = [];
  return { lines, info: (e, d) => lines.push(['info', e, d]), warn: (e, d) => lines.push(['warn', e, d]), error: (e, d) => lines.push(['error', e, d]) };
};

// `answer(n, body)`: the manager API's answer to its n-th POST, { status, body }, or a promise that never settles (a hang).
function setup({ answer = () => OK, events = EVENTS, workloads = [], budgetMs, sendMs } = {}) {
  const firestore = fakeFirestore();
  const clock = { t: START };
  const now = () => clock.t;
  const store = createFirestoreStore({ google: { request: firestore.request }, project: 'p', database: 'dmtr-europe-west1', now, sleep: async () => {} });
  const posts = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    posts.push({ url, method: init.method, headers: init.headers, body, bytes: Buffer.byteLength(init.body) });
    const a = await answer(posts.length, body, init);
    return new Response(JSON.stringify(a.body), { status: a.status });
  };
  const asked = [];
  const tokens = { token: async (audience) => { asked.push(audience); return 'id-token'; } };
  const log = logs();
  const rows = async () => ({ router: ROUTER, workloads });
  const reporter = createReporter({ store, tokens, fetch, region: 'europe-west1', rows, now, log, ...(sendMs ? { sendMs } : {}) });
  const wrapped = withReports(store, reporter, { log, ...(budgetMs ? { budgetMs } : {}) });
  const ready = (async () => {
    if (events) await store.putManagerSettings({ settings: {}, etag: '"e1"', at: 1, events });
    for (const id of ['a', 'b', 'c']) await store.initRun(id, START);
  })();
  // A state change through the wrapped store, a millisecond later each.
  const change = async (id, from, to) => {
    clock.t += 1;
    return wrapped.transition(id, { cond: { state: from }, set: { state: to } });
  };
  return { firestore, store, wrapped, reporter, posts, asked, log, clock, change, ready };
}

const sentIds = (post) => post.body.events.map((e) => `${e.detail.workloadId}-${e.detail.to}`);
const idOf = (ms, id, state) => `${String(ms).padStart(13, '0')}-${id}-${state}`;

test('the bounds: a transition waits 2 s at most for its report; one send, its two tries included, 2 s', () => {
  assert.deepEqual([REPORT_BUDGET_MS, SEND_MS, ATTEMPTS], [2000, 2000, 2]);
});

test('a transition sends the journal after the cursor: each entry as Workload state changed without its id, with the identity token for the audience; a 200 moves the cursor to the last one sent', async () => {
  const { posts, asked, store, change, ready } = setup();
  await ready;
  await change('a', STATES.AWAKE, STATES.NAPPING);
  assert.equal(posts.length, 1);
  const [first] = posts;
  assert.deepEqual([first.url, first.method, first.headers.authorization, first.headers['content-type']], [EVENTS.url, 'POST', 'Bearer id-token', 'application/json']);
  assert.deepEqual(asked, [EVENTS.audience]);
  assert.deepEqual(first.body, {
    events: [{
      detailType: 'Workload state changed',
      detail: { workloadId: 'a', from: 'AWAKE', to: 'NAPPING', at: new Date(START + 1).toISOString(), tags: {}, router: 'dmtr-europe-west1', region: 'europe-west1', project: 'p' },
    }],
  });
  assert.deepEqual(await store.getReport(), { sentThrough: idOf(START + 1, 'a', 'NAPPING'), lastSentAt: START + 1, recent: [idOf(START + 1, 'a', 'NAPPING')] });
  await change('b', STATES.AWAKE, STATES.NAPPING);
  await change('a', STATES.NAPPING, STATES.ASLEEP);
  assert.deepEqual(posts.slice(1).map(sentIds), [['b-NAPPING'], ['a-ASLEEP']], 'only what came after the cursor');
  assert.equal((await store.getReport()).sentThrough, idOf(START + 3, 'a', 'ASLEEP'));
});

test('a change that is no state change, or a condition that failed, sends nothing', async () => {
  const { posts, wrapped, ready } = setup();
  await ready;
  await wrapped.transition('a', { cond: { state: STATES.AWAKE }, set: { holders: 1 } });
  await wrapped.transition('a', { cond: { state: STATES.ASLEEP }, set: { state: STATES.WAKING } });
  assert.equal(posts.length, 0);
});

test('a failed send moves no cursor and says why (ReportFailed); the next send starts from the cursor, the missed entries with it', async () => {
  const { posts, store, change, log, ready } = setup({ answer: (n) => (n <= 2 ? { status: 500, body: { message: 'Internal Server Error' } } : OK) });
  await ready;
  await change('a', STATES.AWAKE, STATES.NAPPING);
  assert.equal(posts.length, 2, 'a 5xx is tried twice');
  assert.deepEqual(await store.getReport(), { sentThrough: null, lastError: '500 Internal Server Error' });
  assert.ok(log.lines.some(([level, event, data]) => level === 'warn' && event === 'ReportFailed' && data.what === 'state' && data.status === 500));
  await change('b', STATES.AWAKE, STATES.NAPPING);
  assert.deepEqual(sentIds(posts[2]), ['a-NAPPING', 'b-NAPPING']);
  const report = await store.getReport();
  assert.equal(report.sentThrough, idOf(START + 2, 'b', 'NAPPING'));
  assert.equal(report.lastError, undefined, 'a 200 clears the error');
});

test('a 400 or a 403 is not tried again; a 502 (entries the bus refused) is', async () => {
  for (const [status, body, tries] of [[400, { error: 'bad_request' }, 1], [403, { error: 'router_unknown' }, 1], [502, { error: 'not_published', failed: 1 }, 2]]) {
    const { posts, change, ready } = setup({ answer: () => ({ status, body }) });
    await ready;
    await change('a', STATES.AWAKE, STATES.NAPPING);
    assert.equal(posts.length, tries, String(status));
  }
});

test('a manager that hangs holds a transition (a wake) no longer than its budget, and moves no cursor', async () => {
  const { change, store, log, ready } = setup({ answer: () => new Promise(() => {}), budgetMs: 50 });
  await ready;
  const started = performance.now();
  const next = await change('a', STATES.AWAKE, STATES.NAPPING);
  assert.equal(next.state, STATES.NAPPING);
  assert.ok(performance.now() - started < 500, `held ${performance.now() - started} ms`);
  assert.ok(log.lines.some(([level, event, data]) => level === 'warn' && event === 'ReportSlow' && data.budgetMs === 50));
  assert.equal((await store.getReport())?.sentThrough ?? null, null);
});

test('one send is bounded, its tries included: a manager that never answers is given up after sendMs, the error recorded', async () => {
  // The fake honours the request's signal, as fetch does.
  const hang = (n, body, init) => new Promise((resolve, reject) => { init.signal.addEventListener('abort', () => reject(init.signal.reason)); });
  const { reporter, store, posts, ready } = setup({ answer: hang, sendMs: 60 });
  await ready;
  await store.transition('a', { cond: { state: STATES.AWAKE }, set: { state: STATES.NAPPING } });
  const started = performance.now();
  await reporter.transitioned();
  assert.ok(performance.now() - started < 500, `took ${performance.now() - started} ms`);
  assert.equal(posts.length, 1, 'a request that ran out of its time is not tried again');
  assert.match((await store.getReport()).lastError, /timeout|aborted/i);
});

test('nothing is sent, nor read past the manager\'s settings, without events', async () => {
  const { posts, change, reporter, store, ready } = setup({ events: null });
  await ready;
  await change('a', STATES.AWAKE, STATES.NAPPING);
  await reporter.checked({ checkedAt: START, durationMs: 5, health: { status: 'ok', problems: [] }, pauses: [], counts: { AWAKE: 3 } });
  assert.equal(posts.length, 0);
  assert.equal(await store.getReport(), null);
});

test('a check sends the journal after the cursor, then Router checked in chunks under 64 KB, AWS\'s detail with the ETag the router holds, in requests of 100 entries and 1 MB at most', async () => {
  const workloads = Array.from({ length: 300 }, (_, i) => ({ workloadId: `w${i}`, name: 'x'.repeat(1400), state: 'AWAKE' }));
  const { posts, reporter, store, ready } = setup({ workloads });
  await ready;
  await store.transition('a', { cond: { state: STATES.AWAKE }, set: { state: STATES.NAPPING } });
  const health = { status: 'ok', problems: [] };
  await reporter.checked({ checkedAt: START, durationMs: 1200, health, pauses: [], counts: { AWAKE: 2, NAPPING: 1 } });
  assert.deepEqual(sentIds(posts[0]), ['a-NAPPING'], 'the journal first');
  const entries = posts.slice(1).flatMap((p) => p.body.events);
  for (const p of posts) assert.ok(p.body.events.length <= 100 && p.bytes <= 1024 * 1024);
  assert.ok(entries.length >= 7);
  for (const [index, { detailType, detail }] of entries.entries()) {
    assert.equal(detailType, 'Router checked');
    assert.ok(Buffer.byteLength(JSON.stringify(detail)) <= 64 * 1024);
    assert.deepEqual({ ...detail, workloads: undefined }, {
      router: { ...ROUTER, region: 'europe-west1' }, checkedAt: new Date(START).toISOString(), durationMs: 1200, health, pauses: [], counts: { AWAKE: 2, NAPPING: 1 },
      managerSettings: { etag: '"e1"' }, chunk: { index, total: entries.length }, workloads: undefined,
    });
  }
  assert.deepEqual(entries.flatMap((e) => e.detail.workloads.map((w) => w.workloadId)), workloads.map((w) => w.workloadId));
  assert.equal((await store.getReport()).sentThrough, idOf(START, 'a', 'NAPPING'));
});

test('a check with nothing new in the journal sends Router checked only; a failed journal send sends no Router checked', async () => {
  const { posts, reporter, store, ready } = setup({ answer: (n) => (n === 2 || n === 3 ? { status: 503, body: {} } : OK) });
  await ready;
  const summary = { checkedAt: START, durationMs: 5, health: { status: 'ok', problems: [] }, pauses: [], counts: { AWAKE: 3 } };
  await reporter.checked(summary);
  assert.deepEqual(posts.map((p) => p.body.events.map((e) => e.detailType)), [['Router checked']]);
  assert.deepEqual(await store.getReport(), { sentThrough: null, lastSentAt: START });
  await store.transition('a', { cond: { state: STATES.AWAKE }, set: { state: STATES.NAPPING } });
  await reporter.checked(summary);
  assert.deepEqual(posts.slice(1).map((p) => p.body.events.map((e) => e.detailType)), [['Workload state changed'], ['Workload state changed']], 'the journal tried twice, then no Router checked');
  assert.equal((await store.getReport()).lastError, '503 Service Unavailable');
});

test('403 router_unknown: the refusal recorded and ReportRefused logged once by the check; the transitions send nothing while it lasts; a check\'s 200 clears it', async () => {
  let refuse = true;
  const { posts, reporter, store, change, log, ready } = setup({ answer: () => (refuse ? { status: 403, body: { error: 'router_unknown' } } : OK) });
  await ready;
  const summary = { checkedAt: START, durationMs: 5, health: { status: 'ok', problems: [] }, pauses: [], counts: { AWAKE: 3 } };
  await reporter.checked(summary);
  assert.deepEqual(await store.getReport(), { sentThrough: null, lastError: '403 router_unknown', lastRefusal: 'router_unknown' });
  assert.equal(log.lines.filter(([, event]) => event === 'ReportRefused').length, 1);
  assert.deepEqual(log.lines.find(([, event]) => event === 'ReportRefused')[2], { host: 'api.example.com', refusal: 'router_unknown' });
  const before = posts.length;
  await change('a', STATES.AWAKE, STATES.NAPPING);
  assert.equal(posts.length, before, 'refused: the transition sends nothing');
  refuse = false;
  await reporter.checked(summary);
  const report = await store.getReport();
  assert.deepEqual([report.lastRefusal, report.lastError, report.sentThrough], [undefined, undefined, idOf(START + 1, 'a', 'NAPPING')]);
});

test('an entry committed late, its time before the cursor (another service\'s, within 5 minutes), is still sent, and none twice', async () => {
  const { posts, store, change, firestore, ready } = setup();
  await ready;
  await change('a', STATES.AWAKE, STATES.NAPPING);
  // The waker's change of b, timed a minute before a's, committed after a's report.
  const late = idOf(START - 60_000, 'b', 'WAKING');
  firestore.docs.set(`events/${late}`, { fields: { workloadId: { stringValue: 'b' }, to: { stringValue: 'WAKING' } }, updateTime: 't' });
  // One older than 5 minutes before the cursor is past the window.
  firestore.docs.set(`events/${idOf(START - 6 * 60_000, 'c', 'WAKING')}`, { fields: { workloadId: { stringValue: 'c' }, to: { stringValue: 'WAKING' } }, updateTime: 't' });
  await change('c', STATES.AWAKE, STATES.NAPPING);
  assert.deepEqual(posts.map(sentIds), [['a-NAPPING'], ['b-WAKING', 'c-NAPPING']]);
  const report = await store.getReport();
  assert.equal(report.sentThrough, idOf(START + 2, 'c', 'NAPPING'));
  assert.deepEqual(report.recent, [late, idOf(START + 1, 'a', 'NAPPING'), idOf(START + 2, 'c', 'NAPPING')]);
});

test('a journal longer than a request is sent in requests of 100 entries, the cursor moved by each', async () => {
  const { posts, store, reporter, firestore, ready } = setup();
  await ready;
  for (let i = 0; i < 230; i += 1) firestore.docs.set(`events/${idOf(START - 1000 + i, `w${i}`, 'ASLEEP')}`, { fields: { workloadId: { stringValue: `w${i}` }, to: { stringValue: 'ASLEEP' } }, updateTime: 't' });
  await reporter.transitioned();
  assert.deepEqual(posts.map((p) => p.body.events.length), [100, 100, 30]);
  assert.equal((await store.getReport()).sentThrough, idOf(START - 1000 + 229, 'w229', 'ASLEEP'));
});

test('readReport: where the router reports (the URL\'s host), its last report, the cursor, the last error and refusal; null without events; an unreadable store said', async () => {
  const { store, change, ready } = setup({ answer: () => ({ status: 403, body: { error: 'router_unknown' } }) });
  await ready;
  assert.deepEqual(await readReport(store), { host: 'api.example.com', lastSentAt: null, sentThrough: null });
  await change('a', STATES.AWAKE, STATES.NAPPING);
  assert.deepEqual(await readReport(store), { host: 'api.example.com', lastSentAt: null, sentThrough: null, lastError: '403 router_unknown', lastRefusal: 'router_unknown' });
  const none = setup({ events: null });
  await none.ready;
  assert.equal(await readReport(none.store), null);
  assert.deepEqual(await readReport({ getManagerSettings: async () => { throw new Error('Firestore down'); }, getReport: async () => null }), { error: 'Firestore down' });
});

test('readReport is bounded: a store that does not answer is said within its time, never a held health', async () => {
  const hung = { getManagerSettings: () => new Promise(() => {}), getReport: async () => null };
  const started = performance.now();
  assert.deepEqual(await readReport(hung, { timeoutMs: 30 }), { error: 'not read within 30 ms' });
  assert.ok(performance.now() - started < 500);
});
