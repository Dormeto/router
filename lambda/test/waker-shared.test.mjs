// What both routers' wakers answer from lambda/src/lib/waker-core.mjs: AWS's (its createWaker) and Google Cloud's
// (gcp/src/waker.mjs, which renders its own page around the shared decision): the nap window, the waiting page's headers and
// its HTML answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PAGE_CSP, renderPage } from '../src/lib/page.mjs';
import { STATES } from '../src/lib/state.mjs';
import { napWindow, pageResponse, waitingHeaders } from '../src/lib/waker-core.mjs';

// Monday 2026-10-19 at 23:00 in Paris (CEST): inside the night window, which ends Tuesday at 07:00.
const NOW = Date.parse('2026-10-19T23:00:00+02:00');
const night = (more = {}) => ({ timeZone: 'Europe/Paris', windows: [{ kind: 'nap', days: ['mon'], start: '20:00', end: '07:00', ...more }], by: 'ops', at: NOW });
const UNTIL = { at: '2026-10-20T05:00:00.000Z', local: 'Tue 07:00', timeZone: 'Europe/Paris' };

function ports(schedule, { routerJoin = null } = {}) {
  const logs = [];
  const asked = [];
  // As createJoinLevelsCache's: `levels` reads the cache's own `records`, which Google Cloud's waker replaces by the request's.
  const levelsCache = {
    records: async (fields) => {
      asked.push(fields);
      return { router: routerJoin === null ? null : { joinMinutes: routerJoin }, manager: null };
    },
    async levels(fields) {
      const { router, manager } = await this.records(fields);
      return { router: router?.joinMinutes ?? null, manager: manager?.joinMinutes ?? null };
    },
  };
  const log = { info() {}, error() {}, warn: (event, fields) => logs.push({ event, ...fields }) };
  return { logs, asked, getSchedule: async () => schedule, levelsCache, now: () => NOW, log };
}

test('napWindow: asleep, napping or failed inside a nap window, its wake and its end; awake, outside one or without a schedule, none', async () => {
  assert.deepEqual(await napWindow(ports(night({ wake: 'header' })), 'demo', STATES.ASLEEP), { wake: 'header', until: UNTIL });
  assert.deepEqual(await napWindow(ports(night()), 'demo', STATES.NAPPING), { wake: 'never', until: UNTIL });
  assert.deepEqual(await napWindow(ports(night()), 'demo', STATES.FAILED), { wake: 'never', until: UNTIL });
  for (const state of [STATES.AWAKE, STATES.WAKING]) assert.equal(await napWindow(ports(night()), 'demo', state), null, state);
  assert.equal(await napWindow(ports(null), 'demo', STATES.ASLEEP), null);
  assert.equal(await napWindow({ ...ports(night()), now: () => NOW + 12 * 3_600_000 }, 'demo', STATES.ASLEEP), null, 'Tuesday 11:00, past the window');
});

test('napWindow: the windows join by the schedule\'s own joinMinutes, else by the levels above it, read through the cache as a method', async () => {
  const own = ports({ ...night(), joinMinutes: 0 });
  await napWindow(own, 'demo', STATES.ASLEEP);
  assert.deepEqual(own.asked, [], 'the schedule sets its own: no level read');
  const inherited = ports(night(), { routerJoin: 30 });
  assert.deepEqual(await napWindow(inherited, 'demo', STATES.ASLEEP), { wake: 'never', until: UNTIL });
  assert.deepEqual(inherited.asked, [{ workloadId: 'demo' }]);
});

test('napWindow: a schedule that cannot be read counts as none, said once as ScheduleSkipped', async () => {
  const failing = { ...ports(null), getSchedule: async () => { throw new Error('denied'); } };
  const { logs } = failing;
  assert.equal(await napWindow(failing, 'demo', STATES.ASLEEP), null);
  assert.deepEqual(logs, [{ event: 'ScheduleSkipped', workloadId: 'demo', error: 'denied' }]);
});

test('waitingHeaders: the poll, the state, the nap window\'s end, why the workload failed and when it retries, the wake\'s progress', () => {
  const retryAt = NOW + 60_000;
  assert.deepEqual(waitingHeaders({ state: STATES.WAKING, pollSeconds: 3, progress: { elapsedMs: 1200.4, typicalMs: 30_000 } }), {
    'cache-control': 'no-store', 'retry-after': '3', 'x-dormeto-state': 'WAKING', 'x-dormeto-wake-elapsed': '1200', 'x-dormeto-wake-typical': '30000',
  });
  assert.deepEqual(waitingHeaders({ state: STATES.FAILED, pollSeconds: 3, failed: { kind: 'capacity', retryAt } }), {
    'cache-control': 'no-store', 'retry-after': '3', 'x-dormeto-state': 'FAILED', 'x-dormeto-failure': 'capacity', 'x-dormeto-retry-at': new Date(retryAt).toISOString(),
  });
  assert.equal(waitingHeaders({ state: STATES.FAILED, pollSeconds: 3, failed: { kind: null, retryAt } })['x-dormeto-failure'], undefined, 'a failure of no known kind');
  assert.equal(waitingHeaders({ state: STATES.ASLEEP, pollSeconds: 3, napUntil: UNTIL })['x-dormeto-nap-until'], UNTIL.at);
  assert.equal(waitingHeaders({ state: STATES.ASLEEP, pollSeconds: 3, napUntil: { at: null, local: null, timeZone: 'UTC' } })['x-dormeto-nap-until'], 'unknown');
});

test('pageResponse: the page with the cloud\'s status code, in the visitor\'s language, with our policy unless the page is the customer\'s', () => {
  const view = { state: STATES.FAILED, pollSeconds: 3, failed: { kind: 'capacity', retryAt: NOW + 60_000 }, napUntil: null, progress: null };
  const headers = waitingHeaders(view);
  const res = pageResponse({ statusCode: 200, headers, ...view, at: NOW, language: 'fr', page: null, icon: null, probeUrl: '/_dormeto/wake', cloud: 'Google Cloud' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.multiValueHeaders, Object.fromEntries(Object.entries({
    ...headers, 'content-type': 'text/html; charset=utf-8', vary: 'accept-language', 'content-security-policy': PAGE_CSP,
  }).map(([name, value]) => [name, [value]])));
  assert.equal(res.body, renderPage({
    state: STATES.FAILED, pollSeconds: 3, failure: 'capacity', retryInMs: 60_000, napUntil: null, progress: null, language: 'fr', page: null, icon: null, probeUrl: '/_dormeto/wake', cloud: 'Google Cloud',
  }));
  const custom = pageResponse({ statusCode: 503, headers, ...view, at: NOW + 90_000, page: { mode: 'custom', html: '<html><body>Back soon</body></html>' } });
  assert.equal(custom.statusCode, 503);
  assert.equal(custom.multiValueHeaders['content-security-policy'], undefined, 'a custom page is the customer\'s');
  assert.match(custom.body, /Back soon/);
  assert.equal(custom.body, renderPage({ state: STATES.FAILED, pollSeconds: 3, failure: 'capacity', retryInMs: 0, napUntil: null, progress: null, page: { mode: 'custom', html: '<html><body>Back soon</body></html>' } }), 'past the retry time: 0');
});
