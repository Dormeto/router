// measure.mjs's commands run whole, on their context: Google's answers and the load balancer's from the test, the time
// virtual. Whoever waits is woken in time order, once everything that can run has run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../tools/measure-core.mjs';
import { runSql } from '../tools/measure.mjs';

function virtualTime() {
  let clock = 0;
  let waiting = [];
  const wait = (ms) => new Promise((resolve) => { waiting.push({ at: clock + ms, resolve }); });
  return {
    now: () => clock,
    wait,
    every: (fn, ms) => {
      let stopped = false;
      (async () => {
        for (;;) {
          await wait(ms);
          if (stopped) return;
          fn();
        }
      })();
      return () => { stopped = true; };
    },
    // Until the promise settles.
    async drive(promise) {
      let settled = false;
      const end = () => { settled = true; };
      promise.then(end, end);
      for (;;) {
        await new Promise((resolve) => { setImmediate(resolve); });
        if (settled) return promise;
        waiting.sort((a, b) => a.at - b.at);
        const next = waiting.shift();
        if (next) {
          clock = Math.max(clock, next.at);
          next.resolve();
        }
      }
    },
  };
}

// The context of a command line, and what it asked of Google in order: 'METHOD url'. `google(method, url, body, t)` answers.
function contextOf(argv, { google, answer = () => ({ kind: 'http 503' }) }) {
  const time = virtualTime();
  const { command, action, options } = parseArgs(argv);
  const lines = [];
  const asked = [];
  const ctx = {
    command,
    action,
    options,
    request: async (method, url, body) => {
      asked.push({ method, url, body, t: time.now() });
      return structuredClone(await google(method, url, body, time.now()));
    },
    at: time.now,
    log: (what, value, t = time.now()) => lines.push({ t, what, value }),
    wait: time.wait,
    every: time.every,
    probe: async () => answer(time.now()),
    interrupted: () => false,
  };
  return { ctx, lines, asked, time, said: (what) => lines.filter((l) => l.what === what).map((l) => l.value) };
}

const unexpected = (method, url) => { throw new Error(`unexpected ${method} ${url}`); };

// --- sql stop|start: the operation the PATCH returns ---------------------------------------------------------------------

const SQL = 'https://sqladmin.googleapis.com/v1/projects/dormeto-dev';
const INSTANCE = `${SQL}/instances/dmt-demo-sql`;
const OPERATION = `${SQL}/operations/op-1`;

// Cloud SQL's states as Google documents them: RUNNABLE is "running, or has been stopped by owner", SUSPENDED is for billing
// and the like. So a stop reads RUNNABLE from the start to the end, and its operation alone tells that it ended.
function sqlWorld({ from, to, doneAt = 40_000, operation = {}, readFails = () => false }) {
  let sentAt = null;
  const policy = () => (sentAt === null ? from : to);
  return (method, url, body, t) => {
    if (method === 'GET' && url === INSTANCE) {
      return { state: 'RUNNABLE', databaseVersion: 'POSTGRES_16', settings: { activationPolicy: policy(), tier: 'db-f1-micro', dataDiskType: 'PD_HDD', dataDiskSizeGb: '10' } };
    }
    if (method === 'PATCH' && url === INSTANCE) {
      assert.deepEqual(body, { settings: { activationPolicy: to } });
      sentAt = t;
      return { kind: 'sql#operation', name: 'op-1', operationType: 'UPDATE', status: 'PENDING' };
    }
    if (method === 'GET' && url === OPERATION) {
      if (readFails(t - sentAt)) throw new Error('Google: 503 unavailable');
      if (t - sentAt < doneAt) return { name: 'op-1', status: t - sentAt < 5000 ? 'PENDING' : 'RUNNING' };
      return { name: 'op-1', status: 'DONE', insertTime: '2026-11-02T10:00:00.000Z', endTime: '2026-11-02T10:00:38.500Z', ...operation };
    }
    return unexpected(method, url);
  };
}

test('sql stop: RUNNABLE all along, the operation\'s end is the time, and each sample prints the state, the policy and the operation', async () => {
  const { ctx, said, time } = contextOf(['sql', 'stop'], { google: sqlWorld({ from: 'ALWAYS', to: 'NEVER' }) });
  assert.equal(await time.drive(runSql(ctx)), 0);
  assert.deepEqual(said('state'), [
    'dmt-demo-sql RUNNABLE NEVER, operation PENDING',
    'dmt-demo-sql RUNNABLE NEVER, operation RUNNING',
    'dmt-demo-sql RUNNABLE NEVER, operation RUNNING',
    'dmt-demo-sql RUNNABLE NEVER, operation RUNNING',
    'dmt-demo-sql RUNNABLE NEVER, operation DONE',
  ]);
  assert.deepEqual(said('done'), ['+40.0s after the request; Google: 38.5 s from insertTime to endTime']);
  assert.deepEqual(said('policy'), ['NEVER, +0.0s after the request']);
});

test('sql start: the operation\'s end whichever state the instance reads', async () => {
  const { ctx, said, time } = contextOf(['sql', 'start'], { google: sqlWorld({ from: 'NEVER', to: 'ALWAYS', doneAt: 20_000 }) });
  assert.equal(await time.drive(runSql(ctx)), 0);
  assert.equal(said('state').at(-1), 'dmt-demo-sql RUNNABLE ALWAYS, operation DONE');
  assert.deepEqual(said('done'), ['+20.0s after the request; Google: 38.5 s from insertTime to endTime']);
});

test('sql: an operation that fails says Google\'s words and exits 1', async () => {
  const operation = { error: { kind: 'sql#operationErrors', errors: [{ code: 'INTERNAL_ERROR', message: 'an internal error' }] } };
  const { ctx, said, time } = contextOf(['sql', 'stop'], { google: sqlWorld({ from: 'ALWAYS', to: 'NEVER', operation }) });
  assert.equal(await time.drive(runSql(ctx)), 1);
  assert.deepEqual(said('done'), ['no: INTERNAL_ERROR: an internal error']);
});

test('sql: an operation not done in time exits 1, and an unread sample does not end it', async () => {
  const { ctx, said, time, lines } = contextOf(['sql', 'stop', '--timeout', '60'], {
    google: sqlWorld({ from: 'ALWAYS', to: 'NEVER', doneAt: 3_600_000, readFails: (ms) => ms >= 10_000 && ms < 20_000 }),
  });
  assert.equal(await time.drive(runSql(ctx)), 1);
  assert.deepEqual(said('done'), ['no: not within 60 s']);
  assert.equal(lines.filter((l) => l.what === 'error').length, 1);
  assert.ok(said('state').length > 3);
});

test('sql: the policy already set is refused before any change', async () => {
  const { ctx, asked, time } = contextOf(['sql', 'stop'], { google: sqlWorld({ from: 'NEVER', to: 'NEVER' }) });
  await assert.rejects(time.drive(runSql(ctx)), /has the activation policy NEVER already/);
  assert.deepEqual(asked.map((a) => a.method), ['GET']);
});
