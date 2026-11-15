// The Google Cloud router's reports to the manager (vision docs/specs/2026-11-14-google-cloud-router-push-design.md, §4, and
// docs/specs/2026-11-15-router-credentials-design.md, §5): the journal after each state change and each check, then the check's
// `Router checked`, put on the manager's bus by the router itself with the credentials the manager's API gives for its identity
// token; the cursor in router/report, moved through the last entry put. Over the real store on a Firestore fake, the manager's API
// and EventBridge faked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATES } from '../../lambda/src/lib/state.mjs';
import { createFirestoreStore } from '../src/firestore.mjs';
import { ATTEMPTS, JITTER_MS, RENEW_MS, REPORT_BUDGET_MS, SEND_MS, createReporter, readReport, withReports } from '../src/report.mjs';
import { signedHeaders } from '../src/sigv4.mjs';
import { fakeFirestore } from './firestore-fake.mjs';

const EVENTS = { url: 'https://api.example.com/routers/credentials', audience: 'https://api.example.com' };
const START = Date.parse('2026-11-14T10:00:00Z');
const PROJECT = 'p';
const REGION = 'europe-west1';
const SOURCE = `dormeto.router.gcp/${PROJECT}/${REGION}`;
const BUS = { name: 'dmt-dev-manager', region: 'eu-west-1' };
const PUT_URL = 'https://events.eu-west-1.amazonaws.com/';
const ROUTER = { name: 'dmtr-europe-west1', version: '0.41.0', build: 'b1', checkSchedule: 'rate(5 minutes)', lastScheduledCheckAt: null, pauses: [] };
const KEY_ID = 'ASIAEXAMPLE';
const SECRET = 'the-secret-access-key';
const SESSION = 'the-session-token';

// The credentials route's answer, valid an hour after `at`.
const granted = (at = START, more = {}) => ({
  status: 200,
  body: {
    credentials: { accessKeyId: KEY_ID, secretAccessKey: SECRET, sessionToken: SESSION, expiration: new Date(at + 3600_000).toISOString() },
    bus: BUS, source: SOURCE, managerSettings: { etag: '"e1"' }, ...more,
  },
});
// PutEvents' answer: every entry put.
const allPut = (body) => ({ status: 200, body: { FailedEntryCount: 0, Entries: body.Entries.map((_, i) => ({ EventId: `id-${i}` })) } });

const logs = () => {
  const lines = [];
  return { lines, info: (e, d) => lines.push(['info', e, d]), warn: (e, d) => lines.push(['warn', e, d]), error: (e, d) => lines.push(['error', e, d]) };
};

// `grant(n, clock, init)`: the credentials route's answer to its n-th call; `put(n, body, init)`: PutEvents' to its n-th call. Each
// is { status, body }, or a promise that never settles (a hang).
function setup({ grant = (n, clock) => granted(clock.t), put = (n, body) => allPut(body), events = EVENTS, workloads = [], budgetMs, sendMs, random, token = async () => 'id-token' } = {}) {
  const firestore = fakeFirestore();
  const clock = { t: START };
  const now = () => clock.t;
  const store = createFirestoreStore({ google: { request: firestore.request }, project: PROJECT, database: 'dmtr-europe-west1', now, sleep: async () => {} });
  const grants = [];
  const puts = [];
  const fetch = async (url, init) => {
    if (url === EVENTS.url) {
      grants.push({ url, method: init.method, headers: init.headers, body: init.body });
      const a = await grant(grants.length, clock, init);
      return new Response(JSON.stringify(a.body), { status: a.status });
    }
    const body = JSON.parse(init.body);
    puts.push({ url, method: init.method, headers: init.headers, body, raw: init.body });
    const a = await put(puts.length, body, init);
    return new Response(JSON.stringify(a.body), { status: a.status });
  };
  const asked = [];
  const tokens = { token: async (audience) => { asked.push(audience); return token(audience); } };
  const log = logs();
  const rows = async () => ({ router: ROUTER, workloads });
  const reporter = createReporter({
    store, tokens, fetch, project: PROJECT, region: REGION, rows, now, log, ...(sendMs ? { sendMs } : {}), ...(random ? { random } : {}),
  });
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
  return { firestore, store, wrapped, reporter, grants, puts, asked, log, clock, change, ready };
}

const sentIds = (put) => put.body.Entries.map((e) => {
  const d = JSON.parse(e.Detail);
  return `${d.workloadId}-${d.to}`;
});
const typesOf = (put) => put.body.Entries.map((e) => e.DetailType);
const idOf = (ms, id, state) => `${String(ms).padStart(13, '0')}-${id}-${state}`;
const summaryOf = () => ({ checkedAt: START, durationMs: 5, health: { status: 'ok', problems: [] }, pauses: [], counts: { AWAKE: 3 } });
const journalOf = (firestore, count) => {
  for (let i = 0; i < count; i += 1) {
    firestore.docs.set(`events/${idOf(START - 1000 + i, `w${i}`, 'ASLEEP')}`, { fields: { workloadId: { stringValue: `w${i}` }, to: { stringValue: 'ASLEEP' } }, updateTime: 't' });
  }
};

test('the bounds: a transition waits 2 s at most for its report; a report, its credentials and tries included, 2 s; credentials renewed 5 minutes before they expire, plus up to 5 minutes', () => {
  assert.deepEqual([REPORT_BUDGET_MS, SEND_MS, ATTEMPTS, RENEW_MS, JITTER_MS], [2000, 2000, 2, 300_000, 300_000]);
});

test('a transition asks the manager for credentials with the identity token and no body, then puts the journal after the cursor on the bus, signed with them; the cursor moves to the last one put', async () => {
  const { grants, puts, asked, store, change, ready } = setup();
  await ready;
  await change('a', STATES.AWAKE, STATES.NAPPING);
  assert.equal(grants.length, 1);
  assert.deepEqual([grants[0].method, grants[0].headers.authorization, grants[0].body], ['POST', 'Bearer id-token', undefined]);
  assert.deepEqual(asked, [EVENTS.audience]);
  assert.equal(puts.length, 1);
  const [first] = puts;
  assert.deepEqual([first.url, first.method, first.headers['content-type'], first.headers['x-amz-target'], first.headers['x-amz-security-token']],
    [PUT_URL, 'POST', 'application/x-amz-json-1.1', 'AWSEvents.PutEvents', SESSION]);
  assert.deepEqual(first.body, {
    Entries: [{
      EventBusName: BUS.name, Source: SOURCE, DetailType: 'Workload state changed',
      Detail: JSON.stringify({ workloadId: 'a', from: 'AWAKE', to: 'NAPPING', at: new Date(START + 1).toISOString(), tags: {}, router: 'dmtr-europe-west1', region: REGION, project: PROJECT }),
    }],
  });
  // The signature is Signature Version 4's of this very body, for `events` in the bus's region, at the request's X-Amz-Date.
  const at = Date.parse(first.headers['x-amz-date'].replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/, '$1-$2-$3T$4:$5:$6Z'));
  const expected = signedHeaders({
    method: 'POST', url: PUT_URL, headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'AWSEvents.PutEvents' }, body: first.raw,
    credentials: { accessKeyId: KEY_ID, secretAccessKey: SECRET, sessionToken: SESSION }, region: BUS.region, service: 'events', now: at,
  });
  assert.equal(first.headers.authorization, expected.authorization);
  assert.match(first.headers.authorization, /Credential=ASIAEXAMPLE\/\d{8}\/eu-west-1\/events\/aws4_request/);
  assert.deepEqual(await store.getReport(), { sentThrough: idOf(START + 1, 'a', 'NAPPING'), lastSentAt: START + 1, recent: [idOf(START + 1, 'a', 'NAPPING')] });
  await change('b', STATES.AWAKE, STATES.NAPPING);
  await change('a', STATES.NAPPING, STATES.ASLEEP);
  assert.deepEqual(puts.slice(1).map(sentIds), [['b-NAPPING'], ['a-ASLEEP']], 'only what came after the cursor');
  assert.equal(grants.length, 1, 'the credentials are kept');
  assert.equal((await store.getReport()).sentThrough, idOf(START + 3, 'a', 'ASLEEP'));
});

test('the credentials are kept until 5 minutes before they expire plus the instance\'s jitter, then asked again', async () => {
  for (const [random, jitter] of [[0, 0], [0.5, JITTER_MS / 2], [0.999, 0.999 * JITTER_MS]]) {
    const { grants, change, clock, ready } = setup({ random: () => random, grant: () => granted(START) });
    await ready;
    await change('a', STATES.AWAKE, STATES.NAPPING);
    const renewAt = START + 3600_000 - RENEW_MS - jitter;
    clock.t = Math.floor(renewAt) - 2;
    await change('a', STATES.NAPPING, STATES.ASLEEP);
    assert.equal(grants.length, 1, `kept before the renewal (${random})`);
    clock.t = Math.ceil(renewAt);
    await change('a', STATES.ASLEEP, STATES.WAKING);
    assert.equal(grants.length, 2, `asked again at the renewal (${random})`);
  }
});

test('the jitter is the instance\'s, between 0 and 5 minutes: two instances renew at different times', async () => {
  const early = setup({ random: () => 0, grant: () => granted(START) });
  const late = setup({ random: () => 0.9, grant: () => granted(START) });
  for (const t of [early, late]) {
    await t.ready;
    await t.change('a', STATES.AWAKE, STATES.NAPPING);
    t.clock.t = START + 3600_000 - RENEW_MS - 60_000;
    await t.change('a', STATES.NAPPING, STATES.ASLEEP);
  }
  assert.deepEqual([early.grants.length, late.grants.length], [1, 2]);
});

test('the credentials are never stored nor logged, the failures\' included', async () => {
  let answer = (body) => allPut(body);
  const t = setup({ put: (n, body) => answer(body) });
  await t.ready;
  await t.change('a', STATES.AWAKE, STATES.NAPPING);
  await t.reporter.checked(summaryOf());
  answer = () => ({ status: 400, body: { __type: 'ValidationException', message: 'bad' } });
  await t.change('b', STATES.AWAKE, STATES.NAPPING);
  answer = () => ({ status: 403, body: { __type: 'AccessDeniedException', message: 'denied' } });
  await t.change('c', STATES.AWAKE, STATES.NAPPING);
  const stored = JSON.stringify([...t.firestore.docs.values()]);
  const logged = JSON.stringify(t.log.lines);
  for (const secret of [SECRET, SESSION, KEY_ID]) {
    assert.ok(!stored.includes(secret), `stored: ${secret}`);
    assert.ok(!logged.includes(secret), `logged: ${secret}`);
  }
  assert.ok(t.log.lines.some(([, event]) => event === 'ReportFailed'));
});

test('a change that is no state change, or a condition that failed, sends nothing', async () => {
  const { grants, puts, wrapped, ready } = setup();
  await ready;
  await wrapped.transition('a', { cond: { state: STATES.AWAKE }, set: { holders: 1 } });
  await wrapped.transition('a', { cond: { state: STATES.ASLEEP }, set: { state: STATES.WAKING } });
  assert.deepEqual([grants.length, puts.length], [0, 0]);
});

test('a failed put moves no cursor and says why (ReportFailed); the next put starts from the cursor, the missed entries with it', async () => {
  const { puts, store, change, log, ready } = setup({ put: (n, body) => (n <= 2 ? { status: 500, body: { __type: 'InternalException', message: 'Internal' } } : allPut(body)) });
  await ready;
  await change('a', STATES.AWAKE, STATES.NAPPING);
  assert.equal(puts.length, 2, 'a 5xx is tried twice');
  assert.deepEqual(await store.getReport(), { sentThrough: null, lastError: '500 InternalException: Internal' });
  assert.ok(log.lines.some(([level, event, data]) => level === 'warn' && event === 'ReportFailed' && data.what === 'state' && data.status === 500 && data.host === 'api.example.com'));
  await change('b', STATES.AWAKE, STATES.NAPPING);
  assert.deepEqual(sentIds(puts[2]), ['a-NAPPING', 'b-NAPPING']);
  const report = await store.getReport();
  assert.equal(report.sentThrough, idOf(START + 2, 'b', 'NAPPING'));
  assert.equal(report.lastError, undefined, 'a put clears the error');
});

test('a put that fails some entries moves the cursor through the last entry before the first failed one; the rest goes next time', async () => {
  let fail = true;
  const put = (n, body) => (fail ? {
    status: 200,
    body: { FailedEntryCount: 2, Entries: body.Entries.map((_, i) => (i === 2 || i === 3 ? { ErrorCode: 'ThrottlingException', ErrorMessage: 'Rate exceeded' } : { EventId: `id-${i}` })) },
  } : allPut(body));
  const { puts, store, reporter, firestore, log, ready } = setup({ put });
  await ready;
  journalOf(firestore, 5);
  await reporter.transitioned();
  assert.equal(puts.length, 1, 'a failed entry is not put again at once');
  const report = await store.getReport();
  assert.equal(report.sentThrough, idOf(START - 999, 'w1', 'ASLEEP'));
  assert.equal(report.lastError, '200 ThrottlingException: Rate exceeded');
  assert.ok(log.lines.some(([, event, data]) => event === 'ReportFailed' && data.error === '200 ThrottlingException: Rate exceeded'));
  fail = false;
  await reporter.transitioned();
  assert.deepEqual(sentIds(puts[1]), ['w2-ASLEEP', 'w3-ASLEEP', 'w4-ASLEEP'], 'from the first failed one, none twice');
  assert.equal((await store.getReport()).sentThrough, idOf(START - 996, 'w4', 'ASLEEP'));
});

test('a transient per-entry failure (InternalFailure) stops the cursor before it as a throttled one does', async () => {
  const put = (n, body) => (n === 1 ? {
    status: 200, body: { FailedEntryCount: 1, Entries: body.Entries.map((_, i) => (i === 1 ? { ErrorCode: 'InternalFailure', ErrorMessage: 'try again' } : { EventId: `id-${i}` })) },
  } : allPut(body));
  const { store, reporter, firestore, log, ready } = setup({ put });
  await ready;
  journalOf(firestore, 3);
  await reporter.transitioned();
  assert.equal((await store.getReport()).sentThrough, idOf(START - 1000, 'w0', 'ASLEEP'));
  assert.ok(!log.lines.some(([, event]) => event === 'ReportDropped'));
});

test('an entry PutEvents refuses for good (an ErrorCode neither throttling nor internal) is dropped, ReportDropped, and the cursor moves past it to the end', async () => {
  const put = (n, body) => (n === 1 ? {
    status: 200,
    body: { FailedEntryCount: 1, Entries: body.Entries.map((_, i) => (i === 1 ? { ErrorCode: 'MalformedDetail', ErrorMessage: 'Detail is malformed.' } : { EventId: `id-${i}` })) },
  } : allPut(body));
  const { puts, store, reporter, firestore, log, ready } = setup({ put });
  await ready;
  journalOf(firestore, 14);
  await reporter.transitioned();
  assert.deepEqual(puts.map((p) => p.body.Entries.length), [10, 4], 'carried on with the next entries');
  const report = await store.getReport();
  assert.equal(report.sentThrough, idOf(START - 1000 + 13, 'w13', 'ASLEEP'));
  assert.equal(report.lastError, undefined);
  const dropped = log.lines.filter(([, event]) => event === 'ReportDropped').map(([, , data]) => data);
  assert.deepEqual(dropped, [{ id: idOf(START - 999, 'w1', 'ASLEEP'), detailType: 'Workload state changed', error: 'MalformedDetail' }]);
});

test('a 400 ValidationException: a call of one entry drops it; a call of several is put again one entry a call, the bad one dropped', async () => {
  const bad = idOf(START - 998, 'w2', 'ASLEEP');
  const put = (n, body) => (body.Entries.some((e) => JSON.parse(e.Detail).workloadId === 'w2') ? { status: 400, body: { __type: 'ValidationException', message: 'invalid' } } : allPut(body));
  const { puts, store, reporter, firestore, log, ready } = setup({ put });
  await ready;
  journalOf(firestore, 4);
  await reporter.transitioned();
  assert.deepEqual(puts.map((p) => p.body.Entries.length), [4, 1, 1, 1, 1]);
  assert.equal((await store.getReport()).sentThrough, idOf(START - 997, 'w3', 'ASLEEP'));
  assert.deepEqual(log.lines.filter(([, event]) => event === 'ReportDropped').map(([, , data]) => data), [{ id: bad, detailType: 'Workload state changed', error: 'ValidationException' }]);
});

test('a journal entry whose detail is over 64 KB is dropped without a call, and a check still puts Router checked after it', async () => {
  const { puts, store, reporter, firestore, log, ready } = setup();
  await ready;
  journalOf(firestore, 2);
  const big = idOf(START - 1000, 'w0', 'ASLEEP');
  firestore.docs.set(`events/${big}`, { fields: { workloadId: { stringValue: 'w0' }, to: { stringValue: 'ASLEEP' }, note: { stringValue: 'x'.repeat(70 * 1024) } }, updateTime: 't' });
  await reporter.checked(summaryOf());
  assert.deepEqual(puts.map(sentIds)[0], ['w1-ASLEEP'], 'the big one never sent');
  assert.deepEqual(typesOf(puts[1]), ['Router checked']);
  assert.equal((await store.getReport()).sentThrough, idOf(START - 999, 'w1', 'ASLEEP'));
  assert.deepEqual(log.lines.filter(([, event]) => event === 'ReportDropped').map(([, , data]) => data), [{ id: big, detailType: 'Workload state changed', error: 'EntryTooLarge' }]);
});

test('a Router checked chunk refused for good is dropped and logged, and the other chunks are put', async () => {
  const workloads = Array.from({ length: 1200 }, (_, i) => ({ workloadId: `w${i}`, name: 'x'.repeat(1400), state: 'AWAKE' }));
  const put = (n, body) => (n === 1 ? {
    status: 200, body: { FailedEntryCount: 1, Entries: body.Entries.map((_, i) => (i === 0 ? { ErrorCode: 'MalformedDetail', ErrorMessage: 'no' } : { EventId: `id-${i}` })) },
  } : allPut(body));
  const { puts, store, reporter, log, ready } = setup({ workloads, put, sendMs: 10_000 });
  await ready;
  await reporter.checked(summaryOf());
  assert.ok(puts.length >= 3, `${puts.length} calls`);
  assert.deepEqual(log.lines.filter(([, event]) => event === 'ReportDropped').map(([, , data]) => data), [{ id: 'check', detailType: 'Router checked', error: 'MalformedDetail' }]);
  const report = await store.getReport();
  assert.deepEqual([report.lastError, report.lastSentAt], [undefined, START]);
});

test('an AWS error that quotes the credentials never reaches the store nor a log: its type and first line only, 200 characters at most, the secrets masked', async () => {
  const quoting = `The request signature we calculated does not match the signature you provided. Check your AWS Secret Access Key and signing method.
The Canonical String for this request should have been
'POST
/

content-type:application/x-amz-json-1.1
host:events.eu-west-1.amazonaws.com
x-amz-security-token:${SESSION}
x-amz-target:AWSEvents.PutEvents'`;
  for (const answer of [
    { status: 403, body: { __type: 'InvalidSignatureException', message: quoting } },
    { status: 400, body: { __type: 'ValidationException', message: `key ${KEY_ID} secret ${SECRET} token ${SESSION} ${'y'.repeat(300)}` } },
  ]) {
    const t = setup({ put: () => answer });
    await t.ready;
    await t.change('a', STATES.AWAKE, STATES.NAPPING);
    await t.reporter.checked(summaryOf());
    const stored = JSON.stringify([...t.firestore.docs.values()]);
    const logged = JSON.stringify(t.log.lines);
    for (const secret of [SECRET, SESSION, KEY_ID]) {
      assert.ok(!stored.includes(secret), `stored: ${secret}`);
      assert.ok(!logged.includes(secret), `logged: ${secret}`);
    }
    const { lastError } = await t.store.getReport();
    if (answer.status === 403) {
      assert.equal(lastError, '403 InvalidSignatureException: The request signature we calculated does not match the signature you provided. Check your AWS Secret Access Key and signing method.');
    }
  }
  // A per-entry message and the manager's answer are cut and masked the same way.
  const entry = setup({ put: (n, body) => ({ status: 200, body: { FailedEntryCount: 1, Entries: body.Entries.map(() => ({ ErrorCode: 'ThrottlingException', ErrorMessage: `slow ${SESSION}\nmore ${SECRET}` })) } }) });
  await entry.ready;
  await entry.change('a', STATES.AWAKE, STATES.NAPPING);
  assert.equal((await entry.store.getReport()).lastError, '200 ThrottlingException: slow ***');
  const manager = setup({ grant: () => ({ status: 500, body: { message: `${'z'.repeat(250)}\nsecond line` } }) });
  await manager.ready;
  await manager.change('a', STATES.AWAKE, STATES.NAPPING);
  assert.equal((await manager.store.getReport()).lastError, `500 ${'z'.repeat(200)}`);
});

test('a put refused for its credentials (403) drops them and asks again once, within the same report', async () => {
  const { grants, puts, store, change, ready } = setup({ put: (n, body) => (n === 1 ? { status: 403, body: { __type: 'ExpiredTokenException', message: 'expired' } } : allPut(body)) });
  await ready;
  await change('a', STATES.AWAKE, STATES.NAPPING);
  assert.deepEqual([grants.length, puts.length], [2, 2]);
  assert.equal((await store.getReport()).sentThrough, idOf(START + 1, 'a', 'NAPPING'));
  // Refused again with the new ones: no third ask, the failure kept.
  const again = setup({ put: () => ({ status: 403, body: { __type: 'AccessDeniedException', message: 'not authorized' } }) });
  await again.ready;
  await again.change('a', STATES.AWAKE, STATES.NAPPING);
  assert.deepEqual([again.grants.length, again.puts.length], [2, 2]);
  assert.deepEqual(await again.store.getReport(), { sentThrough: null, lastError: '403 AccessDeniedException: not authorized' });
});

test('an expired token answered 400 (ExpiredTokenException, as AWS\'s JSON services answer it) is renewed once too', async () => {
  const expired = { status: 400, body: { __type: 'com.amazon.coral.service#ExpiredTokenException', message: 'expired' } };
  const { grants, puts, store, change, ready } = setup({ put: (n, body) => (n === 1 ? expired : allPut(body)) });
  await ready;
  await change('a', STATES.AWAKE, STATES.NAPPING);
  assert.deepEqual([grants.length, puts.length], [2, 2]);
  assert.equal((await store.getReport()).lastError, undefined);
});

test('a 400 is not tried again; a 429 or a 5xx is, on the credentials route and on the bus', async () => {
  for (const [where, status, tries] of [['put', 400, 1], ['put', 429, 2], ['put', 503, 2], ['grant', 400, 1], ['grant', 502, 2]]) {
    const failing = { status, body: { __type: 'X', error: 'no_credentials' } };
    const { grants, puts, change, ready } = setup(where === 'put' ? { put: () => failing } : { grant: () => failing });
    await ready;
    await change('a', STATES.AWAKE, STATES.NAPPING);
    assert.equal(where === 'put' ? puts.length : grants.length, tries, `${where} ${status}`);
  }
});

test('an answer that names another source, a bus region that is no region, or no credentials: nothing is put, ReportFailed', async () => {
  const cases = [
    { source: 'dormeto.router.gcp/other/europe-west1' }, { source: 'dormeto.router' }, { source: `${SOURCE}/x` },
    { bus: { name: BUS.name, region: 'evil.example.com/x' } }, { bus: { name: BUS.name, region: 'EU-WEST-1' } }, { bus: { name: '', region: 'eu-west-1' } },
    { credentials: { accessKeyId: 'A', secretAccessKey: 'S', sessionToken: 'T', expiration: 'never' } }, { credentials: null },
  ];
  for (const more of cases) {
    const { puts, grants, store, change, log, ready } = setup({ grant: (n, clock) => granted(clock.t, more) });
    await ready;
    await change('a', STATES.AWAKE, STATES.NAPPING);
    await change('b', STATES.AWAKE, STATES.NAPPING);
    assert.equal(puts.length, 0, JSON.stringify(more));
    assert.equal(grants.length, 2, `not kept: ${JSON.stringify(more)}`);
    const report = await store.getReport();
    assert.equal(report.sentThrough, null);
    assert.match(report.lastError, /^200 the manager's answer /, JSON.stringify(more));
    assert.ok(log.lines.some(([, event]) => event === 'ReportFailed'));
  }
});

test('an identity token the metadata server refuses: nothing asked nor put, the error recorded', async () => {
  const { grants, puts, store, change, log, ready } = setup({ token: async () => { throw new Error('Google: the metadata server refused the identity token: 500'); } });
  await ready;
  await change('a', STATES.AWAKE, STATES.NAPPING);
  assert.deepEqual([grants.length, puts.length], [0, 0]);
  assert.deepEqual(await store.getReport(), { sentThrough: null, lastError: 'Google: the metadata server refused the identity token: 500' });
  assert.ok(log.lines.some(([, event, data]) => event === 'ReportFailed' && data.what === 'state'));
});

test('a manager that hangs holds a transition (a wake) no longer than its budget, and moves no cursor', async () => {
  const { change, store, log, ready } = setup({ grant: () => new Promise(() => {}), budgetMs: 50 });
  await ready;
  const started = performance.now();
  const next = await change('a', STATES.AWAKE, STATES.NAPPING);
  assert.equal(next.state, STATES.NAPPING);
  assert.ok(performance.now() - started < 500, `held ${performance.now() - started} ms`);
  assert.ok(log.lines.some(([level, event, data]) => level === 'warn' && event === 'ReportSlow' && data.budgetMs === 50));
  assert.equal((await store.getReport())?.sentThrough ?? null, null);
});

// The fakes honour the request's signal, as fetch does.
const hang = (init) => new Promise((resolve, reject) => { init.signal.addEventListener('abort', () => reject(init.signal.reason)); });

test('a report is bounded, its credentials and tries included: a manager or a bus that never answers is given up after sendMs, the error recorded', async () => {
  for (const which of ['grant', 'put']) {
    const { reporter, store, grants, puts, ready } = setup(which === 'grant' ? { grant: (n, c, init) => hang(init), sendMs: 60 } : { put: (n, b, init) => hang(init), sendMs: 60 });
    await ready;
    await store.transition('a', { cond: { state: STATES.AWAKE }, set: { state: STATES.NAPPING } });
    const started = performance.now();
    await reporter.transitioned();
    assert.ok(performance.now() - started < 500, `${which} took ${performance.now() - started} ms`);
    assert.equal(which === 'grant' ? grants.length : puts.length, 1, 'a request that ran out of its time is not tried again');
    assert.match((await store.getReport()).lastError, /timeout|aborted/i);
  }
});

test('a check is held by its report no longer than the report\'s time: a slow bus stops it, what was not put left for the next', async () => {
  const workloads = Array.from({ length: 1200 }, (_, i) => ({ workloadId: `w${i}`, name: 'x'.repeat(1400), state: 'AWAKE' }));
  const put = async (n, body) => {
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    return allPut(body);
  };
  const { reporter, store, puts, log, ready } = setup({ workloads, sendMs: 80, put });
  await ready;
  const started = performance.now();
  await reporter.checked(summaryOf());
  assert.ok(performance.now() - started < 400, `held ${performance.now() - started} ms`);
  assert.ok(puts.length <= 2, `${puts.length} puts`);
  assert.equal((await store.getReport()).lastError, 'not sent within 80 ms');
  assert.ok(log.lines.some(([, event, data]) => event === 'ReportFailed' && data.what === 'check'));
});

test('nothing is asked nor put, nor read past the manager\'s settings, without events', async () => {
  const { grants, puts, change, reporter, store, ready } = setup({ events: null });
  await ready;
  await change('a', STATES.AWAKE, STATES.NAPPING);
  await reporter.checked(summaryOf());
  assert.deepEqual([grants.length, puts.length], [0, 0]);
  assert.equal(await store.getReport(), null);
});

test('a check puts the journal after the cursor, then Router checked in chunks under 64 KB, AWS\'s detail with the ETag the router holds, in calls of 10 entries and 256 KB at most', async () => {
  const workloads = Array.from({ length: 1200 }, (_, i) => ({ workloadId: `w${i}`, name: 'x'.repeat(1400), state: 'AWAKE' }));
  const { puts, grants, reporter, store, ready } = setup({ workloads, sendMs: 10_000 });
  await ready;
  await store.transition('a', { cond: { state: STATES.AWAKE }, set: { state: STATES.NAPPING } });
  const health = { status: 'ok', problems: [] };
  await reporter.checked({ checkedAt: START, durationMs: 1200, health, pauses: [], counts: { AWAKE: 2, NAPPING: 1 } });
  assert.equal(grants.length, 1);
  assert.deepEqual(sentIds(puts[0]), ['a-NAPPING'], 'the journal first');
  const entries = puts.slice(1).flatMap((p) => p.body.Entries);
  for (const p of puts) {
    assert.ok(p.body.Entries.length <= 10);
    assert.ok(p.body.Entries.reduce((n, e) => n + Buffer.byteLength(e.Detail) + Buffer.byteLength(e.DetailType) + Buffer.byteLength(e.Source), 0) <= 256 * 1024);
  }
  assert.ok(puts.length >= 3, 'more than one call of Router checked');
  assert.ok(entries.length >= 25);
  for (const [index, { EventBusName, Source, DetailType, Detail }] of entries.entries()) {
    assert.deepEqual([EventBusName, Source, DetailType], [BUS.name, SOURCE, 'Router checked']);
    assert.ok(Buffer.byteLength(Detail) <= 64 * 1024);
    const detail = JSON.parse(Detail);
    assert.deepEqual({ ...detail, workloads: undefined }, {
      router: { ...ROUTER, region: REGION }, checkedAt: new Date(START).toISOString(), durationMs: 1200, health, pauses: [], counts: { AWAKE: 2, NAPPING: 1 },
      managerSettings: { etag: '"e1"' }, chunk: { index, total: entries.length }, workloads: undefined,
    });
  }
  assert.deepEqual(entries.flatMap((e) => JSON.parse(e.Detail).workloads.map((w) => w.workloadId)), workloads.map((w) => w.workloadId));
  assert.equal((await store.getReport()).sentThrough, idOf(START, 'a', 'NAPPING'));
});

test('a check with nothing new in the journal puts Router checked only; a failed journal put puts no Router checked', async () => {
  const { puts, reporter, store, ready } = setup({ put: (n, body) => (n === 2 || n === 3 ? { status: 503, body: {} } : allPut(body)) });
  await ready;
  await reporter.checked(summaryOf());
  assert.deepEqual(puts.map(typesOf), [['Router checked']]);
  assert.deepEqual(await store.getReport(), { sentThrough: null, lastSentAt: START });
  await store.transition('a', { cond: { state: STATES.AWAKE }, set: { state: STATES.NAPPING } });
  await reporter.checked(summaryOf());
  assert.deepEqual(puts.slice(1).map(typesOf), [['Workload state changed'], ['Workload state changed']], 'the journal tried twice, then no Router checked');
  assert.equal((await store.getReport()).lastError, '503 Service Unavailable');
});

test('403 router_unknown from the credentials route: the refusal recorded and ReportRefused logged once by the check; the transitions ask nothing while it lasts; a check\'s put clears it', async () => {
  let refuse = true;
  const { grants, puts, reporter, store, change, log, ready } = setup({ grant: (n, clock) => (refuse ? { status: 403, body: { error: 'router_unknown' } } : granted(clock.t)) });
  await ready;
  await reporter.checked(summaryOf());
  assert.equal(puts.length, 0);
  assert.deepEqual(await store.getReport(), { sentThrough: null, lastError: '403 router_unknown', lastRefusal: 'router_unknown' });
  assert.equal(log.lines.filter(([, event]) => event === 'ReportRefused').length, 1);
  assert.deepEqual(log.lines.find(([, event]) => event === 'ReportRefused')[2], { host: 'api.example.com', refusal: 'router_unknown' });
  const before = grants.length;
  await change('a', STATES.AWAKE, STATES.NAPPING);
  assert.equal(grants.length, before, 'refused: the transition asks nothing');
  refuse = false;
  await reporter.checked(summaryOf());
  const report = await store.getReport();
  assert.deepEqual([report.lastRefusal, report.lastError, report.sentThrough], [undefined, undefined, idOf(START + 1, 'a', 'NAPPING')]);
});

test('an entry committed late, its time before the cursor (another service\'s, within 5 minutes), is still put, and none twice', async () => {
  const { puts, store, change, firestore, ready } = setup();
  await ready;
  await change('a', STATES.AWAKE, STATES.NAPPING);
  // The waker's change of b, timed a minute before a's, committed after a's report.
  const late = idOf(START - 60_000, 'b', 'WAKING');
  firestore.docs.set(`events/${late}`, { fields: { workloadId: { stringValue: 'b' }, to: { stringValue: 'WAKING' } }, updateTime: 't' });
  // One older than 5 minutes before the cursor is past the window.
  firestore.docs.set(`events/${idOf(START - 6 * 60_000, 'c', 'WAKING')}`, { fields: { workloadId: { stringValue: 'c' }, to: { stringValue: 'WAKING' } }, updateTime: 't' });
  await change('c', STATES.AWAKE, STATES.NAPPING);
  assert.deepEqual(puts.map(sentIds), [['a-NAPPING'], ['b-WAKING', 'c-NAPPING']]);
  const report = await store.getReport();
  assert.equal(report.sentThrough, idOf(START + 2, 'c', 'NAPPING'));
  assert.deepEqual(report.recent, [late, idOf(START + 1, 'a', 'NAPPING'), idOf(START + 2, 'c', 'NAPPING')]);
});

test('a journal longer than a call is put in calls of 10 entries, the cursor moved by each', async () => {
  const { puts, store, reporter, firestore, ready } = setup();
  await ready;
  journalOf(firestore, 230);
  await reporter.transitioned();
  assert.deepEqual(puts.map((p) => p.body.Entries.length), Array(23).fill(10));
  assert.equal((await store.getReport()).sentThrough, idOf(START - 1000 + 229, 'w229', 'ASLEEP'));
});

test('readReport: where the router reports (the manager URL\'s host), its last report, the cursor, the last error and refusal; null without events; an unreadable store said', async () => {
  const { store, change, ready } = setup({ grant: () => ({ status: 403, body: { error: 'router_unknown' } }) });
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
