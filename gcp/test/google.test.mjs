import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGoogle, GoogleError } from '../src/google.mjs';

const TOKEN_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// A fake fetch: the metadata server gives tokens t1, t2... valid for `expiresIn` seconds; `api` answers the rest.
function harness({ expiresIn = 3600, api = () => json({ ok: true }) } = {}) {
  const state = { time: 1_000_000, tokens: 0, calls: [], sleeps: [] };
  const fetch = async (url, init = {}) => {
    state.calls.push({ url, ...init });
    if (url === TOKEN_URL) {
      state.tokens += 1;
      return json({ access_token: `t${state.tokens}`, expires_in: expiresIn, token_type: 'Bearer' });
    }
    return api(url, init, state);
  };
  const google = createGoogle({ fetch, now: () => state.time });
  return { google, state, api: () => state.calls.filter((c) => c.url !== TOKEN_URL) };
}

test('request: the metadata server\'s token as a bearer, JSON in and out', async () => {
  const { google, state, api } = harness({ api: () => json({ name: 'x' }) });
  assert.deepEqual(await google.request('POST', 'https://compute.googleapis.com/a', { b: 1 }), { name: 'x' });
  assert.equal(state.calls[0].url, TOKEN_URL);
  assert.equal(state.calls[0].headers['metadata-flavor'], 'Google');
  const [call] = api();
  assert.equal(call.method, 'POST');
  assert.equal(call.headers.authorization, 'Bearer t1');
  assert.equal(call.headers['content-type'], 'application/json');
  assert.equal(call.body, '{"b":1}');
});

test('request: no body, no content type; an empty answer is {}', async () => {
  const { google, api } = harness({ api: () => new Response('', { status: 200 }) });
  assert.deepEqual(await google.request('GET', 'https://x/y'), {});
  assert.equal(api()[0].body, undefined);
  assert.equal(api()[0].headers['content-type'], undefined);
});

test('the token is cached until 60 s before it expires', async () => {
  const { google, state } = harness({ expiresIn: 3600 });
  await google.request('GET', 'https://x/1');
  state.time += (3600 - 61) * 1000;
  await google.request('GET', 'https://x/2');
  assert.equal(state.tokens, 1);
  state.time += 2000;
  await google.request('GET', 'https://x/3');
  assert.equal(state.tokens, 2);
});

test('concurrent requests share one token call', async () => {
  const { google, state } = harness();
  await Promise.all([google.request('GET', 'https://x/1'), google.request('GET', 'https://x/2')]);
  assert.equal(state.tokens, 1);
});

test('a 401 drops the token and sends the request once more', async () => {
  let n = 0;
  const { google, state, api } = harness({ api: () => (++n === 1 ? json({ error: { code: 401, message: 'expired', status: 'UNAUTHENTICATED' } }, 401) : json({ ok: 1 })) });
  assert.deepEqual(await google.request('GET', 'https://x/1'), { ok: 1 });
  assert.equal(state.tokens, 2);
  assert.deepEqual(api().map((c) => c.headers.authorization), ['Bearer t1', 'Bearer t2']);
});

test('errors carry the code, the status and the reason', async () => {
  const error = { code: 403, message: 'Required \'compute.urlMaps.get\' permission', status: 'PERMISSION_DENIED', errors: [{ reason: 'forbidden', message: 'm' }] };
  const { google } = harness({ api: () => json({ error }, 403) });
  await assert.rejects(google.request('GET', 'https://x/1'), (e) => {
    assert.ok(e instanceof GoogleError);
    assert.equal(e.code, 403);
    assert.equal(e.status, 'PERMISSION_DENIED');
    assert.equal(e.reason, 'forbidden');
    assert.match(e.message, /GET https:\/\/x\/1.*compute\.urlMaps\.get/);
    return true;
  });
});

test('errors: the reason from the details when the errors list has none; a non-JSON body is kept', async () => {
  const error = { code: 429, message: 'quota', status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'RATE_LIMIT_EXCEEDED' }] };
  const { google } = harness({ api: () => json({ error }, 429) });
  await assert.rejects(google.request('GET', 'https://x/1'), { code: 429, reason: 'RATE_LIMIT_EXCEEDED' });
  const html = harness({ api: () => new Response('<html>bad gateway</html>', { status: 502 }) });
  await assert.rejects(html.google.request('GET', 'https://x/1'), (e) => e.code === 502 && /bad gateway/.test(e.message));
});

test('a token the metadata server refuses is an error', async () => {
  const google = createGoogle({ fetch: async () => new Response('no', { status: 404 }), now: () => 0 });
  await assert.rejects(google.request('GET', 'https://x/1'), /metadata server.*404/);
});

test('waitCompute: waits through the operation\'s wait until it is done', async () => {
  const waits = [];
  const { google } = harness({
    api: (url, init) => {
      waits.push(`${init.method} ${url}`);
      return json({ name: 'op', selfLink: 'https://compute.googleapis.com/compute/v1/projects/p/global/operations/op', status: waits.length < 2 ? 'RUNNING' : 'DONE' });
    },
  });
  const op = { name: 'op', selfLink: 'https://compute.googleapis.com/compute/v1/projects/p/global/operations/op', status: 'RUNNING' };
  const done = await google.waitCompute(op, 1_000_000 + 60_000);
  assert.equal(done.status, 'DONE');
  assert.deepEqual(waits, Array(2).fill('POST https://compute.googleapis.com/compute/v1/projects/p/global/operations/op/wait'));
});

test('waitCompute: an operation already done is not waited for; its error is thrown', async () => {
  const { google, api } = harness();
  assert.equal((await google.waitCompute({ status: 'DONE', selfLink: 's' }, 2_000_000)).status, 'DONE');
  assert.equal(api().length, 0);
  const failed = { status: 'DONE', selfLink: 's', operationType: 'insert', httpErrorStatusCode: 409, error: { errors: [{ code: 'RESOURCE_ALREADY_EXISTS', message: 'exists' }] } };
  await assert.rejects(google.waitCompute(failed, 2_000_000), { code: 409, reason: 'RESOURCE_ALREADY_EXISTS' });
});

test('waitCompute: past the deadline it gives up', async () => {
  const { google, state } = harness({
    api: (url, init, s) => { s.time += 40_000; return json({ status: 'RUNNING', selfLink: 's', name: 'op' }); },
  });
  await assert.rejects(google.waitCompute({ status: 'RUNNING', selfLink: 's', name: 'op' }, state.time + 60_000), /not done/);
});

test('waitCompute: giving up says the operation is not done, not that it failed', async () => {
  const { google, state } = harness({ api: (url, init, s) => { s.time += 40_000; return json({ status: 'RUNNING', selfLink: 's', name: 'op' }); } });
  await assert.rejects(google.waitCompute({ status: 'RUNNING', selfLink: 's', name: 'op' }, state.time + 60_000), { reason: 'OPERATION_NOT_DONE' });
});
