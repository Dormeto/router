// What a manager asks a router, both routers' (vision docs/specs/2026-11-12-cloud-duplication-design.md, §5; the research's R5, R6
// and R7), answered in AWS's shapes, which released managers read from AWS routers. AWS's controller dispatches these from its
// action handler (controller-core.mjs); Google Cloud's from POST /v1/actions (gcp/src/actions.mjs), and its REST routes call the same
// functions and turn their answers into the shapes CLI 0.11.0 reads (gcp/src/onboarding.mjs).
//
// The ports of createManagerActions, passed where each cloud creates it:
// - `store`: the cloud's store, under the names and contract both share: `getRun`, `putConfig(workloadId, cfg, { mustExist })`
//   (false once offboarded: a write never puts a workload back), `putSchedule`, `deleteSchedule`, `getRouterSettings`,
//   `putRouterSettings`, `putWaitingPage`, `deleteWaitingPage`;
// - `find(workloadId)`: the configuration, or the cloud's refusal of an unknown workload (and Google Cloud's of a bad id);
// - `refuse`: the cloud's refusals, `invalid(message)` and `notFound(workloadId)` (a write that found the workload offboarded);
// - `guard(write, { workloadId, cfg, settings, page, level })`: what only one cloud holds back, before a write (`name`, `tags`,
//   `settings`, `page`, `page delete`). It throws the cloud's refusal, or answers the problems said before the write's own, for the
//   writes that answer problems (settings, a page): AWS refuses to change a workload Terraform wrote, a waiting page it wrote too;
//   Google Cloud refuses a custom page while its install's switch is off;
// - `who(by)`: who wrote, as stored and said: AWS's as sent, Google Cloud's `unknown` when none is (B8 of the design, left);
// - `pausesFor(workloadId)` (pauses.mjs's), `napNow(workloadId, by)`: the cloud's nap of the manager's, in a request of its own;
// - `wake`: asked-wake.mjs's ports, `{ start, pending }`;
// - `tagged(workloadId, tags)`: after the tags are written;
// - `scheduleView(workloadId, schedule)`: the view a schedule action answers (scheduleView below, with the cloud's reads);
// - `settings`: `routerProblems(settings)`, `workloadProblems(settings, cfg)`, `next(cfg, settings)` (settings-writes.mjs's
//   withSettings, as the cloud reads an older configuration), `levels()` (read before the write: a failed read changes nothing) and
//   `answer(workloadId, next, levels)`, the written workload's `{ hibernation, resolved }`;
// - `pageView(workloadId, cfg)`: what a waiting-page action answers (page-settings.mjs's pageViewOf, as the cloud resolves it);
// - `now`, `log`.
import { createHash } from 'node:crypto';
import { askedWake } from './asked-wake.mjs';
import { checkName } from './names.mjs';
import { validatePage } from './page-settings.mjs';
import { pauseText } from './pauses.mjs';
import { nextEvents, normalizeSchedule, resolveJoin, scheduleProblems } from './schedule.mjs';
import { mergedRouterSettings, routerSettingsView, writtenRouterView } from './settings-writes.mjs';
import { STATES } from './state.mjs';
import { tagsProblem } from './tags.mjs';

const iso = (ms) => new Date(ms).toISOString();
const isoOrNull = (ms) => (ms ? iso(ms) : null);

// A schedule as people read it: the schedule (its `at` ISO; null when none), its next events, the maintenance wake due, and its
// joinMinutes as the levels resolve it, the value in force and its level, and what removing the workload's own would give. A
// schedule the router cannot read (a time zone the runtime refuses) is shown, with no next event, said in ScheduleSkipped (B3 of the
// design: AWS said none). `joins()`: the levels' `{ router, manager }`, read once the schedule is shown; `run`: the run read, or its
// read under way, for `dues(schedule, run, { readable })`, the maintenance wake's time (ms) or null: each cloud's, which shows none
// for a schedule the router cannot read, as its check applies none (Google Cloud's REST answer has none at all).
export async function scheduleView({ now, log, dues = () => null }, workloadId, schedule, { run, joins }) {
  const shown = schedule && { ...schedule, at: iso(schedule.at) };
  const levels = await joins();
  const join = resolveJoin({ workload: schedule?.joinMinutes, ...levels });
  const inherited = resolveJoin(levels);
  let next = [];
  let readable = true;
  try {
    next = nextEvents(schedule, now(), { joinMinutes: join.joinMinutes });
  } catch (err) {
    readable = false;
    log.warn('ScheduleSkipped', { workloadId, error: err.message });
  }
  const due = dues(schedule, await run, { readable });
  return {
    schedule: shown, next, maintenanceDue: due === null ? null : iso(due),
    joinMinutes: join.joinMinutes, joinFrom: join.from, joinInherited: { joinMinutes: inherited.joinMinutes, joinFrom: inherited.from },
  };
}

// --- The list (R6): the pauses read once, each row's, and the router's line ---------------------------------------------

// The pauses as a list reads them, once: unreadable, none, the error said and answered.
export async function readPauses({ store, log }) {
  try {
    return { pauses: await store.listPauses() };
  } catch (err) {
    log.warn('PausesUnreadable', { error: err.message });
    return { pauses: [], pausesError: err.message };
  }
}

// The pauses in force as a router answer reads them (pauses.mjs's `expired`): unreadable, none and the error, which its health says.
export async function readActivePauses({ store, expired }) {
  try {
    return { pauses: (await store.listPauses()).filter((p) => !expired(p)) };
  } catch (err) {
    return { pauses: [], pausesError: err.message };
  }
}

// A row's pauses: its own (an exclusion's among them) and the router's.
export const rowPauses = (pauses, workloadId) => pauses.filter((p) => p.workloadId === workloadId || p.workloadId === null);

// The list's router: who it is, its check's schedule and the last scheduled check (ISO, or null), the router's pause as shown, and
// the pauses' read error when there is one.
export const listRouter = ({ name, version, build, checkSchedule, lastScheduledCheckAt, pauses, pausesError }) => ({
  name, version, build, checkSchedule, lastScheduledCheckAt, pauses, ...(pausesError ? { pausesError } : {}),
});

// --- The router (R5) ---------------------------------------------------------------------------------------------------

// The `router` action's answer. `settings`: the router level's record; `manager`: the organization's level as this router holds it
// (null: none read), `managerUrl` where it reads it; `routerPauses`: the router's pause as shown; `pauses`: every pause in force, for
// the paused workloads; `lastActivity`: the newest run update (ms, 0 for none); `health`: healthOf's, its problems said, and
// `figures`, what the health adds beside it.
export function routerAnswer({ router, settings, manager, managerUrl = null, configuration, routerPauses, pauses, configs, byState, lastActivity, health, figures }) {
  const { checkSchedule, lastScheduledCheckAt, lambda, queues, ipLists, concurrency, drift24h } = figures;
  return {
    router,
    settings: routerSettingsView(settings),
    managerSettings: {
      url: managerUrl, hibernate: manager?.hibernate ?? null, joinMinutes: manager?.joinMinutes ?? null,
      // The organization's defaults and types as this router holds them (settings at scale design §6), when there are some.
      ...(manager?.defaults ? { defaults: manager.defaults } : {}), ...(manager?.types ? { types: manager.types } : {}),
      readAt: manager?.readAt ? iso(manager.readAt) : null, error: manager?.error ?? null,
    },
    configuration,
    pauses: routerPauses,
    workloads: {
      total: configs.length,
      byState,
      paused: pauses.some((p) => p.workloadId === null) ? configs.length : configs.filter((cfg) => pauses.some((p) => p.workloadId === cfg.workloadId)).length,
      lastActivityAt: isoOrNull(lastActivity),
    },
    health: { ...health, checkSchedule, lastScheduledCheckAt: isoOrNull(lastScheduledCheckAt), lambda, queues, ipLists, concurrency, drift24h },
  };
}

// --- The actions (R7) --------------------------------------------------------------------------------------------------

export function createManagerActions({
  store, find, refuse, guard = async () => [], who = (by) => by, pausesFor, napNow, wake, tagged = () => {}, scheduleView: viewOf, settings, pageView, now, log,
}) {
  // request-nap: refused at once with the reason when the workload is not awake or is paused, else the cloud's nap, asked.
  async function requestNap({ workloadId, by }) {
    await find(workloadId);
    const run = await store.getRun(workloadId);
    if (run?.state !== STATES.AWAKE) return { requested: false, reason: `not awake (${run?.state ?? 'UNKNOWN'})` };
    const [first] = await pausesFor(workloadId);
    if (first) return { requested: false, reason: pauseText(first) };
    await napNow(workloadId, by);
    log.info('NapRequested', { workloadId, trigger: { kind: 'manager', by } });
    return { requested: true };
  }

  // force-wake: whatever the retry delay, an asleep or failed workload's wake, a napping one's pending wake, else its state.
  const forceWake = async ({ workloadId, by }) => (await askedWake({ find, store, ...wake }, workloadId, { kind: 'manager', by })).answer;

  // A configuration written whole, conditional on the workload still being there: a write racing an offboarding never puts it back.
  async function written(workloadId, cfg) {
    if (!(await store.putConfig(workloadId, cfg, { mustExist: true }))) throw refuse.notFound(workloadId);
  }

  // The name people see (design section 7).
  async function rename({ workloadId, name, by }) {
    const cfg = await find(workloadId);
    await guard('name', { workloadId, cfg });
    const checked = checkName(name);
    if (!checked.name) throw refuse.invalid('name: required');
    if (checked.problem) throw refuse.invalid(checked.problem);
    await written(workloadId, { ...cfg, name: checked.name });
    log.info('Renamed', { workloadId, name: checked.name, by });
    return { workloadId, name: checked.name };
  }

  // The workload's tags (tags design, section 3), replaced whole.
  async function tag({ workloadId, tags, by }) {
    const cfg = await find(workloadId);
    await guard('tags', { workloadId, cfg });
    const problem = tagsProblem(tags);
    if (problem) throw refuse.invalid(problem);
    await written(workloadId, { ...cfg, tags });
    tagged(workloadId, tags);
    log.info('Tagged', { workloadId, tags, by });
    return { workloadId, tags };
  }

  // A schedule (R12), stored beside the workload with who set it and when, applied by the check: its problems answered, nothing
  // written; else the schedule's view.
  async function setSchedule({ workloadId, schedule, by }) {
    await find(workloadId);
    const problems = scheduleProblems(schedule, { now: now() });
    if (problems.length) return { problems };
    const stored = { ...normalizeSchedule(schedule), by: who(by), at: now() };
    await store.putSchedule(workloadId, stored);
    log.info('Scheduled', { workloadId, by: stored.by });
    return viewOf(workloadId, stored);
  }

  // `{ cleared }`: whether there was one.
  async function clearSchedule({ workloadId, by }) {
    await find(workloadId);
    const cleared = await store.deleteSchedule(workloadId);
    log.info('ScheduleCleared', { workloadId, ...(by ? { by } : {}), cleared });
    return { cleared };
  }

  // The router's record (hibernation design §4, settings at scale design §8): hibernate, joinMinutes and the defaults of its
  // workloads, merged with what it holds (settings-writes.mjs), a key sent null removed; none left, no record. An empty body reads.
  // Its problems answered, nothing written; a record that cannot be read is not written over.
  async function setRouterSettings({ settings: sent, by }) {
    const problems = settings.routerProblems(sent);
    if (problems.length) return { problems };
    const stored = await store.getRouterSettings();
    if (!Object.keys(sent).length) return { level: 'router', settings: routerSettingsView(stored) };
    const record = mergedRouterSettings(stored, sent, { by: who(by), at: now() });
    await store.putRouterSettings(record);
    log.info('RouterSettings', { hibernate: record.hibernate, joinMinutes: record.joinMinutes, defaults: record.defaults ? Object.keys(record.defaults) : [], by: record.by });
    return { level: 'router', settings: writtenRouterView(record) };
  }

  // A workload's settings: hibernate (null removes it), the settings of the levels (null gives the key back to them), its rules (null:
  // none) and its type (null: inherited). Its problems answered, nothing written.
  async function setWorkloadSettings({ workloadId, settings: sent, by }) {
    const cfg = await find(workloadId);
    const problems = [...(await guard('settings', { workloadId, cfg, settings: sent })), ...settings.workloadProblems(sent, cfg)];
    if (problems.length) return { problems };
    const next = settings.next(cfg, sent);
    const levels = await settings.levels();
    await written(workloadId, next);
    log.info('WorkloadSettings', { workloadId, keys: Object.keys(sent), hibernate: next.hibernate ?? null, previous: cfg.hibernate ?? null, by: who(by) });
    return { level: 'workload', settings: { ...sent }, ...(await settings.answer(workloadId, next, levels)) };
  }

  // The settings action: without a workload the router's level, with one the workload's.
  const setSettings = (payload) => (payload.workloadId ? setWorkloadSettings(payload) : setRouterSettings(payload));

  // The waiting page (branded waiting page design §5, §11): `op` get, put or delete, of the router's level (no workloadId) or a
  // workload's, one document per level. A put needs who sets it, asked before the workload is looked up; its problems are answered,
  // nothing written. The log holds the size and the SHA-256 of a custom page, never the page.
  async function waitingPage({ op, workloadId = null, page, by }) {
    // Null or absent is the router's level; anything else must be a workload's id, never a falsy value read as the router's.
    if (workloadId !== null && (typeof workloadId !== 'string' || !workloadId)) throw refuse.invalid('workloadId must be the id of a workload');
    if (op === 'put' && (typeof by !== 'string' || !by)) throw refuse.invalid('a put needs by: who sets the page');
    const cfg = workloadId ? await find(workloadId) : null;
    const level = workloadId ? { workloadId } : 'router';
    const said = { level: workloadId ? 'workload' : 'router', workloadId };
    switch (op) {
      case 'get':
        break;
      case 'put': {
        const problems = [...(await guard('page', { workloadId, cfg, page, level })), ...validatePage(page)];
        if (problems.length) return { problems };
        await store.putWaitingPage(level, page, { by: who(by), at: now() });
        const custom = page.mode === 'custom';
        log.info('WaitingPageSet', {
          ...said, mode: page.mode, bytes: custom ? Buffer.byteLength(page.html) : undefined, sha256: custom ? createHash('sha256').update(page.html).digest('hex') : undefined, by: who(by),
        });
        break;
      }
      case 'delete': {
        await guard('page delete', { workloadId, cfg, level });
        const cleared = await store.deleteWaitingPage(level);
        log.info('WaitingPageCleared', { ...said, cleared, by: who(by) });
        break;
      }
      default:
        throw refuse.invalid(`unknown waiting-page op: ${op}`);
    }
    return pageView(workloadId, cfg);
  }

  return { requestNap, forceWake, rename, tag, setSchedule, clearSchedule, setSettings, setRouterSettings, setWorkloadSettings, waitingPage };
}
