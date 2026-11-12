// The contract of lib/manager-actions.mjs and lib/asked-wake.mjs on a cloud's store (vision
// docs/specs/2026-11-12-cloud-duplication-design.md, §2 rule 4): run on the DynamoDB store's fake by manager-actions-shared.test.mjs
// and on the Firestore store over its fake by gcp/test/manager-actions-shared.test.mjs. `setup({ run, now })` answers `{ store,
// offboard }`: the cloud's store holding the workload `demo` (its run as given, none when null), and `offboard()`, after which a write
// conditional on the workload finds it gone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { beginWake, pendingWake } from '../src/lib/asked-wake.mjs';
import { settingsProblems, workloadSettingsProblems } from '../src/lib/hibernation.mjs';
import { createManagerActions, readPauses, scheduleView } from '../src/lib/manager-actions.mjs';
import { shownPause } from '../src/lib/pauses.mjs';
import { withSettings } from '../src/lib/settings-writes.mjs';
import { STATES } from '../src/lib/state.mjs';

const START = Date.parse('2026-03-10T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const WEEKEND = { timeZone: 'europe/paris', windows: [{ kind: 'nap', days: ['sat', 'sun'], start: '20:00', end: '08:00' }], maxNapDays: 7 };
const PAGE_HTML = '<!doctype html><p data-dormeto="status"></p>';

export function managerActionsContract(cloud, setup) {
  // The actions on the cloud's store, its clock at START, its log kept, refusals that say their code, and ports that keep their calls:
  // the guard (none by default), who wrote (as sent by default), the pauses (`h.paused`), the nap, the wakes, the tags written, a
  // schedule's view (scheduleView with the join levels `h.joins`), the settings and the page's view.
  async function harness({ run = { state: STATES.AWAKE, awakeSince: START - 1000 }, guard, who } = {}) {
    let t = START;
    const now = () => t;
    const { store, offboard } = await setup({ run, now });
    const logs = [];
    const keep = (level) => (event, data) => { logs.push([event, data, level]); };
    const log = { info: keep('info'), warn: keep('warn'), error: keep('error') };
    const calls = [];
    const h = { store, calls, joins: { router: null, manager: null }, paused: [], before: null };
    const refuse = {
      invalid: (message) => Object.assign(new Error(message), { code: 'invalid' }),
      notFound: (workloadId) => Object.assign(new Error(`not configured: ${workloadId}`), { code: 'not_found' }),
    };
    // The configuration, then what a test does between the read and the write (an offboarding).
    const find = async (workloadId) => {
      const cfg = await store.getConfig(workloadId);
      if (!cfg) throw refuse.notFound(workloadId);
      await h.before?.();
      return cfg;
    };
    h.actions = createManagerActions({
      store, find, refuse, ...(guard ? { guard } : {}), ...(who ? { who } : {}),
      pausesFor: async (workloadId) => h.paused.filter((p) => p.workloadId === workloadId).map(shownPause),
      napNow: async (workloadId, by) => { calls.push(['nap', workloadId, by]); },
      wake: {
        start: async (workloadId, state, trigger) => {
          calls.push(['start', workloadId, state.state, trigger]);
          return h.started ?? { woke: true, answer: { state: STATES.WAKING } };
        },
        pending: async (workloadId, trigger) => {
          calls.push(['pending', workloadId, trigger]);
          return true;
        },
      },
      tagged: (workloadId, tags) => { calls.push(['tagged', workloadId, tags, logs.length]); },
      scheduleView: async (workloadId, schedule) => scheduleView({ now, log }, workloadId, schedule, { run: await store.getRun(workloadId), joins: () => h.joins }),
      settings: {
        routerProblems: settingsProblems,
        workloadProblems: (settings) => workloadSettingsProblems(settings),
        next: (cfg, settings) => withSettings(cfg, settings),
        levels: async () => {
          calls.push(['levels']);
          return { router: await store.getRouterSettings() };
        },
        answer: async (workloadId, next, levels) => ({ hibernation: next.hibernate ?? null, resolved: { router: levels.router?.joinMinutes ?? null } }),
      },
      pageView: async (workloadId, cfg) => ({ level: workloadId ?? 'router', own: (await store.getWaitingPage(workloadId ? { workloadId } : 'router'))?.page ?? null, configured: Boolean(cfg) }),
      now,
      log,
    });
    return Object.assign(h, { offboard, advance: (ms) => { t += ms; }, logged: (event) => logs.filter(([e]) => e === event).map(([, d]) => d), logs });
  }
  const named = (what) => `the manager's actions on ${cloud}: ${what}`;
  const refusedAs = (code, message) => (err) => err.code === code && (message === undefined || (message instanceof RegExp ? message.test(err.message) : err.message === message));

  test(named('request-nap: an awake workload\'s nap asked, with who asked, and said; not awake or paused, refused with the reason, nothing asked'), async () => {
    const h = await harness();
    assert.deepEqual(await h.actions.requestNap({ workloadId: 'demo', by: 'ann' }), { requested: true });
    assert.deepEqual(h.calls, [['nap', 'demo', 'ann']]);
    assert.deepEqual(h.logged('NapRequested'), [{ workloadId: 'demo', trigger: { kind: 'manager', by: 'ann' } }]);
    h.paused.push({ workloadId: 'demo', by: 'ops', at: START, reason: 'deploy', keepAsleep: false });
    assert.deepEqual(await h.actions.requestNap({ workloadId: 'demo', by: 'ann' }), { requested: false, reason: 'paused by ops: deploy' });
    const asleep = await harness({ run: { state: STATES.ASLEEP } });
    assert.deepEqual(await asleep.actions.requestNap({ workloadId: 'demo', by: 'ann' }), { requested: false, reason: 'not awake (ASLEEP)' });
    const none = await harness({ run: null });
    assert.deepEqual(await none.actions.requestNap({ workloadId: 'demo', by: 'ann' }), { requested: false, reason: 'not awake (UNKNOWN)' });
    await assert.rejects(h.actions.requestNap({ workloadId: 'nope', by: 'ann' }), refusedAs('not_found'));
    assert.deepEqual([h.calls.length, asleep.calls, none.calls], [1, [], []]);
  });

  test(named('force-wake: an asleep or failed workload\'s wake from the run read, a napping one\'s pending wake, any other state as it is'), async () => {
    for (const state of [STATES.ASLEEP, STATES.FAILED]) {
      const h = await harness({ run: { state } });
      assert.deepEqual(await h.actions.forceWake({ workloadId: 'demo', by: 'ann' }), { state: STATES.WAKING }, state);
      assert.deepEqual(h.calls, [['start', 'demo', state, { kind: 'manager', by: 'ann' }]], state);
      // A wake the cloud answers no state of: the run read again.
      h.started = { woke: false, answer: null };
      assert.deepEqual(await h.actions.forceWake({ workloadId: 'demo', by: 'ann' }), { state }, state);
    }
    const napping = await harness({ run: { state: STATES.NAPPING } });
    assert.deepEqual(await napping.actions.forceWake({ workloadId: 'demo' }), { state: STATES.NAPPING, pendingWake: true });
    assert.deepEqual(napping.calls, [['pending', 'demo', { kind: 'manager', by: undefined }]]);
    for (const state of [STATES.AWAKE, STATES.WAKING]) {
      const h = await harness({ run: { state } });
      assert.deepEqual(await h.actions.forceWake({ workloadId: 'demo', by: 'ann' }), { state }, state);
      assert.deepEqual(h.calls, [], state);
    }
    const none = await harness({ run: null });
    assert.deepEqual(await none.actions.forceWake({ workloadId: 'demo', by: 'ann' }), { state: undefined });
    await assert.rejects(none.actions.forceWake({ workloadId: 'nope' }), refusedAs('not_found'));
  });

  test(named('rename and tag: written whole, conditional on the workload, said, answered; a bad name or tag refused, a guard\'s refusal, nothing written'), async () => {
    const h = await harness();
    assert.deepEqual(await h.actions.rename({ workloadId: 'demo', name: '  Shop  ', by: 'ann' }), { workloadId: 'demo', name: 'Shop' });
    assert.deepEqual(await h.actions.tag({ workloadId: 'demo', tags: { team: 'a' }, by: 'ann' }), { workloadId: 'demo', tags: { team: 'a' } });
    const cfg = await h.store.getConfig('demo');
    assert.deepEqual([cfg.workloadId, cfg.name, cfg.tags], ['demo', 'Shop', { team: 'a' }]);
    assert.deepEqual([h.logged('Renamed'), h.logged('Tagged')], [[{ workloadId: 'demo', name: 'Shop', by: 'ann' }], [{ workloadId: 'demo', tags: { team: 'a' }, by: 'ann' }]]);
    // The cloud hears of the tags once written, before they are said.
    const tagged = h.calls.find(([what]) => what === 'tagged');
    assert.deepEqual(tagged.slice(0, 3), ['tagged', 'demo', { team: 'a' }]);
    assert.equal(h.logs[tagged[3]][0], 'Tagged');
    for (const [name, message] of [['', 'name: required'], ['   ', 'name: required'], [undefined, 'name: required'], ['x'.repeat(65), 'name: at most 64 characters'], ['a\u0007b', 'name: no control characters']]) {
      await assert.rejects(h.actions.rename({ workloadId: 'demo', name, by: 'ann' }), refusedAs('invalid', message), JSON.stringify(name));
    }
    await assert.rejects(h.actions.tag({ workloadId: 'demo', tags: { 'dormeto:x': 'y' } }), refusedAs('invalid', 'tag "dormeto:x": the dormeto: prefix is reserved'));
    await assert.rejects(h.actions.tag({ workloadId: 'demo', tags: 'a' }), refusedAs('invalid', 'tags: an object of key and value strings'));
    await assert.rejects(h.actions.rename({ workloadId: 'nope', name: 'a' }), refusedAs('not_found'));
    assert.deepEqual([(await h.store.getConfig('demo')).name, (await h.store.getConfig('demo')).tags], ['Shop', { team: 'a' }]);
    // The guard runs on the configuration read, before the name's checks.
    const asked = [];
    const held = await harness({ guard: async (write, details) => { asked.push([write, details]); throw Object.assign(new Error(`held: ${write}`), { code: 'conflict' }); } });
    await assert.rejects(held.actions.rename({ workloadId: 'demo', name: '' }), refusedAs('conflict', 'held: name'));
    await assert.rejects(held.actions.tag({ workloadId: 'demo', tags: 'bad' }), refusedAs('conflict', 'held: tags'));
    assert.deepEqual(asked.map(([write, { workloadId, cfg }]) => [write, workloadId, cfg.workloadId]), [['name', 'demo', 'demo'], ['tags', 'demo', 'demo']]);
    assert.deepEqual([held.logged('Renamed'), held.logged('Tagged'), held.calls], [[], [], []]);
  });

  test(named('rename, tag and settings racing an offboarding: refused not found, nothing written back, nothing said'), async () => {
    for (const [what, write, written, said] of [
      ['rename', (a) => a.rename({ workloadId: 'demo', name: 'Shop', by: 'ann' }), (cfg) => cfg?.name === 'Shop', 'Renamed'],
      ['tag', (a) => a.tag({ workloadId: 'demo', tags: { team: 'a' }, by: 'ann' }), (cfg) => cfg?.tags?.team === 'a', 'Tagged'],
      ['settings', (a) => a.setSettings({ workloadId: 'demo', settings: { idleMinutes: 30 }, by: 'ann' }), (cfg) => cfg?.idleMinutes === 30, 'WorkloadSettings'],
    ]) {
      const h = await harness();
      h.before = () => h.offboard();
      await assert.rejects(write(h.actions), refusedAs('not_found', 'not configured: demo'), what);
      assert.equal(written(await h.store.getConfig('demo')), false, what);
      assert.deepEqual([h.logged(said), h.calls.filter(([call]) => call === 'tagged')], [[], []], what);
    }
  });

  test(named('a schedule: refused with its problems, nothing stored; else stored as normalized with who set it and when, said, and its view answered'), async () => {
    const h = await harness({ run: { state: STATES.ASLEEP, stateAt: START - 1000 } });
    assert.deepEqual(await h.actions.setSchedule({ workloadId: 'demo', schedule: 'weekends', by: 'ann' }), { problems: ['schedule: an object'] });
    assert.deepEqual((await h.actions.setSchedule({ workloadId: 'demo', schedule: { windows: [] }, by: 'ann' })).problems, ['schedule: windows or maxNapDays required']);
    assert.equal(await h.store.getSchedule('demo'), null);
    await assert.rejects(h.actions.setSchedule({ workloadId: 'nope', schedule: WEEKEND }), refusedAs('not_found'));
    const answer = await h.actions.setSchedule({ workloadId: 'demo', schedule: { ...WEEKEND, by: 'someone else', at: 1 }, by: 'ann' });
    const stored = { timeZone: 'Europe/Paris', windows: WEEKEND.windows, maxNapDays: 7, by: 'ann', at: START };
    assert.deepEqual(await h.store.getSchedule('demo'), stored);
    assert.deepEqual(Object.keys(answer), ['schedule', 'next', 'maintenanceDue', 'joinMinutes', 'joinFrom', 'joinInherited']);
    assert.deepEqual(answer.schedule, { ...stored, at: iso(START) });
    assert.ok(answer.next.length > 0 && answer.next.every((event) => typeof event.at === 'string'));
    assert.deepEqual(h.logged('Scheduled'), [{ workloadId: 'demo', by: 'ann' }]);
    // Who set it as the cloud says it: without one, its own default.
    const unknown = await harness({ who: (by) => by ?? 'unknown' });
    await unknown.actions.setSchedule({ workloadId: 'demo', schedule: WEEKEND });
    assert.equal((await unknown.store.getSchedule('demo')).by, 'unknown');
    assert.deepEqual(unknown.logged('Scheduled'), [{ workloadId: 'demo', by: 'unknown' }]);
  });

  test(named('clear-schedule: whether there was one, said with who cleared it when one is named'), async () => {
    const h = await harness();
    await h.store.putSchedule('demo', { ...WEEKEND, by: 'ann', at: START });
    assert.deepEqual(await h.actions.clearSchedule({ workloadId: 'demo', by: 'ann' }), { cleared: true });
    assert.deepEqual(await h.actions.clearSchedule({ workloadId: 'demo' }), { cleared: false });
    assert.equal(await h.store.getSchedule('demo'), null);
    assert.deepEqual(h.logged('ScheduleCleared').map((fields) => Object.entries(fields)), [
      [['workloadId', 'demo'], ['by', 'ann'], ['cleared', true]], [['workloadId', 'demo'], ['cleared', false]],
    ]);
    await assert.rejects(h.actions.clearSchedule({ workloadId: 'nope' }), refusedAs('not_found'));
  });

  test(named('a schedule as read back: the stored one shown, its next events and join; one the runtime refuses shown with none, said (B3)'), async () => {
    const h = await harness();
    const stored = { ...WEEKEND, timeZone: 'Europe/Paris', joinMinutes: 30, by: 'ann', at: START };
    await h.store.putSchedule('demo', stored);
    const dues = [];
    const view = (schedule) => scheduleView({ now: () => START, log: { warn: (event, data) => h.logs.push([event, data]) }, dues: (...args) => { dues.push(args); return START + 1000; } }, 'demo', schedule, { run: { state: STATES.ASLEEP }, joins: () => ({ router: 60, manager: null }) });
    const read = await view(await h.store.getSchedule('demo'));
    assert.deepEqual([read.schedule, read.next.length > 0, read.maintenanceDue], [{ ...stored, at: iso(START) }, true, iso(START + 1000)]);
    assert.deepEqual([read.joinMinutes, read.joinFrom, read.joinInherited], [30, 'workload', { joinMinutes: 60, joinFrom: 'router' }]);
    await h.store.putSchedule('demo', { ...stored, timeZone: 'Nowhere/Land' });
    const unreadable = await view(await h.store.getSchedule('demo'));
    assert.deepEqual([unreadable.schedule.timeZone, unreadable.next, unreadable.joinFrom], ['Nowhere/Land', [], 'workload']);
    assert.deepEqual(h.logged('ScheduleSkipped').map((d) => d.workloadId), ['demo']);
    // The maintenance wake is the cloud's, told whether the schedule could be read.
    assert.deepEqual(dues.map(([, run, { readable }]) => [run.state, readable]), [[STATES.ASLEEP, true], [STATES.ASLEEP, false]]);
    const none = await view(null);
    assert.deepEqual([none.schedule, none.next, none.joinMinutes, none.joinFrom], [null, [], 60, 'router']);
  });

  test(named('the router\'s settings: refused with their problems, nothing written; an empty body reads; else merged with who set them, said'), async () => {
    const h = await harness();
    assert.deepEqual(await h.actions.setSettings({ settings: { joinMinutes: 7 }, by: 'adm' }), { problems: ['settings: joinMinutes: must be a whole number from 0 to 120, a multiple of 5, or null'] });
    assert.deepEqual(await h.actions.setSettings({ settings: 'x', by: 'adm' }), { problems: ['settings must be an object'] });
    assert.equal(await h.store.getRouterSettings(), null);
    const empty = { hibernate: null, joinMinutes: null, by: null, at: null };
    assert.deepEqual(await h.actions.setSettings({ settings: {}, by: 'adm' }), { level: 'router', settings: empty });
    const written = await h.actions.setSettings({ settings: { joinMinutes: 10, defaults: { idleMinutes: 30 } }, by: 'adm' });
    const settings = { hibernate: null, joinMinutes: 10, defaults: { idleMinutes: 30 }, by: 'adm', at: iso(START) };
    assert.deepEqual(written, { level: 'router', settings });
    assert.deepEqual(await h.actions.setSettings({ settings: {} }), { level: 'router', settings });
    h.advance(1000);
    assert.deepEqual((await h.actions.setSettings({ settings: { hibernate: false }, by: 'ops' })).settings, { ...settings, hibernate: false, by: 'ops', at: iso(START + 1000) });
    // None left: no record.
    assert.deepEqual(await h.actions.setRouterSettings({ settings: { hibernate: null, joinMinutes: null, defaults: null }, by: 'ops' }), { level: 'router', settings: empty });
    assert.equal(await h.store.getRouterSettings(), null);
    assert.deepEqual(h.logged('RouterSettings'), [
      { hibernate: null, joinMinutes: 10, defaults: ['idleMinutes'], by: 'adm' }, { hibernate: false, joinMinutes: 10, defaults: ['idleMinutes'], by: 'ops' },
      { hibernate: null, joinMinutes: null, defaults: [], by: 'ops' },
    ]);
  });

  test(named('a workload\'s settings: the guard\'s problems first, then the body\'s, nothing written; else the levels read before the write, said, answered'), async () => {
    const h = await harness();
    await h.store.putRouterSettings({ hibernate: null, joinMinutes: 20, defaults: null, by: 'adm', at: START });
    assert.deepEqual(await h.actions.setSettings({ workloadId: 'demo', settings: { idleMinutes: 1, joinMinutes: 10 }, by: 'ann' }), {
      problems: ['settings: idleMinutes: must be a whole number from 5 to 1440', 'settings: a workload\'s joinMinutes is on its schedule'],
    });
    const answer = await h.actions.setSettings({ workloadId: 'demo', settings: { idleMinutes: 45, hibernate: false }, by: 'ann' });
    assert.deepEqual(answer, { level: 'workload', settings: { idleMinutes: 45, hibernate: false }, hibernation: false, resolved: { router: 20 } });
    const cfg = await h.store.getConfig('demo');
    assert.deepEqual([cfg.idleMinutes, cfg.hibernate], [45, false]);
    assert.deepEqual(h.logged('WorkloadSettings'), [{ workloadId: 'demo', keys: ['idleMinutes', 'hibernate'], hibernate: false, previous: null, by: 'ann' }]);
    assert.deepEqual(h.calls, [['levels']]);
    await assert.rejects(h.actions.setSettings({ workloadId: 'nope', settings: { idleMinutes: 45 } }), refusedAs('not_found'));
    // A cloud's guard: its problems before the body's, its refusal before them.
    const guarded = await harness({ guard: async (write, { settings }) => (write === 'settings' ? [`held: ${Object.keys(settings)}`] : []), who: (by) => by ?? 'unknown' });
    assert.deepEqual(await guarded.actions.setSettings({ workloadId: 'demo', settings: { idleMinutes: 1 } }), { problems: ['held: idleMinutes', 'settings: idleMinutes: must be a whole number from 5 to 1440'] });
    assert.deepEqual(guarded.calls, []);
    const refused = await harness({ guard: async () => { throw Object.assign(new Error('held'), { code: 'conflict' }); } });
    await assert.rejects(refused.actions.setSettings({ workloadId: 'demo', settings: 'x' }), refusedAs('conflict', 'held'));
  });

  test(named('a waiting page: get, put and delete of the router\'s level or a workload\'s; a put needs who sets it, its problems answered, its log the size and hash'), async () => {
    const h = await harness();
    assert.deepEqual(await h.actions.waitingPage({ op: 'get' }), { level: 'router', own: null, configured: false });
    const page = { mode: 'template', title: 'Acme' };
    assert.deepEqual(await h.actions.waitingPage({ op: 'put', page, by: 'adm' }), { level: 'router', own: page, configured: false });
    assert.deepEqual((await h.store.getWaitingPage('router')).by, 'adm');
    const custom = { mode: 'custom', html: PAGE_HTML };
    assert.deepEqual(await h.actions.waitingPage({ op: 'put', workloadId: 'demo', page: custom, by: 'ann' }), { level: 'demo', own: custom, configured: true });
    assert.deepEqual(h.logged('WaitingPageSet').map((fields) => Object.entries(fields)), [
      [['level', 'router'], ['workloadId', null], ['mode', 'template'], ['bytes', undefined], ['sha256', undefined], ['by', 'adm']],
      [['level', 'workload'], ['workloadId', 'demo'], ['mode', 'custom'], ['bytes', Buffer.byteLength(PAGE_HTML)], ['sha256', createHash('sha256').update(PAGE_HTML).digest('hex')], ['by', 'ann']],
    ]);
    assert.deepEqual(await h.actions.waitingPage({ op: 'put', page: { mode: 'template', title: '' }, by: 'adm' }), { problems: ['title must be one line of text'] });
    assert.deepEqual((await h.store.getWaitingPage('router')).page, page);
    // Asked before the workload is read: who sets a page, and a workload's id that is one.
    for (const [payload, message] of [
      [{ op: 'put', workloadId: 'nope', page }, 'a put needs by: who sets the page'], [{ op: 'put', workloadId: 'nope', page, by: '' }, 'a put needs by: who sets the page'],
      [{ op: 'get', workloadId: '' }, 'workloadId must be the id of a workload'], [{ op: 'get', workloadId: 3 }, 'workloadId must be the id of a workload'],
      [{ op: 'other', workloadId: 'demo' }, 'unknown waiting-page op: other'],
    ]) await assert.rejects(h.actions.waitingPage(payload), refusedAs('invalid', message), JSON.stringify(payload));
    await assert.rejects(h.actions.waitingPage({ op: 'get', workloadId: 'nope' }), refusedAs('not_found'));
    assert.deepEqual(await h.actions.waitingPage({ op: 'delete', workloadId: 'demo' }), { level: 'demo', own: null, configured: true });
    assert.deepEqual(await h.actions.waitingPage({ op: 'delete', workloadId: 'demo', by: 'ann' }), { level: 'demo', own: null, configured: true });
    assert.deepEqual(h.logged('WaitingPageCleared').map((fields) => Object.entries(fields)), [
      [['level', 'workload'], ['workloadId', 'demo'], ['cleared', true], ['by', undefined]], [['level', 'workload'], ['workloadId', 'demo'], ['cleared', false], ['by', 'ann']],
    ]);
  });

  test(named('a waiting page\'s guard: its problems before the page\'s, its refusal before any write; a delete asked of it, with the level'), async () => {
    const asked = [];
    const h = await harness({
      who: (by) => by ?? 'unknown',
      guard: async (write, { workloadId, cfg, page, level }) => {
        asked.push([write, workloadId, Boolean(cfg), level]);
        if (write === 'page delete' && workloadId) throw Object.assign(new Error('held'), { code: 'conflict' });
        return write === 'page' && page?.mode === 'custom' ? ['custom pages are off'] : [];
      },
    });
    assert.deepEqual(await h.actions.waitingPage({ op: 'put', page: { mode: 'custom', html: '' }, by: 'adm' }), { problems: ['custom pages are off', 'html must be a page, not blank'] });
    assert.equal(await h.store.getWaitingPage('router'), null);
    await h.actions.waitingPage({ op: 'put', workloadId: 'demo', page: { mode: 'template' }, by: 'ann' });
    await assert.rejects(h.actions.waitingPage({ op: 'delete', workloadId: 'demo' }), refusedAs('conflict'));
    assert.deepEqual((await h.store.getWaitingPage({ workloadId: 'demo' })).page, { mode: 'template' });
    await h.actions.waitingPage({ op: 'delete' });
    assert.deepEqual(asked, [['page', null, false, 'router'], ['page', 'demo', true, { workloadId: 'demo' }], ['page delete', 'demo', true, { workloadId: 'demo' }], ['page delete', null, false, 'router']]);
    assert.deepEqual(h.logged('WaitingPageCleared'), [{ level: 'router', workloadId: null, cleared: false, by: 'unknown' }]);
  });

  test(named('the pauses a list reads: once, and none when they cannot be read, said and answered'), async () => {
    const h = await harness();
    h.store.listPauses = async () => { throw new Error('throttled'); };
    assert.deepEqual(await readPauses({ store: h.store, log: { warn: (event, data) => h.logs.push([event, data]) } }), { pauses: [], pausesError: 'throttled' });
    assert.deepEqual(h.logged('PausesUnreadable'), [{ error: 'throttled' }]);
  });

  test(named('a wake begun from the state read: WAKING with its id, its cause and who asked, said; none when the state changed'), async () => {
    for (const state of [STATES.ASLEEP, STATES.FAILED]) {
      const h = await harness({ run: { state, failedAt: START - 1, wakeCount: 2 } });
      const ports = { transition: (id, change) => h.store.transition(id, change), newId: () => 'w1', now: () => START, log: { info: (event, data) => h.logs.push([event, data]) } };
      assert.equal(await beginWake(ports, 'demo', state, { kind: 'manager', by: 'ann', set: { scheduleApplied: 'o1' } }), 'w1');
      const run = await h.store.getRun('demo');
      assert.deepEqual([run.state, run.wakeId, run.wakeStartedAt, run.wakeCount, run.failedAt, run.scheduleApplied], [STATES.WAKING, 'w1', START, 3, undefined, 'o1'], state);
      assert.deepEqual(h.logged('WakeRequested'), [{ workloadId: 'demo', wakeId: 'w1', trigger: { kind: 'manager', by: 'ann' } }], state);
      // The state read is no longer the run's: nothing written, nothing said.
      assert.equal(await beginWake(ports, 'demo', state, { kind: 'pause' }), null);
      assert.equal(h.logged('WakeRequested').length, 1);
    }
  });

  test(named('a pending wake: set only while napping and once a nap, said and counted once'), async () => {
    const h = await harness({ run: { state: STATES.NAPPING } });
    const counted = [];
    const ports = { store: h.store, count: async (id, counter) => { counted.push([id, counter]); }, log: { info: (event, data) => h.logs.push([event, data]) } };
    assert.equal(await pendingWake(ports, 'demo', { kind: 'pause', by: 'ops' }), true);
    assert.equal(await pendingWake(ports, 'demo', { kind: 'manager', by: 'ann' }), false);
    assert.equal((await h.store.getRun('demo')).pendingWake, true);
    assert.deepEqual([h.logged('PendingWake'), counted], [[{ workloadId: 'demo', trigger: { kind: 'pause', by: 'ops' } }], [['demo', 'wake:pause']]]);
    const awake = await harness();
    assert.equal(await pendingWake({ ...ports, store: awake.store }, 'demo', { kind: 'pause' }), false);
    assert.equal(counted.length, 1);
  });
}
