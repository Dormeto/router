import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

// The lib modules take AWS clients as ports and are tested with fakes: every call they make on a port must exist in its
// SDK adapter (lambda/src/aws/<port>.mjs), or the deployed Lambda fails while every test passes.
const SRC = new URL('../src/', import.meta.url).pathname;
const PORTS = ['elbv2', 'ec2', 'autoscaling', 'ecs', 'cloudwatch', 'tagging', 'appscaling', 'rds', 'dynamo', 'sqs', 'lambda', 'events'];

test('every call of the lib modules on an AWS port exists in its SDK adapter', async () => {
  const lib = (await Promise.all((await readdir(`${SRC}lib`)).filter((f) => f.endsWith('.mjs')).map((f) => readFile(`${SRC}lib/${f}`, 'utf8')))).join('\n');
  for (const port of PORTS) {
    const used = new Set([...lib.matchAll(new RegExp(`\\b${port}\\??\\.(\\w+)\\(`, 'g'))].map((m) => m[1]));
    const adapter = await readFile(`${SRC}aws/${port}.mjs`, 'utf8');
    for (const method of used) assert.match(adapter, new RegExp(`\\b${method}:`), `${port}.${method} is used by a lib module but missing from aws/${port}.mjs`);
  }
});
