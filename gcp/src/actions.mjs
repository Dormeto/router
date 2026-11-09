// The manager's calls (vision docs/specs/2026-11-09-google-cloud-manager-design.md, section 5.1): `POST /v1/actions` takes the AWS
// controller's payload, `{ action, …, refusals? }`, and answers in the AWS controller's shapes (lambda/src/lib/controller-core.mjs), each
// action by the code behind the REST routes, which stay for the CLI. The manager's seam changes only its transport.
//
// `refusals: true` (the manager's synchronous calls) turns a refusal into AWS's answer, `{ refused: { code, message } }` (vision
// refusals design §1), its status read as AWS's code: 400 invalid, 404 not_found, 409 conflict. Without it, the REST routes' error and
// status, `{ error, reason, problems? }`. The problems AWS answers as `{ problems }` (settings, the waiting page, a schedule) are answers
// either way. An action the router does not serve is a 400 `{ error: 'unknown-action' }` either way: the wake, nap, release, check and
// list refresh of AWS's own invocations among them, as the router's own work goes through /v1/tasks.
//
// The manager's wake, nap and pause say who asked (`by`) and, as AWS's, the cause `manager`, in their events. What AWS's status reads
// live and the Google Cloud router does not (CloudWatch's last request, the load balancer's rules and targets, the backends' status,
// the instances' hibernation) keeps its key, empty, as routerInfo keeps the Lambda figures. AWS's onboarder's three (`preview`,
// `onboard`, `offboard`) answer in its shapes (lambda/src/lib/onboarding.mjs), the Google Cloud resources for its target groups and
// steps for what the Google Cloud onboarding changed, the REST answers' fields beside them; the REST routes keep their own answers for
// the CLI. Two actions are Google Cloud's, the manager's poll: `events`, the journal (§5.3), and `manager-settings`, the organization's
// level (§5.5).
import { k8sId } from '../../lambda/src/lib/kubernetes.mjs';
import { describeStoredLists } from '../../lambda/src/lib/list-cache.mjs';
import { maintenanceDue } from '../../lambda/src/lib/schedule.mjs';
import { STATES } from '../../lambda/src/lib/state.mjs';
import { STATS_DAYS } from '../../lambda/src/lib/summary.mjs';
import { CHECK_SCHEDULE, PauseRefused } from './controller-core.mjs';
import { isPods } from './gke.mjs';
import { Refusal } from './onboarding.mjs';
import { organizationOf } from './organization.mjs';
import { CUSTOM_PAGES_REFUSED } from './pages.mjs';
import { rowOf } from './rows.mjs';

// A refusal's status as AWS's code (lambda/src/lib/refusal.mjs).
const CODES = { 400: 'invalid', 404: 'not_found', 409: 'conflict' };
const UNKNOWN_ACTION = 'unknown-action';
// A page of the journal (§5.3), and an event's id: `<stateAt, 13 digits>-<workloadId>-<state>`.
const EVENTS_MAX = 500;
const EVENT_ID = /^\d{13}-[a-z0-9-]+-[A-Z]+$/;
const ETAG_MAX = 256;
const WAKEABLE = [STATES.ASLEEP, STATES.FAILED, STATES.NAPPING];
const EXCLUSIONS_REFUSED = 'exclusions don\'t reach Google Cloud routers yet';

const iso = (ms) => new Date(ms).toISOString();
const isoOrNull = (ms) => (typeof ms === 'number' && ms > 0 ? iso(ms) : null);
const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const invalid = (message) => new Refusal(400, 'bad-request', message);

// A stored pause as AWS shows it (controller-core.mjs's shownPauses), its scope the workload's or the router's.
const pauseOf = ({ workloadId, by, at, reason, until, keepAsleep }) => ({
  scope: workloadId === null ? 'router' : 'workload', by, at: iso(at), reason, until: until === undefined ? null : iso(until), keepAsleep: keepAsleep === true,
});
// One as the controller shows it, which names the router's scope only.
const scoped = (pause) => ({ scope: pause.scope ?? 'workload', ...pause });
// The workload's own first, then the router's; the newest first within each.
const RANK = { workload: 0, router: 1 };
const inOrder = (pauses) => pauses.sort((a, b) => RANK[a.scope] - RANK[b.scope] || b.at.localeCompare(a.at));
// A pause in AWS's words, as its request-nap answers it (controller-core.mjs's pauseText).
const pauseText = (p) => `${p.scope === 'router' ? 'router ' : ''}paused by ${p.by}: ${p.reason}`;

// A backend as AWS's status names it (status.mjs): AWS's kind, the Google Cloud location. Its status is not read here.
function backendOf(backend) {
  switch (backend.kind) {
    case 'vm': return { kind: 'instance', id: backend.name, status: null, location: backend.location };
    case 'mig': return { kind: 'asg', id: backend.name, status: null, location: backend.location };
    case 'k8s': {
      const cluster = `${backend.cluster.location}/${backend.cluster.name}`;
      return { kind: 'k8s', id: k8sId({ cluster, namespace: backend.namespace, owner: backend.owner }), status: null, cluster, namespace: backend.namespace, owner: backend.owner };
    }
    case 'cloudsql': return { kind: 'cloudsql-instance', id: backend.name, status: null, companion: true };
    default: return { kind: backend.kind, id: backend.name ?? null, status: null };
  }
}

// AWS's hibernation view (controller-core.mjs's hibernationView) from the REST one: the manager's level as AWS's status gives it, and
// no instance read.
const hibernationOf = (hibernation, manager) => ({ ...hibernation, manager, instances: null, freshBoot: false });

// AWS's schedule view (controller-core.mjs's scheduleView) from the REST one: `next` for its next events, and the maximum nap's wake
// while asleep. No hibernation limit wakes a workload here: Compute Engine itself stops a VM suspended for 60 days.
function scheduleAnswer({ schedule, nextEvents, joinMinutes, joinFrom, joinInherited }, run) {
  const due = schedule && run?.state === STATES.ASLEEP ? maintenanceDue(schedule, run.stateAt) : null;
  return { schedule, next: nextEvents, maintenanceDue: due === null ? null : iso(due), joinMinutes, joinFrom, joinInherited };
}

// router/check with its times as the manager reads every router's, ISO.
const checkOf = (check) => check && { ...check, checkedAt: iso(check.checkedAt), lastScheduledCheckAt: isoOrNull(check.lastScheduledCheckAt) };

// An onboarding in AWS's onboarder's words (`workloadId`, `databases`: here the Cloud SQL instances), with the Google Cloud resources
// it names, onboarded by the manager. GKE access and request logs stay with the CLI (§8): not taken here.
const onboardingOf = ({ workloadId, name, tags, settings, urlMap, backendService, loadBalancer, databases, fallbackInstanceTypes }) => ({
  urlMap, backendService, id: workloadId, name, tags, settings, loadBalancer, cloudSql: databases, fallbackInstanceTypes, source: 'manager',
});

// AWS's preview (lambda/src/lib/onboarding.mjs's preview, :392 and :451): the workload's id, name and tags; instead of the target
// groups and the load balancer, the Google Cloud resources (the URL map, the backend service, the waker's, `lb`); its backends and
// databases in AWS's entries (:442, :449), `tagged` unknown: the router cannot see the tags the CLI binds; `ok` and `problems`. The REST
// dry run's fields beside them. A dry run reads no route the onboarding adds: no `rules`.
const previewOf = ({ request, answer }) => ({
  ...request,
  ...answer,
  backends: [
    ...answer.vms.map((vm) => ({ kind: 'instance', id: vm.name, tagged: null, location: vm.zone })),
    ...answer.groups.map((group) => ({ kind: 'asg', id: group.name, tagged: null, location: group.location })),
  ],
  databases: answer.databases.map((database) => ({ kind: 'cloudsql-instance', id: database.name, tagged: null, ...database })),
  ok: answer.eligible,
  problems: answer.reasons,
});

// AWS answers a refused body's problems as `{ problems }`, an answer and not a refusal.
async function problemsAnswered(write) {
  try {
    return await write();
  } catch (err) {
    if (err instanceof Refusal && err.problems) return { problems: err.problems };
    throw err;
  }
}

// `controller`: controller-core.mjs's; `onboarding`: onboarding.mjs's; `router`: `{ name, version, build, project, region }`; `lists`:
// the router's IP lists (DMT_IP_LISTS). `act(payload)` answers `{ status, body }`.
export function createActions({ controller, onboarding, store, router, lists = [], now = Date.now, log }) {
  const expired = (p) => p.until !== undefined && p.until <= now();

  // The organization's level (router/manager): what the levels read, and the manager's as AWS's hibernation shows it, null while the
  // manager has pushed none. One that cannot be read counts as unset and is said, as the REST routes count it.
  async function organization() {
    try {
      const stored = await store.getManagerSettings();
      const { level, readAt, error } = organizationOf(stored ?? null);
      return { level, manager: stored ? { hibernate: level?.hibernate ?? null, readAt: readAt ? iso(readAt) : null, error } : null };
    } catch (err) {
      log.warn('SettingsLevelUnreadable', { level: 'organization', error: err.message });
      return { level: null, manager: { hibernate: null, readAt: null, error: err.message } };
    }
  }

  // The levels above the workloads, for their rows: the router's (one that cannot be read fails the answer, as the REST list's), the
  // organization's.
  async function levels() {
    const [routerLevel, above] = await Promise.all([store.getRouterSettings(), organization()]);
    return { router: routerLevel ?? null, organization: above.level, manager: above.manager };
  }

  const rowFor = (cfg, { run, stats, pauses, scheduled, above }) => rowOf({
    cfg, run, stats7d: stats, routerName: router.name, router: above.router, organization: above.organization, pauses, scheduled,
  });

  // AWS's list: the router, then a row per workload (rows.mjs), by id. The pauses are read once, as AWS's: unreadable, it is said in
  // `pausesError` and none is shown.
  async function list() {
    let pausesError;
    const [{ configs, schedules }, above, checked, pauses] = await Promise.all([
      store.listWorkloads(),
      levels(),
      store.getCheck().catch(() => null),
      store.listPauses().catch((err) => {
        pausesError = err.message;
        log.warn('PausesUnreadable', { error: err.message });
        return [];
      }),
    ]);
    const active = pauses.filter((p) => !expired(p));
    const workloads = await Promise.all(configs.map(async (cfg) => {
      const [run, stats] = await Promise.all([store.getRun(cfg.workloadId), store.getStats(cfg.workloadId, STATS_DAYS).catch(() => null)]);
      const shown = inOrder(active.filter((p) => p.workloadId === cfg.workloadId || p.workloadId === null).map(pauseOf));
      return rowFor(cfg, { run, stats, pauses: shown, scheduled: schedules.has(cfg.workloadId), above });
    }));
    return {
      router: {
        name: router.name,
        version: router.version ?? null,
        build: router.build ?? null,
        checkSchedule: CHECK_SCHEDULE,
        lastScheduledCheckAt: isoOrNull(checked?.lastScheduledCheckAt),
        pauses: inOrder(active.filter((p) => p.workloadId === null).map(pauseOf)),
        ...(pausesError ? { pausesError } : {}),
      },
      workloads: workloads.sort((a, b) => a.workloadId.localeCompare(b.workloadId)),
    };
  }

  // AWS's status (status.mjs, then the schedule's view): the REST Workload's fields, the row's, and AWS's status keys.
  async function status({ workloadId }) {
    const cfg = await onboarding.find(workloadId);
    const id = cfg.workloadId;
    const [shown, run, above, stats, pauses, view, ipLists] = await Promise.all([
      onboarding.show(id),
      store.getRun(id),
      levels(),
      store.getStats(id, STATS_DAYS).catch((err) => ({ error: err.message })),
      controller.pausesFor(id),
      onboarding.showSchedule(id),
      lists.length ? describeStoredLists(store, lists).catch((err) => [{ error: err.message }]) : [],
    ]);
    const row = rowFor(cfg, { run, stats: stats.error ? null : stats, pauses: pauses.map(scoped), scheduled: Boolean(view.schedule), above });
    return {
      ...shown,
      ...row,
      router: { version: router.version ?? 'unknown', build: router.build ?? 'unknown' },
      drift: [],
      fallbacks: row.fallbacks ?? [],
      holders: run?.holders ?? 0,
      lastRequestAt: null,
      nap: null,
      route: null,
      rules: [],
      issues: [],
      discovery: null,
      instances: [],
      hibernation: hibernationOf(shown.hibernation, above.manager),
      backends: cfg.backends.map(backendOf),
      ignoredTargets: [],
      recommendations: [],
      targets: [],
      settings: shown.settings,
      settingsFrom: shown.settingsFrom,
      type: shown.type,
      stats,
      ipLists,
      wakeMode: shown.settings.wakeMode,
      wakeRules: shown.wakeRules,
      noWakeRules: shown.noWakeRules,
      ...scheduleAnswer(view, run),
    };
  }

  // AWS's request-nap: refused at once with the reason when not awake or paused, else the nap's task, the manager's.
  async function requestNap({ workloadId, by }) {
    await onboarding.find(workloadId);
    const run = await store.getRun(workloadId);
    if (run?.state !== STATES.AWAKE) return { requested: false, reason: `not awake (${run?.state ?? 'UNKNOWN'})` };
    const [first] = await controller.pausesFor(workloadId);
    if (first) return { requested: false, reason: pauseText(first) };
    await controller.napNow(workloadId, { cause: 'manager', by });
    log.info('NapRequested', { workloadId, trigger: { kind: 'manager', by } });
    return { requested: true };
  }

  // AWS's force-wake: an asleep or failed workload's wake, a napping one's pending wake, else its state as it is.
  async function forceWake({ workloadId, by }) {
    await onboarding.find(workloadId);
    const run = await store.getRun(workloadId);
    if (WAKEABLE.includes(run?.state)) await controller.wakeNow(workloadId, 'manager', by);
    if (run?.state === STATES.NAPPING) return { state: STATES.NAPPING, pendingWake: true };
    if (WAKEABLE.includes(run?.state)) return { state: (await store.getRun(workloadId))?.state };
    return { state: run?.state };
  }

  // The manager's exclusions are AWS's workload pauses with an exclusionId (and the target group they matched), several per workload;
  // a Google Cloud router keeps one pause per workload and has none of them yet (plan 2): refused, so that an exclusion's pause cannot
  // replace an operator's, nor its lift remove it.
  const noExclusion = ({ exclusionId, targetGroupArn }) => {
    if (exclusionId != null || targetGroupArn != null) throw invalid(EXCLUSIONS_REFUSED);
  };

  // AWS's pause: the workload's, or without workloadId the router's (§5.6): `{ pause, woken }`.
  async function pause(payload) {
    noExclusion(payload);
    const workloadId = payload.workloadId ?? null;
    if (workloadId !== null) await onboarding.find(workloadId);
    const answer = workloadId === null ? await onboarding.pauseRouter(payload) : await controller.pause(workloadId, payload).catch((err) => {
      if (err instanceof PauseRefused) throw invalid(err.message);
      throw err;
    });
    return { ...answer, pause: scoped(answer.pause) };
  }

  // AWS's resume: whether there was the pause, the workload's or the router's.
  async function resume(payload) {
    noExclusion(payload);
    const { workloadId = null, by } = payload;
    if (workloadId === null) return onboarding.resumeRouter({ by });
    await onboarding.find(workloadId);
    return controller.resume(workloadId, by ?? 'unknown');
  }

  // AWS's settings action: without a workload the router's level, with one the workload's, its hibernation in AWS's shape.
  async function setSettings({ workloadId, settings, by }) {
    if (!isObject(settings)) return { problems: ['settings must be an object'] };
    return problemsAnswered(async () => {
      if (!workloadId) return onboarding.setRouterSettings({ ...settings, by });
      const answer = await onboarding.setSettings(workloadId, { ...settings, by });
      return { ...answer, hibernation: hibernationOf(answer.hibernation, (await organization()).manager) };
    });
  }

  // AWS's waiting-page action, its checks first. A custom page the install's switch keeps off is a conflict (§5.5: the manager
  // answers 409 with these words); the page's other problems, AWS's answer.
  async function waitingPage({ op, workloadId = null, page, by }) {
    if (workloadId !== null && (typeof workloadId !== 'string' || !workloadId)) throw invalid('workloadId must be the id of a workload');
    if (op === 'put' && (typeof by !== 'string' || !by)) throw invalid('a put needs by: who sets the page');
    const answer = await problemsAnswered(() => onboarding.waitingPage(workloadId === null ? 'router' : { workloadId }, { op, page, by }));
    if (answer.problems?.includes(CUSTOM_PAGES_REFUSED)) throw new Refusal(409, 'custom-pages-off', CUSTOM_PAGES_REFUSED);
    return answer;
  }

  // AWS's schedule action: the schedule stored with who set it, and AWS's view of it.
  async function setSchedule({ workloadId, schedule, by }) {
    const view = await problemsAnswered(() => onboarding.setSchedule(workloadId, isObject(schedule) ? { ...schedule, by } : schedule));
    if (view.problems) return view;
    return scheduleAnswer(view, await store.getRun(workloadId));
  }

  // AWS's offboard (:793): its steps, with the REST answer's fields (the VMs left on a fallback type, and a forced one's backends left).
  // What only the CLI undoes is refused with its command (design §8): the request logs the onboarding turned on (setting them back
  // needs compute.backendServices.update, which the manager's accounts don't hold) and a GKE workload's Kubernetes access (its RBAC
  // objects are the operator's). The REST route, the CLI's, offboards both.
  async function offboard({ workloadId, force }) {
    const cfg = await onboarding.find(workloadId);
    const why = cfg.backends.some(isPods) ? 'a GKE workload\'s Kubernetes access is the CLI\'s to remove'
      : cfg.requestLogs?.before ? 'its onboarding turned its backend service\'s request logs on, which the CLI sets back' : null;
    if (why) {
      const command = `dormeto gcp workloads offboard ${cfg.workloadId} --project ${router.project} --region ${router.region}`;
      throw new Refusal(409, 'cli-only', `cannot offboard ${cfg.workloadId} through the manager: ${why}: ${command}`);
    }
    const { answer, steps } = await onboarding.offboardWithSteps(cfg.workloadId, { force: force === true });
    return { steps, ...answer };
  }

  // The journal after `after` (null: from the oldest kept), `limit` at most (§5.3), with what the poll compares: the last check's
  // summary and the etag of the organization's settings the router holds.
  async function events({ after = null, limit }) {
    if (!Number.isInteger(limit) || limit < 1 || limit > EVENTS_MAX) throw invalid(`limit must be a whole number from 1 to ${EVENTS_MAX}`);
    if (after !== null && (typeof after !== 'string' || !EVENT_ID.test(after))) throw invalid('after must be the id of an event, or null');
    const [page, check, stored] = await Promise.all([store.listEvents({ after, limit }), store.getCheck(), store.getManagerSettings()]);
    return { ...page, check: checkOf(check), managerSettings: { etag: stored?.etag ?? null } };
  }

  // The manager's settings.json, pushed whole with its ETag (§5.5), the organization's level from the next read on. One that is not an
  // object is stored as pushed: the level reads it as unset and the health says so.
  async function pushManagerSettings({ settings, etag }) {
    if (settings === undefined) throw invalid('settings: the manager\'s settings.json is needed');
    if (typeof etag !== 'string' || !etag || etag.length > ETAG_MAX) throw invalid(`etag: the ETag of settings.json, a string of 1 to ${ETAG_MAX} characters`);
    await store.putManagerSettings({ settings, etag, at: now() });
    log.info('ManagerSettingsStored', { etag });
    return { etag };
  }

  const ACTIONS = {
    router: () => controller.routerInfo(),
    list,
    status,
    'request-nap': requestNap,
    'force-wake': forceWake,
    pause,
    resume,
    rename: ({ workloadId, name, by }) => onboarding.setName(workloadId, name, by),
    tag: ({ workloadId, tags, by }) => onboarding.setTags(workloadId, tags, by),
    settings: setSettings,
    'waiting-page': waitingPage,
    schedule: setSchedule,
    'clear-schedule': ({ workloadId, by }) => onboarding.deleteSchedule(workloadId, { by }),
    preview: async (payload) => previewOf(await onboarding.dryRunOf(onboardingOf(payload))),
    // AWS's onboard (:552): its steps, and the workload with the REST Workload's fields; the waker backend service for its target group.
    onboard: async (payload) => {
      const { workload, steps } = await onboarding.onboardWithSteps(onboardingOf(payload));
      return { steps, workload: { workloadId: workload.id, ...workload } };
    },
    offboard,
    events,
    'manager-settings': pushManagerSettings,
  };

  return async function act(payload) {
    const action = payload?.action;
    if (typeof action !== 'string' || !Object.hasOwn(ACTIONS, action)) {
      const message = `unknown action: ${action}`;
      log.info('Refused', { action: action ?? null, workloadId: payload?.workloadId ?? null, code: UNKNOWN_ACTION, message });
      return { status: 400, body: { error: UNKNOWN_ACTION, message } };
    }
    try {
      return { status: 200, body: await ACTIONS[action](payload) };
    } catch (err) {
      if (!(err instanceof Refusal)) throw err;
      if (payload.refusals !== true) return { status: err.status, body: { error: err.message, reason: err.reason, ...(err.problems ? { problems: err.problems } : {}) } };
      const code = CODES[err.status] ?? 'invalid';
      log.info('Refused', { action, workloadId: payload.workloadId ?? null, code, message: err.message });
      return { status: 200, body: { refused: { code, message: err.message } } };
    }
  };
}
