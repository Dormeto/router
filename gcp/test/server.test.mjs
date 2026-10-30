import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { response } from '../../lambda/src/lib/http.mjs';
import { createLogger } from '../../lambda/src/lib/log.mjs';
import { silentLog } from '../../lambda/test/fakes.mjs';
import { serve, withSeverity } from '../src/server.mjs';

const SERVER = fileURLToPath(new URL('../src/server.mjs', import.meta.url));

// A server on a free port, closed at the end of the test.
async function serving(t, handler, log = silentLog) {
  const server = serve(handler, { port: 0, log });
  t.after(() => new Promise((resolve) => { server.close(resolve); }));
  await new Promise((resolve) => { server.once('listening', resolve); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('serve hands the request to the role and writes its answer, the body of a POST unread', async (t) => {
  const seen = [];
  const url = await serving(t, async ({ method, url: target, headers }) => {
    seen.push({ method, target, workload: headers['x-dormeto-workload'] });
    return response(503, { 'retry-after': '3', 'content-type': 'text/plain' }, 'waiting');
  });
  const res = await fetch(`${url}/_dormeto/wake?a=%2Fb`, { method: 'POST', headers: { 'x-dormeto-workload': 'demo' }, body: 'x'.repeat(100_000) });
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('retry-after'), '3');
  assert.equal(await res.text(), 'waiting');
  assert.deepEqual(seen, [{ method: 'POST', target: '/_dormeto/wake?a=%2Fb', workload: 'demo' }]);
});

test('serve: a handler that throws → 500, logged, with nothing of the error in the answer', async (t) => {
  const logged = [];
  const url = await serving(t, async () => { throw new Error('Google: secret detail'); }, { ...silentLog, error: (event, fields) => logged.push({ event, ...fields }) });
  const res = await fetch(`${url}/_dormeto/wake?token=abc`);
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: 'internal error', reason: 'see the logs' });
  assert.deepEqual(logged, [{ event: 'RequestFailed', method: 'GET', path: '/_dormeto/wake', error: 'Google: secret detail' }]);
});

// The real entry point in its own process: no Google call, a request without the workload's header stops at 400.
function start(t, env) {
  const child = spawn(process.execPath, [SERVER], { env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { child.kill('SIGKILL'); });
  let output = '';
  const listening = new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const line = output.split('\n').find((l) => l.includes('"Listening"'));
      if (line) resolve(JSON.parse(line));
    });
    child.on('exit', () => reject(new Error(`exited before listening: ${output}`)));
  });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => { child.on('exit', (code, signal) => resolve({ code, signal, output: () => output })); });
  return { child, listening, exited };
}

test('DMT_ROLE=waker on PORT: answers, and SIGTERM closes it with exit code 0', async (t) => {
  const { child, listening, exited } = start(t, { DMT_ROLE: 'waker', PORT: '0' });
  const { role, port } = await listening;
  assert.equal(role, 'waker');
  const res = await fetch(`http://127.0.0.1:${port}/_dormeto/waiting`);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).reason, 'x-dormeto-workload names no workload');
  child.kill('SIGTERM');
  const { code, signal } = await exited;
  assert.deepEqual({ code, signal }, { code: 0, signal: null });
  await assert.rejects(fetch(`http://127.0.0.1:${port}/_dormeto/waiting`));
});

test('DMT_ROLE=controller on PORT: its health answers the version built into the image, and SIGTERM closes it', async (t) => {
  const { version } = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  const { child, listening, exited } = start(t, { DMT_ROLE: 'controller', PORT: '0', DMT_PROJECT: 'p', DMT_REGION: 'europe-west1', DMT_VERSION: '9.9.9' });
  const { role, port, severity } = await listening;
  assert.equal(role, 'controller');
  assert.equal(severity, 'INFO');
  const res = await fetch(`http://127.0.0.1:${port}/v1/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { version, project: 'p', region: 'europe-west1' });
  child.kill('SIGTERM');
  const { code, signal } = await exited;
  assert.deepEqual({ code, signal }, { code: 0, signal: null });
});

test('withSeverity: Cloud Logging\'s severity on each line of a logger, its fields kept', () => {
  const lines = [];
  const log = withSeverity(createLogger({ out: (line) => lines.push(JSON.parse(line)) }));
  log.info('A', { workloadId: 'demo' });
  log.warn('B');
  log.error('C', { error: 'x' });
  assert.deepEqual(lines, [
    { level: 'info', event: 'A', severity: 'INFO', workloadId: 'demo' },
    { level: 'warn', event: 'B', severity: 'WARNING' },
    { level: 'error', event: 'C', severity: 'ERROR', error: 'x' },
  ]);
});

test('an unknown DMT_ROLE stops the process at once, naming the roles', async (t) => {
  for (const env of [{ DMT_ROLE: 'other' }, {}]) {
    const { exited, listening } = start(t, { ...env, PORT: '0' });
    listening.catch(() => {});
    const { code, output } = await exited;
    assert.equal(code, 1);
    assert.match(output(), /"UnknownRole"/);
    assert.match(output(), /"severity":"ERROR"/);
    assert.match(output(), /waker/);
  }
});
