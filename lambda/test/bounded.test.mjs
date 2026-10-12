import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

// Every AWS call of the router is bounded (2026-10-09: a scheduled check waited 15 minutes for an answer that never came,
// the SDK's default being no timeout, and its lease skipped the next three checks).
const AWS = new URL('../src/aws/', import.meta.url).pathname;

test('every SDK client of the router is created with a bounded request handler', async () => {
  const files = (await readdir(AWS)).filter((f) => f.endsWith('.mjs'));
  let clients = 0;
  for (const file of files) {
    const text = await readFile(`${AWS}${file}`, 'utf8');
    for (const [call] of text.matchAll(/new \w+Client\(\{[^\n]*\)/g)) {
      clients += 1;
      assert.match(call, /requestHandler: (BOUNDED|\{[^}]*\})/, `${file}: ${call}`);
      // An inline handler (EventBridge's tighter one) bounds the silence and throws, as BOUNDED does.
      const inline = /requestHandler: \{([^}]*)\}/.exec(call)?.[1];
      if (inline) for (const key of ['connectionTimeout', 'requestTimeout', 'socketTimeout', 'throwOnRequestTimeout: true']) assert.match(inline, new RegExp(key), `${file}: ${key}`);
    }
  }
  assert.equal(clients, 14, 'one client per AWS service the router calls');
});

test('the bound fails a silent connection in seconds, in every SDK version the Lambda runtime may bundle', async () => {
  const { BOUNDED } = await import('../src/aws/bounded.mjs');
  assert.ok(BOUNDED.connectionTimeout > 0 && BOUNDED.connectionTimeout <= 3_000);
  // socketTimeout: the silence that fails a request in every version; requestTimeout: the same in older versions, and
  // in recent ones only with throwOnRequestTimeout (a warning otherwise).
  assert.ok(BOUNDED.socketTimeout > 0 && BOUNDED.socketTimeout <= 10_000);
  assert.equal(BOUNDED.requestTimeout, BOUNDED.socketTimeout);
  assert.equal(BOUNDED.throwOnRequestTimeout, true);
});
