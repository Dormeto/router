// A workload's onboarding and offboarding on the router, its list, show, nap and wake now, its schedule and its pause (vision
// docs/specs/2026-10-29-google-cloud-design.md, sections 5 and 7). The tags are the CLI's, as the operator: the router holds
// no tag permission, so it neither binds them nor can see them.
//
// A refusal is a `Refusal`: its status and short reason are the API's, its message is what is wrong and what to change.
// Anything else thrown is a failure, a 500 for the caller.
//
// Global, classic and regional load balancers (the coverage design's section 7). A workload's `lb`: `{ kind: 'regional', region }`
// or `{ kind: 'classic' }`, under a swap, with a hold route and a second header on the waker; absent in the configuration for a
// global one, under the policy. The router reads only its own region's regional maps. The internal ones (vision
// docs/specs/2026-11-08-google-cloud-router-features-design.md, section 7) swap too: `{ kind: 'internal', region }`, a regional map whose
// forwarding rules are INTERNAL_MANAGED, and `{ kind: 'cross-region-internal' }`, a global one whose rules are; their waker's headers
// are in the map, as a regional one's.
//
// Cloud SQL companions (section 9): named at the onboarding, `{ kind: 'cloudsql', name }` among the backends, never without an
// application. The router reads them at the project; the tag its update needs is the CLI's, bound before this.
//
// GKE pods (section 8): `gke` in the request, a `k8s` backend. The dry run reads Google only, as it comes before any right in the cluster: it answers the
// namespace and the Service its NEGs name, which the CLI reads the owner of and applies the Role in. The onboarding then checks each right and reads the owner.
//
// Settings by level (vision docs/specs/2026-11-08-google-cloud-router-features-design.md, section 4): AWS's keys in the configuration, with
// `inherits` (the keys that follow the levels) and `source: 'cli'`; the router level in `router/settings`. The routes that set them are
// AWS's `settings` action, with what Google Cloud fixes (levels.mjs); a Workload shows each setting resolved and where it comes from.
//
// The waiting page (section 5): AWS's `waiting-page` action, the router's level or a workload's, its answer AWS's (page-settings.mjs's
// pageViewOf); custom pages need the install's switch (pages.mjs).
import { createHash } from 'node:crypto';
import { resolveHibernation, settingsProblems, workloadSettingsProblems } from '../../lambda/src/lib/hibernation.mjs';
import { checkName } from '../../lambda/src/lib/names.mjs';
import { joinLevels } from '../../lambda/src/lib/manager-settings.mjs';
import { pageViewOf, validatePage } from '../../lambda/src/lib/page-settings.mjs';
import { nextEvents, normalizeSchedule, resolveJoin, scheduleProblems } from '../../lambda/src/lib/schedule.mjs';
import { describedRules, SCALAR_KEYS } from '../../lambda/src/lib/settings-levels.mjs';
import { mergedRouterSettings, resolvedSettings, routerSettingsView, withSettings, writtenRouterView } from '../../lambda/src/lib/settings-writes.mjs';
import { STATES } from '../../lambda/src/lib/state.mjs';
import { fallbacksOf } from '../../lambda/src/lib/summary.mjs';
import { tagsProblem } from '../../lambda/src/lib/tags.mjs';
import { companionRead, INSTANCE_NAME, isCompanion, statusOf } from './cloudsql.mjs';
import { groupOf, PauseRefused } from './controller-core.mjs';
import {
  clusterProblems, clusterRead, giveBackOwner, gkeDescriptionRefusal, gkeMapRefusal, gkeProblems, isGkeNeg, isPods, negsOfService, ownerAsVm, ownerText, pauseLeft,
} from './gke.mjs';
import { beatOf } from './heartbeat.mjs';
import { organizationOf } from './organization.mjs';
import { effectiveOf, inheritsOf, levelProblems } from './levels.mjs';
import { SWITCH_HEADER, WORKLOAD_HEADER, WORKLOAD_ID, swapHeaders } from './names.mjs';
import { CUSTOM_PAGE_NOT_SERVED, CUSTOM_PAGES_REFUSED, notServed, servedPage } from './pages.mjs';
import { aKind, headersInMap, inOneUpdate, isRegionalLb, SWAP_WAIT_MS } from './switch.mjs';
import {
  hostsOf, inMatcher, references, UrlMapRefused, withErrorPolicy, withHoldRoute, withoutErrorPolicy, withoutHoldRoute, withoutSwap, withoutWakerRoute, withSwap, withWakerRoute,
} from './urlmaps.mjs';

const COMPUTE = 'https://compute.googleapis.com/compute/v1';
// A load balancer's scheme by its kind: of its forwarding rules, of its backend services, of the waker's. INTERNAL_SELF_MANAGED (Cloud
// Service Mesh) is no Application Load Balancer.
const SCHEME_OF = {
  global: 'EXTERNAL_MANAGED', classic: 'EXTERNAL', regional: 'EXTERNAL_MANAGED', internal: 'INTERNAL_MANAGED', 'cross-region-internal': 'INTERNAL_MANAGED',
};
// The kinds --load-balancer takes, and those of each scope of a map.
const KINDS = ['global', 'regional', 'classic', 'internal', 'cross-region-internal'];
const REGIONAL_KINDS = KINDS.filter((kind) => isRegionalLb({ kind }));
const GLOBAL_KINDS = KINDS.filter((kind) => !isRegionalLb({ kind }));
const KINDS_TEXT = `${KINDS.slice(0, -1).join(', ')} or ${KINDS.at(-1)}`;
const SUPPORTED = 'only Application Load Balancers are supported: global (EXTERNAL_MANAGED), classic (EXTERNAL), regional (EXTERNAL_MANAGED), internal (INTERNAL_MANAGED) and cross-region-internal (INTERNAL_MANAGED)';
const OTHER_ROUTERS = 'regional load balancers are onboarded on the router of their region';
const GLOBAL_LB = { kind: 'global' };
const NAME = /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/;
const NAME_MAX = 63;
const LOCAL_SSD = 'SCRATCH';
const INSTANCE_GROUP = /\/(zones|regions)\/([^/]+)\/instanceGroups\/([^/]+)$/;
const NEG_URL = /\/(zones|regions|global)\/(?:([^/]+)\/)?networkEndpointGroups\/([^/]+)$/;
const NEG_OF_VMS = 'GCE_VM_IP_PORT';
// A workload's fallback machine types, as AWS's: at most 5.
const FALLBACK_TYPES_MAX = 5;
// Google's rule for a machine type of another series on a stopped VM: "supported for only first and second generation machine series,
// excluding the T2A and A2 machine series". The page does not name the series; these are the first and second generation ones of
// Google's machine families, N1 including its shared-core f1 and g1 types. Read on 2026-11-08 at
// https://docs.cloud.google.com/compute/docs/instances/changing-machine-type-of-stopped-instance
const CHANGEABLE_SERIES = new Set(['n1', 'f1', 'g1', 'n2', 'n2d', 'e2', 'c2', 'c2d', 'm1', 'm2', 't2d']);
const MACHINE_TYPE = /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/;
const FALLBACK_REFUSAL_FOR_GROUPS = 'fallback machine types are for VMs of unmanaged instance groups: a managed group\'s machine type is its template\'s';
// A type's series: its name's first word, `custom-...` being N1's.
const seriesOf = (type) => (type.startsWith('custom-') ? 'n1' : type.split('-')[0]);
const MANAGED_GROUP_OWNER = /\/instanceGroupManagers\/([^/]+)$/;
// Not a setting of the levels.
const POLL_SECONDS = 3;
// The load balancer before it is read: neither the policy nor a swap, so what the settings ask of it waits until it is known.
const UNREAD_LB = { kind: 'unread' };

// `problems`: each problem of a refused body, as AWS's settings action answers them.
export class Refusal extends Error {
  constructor(status, reason, message, { problems } = {}) {
    super(message);
    this.name = 'Refusal';
    this.status = status;
    this.reason = reason;
    if (problems) this.problems = problems;
  }
}

const bad = (message) => new Refusal(400, 'bad-request', message);
const refusedSettings = (problems) => new Refusal(400, 'bad-request', problems.join('; '), { problems });
const notFound = (id) => new Refusal(404, 'not-found', `no workload ${id}`);
const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const nameOf = (url) => url.slice(url.lastIndexOf('/') + 1);
const zoneOf = (url) => /\/zones\/([^/]+)\//.exec(url)?.[1];
// A proxy's URL without what differs between Google's answers, as a forwarding rule's target names it.
// A URL from `projects/` on, whatever the API's host and version: the same proxy has one path, another proxy of the same name elsewhere another.
const fromProjects = (url) => url.slice(Math.max(url.indexOf('projects/'), 0));
const isoOf = (ms) => new Date(ms).toISOString();
const isSwapped = (lb) => Object.hasOwn(SWAP_WAIT_MS, lb.kind);
// A step of an onboarding or an offboarding in AWS's onboarder's shape (lambda/src/lib/onboarding.mjs): done or skipped, and what.
const stepOf = (name, done, detail) => ({ name, status: done ? 'done' : 'skipped', ...(detail ? { detail } : {}) });
const autoscalerText = (a) => `autoscaler ${a.name} (${a.location}): ${a.mode}`;
// The CLI sends `requestLogs` when it turned the backend service's logging on: what the logging was before, kept for the offboarding.
function requestLogsProblems(asked) {
  if (typeof asked !== 'object' || asked === null || Array.isArray(asked)) return ['requestLogs: must be an object'];
  const { before } = asked;
  if (typeof before !== 'object' || before === null || Array.isArray(before)) return ['requestLogs: before must be an object with enable and sampleRate'];
  return [
    ...(typeof before.enable === 'boolean' ? [] : ['requestLogs: before.enable must be true or false']),
    ...(typeof before.sampleRate === 'number' && before.sampleRate >= 0 && before.sampleRate <= 1 ? [] : ['requestLogs: before.sampleRate must be a number from 0 to 1']),
  ];
}

const backendText = (backend) => (isPods(backend) ? ownerText(backend) : backend.name);
const sameCluster = (a, b) => a.location === b.location && a.name === b.name;

// A read's 404, as `.catch(absent)`: null.
const absent = (err) => {
  if (err?.code !== 404) throw err;
  return null;
};

// At the request or at its operation's end, as `.catch(refusedByGoogle(id, what))`. Google's words say what to change, as the
// operator can read them; anything else stays a failure.
const refusedByGoogle = (id, what) => (err) => {
  if (err?.code === 400 || err?.code === 403) throw new Refusal(400, 'not-eligible', `cannot onboard ${id}: Google refused ${what}: ${err.message}`);
  throw err;
};

function checkedId(id) {
  if (typeof id !== 'string' || !WORKLOAD_ID.test(id)) throw bad(`workload ID ${JSON.stringify(id)} does not match ${WORKLOAD_ID.source}`);
  return id;
}

// An onboarding's settings (ruling 1 of the plan's ledger): `hibernate`, true or false, and the settings of the levels, each a value or
// null (left to the levels), through levelProblems. What they ask of the load balancer is checked once it is read: an explicit wake
// timeout must leave room for a swap's map change, and the policy keeps the wake mode browser.
function onboardSettingsProblems(settings, lb = UNREAD_LB) {
  if (!isObject(settings)) return ['settings: must be an object'];
  const { hibernate, ...levels } = settings;
  return [
    ...(Object.hasOwn(settings, 'hibernate') && typeof hibernate !== 'boolean' ? ['settings: hibernate must be true or false'] : []),
    ...levelProblems(levels, { level: 'workload', cfg: { lb } }).map((problem) => `settings: ${problem}`),
  ];
}

// A workload's settings, as AWS's workloadSettingsProblems: `hibernate` and `joinMinutes` in its words, the settings of the levels with
// what Google Cloud refuses for the workload's load balancer.
function workloadProblems(settings, cfg) {
  if (!isObject(settings)) return ['settings must be an object'];
  const aws = (key) => key === 'hibernate' || key === 'joinMinutes';
  const entries = Object.entries(settings);
  return [
    ...workloadSettingsProblems(Object.fromEntries(entries.filter(([key]) => aws(key)))),
    ...levelProblems(Object.fromEntries(entries.filter(([key]) => !aws(key))), { level: 'workload', cfg }).map((problem) => `settings: ${problem}`),
  ];
}

// The router level's, as AWS's settingsProblems: its defaults with what Google Cloud refuses at the router.
function routerProblems(settings) {
  if (!isObject(settings)) return ['settings must be an object'];
  const { defaults, ...rest } = settings;
  return [
    ...settingsProblems(rest),
    ...(defaults === undefined || defaults === null ? [] : levelProblems(defaults, { level: 'router' }).map((problem) => `settings: defaults: ${problem}`)),
  ];
}

// `field` is what the caller sent: `fallbackInstanceTypes`, or AWS's `settings: fallbackInstanceTypes`. One text for a list that is not
// one or is too long, as AWS's onboarder's, with the hint.
function fallbackTypesProblems(types, field = 'fallbackInstanceTypes') {
  if (!Array.isArray(types) || types.length > FALLBACK_TYPES_MAX) return [`${field}: must be a list of at most ${FALLBACK_TYPES_MAX} machine types, such as e2-medium`];
  return [
    ...types.filter((t) => typeof t !== 'string' || !MACHINE_TYPE.test(t)).map((t) => `${field}: ${JSON.stringify(t)} is not a machine type name`),
    ...[...new Set(types.filter((t, i) => types.indexOf(t) !== i))].map((t) => `${field}: ${t} is named twice`),
  ];
}

// `field` is `cloudSql` (the CLI's) or `databases` (AWS's), whichever the caller sent.
function cloudSqlProblems(cloudSql, field = 'cloudSql') {
  if (!Array.isArray(cloudSql)) return [`${field}: must be a list of Cloud SQL instance names`];
  return [
    ...cloudSql.filter((name) => typeof name !== 'string' || !INSTANCE_NAME.test(name)).map((name) => `${field}: ${JSON.stringify(name)} is not a Cloud SQL instance name`),
    ...[...new Set(cloudSql.filter((name, i) => cloudSql.indexOf(name) !== i))].map((name) => `${field}: ${name} is named twice`),
  ];
}

// What each key left to the levels resolves to without any level (the built-in value, with what Google Cloud fixes): the value a
// router before G5 reads, as AWS writes its built-in values for an older router.
const builtInsOf = (cfg) => effectiveOf({ ...cfg, inherits: SCALAR_KEYS });

// AWS's hibernation of a workload, as its status and its settings answer give it: the resolution (its own, none with fallback machine
// types, the router's, the built-in), each level's value, and the manager's (the organization's level, router/manager).
function hibernationOf(cfg, router, organization) {
  return {
    ...resolveHibernation({ workload: cfg.hibernate, fallbackTypes: cfg.fallbackInstanceTypes, router: router?.hibernate, manager: organization }),
    workload: typeof cfg.hibernate === 'boolean' ? cfg.hibernate : null,
    router: typeof router?.hibernate === 'boolean' ? router.hibernate : null,
    manager: typeof organization?.hibernate === 'boolean' ? organization.hibernate : null,
  };
}

// The REST Workload's failure (what CLI 0.11.0 reads): `at` only when the record has one, unlike the row's (lambda/src/lib/summary.mjs's
// failureOf). Its `fallbacks` are the row's (summary.mjs's fallbacksOf).
function failureOf(run) {
  if (!run?.failure) return null;
  try {
    const failure = JSON.parse(run.failure);
    return { ...failure, ...(failure.at === undefined ? {} : { at: isoOf(failure.at) }) };
  } catch {
    return null;
  }
}

// The databases as Cloud SQL instance names: a list of names (the CLI's) or of AWS's entries `{ kind, id }`, not both in one list; an
// entry of another kind is no Cloud SQL instance. Anything else is left to the onboarding's own check.
function databaseNames(databases) {
  if (!Array.isArray(databases)) return databases;
  const entries = databases.filter(isObject);
  if (!entries.length) return databases;
  if (entries.length !== databases.length) throw bad('databases: a list of names or a list of { kind, id } entries, not both');
  const other = entries.find((entry) => entry.kind !== 'cloudsql-instance');
  if (other) throw bad(`databases: ${JSON.stringify(other.kind)} is not a Cloud SQL instance's kind: the kind is cloudsql-instance`);
  const unnamed = entries.find((entry) => typeof entry.id !== 'string' || !INSTANCE_NAME.test(entry.id));
  if (unnamed) throw bad(unnamed.id === undefined ? 'databases: an entry needs an id: the Cloud SQL instance name' : `databases: ${JSON.stringify(unnamed.id)} is not a Cloud SQL instance name`);
  return entries.map((entry) => entry.id);
}

// The request's two names for what AWS's onboarder and the CLI each call differently: the databases (`databases`, AWS's, or `cloudSql`, the
// CLI's) and the fallback machine types (`settings.fallbackInstanceTypes`, or the top-level one). Either, or both when they agree.
function oneOf(first, second, firstName, secondName) {
  if (first === undefined) return second;
  if (second !== undefined && JSON.stringify(first) !== JSON.stringify(second)) throw bad(`${firstName} and ${secondName} are given and differ: give one`);
  return first;
}

// A pause as the controller shows it (controller-core.mjs's `shown`, which names the router's scope only), with AWS's `scope` on every one: the
// workload's or the router's. The API's Workload and the manager's rows and status read the same pause through this.
export const scoped = (pause) => ({ scope: pause.scope ?? 'workload', ...pause });

// The API's Workload. `awakeSince` is a time the CLI prints, and left on the run by a nap. `workloadId` beside `id` (AWS's name beside the CLI's); `pauses`: its active pauses, as AWS's rows list them, and `paused` the first (the CLI's). `companionsGone`:
// the Cloud SQL instances named at its onboarding that no longer exist, as last read. `napAborted`: why the last nap was given up and
// when, until a nap commits. `beatAt`: the running wake's or nap's last heartbeat (heartbeat.mjs), WAKING or NAPPING only. `idleReads`:
// what the idle check read at the last check that read log entries or counted a request, `request logs` or `request count`
// (controller-core.mjs). With the router level (`router`): each setting resolved (`settings`), where it comes from, the type and the
// rules of every level, as AWS's status gives them, and its hibernation; its fallback machine types, and `fallbacks`, as AWS's, while a
// VM runs on one.
function workloadOf(cfg, pauses, run, { router = null, organization = null } = {}) {
  const failure = failureOf(run);
  const fallbacks = fallbacksOf(run);
  const beatAt = run ? beatOf(run) : undefined;
  const effective = effectiveOf(cfg, { run, router, organization });
  const { settings, settingsFrom, type } = resolvedSettings(effective);
  const shownPauses = pauses.map(scoped);
  const [paused] = shownPauses;
  return {
    workloadId: cfg.workloadId,
    id: cfg.workloadId,
    name: cfg.name ?? cfg.workloadId,
    tags: cfg.tags ?? {},
    state: run?.state ?? 'UNKNOWN',
    urlMap: cfg.urlMap,
    backendService: cfg.backendService,
    wakerBackendService: cfg.wakerBackendService,
    hosts: cfg.hosts,
    lb: cfg.lb ?? GLOBAL_LB,
    settings,
    settingsFrom,
    type,
    ...describedRules(effective),
    hibernation: hibernationOf(cfg, router, organization),
    backends: cfg.backends,
    ...(Array.isArray(cfg.fallbackInstanceTypes) && cfg.fallbackInstanceTypes.length ? { fallbackInstanceTypes: cfg.fallbackInstanceTypes } : {}),
    ...(fallbacks.length ? { fallbacks } : {}),
    ...(cfg.requestLogs ? { requestLogs: cfg.requestLogs } : {}),
    ...(cfg.onboardedBy ? { onboardedBy: cfg.onboardedBy } : {}),
    ...(run?.state === STATES.AWAKE && run.awakeSince !== undefined ? { awakeSince: isoOf(run.awakeSince) } : {}),
    ...(run?.lastWake ? { lastWake: run.lastWake } : {}),
    ...(failure ? { failure } : {}),
    pauses: shownPauses,
    ...(paused ? { paused } : {}),
    ...(run?.companionsGone?.length ? { companionsGone: run.companionsGone } : {}),
    ...(run?.napAborted ? { napAborted: { reason: run.napAborted.reason, at: isoOf(run.napAborted.at) } } : {}),
    ...(beatAt !== undefined ? { beatAt: isoOf(beatAt) } : {}),
    ...(run?.idleReads ? { idleReads: run.idleReads } : {}),
  };
}

// customPages: the install's switch (DMT_CUSTOM_PAGES, pages.mjs).
export function createOnboarding({ store, compute, cloudsql, gke, urlmaps, regionalUrlmaps, core, config, customPages = false, now = Date.now, log }) {
  const clients = { compute, kubernetesOf: (cluster) => gke.kubernetesOf(cluster) };
  const wakerName = (id) => `dmtr-${config.region}-${id}`;
  const wakerUrl = (name, lb) => `${COMPUTE}/projects/${config.project}/${isRegionalLb(lb) ? `regions/${lb.region}` : 'global'}/backendServices/${name}`;
  // A regional backend service takes no custom request header (M4: Google refuses them), nor does an internal one, regional or
  // cross-region (Google's page): its waker's are written in the map, and the service says whose waker it is in its description,
  // which a later onboarding of the same workload reads.
  const wakerHeaders = (id, lb) => [`${WORKLOAD_HEADER}: ${id}`, ...(isSwapped(lb) ? [`${SWITCH_HEADER}: swap`] : [])];
  const wakerDescription = (id) => `Dormeto: the waker of workload ${id}`;
  const mapHeaders = (id, lb) => ({ headers: headersInMap(lb) ? swapHeaders(id) : undefined });
  // A waker the workload's kind would write: of its scheme (a regional and an internal one share their description, and the map takes
  // no service of another scheme), with its headers or, where they are in the map, its description.
  const isWakerOf = (service, id, lb) => service.loadBalancingScheme === SCHEME_OF[lb.kind] && (headersInMap(lb)
    ? service.description === wakerDescription(id) && !service.customRequestHeaders?.length
    : service.customRequestHeaders?.length === wakerHeaders(id, lb).length && wakerHeaders(id, lb).every((h) => service.customRequestHeaders.includes(h)));
  const mapsOf = (lb) => (isRegionalLb(lb) ? regionalUrlmaps : urlmaps);
  const getService = (name, lb) => (isRegionalLb(lb) ? compute.getRegionBackendService(lb.region, name) : compute.getBackendService(name));
  const deleteService = (name, lb) => (isRegionalLb(lb) ? compute.deleteRegionBackendService(lb.region, name) : compute.deleteBackendService(name));
  const insertService = (body, lb) => (isRegionalLb(lb) ? compute.insertRegionBackendService(lb.region, body) : compute.insertBackendService(body));

  // The request's fields, or a 400. Without an ID, the backend service's name, when it is one. `needsAll`: an onboarding's `gke` names all, a dry run's the cluster alone.
  function requested({ urlMap, backendService, id, name, tags, source = 'cli', settings = {}, loadBalancer, cloudSql: cloudSqlAsked, databases, gke: gkeAsked, requestLogs, fallbackInstanceTypes: topFallbackTypes, by }, { needsAll = false } = {}) {
    const { fallbackInstanceTypes: inSettings, ...ownSettings } = isObject(settings) ? settings : {};
    if (isObject(settings)) settings = ownSettings;
    const fallbackInstanceTypes = oneOf(inSettings, topFallbackTypes, 'settings.fallbackInstanceTypes', 'fallbackInstanceTypes');
    const fallbackField = inSettings !== undefined ? 'settings: fallbackInstanceTypes' : 'fallbackInstanceTypes';
    // A null is not none: it is refused, as it was before the two names.
    const databasesAsked = oneOf(databaseNames(databases), cloudSqlAsked, 'databases', 'cloudSql');
    const databasesField = databases !== undefined ? 'databases' : 'cloudSql';
    const cloudSql = databasesAsked === undefined ? [] : databasesAsked;
    if (!urlMap || !backendService) throw bad('urlMap and backendService are needed');
    for (const [key, value] of Object.entries({ urlMap, backendService })) {
      if (typeof value !== 'string' || !NAME.test(value)) throw bad(`${key}: ${JSON.stringify(value)} is not a Compute Engine name`);
    }
    if (loadBalancer !== undefined && !KINDS.includes(loadBalancer)) throw bad(`loadBalancer: ${JSON.stringify(loadBalancer)} is not ${KINDS_TEXT}`);
    const workloadId = checkedId(id || backendService);
    const waker = wakerName(workloadId);
    if (waker.length > NAME_MAX) throw bad(`workload ID ${workloadId} would name the waker backend service ${waker}, longer than the ${NAME_MAX} characters of a Compute Engine name: use a shorter one`);
    // The name people see and the labels, as AWS's rename and tag take them (`source`: who onboarded it, the CLI or the manager's action).
    const checkedName = checkName(name);
    if (name !== undefined && checkedName.problem) throw bad(checkedName.problem);
    const tagged = tags === undefined ? null : tagsProblem(tags);
    if (tagged) throw bad(tagged);
    if (source !== 'cli' && source !== 'manager') throw bad('source: cli or manager');
    const problems = [...onboardSettingsProblems(settings), ...(databasesAsked === undefined ? [] : cloudSqlProblems(cloudSql, databasesField)), ...(requestLogs === undefined ? [] : requestLogsProblems(requestLogs)), ...(fallbackInstanceTypes === undefined ? [] : fallbackTypesProblems(fallbackInstanceTypes, fallbackField)), ...(gkeAsked === undefined ? [] : gkeProblems(gkeAsked, { needsAll }))];
    if (problems.length) throw bad(problems.join('; '));
    return { id: workloadId, name: checkedName.name || undefined, tags, source, urlMap, backendService, settings, loadBalancer, cloudSql, gkeAsked, requestLogs, fallbackTypes: fallbackInstanceTypes ?? [], by: by ? String(by) : undefined };
  }

  // The URL map, `{ map, regional }`, or why it is not one: `{ reason }`. A regional one elsewhere than the router's region reads as none.
  // `asked`: a kind, whose map's scope alone is read.
  async function findMap(urlMap, asked) {
    const askedRegional = Boolean(asked) && isRegionalLb({ kind: asked });
    const [inGlobal, inRegion] = await Promise.all([
      askedRegional ? null : urlmaps.get(urlMap).catch(absent),
      asked && !askedRegional ? null : regionalUrlmaps.get(urlMap).catch(absent),
    ]);
    if (inGlobal && inRegion) return { reason: `URL map ${urlMap} exists globally and in region ${config.region}: say which with --load-balancer ${KINDS_TEXT}` };
    if (inGlobal || inRegion) return { map: inGlobal ?? inRegion, regional: Boolean(inRegion) };
    if (askedRegional) return { reason: `URL map ${urlMap} not found in region ${config.region}: ${OTHER_ROUTERS}${asked === 'internal' ? ', or use --load-balancer cross-region-internal' : ''}` };
    if (asked) return { reason: `URL map ${urlMap} not found: name a global URL map of this project, or use --load-balancer ${asked === 'cross-region-internal' ? 'internal' : 'regional'}` };
    return { reason: `URL map ${urlMap} not found: name a global URL map of this project, or a regional one of ${config.region}: ${OTHER_ROUTERS}` };
  }

  // A global map's forwarding rules: the global ones, and the regional ones that target a global proxy, which a classic load
  // balancer on the Standard network tier has (the aggregated list shows them; regional rules have a `region`, global ones none).
  async function globalRules() {
    const [global, aggregated] = await Promise.all([compute.listForwardingRules(), compute.listAggregatedForwardingRules()]);
    return [...global, ...aggregated.filter((r) => r.region)];
  }

  // The URL map's load balancer: one target proxy, and forwarding rules whose scheme tells a global from a classic or a cross-region
  // internal one, and a regional from an internal one. `{ kind, reasons }`, `kind` null when there is nothing supported to tell it from.
  async function loadBalancerOf(urlMap, regional, asked, map) {
    const [https, http, rules] = await Promise.all(regional
      ? [compute.listRegionTargetHttpsProxies(config.region), compute.listRegionTargetHttpProxies(config.region), compute.listRegionForwardingRules(config.region)]
      : [compute.listTargetHttpsProxies(), compute.listTargetHttpProxies(), globalRules()]);
    const refused = (...reasons) => ({ kind: null, reasons });
    const proxies = [...https, ...http].filter((p) => nameOf(p.urlMap ?? '') === urlMap);
    // K14: GKE's, told by the descriptions it writes in the proxies and the rules.
    const owned = (found) => {
      const gke = gkeDescriptionRefusal(urlMap, { map, proxies, rules: found });
      return gke ? { kind: null, reasons: [gke], gke } : null;
    };
    if (proxies.length && owned([])) return owned([]);
    if (!proxies.length) return refused(`URL map ${urlMap} is used by no target proxy: attach it to an Application Load Balancer, then onboard again`);
    if (proxies.length > 1) return refused(`URL map ${urlMap} is used by ${proxies.length} target proxies (${proxies.map((p) => p.name).join(', ')}): give each load balancer its own URL map`);
    const fronts = rules.filter((r) => fromProjects(r.target ?? '') === fromProjects(proxies[0].selfLink));
    if (owned(fronts)) return owned(fronts);
    if (!fronts.length) return refused(`no forwarding rule sends to the target proxy of URL map ${urlMap}: add one, then onboard again`);
    const kinds = regional ? REGIONAL_KINDS : GLOBAL_KINDS;
    const kindsOf = (rule) => kinds.filter((kind) => SCHEME_OF[kind] === rule.loadBalancingScheme);
    const unsupported = fronts.filter((r) => !kindsOf(r).length);
    if (unsupported.length) return refused(...unsupported.map((r) => `forwarding rule ${r.name} has the scheme ${r.loadBalancingScheme}: ${SUPPORTED}`));
    const found = new Set(fronts.flatMap(kindsOf));
    // A proxy migrating from classic to global has rules of both schemes. Google gives an internal one no external rule.
    if (found.size > 1) return refused(`URL map ${urlMap} has forwarding rules of ${[...found].map(aKind).join(' and of ')} load balancer (${fronts.map((r) => `${r.name} ${r.loadBalancingScheme}`).join(', ')}): finish its migration, then onboard again`);
    const [kind] = found;
    return { kind, reasons: asked && asked !== kind ? [`URL map ${urlMap} belongs to ${aKind(kind)} load balancer, not ${aKind(asked)} one: onboard it with --load-balancer ${kind}`] : [] };
  }

  // What the route and the nap would write, tried on the map as it is, the nap's after the route: the route gives the map's
  // default its matcher. A map that does not name the service has its reason already. Under a swap, the nap's is the swap, after
  // the hold route too.
  function mapProblems(map, backendService, waker, lb, id) {
    if (!references(map, backendService).length) return [];
    const problems = [];
    const tried = (write, on, advice) => {
      try {
        return write(on, backendService, waker, mapHeaders(id, lb)).map;
      } catch (err) {
        if (!(err instanceof UrlMapRefused)) throw err;
        problems.push(`${err.message}: ${advice}`);
        return null;
      }
    };
    const change = 'change that, then onboard again';
    const routed = tried(withWakerRoute, map, change);
    if (!inMatcher(routed ?? map, backendService)) {
      if (routed) problems.push(`backend service ${backendService} is named in URL map ${map.name} only by its default, which a host rule * hides: route to it in a path matcher, then onboard again`);
    } else if (isSwapped(lb)) {
      const held = routed && tried(withHoldRoute, routed, change);
      tried(withSwap, held ?? routed ?? map, change);
    } else {
      tried(withErrorPolicy, routed ?? map, 'a nap would replace it, remove it first');
    }
    return problems;
  }

  // A zonal NEG of VMs: `{ reasons, members (its VMs' URLs), neg: true }`. Its VMs stay in it when stopped (measure M1).
  async function negOf(zone, name, service) {
    const neg = await compute.getZonalNetworkEndpointGroup(zone, name).catch(absent);
    const refused = (reason) => ({ reasons: [reason], members: [], neg: { zone, name } });
    if (!neg) return refused(`network endpoint group ${name} of backend service ${service} not found: it was deleted, take it out of the backend service`);
    if (neg.networkEndpointType !== NEG_OF_VMS) return refused(`network endpoint group ${name} of backend service ${service} has the type ${neg.networkEndpointType}: only ${NEG_OF_VMS} is supported, take it out of the backend service`);
    if (isGkeNeg({ ...neg, name })) {
      return refused(`network endpoint group ${name} of backend service ${service} was made by GKE, its endpoints are pods: it needs --gke-cluster`);
    }
    const endpoints = (await compute.listNetworkEndpoints(zone, name)).map((item) => item.networkEndpoint ?? {});
    if (!endpoints.length) return refused(`network endpoint group ${name} has no endpoint: add a VM to it, then onboard again`);
    const bare = endpoints.filter((endpoint) => !endpoint.instance);
    if (bare.length) return refused(`network endpoint group ${name} has an endpoint with no VM (${bare.map((endpoint) => endpoint.ipAddress).join(', ')}): only endpoints naming a VM are supported, replace it with one`);
    return { reasons: [], neg: { zone, name }, members: endpoints.map((endpoint) => `${COMPUTE}/projects/${config.project}/zones/${zone}/instances/${nameOf(endpoint.instance)}`) };
  }

  // A backend of the service: `{ reasons, members (its VMs' URLs), group?, neg? }`, `group` when it is a managed one, `neg` (`{ zone, name }`) when
  // it is a zonal NEG.
  async function backendOf({ group: url }, service) {
    const place = INSTANCE_GROUP.exec(url ?? '');
    if (!place) {
      const [, scope, zone, name] = NEG_URL.exec(url ?? '') ?? [];
      if (scope === 'zones') return negOf(zone, name, service);
      const where = scope === 'regions' ? 'regional network endpoint group (serverless, private service connect)' : scope === 'global' ? 'global network endpoint group (internet)' : 'network endpoint group';
      return { reasons: [`backend ${nameOf(url ?? '')} of backend service ${service} is a ${where}: only zonal network endpoint groups of VMs and instance groups are supported`], members: [] };
    }
    const [, scope, location, name] = place;
    const group = { kind: scope === 'regions' ? 'regional' : 'zonal', location, name };
    const managed = await compute.getManagedGroup(group).catch(absent);
    const members = managed
      ? (await compute.listManagedInstances(group)).map((m) => m.instance)
      : (await compute.listGroupInstances(location, name)).map((m) => m.instance);
    const reasons = [];
    if (!members.length) reasons.push(`instance group ${name} has no VM: add one, then onboard again`);
    if (managed?.status?.stateful?.hasStatefulConfig) reasons.push(`managed group ${name} has a stateful configuration: a nap might not keep it, take the group out of the backend service`);
    // Google's defaults for a regional group, when its answer says nothing.
    if (managed && group.kind === 'regional' && (managed.distributionPolicy?.targetShape ?? 'EVEN') === 'EVEN' && (managed.updatePolicy?.instanceRedistributionType ?? 'PROACTIVE') !== 'NONE') {
      reasons.push(`regional managed group ${name} has the target shape EVEN with instance redistribution on: Google cannot stop or suspend its VMs one by one, set its instance redistribution type to NONE or change its target shape, then onboard again`);
    }
    return { reasons, members, ...(managed ? {} : { source: url }), ...(managed ? { group: { ...group, selfLink: managed.selfLink, id: String(managed.id) } } : {}) };
  }

  async function vmProblems(vm, zone, machineTypes, fallbackTypes = []) {
    const reasons = [];
    const type = nameOf(vm.machineType ?? '');
    const key = `${zone}/${type}`;
    if (!machineTypes.has(key)) machineTypes.set(key, compute.getMachineType(zone, type).catch(absent));
    const machine = await machineTypes.get(key);
    if (vm.guestAccelerators?.length || machine?.accelerators?.length) reasons.push(`VM ${vm.name} has a GPU: GPU VMs are not supported, take it out of the backend service`);
    if (vm.disks?.some((d) => d.type === LOCAL_SSD)) reasons.push(`VM ${vm.name} has a local SSD: a stop would lose its data, take it out of the backend service`);
    reasons.push(...await fallbackProblems(vm, zone, type, machineTypes, fallbackTypes));
    return reasons;
  }

  // The workload's fallback machine types against one VM: not its own, each in its zone, with no GPU, and of its series unless both
  // series may be changed between. A VM with a Local SSD or a GPU is refused above, whatever it is asked.
  async function fallbackProblems(vm, zone, own, machineTypes, fallbackTypes) {
    const reasons = [];
    for (const type of fallbackTypes) {
      if (type === own) {
        reasons.push(`fallbackInstanceTypes: ${type} is the type of VM ${vm.name}`);
        continue;
      }
      const key = `${zone}/${type}`;
      if (!machineTypes.has(key)) machineTypes.set(key, compute.getMachineType(zone, type).catch(absent));
      const machine = await machineTypes.get(key);
      if (!machine) {
        reasons.push(`fallback machine type ${type} does not exist in zone ${zone}, where VM ${vm.name} is: name a type of that zone`);
        continue;
      }
      if (machine.accelerators?.length) {
        reasons.push(`fallback machine type ${type} has a GPU: GPU VMs are not supported`);
        continue;
      }
      const [from, to] = [seriesOf(own), seriesOf(type)];
      if (from === to) continue;
      const rule = `fallback machine type ${type} of VM ${vm.name}: a machine type of another series can be set only between first and second generation series`;
      if (!CHANGEABLE_SERIES.has(to)) reasons.push(`${rule}, and ${to} is not one`);
      else if (!CHANGEABLE_SERIES.has(from)) reasons.push(`${rule}, and VM ${vm.name} is of the series ${from}, which is not one`);
    }
    return reasons;
  }

  // The service's backends: what refuses them, and what the CLI tags: the VMs of unmanaged groups and the managed groups.
  // A managed group's own VMs are the group's to tag and to act on, but they must qualify all the same.
  async function backendsOf(service, others, fallbackTypes = []) {
    const holderOf = (kind, location, name) => others.find((c) => c.backends?.some((b) => b.kind === kind && b.location === location && b.name === name));
    const backends = await Promise.all((service.backends ?? []).map((b) => backendOf(b, service.name)));
    const reasons = backends.flatMap((b) => b.reasons);
    const groups = backends.flatMap((b) => (b.group ? [b.group] : []));
    for (const { name, location } of groups) {
      const holder = holderOf('mig', location, name);
      if (holder) reasons.push(`managed group ${name} belongs to workload ${holder.workloadId}`);
    }
    if (groups.length && fallbackTypes.length) reasons.push(FALLBACK_REFUSAL_FOR_GROUPS);
    const unmanaged = new Set(backends.filter((b) => !b.group).flatMap((b) => b.members));
    // The unmanaged instance group naming each of those VMs (the first, for a VM in two): a nap stops only what is still in it.
    const groupOf = new Map();
    for (const b of backends.filter((x) => x.source)) for (const url of b.members) if (!groupOf.has(url)) groupOf.set(url, b.source);
    // A NEG's VMs: URL -> the NEGs naming it, in the order of the service's backends.
    const negsOf = new Map();
    for (const b of backends.filter((x) => x.neg)) for (const url of b.members) negsOf.set(url, [...(negsOf.get(url) ?? []), b.neg]);
    const machineTypes = new Map();
    // A managed group's members: its template's types, the group refused above when types are asked.
    const groupMembers = new Set(backends.filter((b) => b.group).flatMap((b) => b.members));
    // One read per VM, a VM in two groups of the service being one VM. A group lists a VM it is still creating.
    const read = await Promise.all([...new Set(backends.flatMap((b) => b.members))].map(async (url) => {
      const zone = zoneOf(url);
      const vm = await compute.getInstance(zone, nameOf(url)).catch(absent);
      if (!vm && negsOf.has(url)) reasons.push(`network endpoint group ${negsOf.get(url)[0].name} names the VM ${nameOf(url)}, which does not exist: remove the endpoint, then onboard again`);
      return vm && { url, zone, vm, problems: await vmProblems(vm, zone, machineTypes, groupMembers.has(url) ? [] : fallbackTypes) };
    }));
    const vms = [];
    // The NEGs of each VM that one names, by the VM's name: the nap checks them again.
    const negs = {};
    const memberOf = {};
    for (const { url, zone, vm, problems } of read.filter(Boolean)) {
      reasons.push(...problems);
      const owner = negsOf.has(url) && MANAGED_GROUP_OWNER.exec(vm.metadata?.items?.find((item) => item.key === 'created-by')?.value ?? '')?.[1];
      if (owner) reasons.push(`VM ${vm.name} is a member of managed group ${owner}, which would repair it once stopped: put the managed group in the backend service instead of its VM in a network endpoint group`);
      if (!unmanaged.has(url)) continue;
      const holder = holderOf('vm', zone, vm.name);
      if (holder) reasons.push(`VM ${vm.name} belongs to workload ${holder.workloadId}`);
      vms.push({ zone, name: vm.name, selfLink: vm.selfLink, id: String(vm.id) });
      if (negsOf.has(url)) negs[vm.name] = negsOf.get(url);
      else if (groupOf.has(url)) memberOf[vm.name] = groupOf.get(url);
    }
    // A VM's name is unique in its zone only, and the workload's records (its backends, the run's machine types, its NEGs and groups) are
    // keyed by it: a second VM of that name would take the first one's.
    const zonesOf = new Map();
    for (const { zone, name } of vms) zonesOf.set(name, new Set([...(zonesOf.get(name) ?? []), zone]));
    for (const [name, zones] of zonesOf) {
      const [first, second] = zones;
      if (second) reasons.push(`backend service ${service.name} has two VMs named ${name} (zones ${first} and ${second}): Dormeto records a workload's VMs by name; rename one`);
    }
    return { reasons, vms, groups, negs, memberOf };
  }

  // The companions asked for: what refuses them, and what the CLI tags.
  async function databasesOf(names, others) {
    const found = await Promise.all(names.map(async (name) => {
      const holder = others.find((c) => c.backends?.some((b) => isCompanion(b) && b.name === name));
      const { database, problem } = await companionRead(cloudsql, name);
      return { database, reasons: [...(holder ? [`Cloud SQL instance ${name} belongs to workload ${holder.workloadId}`] : []), ...(problem ? [problem] : [])] };
    }));
    return { reasons: found.flatMap((f) => f.reasons), databases: found.flatMap((f) => (f.database ? [f.database] : [])) };
  }

  // Section 8: what --gke-cluster says of the service's NEGs and of the cluster, from Google alone: what refuses them, `gke` the dry run's answer (with the cluster read) and `podNegs`.
  async function podsOf(service, asked, others, fallbackTypes = []) {
    const { cluster, owner } = asked;
    const [{ view, problem }, { reasons, negs, named }] = await Promise.all([clusterRead(gke, cluster), negsOfService(compute, service, asked)]);
    const place = { namespace: named?.namespace ?? asked.namespace ?? null, service: named?.service ?? asked.service ?? null };
    const inCluster = others.flatMap((c) => (c.backends ?? []).filter((b) => isPods(b) && sameCluster(b.cluster, cluster)).map((b) => ({ holder: c.workloadId, ...b })));
    const where = `GKE cluster ${cluster.location}/${cluster.name}`;
    const holdsService = inCluster.find((b) => b.namespace === place.namespace && b.service === place.service);
    const holdsOwner = owner && inCluster.find((b) => b.namespace === place.namespace && b.owner.kind === owner.kind && b.owner.name === owner.name);
    return {
      reasons: [
        ...(problem ? [problem] : []),
        ...reasons,
        ...(fallbackTypes.length ? [`fallback machine types are for VMs of unmanaged instance groups: the pods of a GKE cluster have no machine type of their own`] : []),
        ...(holdsService ? [`Service ${place.namespace}/${place.service} of ${where} belongs to workload ${holdsService.holder}`] : []),
        ...(holdsOwner ? [`${owner.kind} ${place.namespace}/${owner.name} of ${where} belongs to workload ${holdsOwner.holder}`] : []),
      ],
      vms: [],
      groups: [],
      negs: {},
      podNegs: negs,
      ...(view ? { gke: { cluster, ...place, autopilot: view.autopilot } } : {}),
    };
  }

  // Section 7: why the workload cannot be onboarded, its load balancer (`lb`, none when it cannot be told), its VMs, groups and databases, and with `gkeAsked` the NEGs. Reads only.
  async function inspect({ id, urlMap, backendService, loadBalancer, settings, cloudSql, gkeAsked, fallbackTypes = [] }) {
    const reasons = [];
    const configs = await store.listConfigs();
    const others = configs.filter((c) => c.workloadId !== id);
    if (others.length < configs.length) reasons.push(`workload ${id} is onboarded already`);
    const companions = await databasesOf(cloudSql, others);
    reasons.push(...companions.reasons);
    const { databases } = companions;
    const nothing = { vms: [], groups: [], negs: {}, memberOf: {}, databases };
    // Refused by its name, with nothing read or tried on it.
    const gkeMap = gkeMapRefusal(urlMap);
    if (gkeMap) return { reasons: [...reasons, gkeMap], ...nothing };
    const { map, regional, reason } = await findMap(urlMap, loadBalancer);
    if (!map) return { reasons: [...reasons, reason], ...nothing };
    const front = await loadBalancerOf(urlMap, regional, loadBalancer, map);
    if (front.gke) return { reasons: [...reasons, front.gke], ...nothing };
    reasons.push(...front.reasons);
    // Not told: the kind asked for, whose scope is the map's, else its scope's first.
    const kind = front.kind ?? loadBalancer ?? (regional ? 'regional' : 'global');
    const lb = regional ? { kind, region: config.region } : { kind };
    const told = front.kind ? { lb } : {};
    if (front.kind) reasons.push(...onboardSettingsProblems(settings, lb));

    // A backend service's name is unique in its scope.
    const owner = others.find((c) => c.backendService === backendService && isRegionalLb(c.lb ?? GLOBAL_LB) === regional);
    if (owner) reasons.push(`backend service ${backendService} is already workload ${owner.workloadId}`);
    const service = await getService(backendService, lb).catch(absent);
    if (!service) {
      reasons.push(`backend service ${backendService} not found: name ${regional ? `a regional backend service of ${config.region}` : 'a global backend service of this project'}`);
      return { reasons, ...told, ...nothing };
    }

    if (front.kind && service.loadBalancingScheme !== SCHEME_OF[kind]) reasons.push(`backend service ${backendService} has the scheme ${service.loadBalancingScheme}: the backend services of ${aKind(kind)} load balancer have ${SCHEME_OF[kind]}`);
    if (!references(map, backendService).length) reasons.push(`backend service ${backendService} is not named in URL map ${urlMap}: route to it there, or name the URL map that does`);
    for (const other of await mapsOf(lb).list()) {
      if (other.name !== urlMap && references(other, backendService).length) {
        reasons.push(`backend service ${backendService} is also named in URL map ${other.name}: that load balancer would lose its backends during a nap; give it a backend service of its own`);
      }
    }
    if (!service.healthChecks?.length) reasons.push(`backend service ${backendService} has no health check: a wake waits for a healthy instance, add one`);
    if (!service.backends?.length) reasons.push(`backend service ${backendService} has no backend: add an instance group, then onboard again`);

    const waker = wakerName(id);
    reasons.push(...mapProblems(map, backendService, wakerUrl(waker, lb), lb, id));
    const existing = await getService(waker, lb).catch(absent);
    if (existing && !isWakerOf(existing, id, lb)) {
      reasons.push(`backend service ${waker} exists and is not the waker of ${id}: rename it, or onboard under another id`);
    }

    const backends = await (gkeAsked ? podsOf(service, gkeAsked, others, fallbackTypes) : backendsOf(service, others, fallbackTypes));
    reasons.push(...backends.reasons);
    return {
      reasons,
      ...told,
      vms: backends.vms,
      groups: backends.groups,
      negs: backends.negs,
      memberOf: backends.memberOf ?? {},
      serviceBackends: (service.backends ?? []).map((b) => b.group).filter(Boolean).sort(),
      podNegs: backends.podNegs,
      ...(backends.gke ? { gke: backends.gke } : {}),
      databases,
      hosts: hostsOf(map, backendService),
      wakerExists: Boolean(existing),
    };
  }

  // The dry run with the request as read: AWS's preview answers both (`request`: the workload's id, name and tags, and the Google
  // Cloud resources it names). `dryRun` is the REST route's.
  async function dryRunOf(input) {
    const asked = requested(input);
    const request = {
      workloadId: asked.id, name: asked.name ?? asked.id, tags: asked.tags ?? {}, urlMap: asked.urlMap, backendService: asked.backendService, wakerBackendService: wakerName(asked.id),
    };
    return { request, answer: await dryRunAnswer(asked) };
  }
  const dryRun = async (input) => (await dryRunOf(input)).answer;

  // `warnings`: what does not refuse it, but its operator should know: spec section 8's limit of a Standard cluster, and a database's
  // replicas, which Google leaves running (M8).
  async function dryRunAnswer(asked) {
    const { reasons, vms, groups, databases, lb, gke: pods } = await inspect(asked);
    const warnings = [
      ...(pods && !pods.autopilot ? [`GKE cluster ${pods.cluster.location}/${pods.cluster.name} is a Standard cluster: scaling pods saves money only on Autopilot, or with the node autoscaler freeing a node; its fixed nodes are paid all the same`] : []),
      ...databases.filter((d) => d.replicas).map((d) => `Cloud SQL instance ${d.name} has read replicas (${d.replicas.join(', ')}): Google stops only the primary, its replicas keep running, and billing, while the workload sleeps`),
    ];
    return {
      eligible: reasons.length === 0,
      reasons,
      vms,
      groups,
      databases,
      ...(lb ? { lb } : {}),
      ...(pods ? { gke: pods } : {}),
      ...(warnings.length ? { warnings } : {}),
    };
  }

  // In one update, then the waker backend service: the route and the policy; under a swap, the application back wherever the map
  // is still swapped, the hold route and the route. What is gone already is no failure.
  // A delete refused as in use means a check wrote the route back between the update and the delete (it read the workload
  // before the offboarding began): the route goes again, and the delete is tried once more. Answers what it changed, as steps.
  async function removeFromGoogle({ urlMap, backendService, wakerBackendService: name, lb = GLOBAL_LB }) {
    const waker = wakerUrl(name, lb);
    let routeChanged = false;
    const removeRoute = async () => {
      const removed = await mapsOf(lb).modify(urlMap, (map) => {
        const steps = isSwapped(lb)
          ? [(m) => withoutSwap(m, backendService, waker), (m) => withoutHoldRoute(m, backendService, waker), (m) => withoutWakerRoute(m, waker)]
          : [(m) => withoutErrorPolicy(m, waker), (m) => withoutWakerRoute(m, waker)];
        return inOneUpdate(map, steps);
      }).catch(absent);
      routeChanged ||= Boolean(removed?.paths.length);
    };
    await removeRoute();
    const deleted = () => deleteService(name, lb).then(() => true);
    const wakerGone = await deleted().catch(async (err) => {
      if (err?.code !== 400 || err.reason !== 'resourceInUseByAnotherResource') return absent(err) ?? false;
      await removeRoute();
      return deleted().catch((again) => absent(again) ?? false);
    });
    return [stepOf('restore URL map', routeChanged, `URL map ${urlMap}`), stepOf('waker backend service', wakerGone, name)];
  }

  // Nothing of a failed onboarding stays: a waker backend service left would keep the NEG from being uninstalled.
  async function undo(cfg, cause) {
    const { workloadId } = cfg;
    try {
      await removeFromGoogle(cfg);
      await store.deleteWorkload(workloadId);
      log.warn('OnboardUndone', { workloadId, error: cause.message });
    } catch (err) {
      log.error('OnboardNotUndone', { workloadId, error: err.message, cause: cause.message });
    }
  }

  // The REST route's answer, the Workload; `onboardWithSteps` adds what it changed, as AWS's onboarder's steps.
  const onboard = async (input) => (await onboardWithSteps(input)).workload;

  async function onboardWithSteps(input) {
    const { id, name: personName, tags, source, urlMap, backendService, settings, loadBalancer, cloudSql, gkeAsked, requestLogs, fallbackTypes, by } = requested(input, { needsAll: true });
    if (await store.getConfig(id)) throw new Refusal(409, 'exists', `workload ${id} is onboarded already`);
    const { reasons, vms, groups, negs, memberOf, serviceBackends, podNegs, databases, hosts, wakerExists, lb } = await inspect({ id, urlMap, backendService, loadBalancer, settings, cloudSql, gkeAsked, fallbackTypes });
    if (reasons.length) throw new Refusal(400, 'not-eligible', `cannot onboard ${id}: ${reasons.join('; ')}`);
    // Spec section 8's shape, whatever else the request carried. The cluster last, and before anything is written: refused, the CLI takes back its RBAC.
    const pods = gkeAsked && {
      kind: 'k8s',
      cluster: { location: gkeAsked.cluster.location, name: gkeAsked.cluster.name },
      namespace: gkeAsked.namespace,
      service: gkeAsked.service,
      owner: { kind: gkeAsked.owner.kind, name: gkeAsked.owner.name },
    };
    if (pods) {
      const problems = await clusterProblems(clients, pods, podNegs);
      if (problems.length) throw new Refusal(400, 'not-eligible', `cannot onboard ${id}: ${problems.join('; ')}`);
    }
    // The level the answer resolves with, read before anything is written.
    const above = await levelsOf();
    const name = wakerName(id);
    const waker = wakerUrl(name, lb);
    // A setting sent null is left to the levels, as one not sent.
    const { hibernate, ...asked } = settings;
    const levels = Object.fromEntries(Object.entries(asked).filter(([, value]) => value !== null));
    const written = {
      workloadId: id,
      ...(personName ? { name: personName } : {}),
      ...(tags ? { tags } : {}),
      urlMap,
      backendService,
      wakerBackendService: name,
      hosts,
      ...(lb.kind === 'global' ? {} : { lb }),
      // What a nap checks again before it stops anything: the unmanaged groups' VMs and the service's backends as read now.
      ...(Object.keys(memberOf).length ? { groups: memberOf } : {}),
      ...(pods ? {} : { serviceBackends }),
      ...(fallbackTypes.length ? { fallbackInstanceTypes: fallbackTypes } : {}),
      ...(requestLogs ? { requestLogs: { before: { enable: requestLogs.before.enable, sampleRate: requestLogs.before.sampleRate } } } : {}),
      backends: [
        ...vms.map((vm) => ({
          kind: 'vm',
          location: vm.zone,
          name: vm.name,
          id: vm.id,
          // The NEGs naming it: a nap stops only what is still in them.
          ...(negs[vm.name] ? { neg: negs[vm.name][0], ...(negs[vm.name].length > 1 ? { moreNegs: negs[vm.name].slice(1) } : {}) } : {}),
        })),
        ...groups.map((g) => ({ kind: 'mig', location: g.location, name: g.name, id: g.id })),
        ...(pods ? [pods] : []),
        ...databases.map(({ name: database }) => ({ kind: 'cloudsql', name: database })),
      ],
      pollSeconds: POLL_SECONDS,
      noWakeRules: [],
      wakeRules: [],
      ...levels,
      ...(typeof hibernate === 'boolean' ? { hibernate } : {}),
      // What the onboarding is not given follows the levels (design section 4.1), G1's computed wake timeout included.
      inherits: SCALAR_KEYS.filter((key) => !Object.hasOwn(levels, key)),
      source,
      // Who asked, as AWS's: the manager's action names them; the CLI names no one.
      ...(by ? { onboardedBy: by } : {}),
      onboardedAt: isoOf(now()),
    };
    const builtIn = builtInsOf(written);
    const cfg = { ...written, ...Object.fromEntries(written.inherits.map((key) => [key, builtIn[key]])) };
    const steps = [];
    try {
      if (!wakerExists) {
        // M4 (the coverage design's section 10): Google takes a classic backend service with EXTERNAL and its two custom request
        // headers on the router's serverless NEG, and refuses those headers on a regional one, whose map carries them instead, as an
        // internal one's does. An internal one's waker is INTERNAL_MANAGED on the same NEG (to measure, M3: else the install makes a
        // second NEG for them).
        await insertService({
          name,
          ...(headersInMap(lb) ? { description: wakerDescription(id) } : {}),
          loadBalancingScheme: SCHEME_OF[lb.kind],
          protocol: 'HTTPS',
          backends: [{ group: `${COMPUTE}/projects/${config.project}/regions/${config.region}/networkEndpointGroups/${config.wakerNeg}` }],
          ...(headersInMap(lb) ? {} : { customRequestHeaders: wakerHeaders(id, lb) }),
        }, lb).catch(refusedByGoogle(id, `its waker backend service ${name}`));
      }
      steps.push(stepOf('waker backend service', !wakerExists, name));
      const { paths } = await mapsOf(lb).modify(urlMap, (map) => inOneUpdate(map, isSwapped(lb)
        ? [(m) => withWakerRoute(m, backendService, waker, mapHeaders(id, lb)), (m) => withHoldRoute(m, backendService, waker)]
        : [(m) => withWakerRoute(m, backendService, waker)])).catch(refusedByGoogle(id, `the update of URL map ${urlMap}`));
      steps.push(stepOf('instrument URL map', paths.length > 0, `URL map ${urlMap}`));
      await store.putConfig(id, cfg);
      await store.initRun(id, now());
      steps.push(stepOf('workload configuration', true));
    } catch (err) {
      await undo(cfg, err);
      if (err instanceof UrlMapRefused) throw new Refusal(400, 'not-eligible', `cannot onboard ${id}: ${err.message}`);
      throw err;
    }
    log.info('Onboarded', { workloadId: id, urlMap, backendService, by: by ?? 'unknown' });
    // The router's pause is shown; one that cannot be read leaves the answer of an onboarding that is done, as a list's rows do.
    const pauses = await core.pausesFor(id).catch((err) => {
      log.warn('PausesUnreadable', { workloadId: id, error: err.message });
      return [];
    });
    return { workload: workloadOf(cfg, pauses, await store.getRun(id), above), steps };
  }

  // The configuration, or a 400 or a 404.
  async function find(id) {
    const cfg = await store.getConfig(checkedId(id));
    if (!cfg) throw notFound(id);
    return cfg;
  }

  // The router level (`router/settings`), null when unset. A read that fails fails the request, as any other read of it.
  const routerLevel = async () => (await store.getRouterSettings()) ?? null;
  // The organization's level (`router/manager`, the manager's settings.json) as the shared levels read it: what AWS's manager settings
  // answer. One that cannot be read counts as unset and is said, as the join levels count it: a status or a settings answer is not
  // failed for it.
  const organizationLevel = async () => {
    try {
      return organizationOf((await store.getManagerSettings?.()) ?? null).level;
    } catch (err) {
      log.warn('SettingsLevelUnreadable', { level: 'organization', error: err.message });
      return null;
    }
  };
  const levelsOf = async () => {
    const [router, organization] = await Promise.all([routerLevel(), organizationLevel()]);
    return { router, organization };
  };

  // The VMs a wake left on a fallback machine type (`fallbacks`, fallbacksOf's), named in the offboarding's answer: no stop of the router's
  // gives them their own back once it is offboarded (vision docs/specs/2026-11-08-google-cloud-router-features-design.md, section 6).
  const onFallback = (run) => {
    const fallbacks = fallbacksOf(run);
    return fallbacks.length ? { fallbacks } : {};
  };

  // Back awake in this request, up to the wake's timeout: the VMs must be up once the policy goes and the CLI unbinds the tag.
  async function awaken(id, run) {
    const wakeId = await core.beginWake(id, run.state, 'offboarding');
    if (!wakeId) throw new Refusal(409, 'busy', `cannot offboard ${id}: its state just changed, try again`);
    const { state, error } = await core.wake(id, wakeId);
    if (state !== STATES.AWAKE) throw new Refusal(409, 'wake-failed', `cannot offboard ${id}: its wake failed: ${error ?? state}; fix that and try again, or offboard with --force, which leaves its backends down`);
  }

  // Running, as far as it can be read: anything else, a backend gone included, is not known to be up.
  async function isUp(backend, workloadId) {
    try {
      if (isCompanion(backend)) return statusOf(await cloudsql.get(backend.name)) === 'running';
      if (isPods(backend)) return (await ownerAsVm(clients, backend)).status === 'RUNNING';
      const statuses = backend.kind === 'mig'
        ? (await compute.listManagedInstances(groupOf(backend))).map((m) => m.instanceStatus)
        : [(await compute.getInstance(backend.location, backend.name)).status];
      return statuses.length > 0 && statuses.every((status) => status === 'RUNNING');
    } catch (err) {
      log.warn('BackendUnread', { workloadId, backend: backendText(backend), error: err.message });
      return false;
    }
  }

  // A workload that cannot wake, or whose state is stuck: no wake, and all of Dormeto's goes. The backends stay as they are,
  // and those not up are named. A nap in flight finds its waker backend service gone before it would stop anything, unless
  // it is already stopping them. What it cannot give back is named too, `notGivenBack`, in the operator's words: none, no field, and
  // the router will not try again; and the VMs on a fallback machine type, `fallbacks`. `left` stays what it was for a CLI below
  // this version.
  async function forceOff(cfg, run, by) {
    const { workloadId } = cfg;
    const up = await Promise.all(cfg.backends.map((backend) => isUp(backend, workloadId)));
    const left = cfg.backends.filter((_, i) => !up[i]);
    const notGivenBack = [];
    const givenBack = [];
    await Promise.all((run?.autoscalers ?? []).map((a) => compute.setAutoscalerMode(a, a.mode).then(() => givenBack.push(autoscalerText(a)), (err) => {
      log.warn('AutoscalerNotGivenBack', { workloadId, autoscaler: a.name, mode: a.mode, error: err.message });
      notGivenBack.push(`autoscaler ${a.name} (${a.location}) is still off: set its mode back to ${a.mode}`);
    })));
    // A give-back's failure needs a ScaledObject to give back.
    await Promise.all((run?.owners ?? []).map((record) => giveBackOwner(clients, record).then(() => givenBack.push(ownerText(record)), (err) => {
      log.warn('AutoscalerNotGivenBack', { workloadId, autoscaler: record.keda?.name, error: err.message });
      notGivenBack.push(pauseLeft(record));
    })));
    const restored = notGivenBack.length ? { name: 'restore autoscalers', status: 'failed', detail: notGivenBack.join('; ') } : stepOf('restore autoscalers', givenBack.length > 0, givenBack.join(', '));
    const google = await removeFromGoogle(cfg);
    await store.deleteWorkload(workloadId);
    // An owner left at 0: what it ran goes with the run, its record.
    const replicasBefore = (run?.owners ?? []).map((record) => ({ owner: ownerText(record), replicas: record.replicas }));
    log.warn('Offboarded', { workloadId, by: by ?? 'unknown', force: true, left: left.map(backendText), ...(replicasBefore.length ? { replicasBefore } : {}) });
    return {
      answer: { id: workloadId, left, ...(notGivenBack.length ? { notGivenBack } : {}), ...onFallback(run) },
      steps: [restored, ...google, stepOf('workload configuration', true)],
    };
  }

  // An offboarding that stops keeps the documents: they name what is left to remove when it runs again. Its answer names the VMs left on
  // a fallback machine type. The REST route's answer; `offboardWithSteps` adds what it undid, as AWS's onboarder's steps.
  const offboard = async (id, options) => (await offboardWithSteps(id, options)).answer;

  async function offboardWithSteps(id, { force = false, by } = {}) {
    const cfg = await find(id);
    let run = await store.getRun(id);
    if (force) return forceOff(cfg, run, by);
    if ([STATES.WAKING, STATES.NAPPING].includes(run?.state)) throw new Refusal(409, 'busy', `cannot offboard ${id}: it is ${run.state}, try again once it is done`);
    const asleep = run && run.state !== STATES.AWAKE ? run.state : null;
    if (asleep) {
      await awaken(id, run);
      run = await store.getRun(id);
    }
    // A mode the checks could not give back yet: its record goes with the run.
    await Promise.all([...(run?.autoscalers ?? []).map((a) => compute.setAutoscalerMode(a, a.mode)), ...(run?.owners ?? []).map((record) => giveBackOwner(clients, record))]);
    const givenBack = [...(run?.autoscalers ?? []).map(autoscalerText), ...(run?.owners ?? []).map(ownerText)];
    const google = await removeFromGoogle(cfg);
    await store.deleteWorkload(id);
    log.info('Offboarded', { workloadId: id, by: by ?? 'unknown' });
    return {
      answer: onFallback(run),
      steps: [
        stepOf('wake', Boolean(asleep), asleep && `from ${asleep}`), stepOf('restore autoscalers', givenBack.length > 0, givenBack.join(', ')), ...google,
        stepOf('workload configuration', true),
      ],
    };
  }

  // The Workload as it is now. `levels`: the router's and the organization's, already read.
  async function current(cfg, { levels } = {}) {
    const [run, pauses, read] = await Promise.all([store.getRun(cfg.workloadId), core.pausesFor(cfg.workloadId), levels ?? levelsOf()]);
    return workloadOf(cfg, pauses, run, read);
  }

  // The name people see, for a workload onboarded here (AWS's rename answer). A write racing an offboarding puts nothing back.
  async function setName(id, name, by) {
    const cfg = await find(id);
    const checked = checkName(name);
    if (!checked.name) throw bad('name: required');
    if (checked.problem) throw bad(checked.problem);
    if (!(await store.putConfig(cfg.workloadId, { ...cfg, name: checked.name }, { mustExist: true }))) throw notFound(id);
    log.info('Renamed', { workloadId: cfg.workloadId, name: checked.name, by });
    return { workloadId: cfg.workloadId, name: checked.name };
  }

  // The workload's tags, replaced whole (AWS's tag answer). This instance's events carry them from now on; the others' at their next check.
  async function setTags(id, tags, by) {
    const cfg = await find(id);
    const problem = tagsProblem(tags);
    if (problem) throw bad(problem);
    if (!(await store.putConfig(cfg.workloadId, { ...cfg, tags }, { mustExist: true }))) throw notFound(id);
    core.noteTags(cfg.workloadId, tags);
    log.info('Tagged', { workloadId: cfg.workloadId, tags, by });
    return { workloadId: cfg.workloadId, tags };
  }

  const show = async (id) => current(await find(id));

  async function list() {
    const [configs, levels] = await Promise.all([store.listConfigs(), levelsOf()]);
    const workloads = await Promise.all(configs.map((cfg) => current(cfg, { levels })));
    return workloads.sort((a, b) => a.id.localeCompare(b.id));
  }

  // Nap and wake now: `act` when the state allows it, nothing when it is there already, else a 409.
  async function move(id, { acts, there, act }) {
    const cfg = await find(id);
    const { state } = (await store.getRun(id)) ?? {};
    if (acts.includes(state)) await act(id, cfg);
    else if (state !== there) throw new Refusal(409, 'busy', `workload ${id} is ${state ?? 'UNKNOWN'}`);
    return current(cfg);
  }

  // Refused at once with its reason, as its task would be.
  async function napUnlessPaused(id) {
    const [paused] = await core.pausesFor(id);
    if (paused) throw new Refusal(409, 'paused', `workload ${id} is paused by ${paused.by}: ${paused.reason}`);
    await core.napNow(id);
  }

  const nap = (id) => move(id, { acts: [STATES.AWAKE], there: STATES.ASLEEP, act: napUnlessPaused });
  const wake = (id) => move(id, { acts: [STATES.ASLEEP, STATES.FAILED, STATES.NAPPING], there: STATES.AWAKE, act: (workloadId) => core.wakeNow(workloadId) });

  // A schedule's answer. One the router cannot read (a time zone Intl refuses) is shown, with no next event. Its joinMinutes as AWS's
  // answer resolves it: the schedule's own value, then the router level's (`router/settings`), then the organization's (`router/manager`), then the default
  // (design, section 11); a router level that cannot be read counts as unset, said in `JoinLevelUnreadable`, as AWS's join levels.
  async function scheduleView(id, schedule) {
    const shown = schedule && { ...schedule, at: isoOf(schedule.at) };
    const joins = await joinLevels({ router: () => store.getRouterSettings(), manager: async () => organizationOf((await store.getManagerSettings?.()) ?? null).level, log, fields: { workloadId: id } });
    const { joinMinutes, from } = resolveJoin({ workload: schedule?.joinMinutes, ...joins });
    const inherited = resolveJoin(joins);
    const join = { joinMinutes, joinFrom: from, joinInherited: { joinMinutes: inherited.joinMinutes, joinFrom: inherited.from } };
    try {
      return { schedule: shown, nextEvents: nextEvents(schedule, now(), { joinMinutes }), ...join };
    } catch (err) {
      log.warn('ScheduleSkipped', { workloadId: id, error: err.message });
      return { schedule: shown, nextEvents: [], ...join };
    }
  }

  async function showSchedule(id) {
    await find(id);
    return scheduleView(id, await store.getSchedule(id));
  }

  // The body is the schedule, as on AWS; `by` says who sets it. A refusal names every problem, as AWS's schedule action answers them.
  async function setSchedule(id, schedule) {
    await find(id);
    const problems = scheduleProblems(schedule, { now: now() });
    if (problems.length) throw refusedSettings(problems);
    const stored = { ...normalizeSchedule(schedule), by: schedule.by ?? 'unknown', at: now() };
    await store.putSchedule(id, stored);
    log.info('Scheduled', { workloadId: id, by: stored.by });
    return scheduleView(id, stored);
  }

  // AWS's clear-schedule answer, `{ cleared }`: whether there was one. `by` says who clears it.
  async function deleteSchedule(id, { by } = {}) {
    await find(id);
    const cleared = await store.deleteSchedule(id);
    log.info('ScheduleCleared', { workloadId: id, cleared, ...(by ? { by } : {}) });
    return { cleared };
  }

  async function clearSchedule(id) {
    await deleteSchedule(id);
    return scheduleView(id, null);
  }

  // The Workload with its pause, and the workloads the pause woke, `woken`, as the pause action answers them.
  async function pause(id, input) {
    const cfg = await find(id);
    const { woken } = await core.pause(id, input).catch((err) => {
      if (err instanceof PauseRefused) throw bad(err.message);
      throw err;
    });
    return { ...(await current(cfg)), woken };
  }

  async function resume(id, { by } = {}) {
    const cfg = await find(id);
    await core.resume(id, by ?? 'unknown');
    return current(cfg);
  }

  // The router-wide pause (`router/pause`), for `POST /v1/pause` and `/v1/resume` without a workload: AWS's `pause` and `resume` actions'
  // answers, `{ pause, woken }` and `{ resumed }`.
  async function pauseRouter(input) {
    return core.pause(null, input ?? {}).catch((err) => {
      if (err instanceof PauseRefused) throw bad(err.message);
      throw err;
    });
  }

  async function resumeRouter({ by } = {}) {
    return core.resume(null, by ?? 'unknown');
  }

  // AWS's settings action for a workload, its write shared (settings-writes.mjs): `hibernate` (null removes it), the settings of the
  // levels (null gives the key back to the levels, its value without any level written for a router before G5), the rules (null: none)
  // and the type (null: inherited). Every workload here is the CLI's: no Terraform writes one, so none is refused as on AWS. `by` says
  // who sets them, as a schedule's. A refusal names every problem, with nothing written; a workload offboarded meanwhile is a 404,
  // never written back.
  async function setSettings(id, { by, ...settings }) {
    const cfg = await find(id);
    const problems = workloadProblems(settings, cfg);
    if (problems.length) throw refusedSettings(problems);
    // A configuration from before `inherits` is read as effectiveOf reads it (design section 4.1). Once it has `inherits`, it is the
    // CLI's, as an onboarding writes it.
    const next = withSettings(cfg, settings, { inheritsOf, builtIns: builtInsOf });
    if (Object.hasOwn(next, 'inherits')) next.source ??= 'cli';
    // The level the answer resolves with, read before the write: a failed read changes nothing.
    const levels = await levelsOf();
    if (!(await store.putConfig(id, next, { mustExist: true }))) throw notFound(id);
    log.info('WorkloadSettings', { workloadId: id, keys: Object.keys(settings), hibernate: next.hibernate ?? null, previous: cfg.hibernate ?? null, by: by ?? 'unknown' });
    return { level: 'workload', settings: { ...settings }, hibernation: hibernationOf(next, levels.router, levels.organization), resolved: resolvedSettings(effectiveOf(next, levels)) };
  }

  const routerSettings = async () => ({ level: 'router', settings: routerSettingsView(await routerLevel()) });

  // AWS's settings action without a workload, its merge shared (settings-writes.mjs): `hibernate`, `joinMinutes` and the `defaults` of
  // the router's workloads, merged with what it holds; none left, no record. An empty body reads. `by` says who sets them, as a
  // schedule's. A refusal names every problem, with nothing written.
  async function setRouterSettings({ by, ...settings }) {
    const problems = routerProblems(settings);
    if (problems.length) throw refusedSettings(problems);
    // A record that cannot be read is not written over.
    const stored = await routerLevel();
    if (!Object.keys(settings).length) return { level: 'router', settings: routerSettingsView(stored) };
    const record = mergedRouterSettings(stored, settings, { by: by ?? 'unknown', at: now() });
    await store.putRouterSettings(record);
    log.info('RouterSettings', { hibernate: record.hibernate, joinMinutes: record.joinMinutes, defaults: record.defaults ? Object.keys(record.defaults) : [], by: record.by });
    return { level: 'router', settings: writtenRouterView(record) };
  }

  // The organization's page, the waitingPage of the manager's settings.json in router/manager (organizationOf's), as AWS's view reads
  // it (lambda/src/lib/controller-core.mjs's pageView): one that cannot be read is none, and said.
  const organizationPage = () => Promise.resolve().then(() => store.getManagerSettings?.()).then((stored) => organizationOf(stored ?? null).page).catch((err) => {
    log.warn('WaitingPageUnread', { level: 'organization', error: String(err?.message ?? err).slice(0, 200) });
    return null;
  });

  // A level's page as AWS's action answers it, the organization's level above the router's. No workload here is Terraform's. A custom
  // page the switch keeps from visitors, at any level, is resolved without, as the waker does not serve it; the level's own is still
  // shown, said not served.
  async function pageView(level) {
    const workloadId = level === 'router' ? null : level.workloadId;
    const [organization, router, favicon] = await Promise.all([organizationPage(), store.getWaitingPage('router'), workloadId ? store.getFavicon(workloadId) : null]);
    const own = workloadId ? await store.getWaitingPage(level) : router;
    const view = pageViewOf({ organization, router, own, favicon, workload: Boolean(workloadId), served: servedPage(customPages) });
    return notServed(customPages, own?.page) ? { ...view, warnings: [CUSTOM_PAGE_NOT_SERVED, ...view.warnings] } : view;
  }

  // AWS's waiting-page action: `level` is 'router' or { workloadId } (as the store's), `op` get, put or delete. A put refused names
  // every problem, with nothing written; a custom one needs the switch. `by` says who sets it, as a schedule's. The log holds the size
  // and the SHA-256 of a custom page, never the page.
  async function waitingPage(level, { op, page, by } = {}) {
    const workloadId = level === 'router' ? null : level.workloadId;
    // As AWS's: who sets the page is asked before the workload is looked up.
    if (op === 'put' && (typeof by !== 'string' || !by)) throw bad('a put needs by: who sets the page');
    if (workloadId !== null) await find(workloadId);
    const fields = { level: workloadId ? 'workload' : 'router', workloadId, by: by ?? 'unknown' };
    switch (op) {
      case 'get':
        break;
      case 'put': {
        const problems = [...(page?.mode === 'custom' && !customPages ? [CUSTOM_PAGES_REFUSED] : []), ...validatePage(page)];
        if (problems.length) throw refusedSettings(problems);
        await store.putWaitingPage(level, page, { by: fields.by, at: now() });
        const custom = page.mode === 'custom';
        log.info('WaitingPageSet', {
          ...fields, mode: page.mode, bytes: custom ? Buffer.byteLength(page.html) : undefined, sha256: custom ? createHash('sha256').update(page.html).digest('hex') : undefined,
        });
        break;
      }
      case 'delete':
        log.info('WaitingPageCleared', { ...fields, cleared: await store.deleteWaitingPage(level) });
        break;
      default:
        throw bad(`unknown waiting-page op: ${op}`);
    }
    return pageView(level);
  }

  return {
    dryRun, dryRunOf, onboard, onboardWithSteps, offboard, offboardWithSteps, find, setName, setTags, show, list, nap, wake, showSchedule, setSchedule, clearSchedule, deleteSchedule, pause, resume, pauseRouter, resumeRouter, setSettings,
    routerSettings, setRouterSettings, waitingPage,
  };
}
