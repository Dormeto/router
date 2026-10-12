import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

// The lib modules take AWS clients as ports and are tested with fakes: every call they make on a port must exist in its
// SDK adapter (lambda/src/aws/<port>.mjs), or the deployed Lambda fails while every test passes.
const SRC = new URL('../src/', import.meta.url).pathname;
const PORTS = ['elbv2', 'ec2', 'autoscaling', 'ecs', 'cloudwatch', 'tagging', 'appscaling', 'rds', 'dynamo', 'sqs', 'lambda', 'events', 's3', 'eks'];

test('every call of the lib modules on an AWS port exists in its SDK adapter', async () => {
  const lib = (await Promise.all((await readdir(`${SRC}lib`)).filter((f) => f.endsWith('.mjs')).map((f) => readFile(`${SRC}lib/${f}`, 'utf8')))).join('\n');
  for (const port of PORTS) {
    const used = new Set([...lib.matchAll(new RegExp(`\\b${port}\\??\\.(\\w+)\\(`, 'g'))].map((m) => m[1]));
    const adapter = await readFile(`${SRC}aws/${port}.mjs`, 'utf8');
    for (const method of used) assert.match(adapter, new RegExp(`\\b${method}:`), `${port}.${method} is used by a lib module but missing from aws/${port}.mjs`);
  }
});

test('every call of the entry points on an AWS port exists in its SDK adapter too', async () => {
  const entries = (await Promise.all(['controller.mjs', 'waker.mjs', 'onboarder.mjs', 'lists.mjs'].map((f) => readFile(`${SRC}${f}`, 'utf8')))).join('\n');
  for (const port of PORTS) {
    const used = new Set([...entries.matchAll(new RegExp(`\\b${port}\\??\\.(\\w+)\\(`, 'g'))].map((m) => m[1]));
    const adapter = await readFile(`${SRC}aws/${port}.mjs`, 'utf8');
    for (const method of used) assert.match(adapter, new RegExp(`\\b${method}:`), `${port}.${method} is used by an entry point but missing from aws/${port}.mjs`);
  }
  // The controller queues its naps and the wakes of a router pause.
  assert.match(entries, /\bsqs\.sendMessage\(/);
});

test('the waker and the controller read the manager\'s lists when the router has a catalog (R6b)', async () => {
  for (const entry of ['controller.mjs', 'waker.mjs']) {
    const text = await readFile(`${SRC}${entry}`, 'utf8');
    assert.match(text, /process\.env\.DMT_IP_LISTS_CATALOG/, entry);
    assert.match(text, /createCatalog\(/, entry);
  }
  // The manager's list function (from the router bundle) publishes to its bucket.
  assert.match(await readFile(`${SRC}lists.mjs`, 'utf8'), /createListPublisher\(/);
  // A 304 is an answer, not an error: the S3 adapter turns it into { notModified: true }.
  assert.match(await readFile(`${SRC}aws/s3.mjs`, 'utf8'), /notModified: true/);
});

test('the ELB clients retry adaptively: they slow down under throttling instead of failing (scale design §6)', async () => {
  const adapter = await readFile(`${SRC}aws/elbv2.mjs`, 'utf8');
  assert.match(adapter, /new ElasticLoadBalancingV2Client\(\{[^}]*retryMode: 'adaptive'[^}]*maxAttempts: \d+/);
});

test('review: the waker loads the S3 client only when the router has a catalog (its cold start is on the path of a wake)', async () => {
  const waker = await readFile(`${SRC}waker.mjs`, 'utf8');
  assert.doesNotMatch(waker, /^import .* from '\.\/aws\/s3\.mjs';$/m);
  assert.match(waker, /import\('\.\/aws\/s3\.mjs'\)/);
});
