// What the AWS router answers the manager (lib/manager-actions.mjs and the controller around it), held to stored answers: each
// action's answer, or its refusal, as the manager reads it, compared as JSON text, so a key's order and a key absent or null count
// (vision docs/specs/2026-11-12-cloud-duplication-design.md, §2 rule 2). gcp/test/manager-actions-answers.test.mjs holds Google
// Cloud's. A change meant to change an answer rewrites the fixture: `DORMETO_FIXTURES=write node --test <this file>`, then read its diff.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createController } from '../src/lib/controller-core.mjs';
import { STATES } from '../src/lib/state.mjs';
import { fakeAppScaling, fakeAutoScaling, fakeClock, fakeCloudWatch, fakeEc2, fakeEcs, fakeElbv2, fakeStore, silentLog, testConfig } from './fakes.mjs';

const FIXTURE = new URL('./fixtures/manager-actions-answers.json', import.meta.url);
const WEEKEND = { timeZone: 'europe/paris', windows: [{ kind: 'nap', days: ['sat', 'sun'], start: '20:00', end: '08:00' }], maxNapDays: 7 };
const PAGE_HTML = '<!doctype html><p data-dormeto="status"></p>';

// The controller over the fakes, as controller.test.mjs's: `source: 'manager'` unless a Terraform workload is asked for.
function router({ run = { state: STATES.AWAKE, awakeSince: 1 }, cfg = testConfig({ source: 'manager' }) } = {}) {
  const clock = fakeClock();
  const store = fakeStore({ config: cfg, run, clock });
  let ids = 0;
  const handler = createController({
    organizationPage: { read: async () => null }, fetch: async () => { throw new Error('no network in tests'); }, faviconBudgetMs: 50,
    store, ec2: fakeEc2(cfg.instanceIds, { state: 'running' }), elbv2: fakeElbv2(cfg, { target: 'app', healthy: 1 }), cloudwatch: fakeCloudWatch([], []),
    autoscaling: fakeAutoScaling([]), ecs: fakeEcs([]), tagging: { async getResources() { return { ResourceTagMappingList: [] }; } }, appscaling: fakeAppScaling(),
    invokeSelf: async () => {}, now: clock.now, sleep: clock.sleep, newId: () => `wake-${++ids}`, log: silentLog,
    router: { name: 'dmt-dev', version: '0.40.0', build: 'b7', checkSchedule: 'cron(0/5 * * * ? *)' },
  });
  return { handler, store, clock };
}

async function answers() {
  const found = [];
  // An answer as the manager reads it; a refusal thrown (no `refusals`) as its code and message.
  const ask = async (label, r, event) => {
    try {
      found.push([label, await r.handler(event)]);
    } catch (err) {
      found.push([label, { thrown: { code: err.code ?? null, message: err.message } }]);
    }
  };
  const refusing = (event) => ({ ...event, refusals: true });

  const awake = router();
  await ask('list', awake, refusing({ action: 'list' }));
  await ask('router', awake, refusing({ action: 'router' }));
  await ask('status', awake, refusing({ action: 'status', workloadId: 'demo' }));
  await ask('status of an unknown workload', awake, refusing({ action: 'status', workloadId: 'nope' }));
  await ask('status of an unknown workload, thrown', awake, { action: 'status', workloadId: 'nope' });
  await ask('request-nap', awake, refusing({ action: 'request-nap', workloadId: 'demo', by: 'ann' }));
  await ask('rename', awake, refusing({ action: 'rename', workloadId: 'demo', name: '  Shop  ', by: 'ann' }));
  await ask('rename, empty', awake, refusing({ action: 'rename', workloadId: 'demo', name: '', by: 'ann' }));
  await ask('rename, too long', awake, refusing({ action: 'rename', workloadId: 'demo', name: 'x'.repeat(65), by: 'ann' }));
  await ask('rename of an unknown workload', awake, refusing({ action: 'rename', workloadId: 'nope', name: 'a', by: 'ann' }));
  await ask('tag', awake, refusing({ action: 'tag', workloadId: 'demo', tags: { team: 'a' }, by: 'ann' }));
  await ask('tag, reserved', awake, refusing({ action: 'tag', workloadId: 'demo', tags: { 'dormeto:x': 'y' }, by: 'ann' }));
  await ask('schedule', awake, refusing({ action: 'schedule', workloadId: 'demo', schedule: WEEKEND, by: 'ann' }));
  await ask('schedule, its own join and no by', awake, refusing({ action: 'schedule', workloadId: 'demo', schedule: { ...WEEKEND, joinMinutes: 30 } }));
  await ask('schedule, problems', awake, refusing({ action: 'schedule', workloadId: 'demo', schedule: { windows: [{ kind: 'nap', days: ['someday'], start: '20:00', end: '08:00' }] }, by: 'ann' }));
  await ask('schedule, not an object', awake, refusing({ action: 'schedule', workloadId: 'demo', schedule: 'weekends', by: 'ann' }));
  await ask('status, scheduled', awake, refusing({ action: 'status', workloadId: 'demo' }));
  await ask('clear-schedule', awake, refusing({ action: 'clear-schedule', workloadId: 'demo', by: 'ann' }));
  await ask('clear-schedule, none', awake, refusing({ action: 'clear-schedule', workloadId: 'demo' }));
  await ask('settings of the router', awake, refusing({ action: 'settings', settings: { joinMinutes: 10, defaults: { idleMinutes: 30 } }, by: 'adm' }));
  await ask('settings of the router, read', awake, refusing({ action: 'settings', settings: {} }));
  await ask('settings of the router, problems', awake, refusing({ action: 'settings', settings: { joinMinutes: 7 }, by: 'adm' }));
  await ask('settings of a workload', awake, refusing({ action: 'settings', workloadId: 'demo', settings: { idleMinutes: 45, hibernate: false }, by: 'ann' }));
  await ask('settings of a workload, problems', awake, refusing({ action: 'settings', workloadId: 'demo', settings: { idleMinutes: 1 }, by: 'ann' }));
  await ask('settings of a workload, not an object', awake, refusing({ action: 'settings', workloadId: 'demo', settings: 'idle', by: 'ann' }));
  await ask('settings of a workload, null', awake, refusing({ action: 'settings', workloadId: 'demo', settings: { idleMinutes: null, hibernate: null } }));
  await ask('settings of the router, cleared', awake, refusing({ action: 'settings', settings: { joinMinutes: null, defaults: null } }));
  await ask('waiting page of the router', awake, refusing({ action: 'waiting-page', op: 'get' }));
  await ask('waiting page of the router, put', awake, refusing({ action: 'waiting-page', op: 'put', page: { mode: 'template', title: 'Acme' }, by: 'adm' }));
  await ask('waiting page of a workload, put', awake, refusing({ action: 'waiting-page', op: 'put', workloadId: 'demo', page: { mode: 'template', description: 'Back soon.' }, by: 'ann' }));
  await ask('waiting page of a workload, custom', awake, refusing({ action: 'waiting-page', op: 'put', workloadId: 'demo', page: { mode: 'custom', html: PAGE_HTML }, by: 'ann' }));
  await ask('waiting page, problems', awake, refusing({ action: 'waiting-page', op: 'put', page: { mode: 'template', title: '' }, by: 'adm' }));
  await ask('waiting page, a put without by', awake, refusing({ action: 'waiting-page', op: 'put', page: { mode: 'template' } }));
  await ask('waiting page, an empty workload id', awake, refusing({ action: 'waiting-page', op: 'get', workloadId: '' }));
  await ask('waiting page, an unknown op', awake, refusing({ action: 'waiting-page', op: 'other' }));
  await ask('waiting page of a workload, delete', awake, refusing({ action: 'waiting-page', op: 'delete', workloadId: 'demo' }));
  await ask('force-wake, awake', awake, refusing({ action: 'force-wake', workloadId: 'demo', by: 'ann' }));

  for (const run of [{ state: STATES.ASLEEP, stateAt: Date.UTC(2026, 9, 1) }, { state: STATES.FAILED, failedAt: 1 }, { state: STATES.NAPPING }, { state: STATES.WAKING }, null]) {
    const r = router({ run });
    await ask(`force-wake, ${run?.state ?? 'no run'}`, r, refusing({ action: 'force-wake', workloadId: 'demo', by: 'ann' }));
    await ask(`request-nap, ${run?.state ?? 'no run'}`, r, refusing({ action: 'request-nap', workloadId: 'demo', by: 'ann' }));
  }

  // A schedule the router cannot read (B3), then one with nothing to show, asleep and hibernated.
  const asleep = router({ run: { state: STATES.ASLEEP, stateAt: Date.UTC(2026, 9, 1), hibernated: JSON.stringify({ ids: ['i-1'], at: Date.UTC(2026, 9, 1) }) } });
  asleep.store.state.schedules.demo = { timeZone: 'Nowhere/Land', windows: [{ kind: 'nap', days: ['mon'], start: '20:00', end: '07:00' }], maxNapDays: 3, joinMinutes: 30, by: 'me', at: asleep.clock.now() };
  await ask('status, a schedule it cannot read', asleep, refusing({ action: 'status', workloadId: 'demo' }));
  asleep.store.getSchedule = async () => JSON.parse('{not json');
  await ask('status, a schedule that does not parse', asleep, refusing({ action: 'status', workloadId: 'demo' }));

  const paused = router();
  await paused.handler({ action: 'pause', workloadId: 'demo', reason: 'deploy', by: 'ops' });
  await ask('request-nap, paused', paused, refusing({ action: 'request-nap', workloadId: 'demo', by: 'ann' }));
  await paused.handler({ action: 'pause', reason: 'freeze', by: 'adm', keepAsleep: true });
  await ask('list, paused', paused, refusing({ action: 'list' }));
  await ask('router, paused', paused, refusing({ action: 'router' }));
  paused.store.listPauses = async () => { throw new Error('throttled'); };
  await ask('list, pauses unreadable', paused, refusing({ action: 'list' }));
  await ask('router, pauses unreadable', paused, refusing({ action: 'router' }));

  const terraform = router({ cfg: testConfig() });
  await ask('rename, Terraform\'s', terraform, refusing({ action: 'rename', workloadId: 'demo', name: 'Shop', by: 'ann' }));
  await ask('tag, Terraform\'s', terraform, refusing({ action: 'tag', workloadId: 'demo', tags: {}, by: 'ann' }));
  await ask('settings, Terraform\'s', terraform, refusing({ action: 'settings', workloadId: 'demo', settings: { waitSeconds: 30, idleMinutes: 3 }, by: 'ann' }));
  await ask('waiting page put, Terraform\'s', terraform, refusing({ action: 'waiting-page', op: 'put', workloadId: 'demo', page: { mode: 'template', title: '' }, by: 'ann' }));
  await terraform.store.putWaitingPage({ workloadId: 'demo' }, { mode: 'template', title: 'TF' }, { by: null, at: 1 });
  await ask('waiting page delete, Terraform\'s page', terraform, refusing({ action: 'waiting-page', op: 'delete', workloadId: 'demo', by: 'ann' }));
  await terraform.store.putWaitingPage({ workloadId: 'demo' }, { mode: 'template', title: 'Old' }, { by: 'ann', at: 1 });
  await ask('waiting page delete, a page left', terraform, refusing({ action: 'waiting-page', op: 'delete', workloadId: 'demo', by: 'ann' }));
  await ask('schedule, Terraform\'s', terraform, refusing({ action: 'schedule', workloadId: 'demo', schedule: WEEKEND, by: 'ann' }));

  const racing = router();
  racing.store.putConfig = async () => false;
  await ask('rename racing an offboarding', racing, refusing({ action: 'rename', workloadId: 'demo', name: 'a', by: 'ann' }));
  await ask('settings racing an offboarding', racing, refusing({ action: 'settings', workloadId: 'demo', settings: { idleMinutes: 30 }, by: 'ann' }));

  // Pauses (lib/pauses.mjs): a workload's, an exclusion's and the router's, their refusals and resumes (B4, B5).
  const pausing = router({ run: { state: STATES.ASLEEP, stateAt: 1 } });
  await ask('pause of a workload, asleep', pausing, refusing({ action: 'pause', workloadId: 'demo', reason: 'deploy', until: pausing.clock.now() + 3_600_000, by: 'ops' }));
  await ask('pause, no reason', pausing, refusing({ action: 'pause', workloadId: 'demo', by: 'ops' }));
  await ask('pause, an until past', pausing, refusing({ action: 'pause', workloadId: 'demo', reason: 'r', until: 1, by: 'ops' }));
  await ask('pause of an unknown workload', pausing, refusing({ action: 'pause', workloadId: 'nope', reason: 'r', by: 'ops' }));
  await ask('pause of an exclusion, another target group', pausing, refusing({ action: 'pause', workloadId: 'demo', reason: 'excluded', exclusionId: 'x1', targetGroupArn: 'arn:aws:elasticloadbalancing:eu-west-1:1:targetgroup/other/1', by: 'mgr' }));
  await ask('pause of an exclusion', pausing, refusing({ action: 'pause', workloadId: 'demo', reason: 'excluded', exclusionId: 'x1', targetGroupArn: testConfig().appTargetGroupArn, by: 'mgr' }));
  await ask('pause of the router, keeping asleep', pausing, refusing({ action: 'pause', reason: 'freeze', keepAsleep: true, by: 'adm' }));
  await ask('status, paused', pausing, refusing({ action: 'status', workloadId: 'demo' }));
  await ask('resume of an exclusion', pausing, refusing({ action: 'resume', workloadId: 'demo', exclusionId: 'x1', by: 'mgr' }));
  await ask('resume of a workload', pausing, refusing({ action: 'resume', workloadId: 'demo', by: 'ops' }));
  await ask('resume of a workload, none left', pausing, refusing({ action: 'resume', workloadId: 'demo', by: 'ops' }));
  await ask('resume of the router', pausing, refusing({ action: 'resume', by: 'adm' }));
  await ask('resume of an unknown workload', pausing, refusing({ action: 'resume', workloadId: 'nope', by: 'ops' }));
  await ask('resume of an unknown workload\'s exclusion', pausing, refusing({ action: 'resume', workloadId: 'nope', exclusionId: 'x1', by: 'mgr' }));
  await ask('pause of the router, waking', pausing, refusing({ action: 'pause', reason: 'freeze', by: 'adm' }));
  // Google Cloud's journal: an action an AWS router does not serve.
  await ask('events', pausing, refusing({ action: 'events', after: null, limit: 10 }));
  await ask('events, thrown', pausing, { action: 'events', after: null, limit: 10 });
  return found;
}

// One key a line, each case under its label: a rewrite's diff names the key that changed.
const written = (found) => `${JSON.stringify(Object.fromEntries(found), null, 1)}\n`;

test('the AWS router answers the manager as its stored answers say, keys in order, absent and null as they are', async () => {
  const found = await answers();
  if (process.env.DORMETO_FIXTURES === 'write') writeFileSync(FIXTURE, written(found));
  const stored = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  assert.deepEqual(found.map(([label]) => label), Object.keys(stored));
  for (const [label, answer] of found) assert.equal(JSON.stringify(answer), JSON.stringify(stored[label]), label);
});
