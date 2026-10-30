// gcp/tools/probe.mjs (vision docs/specs/2026-10-30-google-cloud-coverage-design.md, section 10): one call as the
// service account of the Cloud Run job it runs in, the status and the body printed. No live call here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { main } from '../tools/probe.mjs';
import { createGoogle } from '../src/google.mjs';

const run = async (argv, answer = { status: 200, statusText: 'OK', body: '{"ok":true}' }) => {
  const calls = [];
  const lines = [];
  const errors = [];
  const code = await main(argv, {
    google: { token: async () => 'the-token' },
    fetch: async (url, init) => {
      calls.push({ url, ...init });
      return new Response(answer.body, { status: answer.status, statusText: answer.statusText });
    },
    out: (line) => lines.push(line),
    err: (line) => errors.push(line),
  });
  return { code, calls, lines, errors };
};

test('probe: the method and URL sent with the service account\'s token, the status and the body printed', async () => {
  const { code, calls, lines } = await run(['GET', 'https://dns.example.goog/apis/apps/v1/namespaces/default/deployments/x/scale']);
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url, 'https://dns.example.goog/apis/apps/v1/namespaces/default/deployments/x/scale');
  assert.equal(calls[0].headers.authorization, 'Bearer the-token');
  assert.equal(calls[0].body, undefined);
  assert.deepEqual(lines, ['200 OK', '{"ok":true}']);
});

test('probe: a JSON body is sent as JSON; a refusal prints its status and body and exits 1', async () => {
  const { code, calls, lines } = await run(['PUT', 'https://dns.example.goog/scale', '{"spec":{"replicas":0}}'],
    { status: 403, statusText: 'Forbidden', body: '{"message":"forbidden"}' });
  assert.equal(code, 1);
  assert.equal(calls[0].method, 'PUT');
  assert.equal(calls[0].body, '{"spec":{"replicas":0}}');
  assert.equal(calls[0].headers['content-type'], 'application/json');
  assert.deepEqual(lines, ['403 Forbidden', '{"message":"forbidden"}']);
});

test('probe: a bad method, URL or body is a usage error, nothing sent', async () => {
  for (const argv of [[], ['GET'], ['TRACE', 'https://x.example/'], ['GET', 'http://x.example/'], ['GET', 'nope'], ['POST', 'https://x.example/', '{bad'], ['GET', 'https://x.example/', '{}', 'extra']]) {
    const { code, calls, errors } = await run(argv);
    assert.equal(code, 2, argv.join(' '));
    assert.equal(calls.length, 0, argv.join(' '));
    assert.ok(errors.length > 0, argv.join(' '));
  }
});

test('probe: a failed call is an error line and exit 1', async () => {
  const errors = [];
  const code = await main(['GET', 'https://x.example/'], {
    google: { token: async () => 'the-token' },
    fetch: async () => { throw new TypeError('fetch failed'); },
    out: () => {},
    err: (line) => errors.push(line),
  });
  assert.equal(code, 1);
  assert.match(errors.join('\n'), /fetch failed/);
});

test('the Google door gives its token from the metadata server', async () => {
  const seen = [];
  const google = createGoogle({
    fetch: async (url, init) => {
      seen.push([url, init.headers]);
      return new Response(JSON.stringify({ access_token: 'abc', expires_in: 3600 }), { status: 200 });
    },
  });
  assert.equal(await google.token(), 'abc');
  assert.match(seen[0][0], /^http:\/\/metadata\.google\.internal\/computeMetadata\/v1\/instance\/service-accounts\/default\/token$/);
  assert.equal(seen[0][1]['metadata-flavor'], 'Google');
});

test('the image carries probe.mjs, and only that file of the tools', () => {
  const file = readFileSync(new URL('../Containerfile', import.meta.url), 'utf8');
  assert.match(file, /^COPY gcp\/tools\/probe\.mjs \.\/gcp\/tools\/probe\.mjs$/m);
  assert.doesNotMatch(file, /measure/);
});
