// The manager's calls (vision docs/specs/2026-11-09-google-cloud-manager-design.md, section 5.1): `POST /v1/actions` takes the AWS
// controller's payload, `{ action, …, refusals? }`, and answers in the AWS controller's shapes (lambda/src/lib/controller-core.mjs), each
// action by the code behind the REST routes, which stay for the CLI. The manager's seam changes only its transport.
//
// `refusals: true` (the manager's synchronous calls) turns a refusal into AWS's answer, `{ refused: { code, message } }` (vision
// refusals design §1), its status read as AWS's code: 400 invalid, 404 not_found, 409 conflict. Without it, the REST routes' error and
// status, `{ error, reason, problems? }`. The problems AWS answers as `{ problems }` (settings, the waiting page, a schedule) are answers
// either way. An action the router does not serve is answered as AWS's controller does (`unsupported` with refusals, else a 400 with
// reason `unknown-action`): the wake, nap, release, check and list refresh of AWS's own invocations among them, as the router's own work
// goes through /v1/tasks.
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
import { listRouter, readPauses, rowPauses } from '../../lambda/src/lib/manager-actions.mjs';
import { maintenanceDue } from '../../lambda/src/lib/schedule.mjs';
import { STATES } from '../../lambda/src/lib/state.mjs';
import { STATS_DAYS } from '../../lambda/src/lib/summary.mjs';
import { CHECK_SCHEDULE, PauseRefused } from './controller-core.mjs';
import { isPods } from './gke.mjs';
import { Refusal } from './onboarding.mjs';
import { organizationOf } from './organization.mjs';
import { CUSTOM_PAGES_REFUSED } from './pages.mjs';
import { rowOf } from './rows.mjs';
import { isRegionalLb } from './switch.mjs';

// A refusal's status as AWS's code (lambda/src/lib/refusal.mjs).
const CODES = { 400: 'invalid', 404: 'not_found', 409: 'conflict' };
const UNKNOWN_ACTION = 'unknown-action';
// A page of the journal (§5.3), and an event's id: `<stateAt, 13 digits>-<workloadId>-<state>`.
const EVENTS_MAX = 500;
const EVENT_ID = /^\d{13}-[a-z0-9-]+-[A-Z]+$/;
const ETAG_MAX = 256;
const TARGET_GROUP_REFUSED = 'a Google Cloud router has no targetGroupArn: name the backendService';
const EXCLUSION_ID_MAX = 64;
// The manager's are UUIDs; part of a document id, so no character a URL or a path changes.
const EXCLUSION_ID = /^[A-Za-z0-9._-]+$/;
const BACKEND_SERVICE_PATH = /^projects\/([^/]+)\/(global|regions\/[^/]+)\/backendServices\/([^/]+)$/;

const iso = (ms) => new Date(ms).toISOString();
const isoOrNull = (ms) => (typeof ms === 'number' && ms > 0 ? iso(ms) : null);
const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const invalid = (message) => new Refusal(400, 'bad-request', message);

// The numeric id the onboarding stored, as a string: the manager removes the tag it bound on that id. An older onboarding stored none.
const resourceIdOf = ({ id }) => (id === undefined || id === null ? {} : { resourceId: String(id) });

// A backend as AWS's status names it (status.mjs): AWS's kind, the Google Cloud location. Its status is not read here.
function backendOf(backend) {
  switch (backend.kind) {
    case 'vm': return { kind: 'instance', id: backend.name, status: null, location: backend.location, ...resourceIdOf(backend) };
    case 'mig': return { kind: 'asg', id: backend.name, status: null, location: backend.location, ...resourceIdOf(backend) };
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

// A schedule's view (manager-actions.mjs's) with AWS's maintenance wake: the maximum nap's while asleep. No hibernation limit wakes a
// workload here: Compute Engine itself stops a VM suspended for 60 days.
function withMaintenance(view, run) {
  const due = view.schedule && run?.state === STATES.ASLEEP ? maintenanceDue(view.schedule, run.stateAt) : null;
  return { ...view, maintenanceDue: due === null ? null : iso(due) };
}

// router/check with its times as the manager reads every router's, ISO; null when its summary was never written (its cursor alone).
const checkOf = (check) => check && { ...check, checkedAt: isoOrNull(check.checkedAt), lastScheduledCheckAt: isoOrNull(check.lastScheduledCheckAt) };

// An onboarding in AWS's onboarder's words (`workloadId`, `databases`: here the Cloud SQL instances), with the Google Cloud resources
// it names, onboarded by the manager, by who asked (`unknown` when the payload names no one, as AWS's onboardedBy). The REST body's
// own names (`cloudSql`, the top-level `fallbackInstanceTypes`) are read too (onboarding.mjs's requested). GKE access and request logs
// stay with the CLI (§8): not taken here.
const onboardingOf = ({ workloadId, name, tags, settings, urlMap, backendService, loadBalancer, databases, cloudSql, fallbackInstanceTypes, by }) => ({
  urlMap, backendService, id: workloadId, name, tags, settings, loadBalancer, databases, cloudSql, fallbackInstanceTypes, source: 'manager', by: by ?? 'unknown',
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

// `controller`: controller-core.mjs's; `onboarding`: onboarding.mjs's; `router`: `{ name, version, build, project, region }`; `lists`:
// the router's IP lists (DMT_IP_LISTS). `act(payload)` answers `{ status, body }`.
export function createActions({ controller, onboarding, store, router, lists = [], now = Date.now, log }) {
  // The actions both routers share (lambda/src/lib/manager-actions.mjs), on this router's ports (onboarding.mjs's).
  const manager = onboarding?.manager;
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

  // AWS's list: the router, then a row per workload (rows.mjs), by id. The pauses are read once, as AWS's, and shown as the
  // controller's (lambda/src/lib/pauses.mjs): unreadable, it is said in `pausesError` and none is shown.
  async function list() {
    const [{ configs, schedules }, above, checked, { pauses, pausesError }] = await Promise.all([
      store.listWorkloads(),
      levels(),
      store.getCheck().catch(() => null),
      readPauses({ store, log }),
    ]);
    const workloads = await Promise.all(configs.map(async (cfg) => {
      const [run, stats] = await Promise.all([store.getRun(cfg.workloadId), store.getStats(cfg.workloadId, STATS_DAYS).catch(() => null)]);
      return rowFor(cfg, { run, stats, pauses: controller.shownPauses(rowPauses(pauses, cfg.workloadId)), scheduled: schedules.has(cfg.workloadId), above });
    }));
    return {
      router: listRouter({
        name: router.name, version: router.version ?? null, build: router.build ?? null, checkSchedule: CHECK_SCHEDULE,
        lastScheduledCheckAt: isoOrNull(checked?.lastScheduledCheckAt), pauses: controller.shownPauses(pauses.filter((p) => p.workloadId === null)), pausesError,
      }),
      workloads: workloads.sort((a, b) => a.workloadId.localeCompare(b.workloadId)),
    };
  }

  // AWS's six keys (status.mjs): the wake mode is the status's own field, at the top.
  const statusSettings = ({ wakeMode, ...six }) => six;

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
      onboarding.workloadSchedule(id),
      lists.length ? describeStoredLists(store, lists).catch((err) => [{ error: err.message }]) : [],
    ]);
    const row = rowFor(cfg, { run, stats: stats.error ? null : stats, pauses, scheduled: Boolean(view.schedule), above });
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
      settings: statusSettings(shown.settings),
      settingsFrom: shown.settingsFrom,
      type: shown.type,
      stats,
      ipLists,
      wakeMode: shown.settings.wakeMode,
      wakeRules: shown.wakeRules,
      noWakeRules: shown.noWakeRules,
      ...withMaintenance(view, run),
    };
  }

  // The manager's exclusions are AWS's workload pauses with an exclusionId, several per workload beside the operator's. The id is a part
  // of the pause's document id (`<workloadId>#<exclusionId>`): letters, digits, `.`, `_` and `-`. A Google Cloud router has no target group: an exclusion
  // names the backend service it matched instead.
  function exclusionOf({ exclusionId, targetGroupArn }) {
    if (targetGroupArn != null) throw invalid(TARGET_GROUP_REFUSED);
    if (exclusionId == null) return undefined;
    if (typeof exclusionId !== 'string' || !exclusionId || exclusionId.length > EXCLUSION_ID_MAX || !EXCLUSION_ID.test(exclusionId)) {
      throw invalid(`exclusionId must be 1 to ${EXCLUSION_ID_MAX} characters, with only letters, digits, . _ and -`);
    }
    return exclusionId;
  }

  // Whether `backendService` is the workload's: a bare name is compared as it is; a path `projects/<p>/(global|regions/<r>)/backendServices/<n>`
  // must be the router's project, the workload's name and its scope (a regional or internal load balancer's region, else global), since
  // routers of one project may each hold a `web` of their own.
  function isBackendServiceOf(cfg, backendService) {
    if (typeof backendService !== 'string') return false;
    const path = BACKEND_SERVICE_PATH.exec(backendService);
    if (!path) return backendService.split('/').at(-1) === cfg.backendService;
    const [, project, scope, name] = path;
    const region = isRegionalLb(cfg.lb) ? (cfg.lb.region ?? router.region) : null;
    return project === router.project && name === cfg.backendService && scope === (region === null ? 'global' : `regions/${region}`);
  }

  // AWS's pause: the workload's, or without workloadId the router's (§5.6): `{ pause, woken }`. An exclusion's names its workload's
  // backend service (a path or a name): another workload of the same id is not it.
  async function pause(payload) {
    const exclusionId = exclusionOf(payload);
    const workloadId = payload.workloadId ?? null;
    if (exclusionId !== undefined && workloadId === null) throw invalid('an exclusion pauses a workload: workloadId is needed');
    if (workloadId !== null) {
      const cfg = await onboarding.find(workloadId).catch((err) => {
        if (err instanceof Refusal && err.status === 404) throw new Refusal(404, err.reason, `workload not configured: ${workloadId}`);
        throw err;
      });
      const { backendService } = payload;
      if (backendService != null && !isBackendServiceOf(cfg, backendService)) {
        throw new Refusal(404, 'not-found', `workload not configured: ${workloadId} (its backend service is not ${backendService})`);
      }
    }
    if (workloadId === null) return onboarding.pauseRouter(payload);
    return controller.pause(workloadId, payload, { exclusionId }).catch((err) => {
      if (err instanceof PauseRefused) throw invalid(err.message);
      throw err;
    });
  }

  // AWS's resume: whether there was the pause, the workload's (the exclusion's when `exclusionId` is given) or the router's.
  async function resume(payload) {
    const exclusionId = exclusionOf(payload);
    const { workloadId = null, by } = payload;
    if (workloadId === null) {
      if (exclusionId !== undefined) throw invalid('an exclusion pauses a workload: workloadId is needed');
      return onboarding.resumeRouter({ by });
    }
    // A workload offboarded since: an exclusion's lift has nothing to lift, as AWS's resume answers; the operator's names it, as pause does.
    try {
      await onboarding.find(workloadId);
    } catch (err) {
      if (!(err instanceof Refusal && err.status === 404)) throw err;
      if (exclusionId !== undefined) return { resumed: false };
      throw new Refusal(404, err.reason, `workload not configured: ${workloadId}`);
    }
    return controller.resume(workloadId, by ?? 'unknown', { exclusionId });
  }

  // AWS's settings action (manager-actions.mjs's): without a workload the router's level, with one the workload's, its hibernation in
  // AWS's shape. A `by` inside the settings is not one of them: the REST routes read `by` beside them.
  async function setSettings({ workloadId, settings, by }) {
    if (!isObject(settings)) return { problems: ['settings must be an object'] };
    const { by: _, ...sent } = settings;
    if (!workloadId) return manager.setRouterSettings({ settings: sent, by });
    const answer = await manager.setWorkloadSettings({ workloadId, settings: sent, by });
    return answer.problems ? answer : { ...answer, hibernation: hibernationOf(answer.hibernation, (await organization()).manager) };
  }

  // AWS's waiting-page action, its checks first. A custom page the install's switch keeps off is a conflict (§5.5: the manager
  // answers 409 with these words); the page's other problems, AWS's answer.
  async function waitingPage(payload) {
    const answer = await manager.waitingPage(payload);
    if (answer.problems?.includes(CUSTOM_PAGES_REFUSED)) throw new Refusal(409, 'custom-pages-off', CUSTOM_PAGES_REFUSED);
    return answer;
  }

  // AWS's schedule action: the schedule stored with who set it, and AWS's view of it.
  async function setSchedule(payload) {
    const view = await manager.setSchedule(payload);
    if (view.problems) return view;
    return withMaintenance(view, await store.getRun(payload.workloadId));
  }

  // AWS's offboard (:793): its steps, with the REST answer's fields (the VMs left on a fallback type, and a forced one's backends left).
  // What only the CLI undoes is refused with its command (design §8): the request logs the onboarding turned on (setting them back
  // needs compute.backendServices.update, which the manager's accounts don't hold) and a GKE workload's Kubernetes access (its RBAC
  // objects are the operator's). The REST route, the CLI's, offboards both.
  async function offboard({ workloadId, force, by }) {
    const cfg = await onboarding.find(workloadId);
    const why = cfg.backends.some(isPods) ? 'a GKE workload\'s Kubernetes access is the CLI\'s to remove'
      : cfg.requestLogs?.before ? 'its onboarding turned its backend service\'s request logs on, which the CLI sets back' : null;
    if (why) {
      const command = `dormeto gcp workloads offboard ${cfg.workloadId} --project ${router.project} --region ${router.region}`;
      throw new Refusal(409, 'cli-only', `cannot offboard ${cfg.workloadId} through the manager: ${why}: ${command}`);
    }
    const { answer, steps } = await onboarding.offboardWithSteps(cfg.workloadId, { force: force === true, by });
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
    'request-nap': (payload) => manager.requestNap(payload),
    'force-wake': (payload) => manager.forceWake(payload),
    pause,
    resume,
    rename: (payload) => manager.rename(payload),
    tag: (payload) => manager.tag(payload),
    settings: setSettings,
    'waiting-page': waitingPage,
    schedule: setSchedule,
    'clear-schedule': (payload) => manager.clearSchedule(payload),
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
      // AWS's controller's wording and answer (controller-core.mjs): refused as unsupported, or a 400 in the REST routes' shape.
      const named = { action: action ?? null, workloadId: payload?.workloadId ?? null };
      if (payload?.refusals === true) {
        log.info('Refused', { ...named, code: 'unsupported', message });
        return { status: 200, body: { refused: { code: 'unsupported', message } } };
      }
      log.info('Refused', { ...named, status: 400, reason: UNKNOWN_ACTION, message });
      return { status: 400, body: { error: message, reason: UNKNOWN_ACTION } };
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
