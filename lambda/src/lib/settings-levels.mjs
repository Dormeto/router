// A workload's settings at scale (vision settings at scale design §4–§7): each field from the most specific level that
// sets it, workload → type → router → organization → built-in; the rules of every level add up. Pure but for the levels'
// reader, which each cloud gives its reads (the router's record, its copy of the manager's settings.json).
import { compileRules, describeRules } from './no-wake.mjs';

export const SETTING_RANGES = {
  idleMinutes: [5, 1440], waitSeconds: [5, 120], drainSeconds: [0, 300], wakeTimeoutSeconds: [60, 3600], maxHolders: [1, 500], failedRetrySeconds: [10, 600],
};
export const BUILT_IN = { idleMinutes: 15, waitSeconds: 60, drainSeconds: 30, wakeTimeoutSeconds: 600, maxHolders: 50, failedRetrySeconds: 60, wakeMode: 'any' };
export const SCALAR_KEYS = Object.keys(BUILT_IN);
export const RULE_KEYS = ['noWakeRules', 'wakeRules'];
export const WAKE_MODES = ['any', 'browser'];
// A slow start (RDS, Aurora) waits longer; never shorter than 600 for a type (design §4: Kubernetes keeps 600).
export const TYPE_BUILT_IN = { databases: { wakeTimeoutSeconds: 1800 } };
export const BUILT_IN_TYPES = ['instance', 'asg', 'ecs', 'k8s', 'databases'];
// A standalone workload's settings (vision standalone workloads design §4): its idle window, its wake timeout and its three
// idle signals; it has no waker, so none of the waker's keys and no rule. `off` turns an inherited signal off.
export const STANDALONE_BUILT_IN = { idleMinutes: 120, wakeTimeoutSeconds: 600, idleCpuPercent: 5, idleNetworkBytes: 'off', idleMetric: 'off' };
export const STANDALONE_KEYS = Object.keys(STANDALONE_BUILT_IN);
export const IDLE_KEYS = ['idleCpuPercent', 'idleNetworkBytes', 'idleMetric'];
// The waker's keys: an HTTP workload's that a standalone one has not.
export const WAKER_KEYS = [...SCALAR_KEYS.filter((key) => !STANDALONE_KEYS.includes(key)), ...RULE_KEYS];
export const IDLE_METRIC_STATISTICS = ['Maximum', 'Average', 'Sum'];
export const IDLE_NETWORK_BYTES_MAX = 10_000_000_000;
const DIMENSIONS_MAX = 30;
const RESOURCE = '${resource}';
// A record without `kind` is an HTTP workload's (released routers wrote none).
export const kindOf = (cfg) => (cfg?.kind === 'standalone' ? 'standalone' : 'http');
export const keysOf = (kind) => (kind === 'standalone' ? STANDALONE_KEYS : SCALAR_KEYS);
export const RULES_MAX = 20;
export const TYPES_MAX = 20;
const TYPE_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const RULE_NAME_MAX = 64;
const DESCRIPTION_MAX = 200;

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const isSet = (value) => value !== undefined && value !== null;
const isTypeName = (value) => typeof value === 'string' && (TYPE_NAME.test(value) || BUILT_IN_TYPES.includes(value));

// A standalone workload's resource as a backend kind (design §2's resources), from its ARN; null for another.
export function resourceKindOf(arn) {
  const match = /^arn:aws[\w-]*:([a-z0-9-]+):[^:]*:[^:]*:(.+)$/.exec(typeof arn === 'string' ? arn : '');
  if (!match) return null;
  const [, service, resource] = match;
  if (service === 'ec2' && resource.startsWith('instance/')) return { kind: 'instance', id: resource.slice('instance/'.length) };
  if (service === 'autoscaling' && resource.includes(':autoScalingGroupName/')) return { kind: 'asg', id: resource.slice(resource.indexOf(':autoScalingGroupName/') + ':autoScalingGroupName/'.length) };
  if (service === 'ecs' && resource.startsWith('service/')) return { kind: 'ecs', id: resource.slice('service/'.length) };
  if (service === 'rds' && resource.startsWith('db:')) return { kind: 'rds-instance', id: resource.slice('db:'.length) };
  if (service === 'rds' && resource.startsWith('cluster:')) return { kind: 'rds-cluster', id: resource.slice('cluster:'.length) };
  return null;
}

// The database whose connections say a standalone workload of the type databases is idle: its resource when it is one, else
// its first companion; null without one.
function databaseOf(cfg) {
  const own = resourceKindOf(cfg?.resourceArn);
  if (own?.kind.startsWith('rds-')) return own;
  const companion = Array.isArray(cfg?.databases) ? cfg.databases.find((db) => isObject(db) && typeof db.id === 'string') : null;
  return companion ? { kind: companion.kind === 'rds-cluster' ? 'rds-cluster' : 'rds-instance', id: companion.id } : null;
}

const connectionsOf = (database) => ({
  namespace: 'AWS/RDS', name: 'DatabaseConnections', dimensions: { [database.kind === 'rds-cluster' ? 'DBClusterIdentifier' : 'DBInstanceIdentifier']: database.id }, statistic: 'Maximum', below: 1,
});

// Each key's built-in value for a kind and a built-in type. A standalone workload of the type databases: the slow start's wake
// timeout, CPU off (an idle database's CPU is not near zero) and its database's connections under 1.
function builtInsOf(kind, typeName, database) {
  if (kind !== 'standalone') return Object.fromEntries(SCALAR_KEYS.map((key) => [key, TYPE_BUILT_IN[typeName]?.[key] ?? BUILT_IN[key]]));
  if (typeName !== 'databases') return { ...STANDALONE_BUILT_IN };
  return { ...STANDALONE_BUILT_IN, ...TYPE_BUILT_IN.databases, idleCpuPercent: 'off', idleMetric: database ? connectionsOf(database) : 'off' };
}

// Derived from the kinds the last check found, else from the configuration: databases first (the slow start decides). A
// standalone workload's resource is one of its kinds.
export function builtInTypeOf(cfg, run) {
  const resource = resourceKindOf(cfg?.resourceArn)?.kind;
  const kinds = [...(typeof run?.backendKinds === 'string' ? run.backendKinds.split(',') : []), ...(resource ? [resource] : [])];
  if (kinds.some((k) => k.startsWith('rds-')) || (Array.isArray(cfg?.databases) && cfg.databases.length)) return 'databases';
  const primary = ['instance', 'asg', 'ecs', 'k8s'].find((k) => kinds.includes(k));
  if (primary) return primary;
  return cfg?.kubernetes ? 'k8s' : null;
}

const custom = (types) => (Array.isArray(types) ? types.filter((t) => isObject(t) && !BUILT_IN_TYPES.includes(t.name)) : []);
const selects = (selector, tags) => isObject(selector) && Object.keys(selector).length > 0 && Object.entries(selector).every(([k, v]) => tags?.[k] === v);

// Its own type (a known name), else the first custom type its tags match, else its built-in type; a lost name is said.
export function typeOf(cfg, run, types) {
  const customs = custom(types);
  const own = cfg?.type;
  let missing;
  if (typeof own === 'string' && own) {
    if (BUILT_IN_TYPES.includes(own) || customs.some((t) => t.name === own)) return { name: own, from: 'workload' };
    missing = own;
  }
  const lost = missing ? { missing } : {};
  const matched = customs.find((t) => selects(t.tags, cfg?.tags));
  if (matched) return { name: matched.name, from: 'tags', ...lost };
  const builtIn = builtInTypeOf(cfg, run);
  return builtIn ? { name: builtIn, from: 'backends', ...lost } : { name: null, from: null, ...lost };
}

// What the onboarder wrote before `inherits` (design §7): a manager configuration without it inherits what equals these.
const legacyDefault = (cfg, key) => {
  if (key !== 'wakeTimeoutSeconds') return BUILT_IN[key];
  if (Array.isArray(cfg.databases) && cfg.databases.length) return 1800;
  return cfg.kubernetes ? 300 : 600;
};

// The workload level: its own scalar values, without those it leaves to the levels.
export function ownSettings(cfg) {
  const own = {};
  const inherits = Array.isArray(cfg?.inherits) ? cfg.inherits : null;
  const kind = kindOf(cfg);
  for (const key of keysOf(kind)) {
    if (!isSet(cfg?.[key])) continue;
    if (inherits ? inherits.includes(key) : kind === 'http' && cfg.source === 'manager' && cfg[key] === legacyDefault(cfg, key)) continue;
    own[key] = cfg[key];
  }
  return own;
}

// Each scalar of its kind's from the first level that sets it, else the type's built-in value, else the built-in value; `off`
// is a value like any other (the signal's reader says it does not apply). `database`: a standalone workload's, for the type
// databases' connections.
export function resolveSettings({ own = {}, type = {}, router = {}, organization = {}, typeName = null, kind = 'http', database = null } = {}) {
  const values = {};
  const from = {};
  const levels = [['workload', own], ['type', type], ['router', router], ['organization', organization]];
  const builtIns = builtInsOf(kind, typeName, database);
  for (const key of keysOf(kind)) {
    const level = levels.find(([, set]) => isSet(set?.[key]));
    if (level) {
      values[key] = level[1][key];
      from[key] = level[0];
    } else {
      values[key] = builtIns[key];
      from[key] = 'default';
    }
  }
  return { values, from };
}

// What `null` gives back to the levels writes for an older router: each key's built-in value, its kind's and its built-in type's.
export const builtInSettingsOf = (cfg) => builtInsOf(kindOf(cfg), builtInTypeOf(cfg, null), databaseOf(cfg));

// The configuration a wake, a nap, a check, a status or a request acts on: the stored one with each scalar resolved, where
// each comes from, the type, and the rules of every level, the most general first (the first that matches decides).
// router: ROUTER/SETTINGS ({ defaults }); organization: the mirror of settings.json ({ defaults, types }); either null.
export function effectiveConfig(cfg, { run = null, router = null, organization = null, terraformRules = [] } = {}) {
  const types = Array.isArray(organization?.types) ? organization.types : [];
  const type = typeOf(cfg, run, types);
  const typeSettings = types.find((t) => isObject(t) && t.name === type.name)?.settings ?? {};
  // The built-in values follow the backends, whatever type picks the workload: a slow start stays slow (review, 2026-11-04).
  const kind = kindOf(cfg);
  const { values, from } = resolveSettings({
    own: ownSettings(cfg), type: typeSettings, router: router?.defaults, organization: organization?.defaults, typeName: builtInTypeOf(cfg, run), kind, database: databaseOf(cfg),
  });
  // A standalone workload has no waker: no rule of any level applies to it.
  if (kind === 'standalone') return { ...cfg, ...values, settingsFrom: from, type, ruleLevels: { noWake: [], wake: [] } };
  const levels = (key, routerOwn = []) => [
    ['organization', organization?.defaults?.[key]], ['router', routerOwn, true], ['router', router?.defaults?.[key]], ['type', typeSettings[key]], ['workload', cfg?.[key]],
  ].filter(([, rules]) => Array.isArray(rules) && rules.length).map(([level, rules, terraform]) => ({ level, rules, ...(terraform ? { terraform: true } : {}) }));
  return { ...cfg, ...values, settingsFrom: from, type, ruleLevels: { noWake: levels('noWakeRules', terraformRules), wake: levels('wakeRules') } };
}

// The levels above a workload's own settings, both routers' reader (design §6; review, 2026-11-04): each level's record read fresh at
// each call (a check reads them once for all its workloads). A read that fails is said and keeps the last record this instance read;
// a level never read makes the levels unreadable: the check then takes no idle nap or failure decision and a wake waits the longest
// timeout. `readers`: `{ [level]: () => record }`, each cloud's reads, called at each call (nothing answered: the level has none).
// Answers each level's record or null, `unreadable: true` when a level that failed was never read, and `errors`, each failed read's
// message, when one failed; the failures said in the levels' order.
export function createLevelsReader(readers, { log }) {
  const last = {};
  return async function readLevels() {
    const levels = Object.keys(readers);
    const reads = await Promise.allSettled(levels.map((level) => Promise.resolve().then(() => readers[level]())));
    const answer = {};
    const errors = {};
    let unreadable = false;
    levels.forEach((level, i) => {
      if (reads[i].status === 'fulfilled') last[level] = reads[i].value ?? null;
      else {
        log.warn('SettingsLevelUnreadable', { level, error: reads[i].reason.message });
        errors[level] = reads[i].reason.message;
        if (!(level in last)) unreadable = true;
      }
      answer[level] = last[level] ?? null;
    });
    return { ...answer, ...(unreadable ? { unreadable: true } : {}), ...(Object.keys(errors).length ? { errors } : {}) };
  };
}

function rulesProblems(key, rules) {
  if (!Array.isArray(rules)) return [`${key} must be a list of rules`];
  if (rules.length > RULES_MAX) return [`${key}: at most ${RULES_MAX} rules`];
  const problems = [];
  for (const rule of rules) {
    if (!isObject(rule) || typeof rule.name !== 'string' || !rule.name.trim() || rule.name.length > RULE_NAME_MAX) {
      problems.push(`${key}: each rule needs a name (at most ${RULE_NAME_MAX} characters)`);
      continue;
    }
    compileRules([rule], { onInvalid: (r, message) => problems.push(`${key}: rule ${r.name}: ${message}`) });
  }
  return problems;
}

const isText = (value, max) => typeof value === 'string' && value.length >= 1 && value.length <= max;

// idleMetric (design §4): off, or one CloudWatch metric and its threshold, `${resource}` the only value replaced.
function idleMetricProblems(value) {
  if (value === 'off') return [];
  if (!isObject(value)) return ['idleMetric: must be off or a metric { namespace, name, dimensions, statistic, below }'];
  const problems = [];
  const fields = ['namespace', 'name', 'dimensions', 'statistic', 'below'];
  problems.push(...Object.keys(value).filter((key) => !fields.includes(key)).map((key) => `idleMetric: unknown field ${key}`));
  if (!isText(value.namespace, 255)) problems.push('idleMetric: namespace must be text of 1 to 255 characters');
  if (!isText(value.name, 255)) problems.push('idleMetric: name must be text of 1 to 255 characters');
  const { dimensions } = value;
  if (!isObject(dimensions) || Object.keys(dimensions).length > DIMENSIONS_MAX || !Object.entries(dimensions).every(([name, v]) => isText(name, 255) && isText(v, 1024))) {
    problems.push(`idleMetric: dimensions must be an object of at most ${DIMENSIONS_MAX} names, each with text of 1 to 1024 characters`);
  } else if (Object.values(dimensions).some((v) => v.replaceAll(RESOURCE, '').includes('${'))) problems.push(`idleMetric: dimensions: only ${RESOURCE} is replaced`);
  if (!IDLE_METRIC_STATISTICS.includes(value.statistic)) problems.push(`idleMetric: statistic must be ${IDLE_METRIC_STATISTICS.slice(0, -1).join(', ')} or ${IDLE_METRIC_STATISTICS.at(-1)}`);
  if (typeof value.below !== 'number' || !Number.isFinite(value.below)) problems.push('idleMetric: below must be a number');
  return problems;
}

function idleProblems(key, value) {
  if (key === 'idleMetric') return idleMetricProblems(value);
  if (value === 'off') return [];
  if (key === 'idleCpuPercent') return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? [] : ['idleCpuPercent: must be a number from 0 to 100, or off'];
  return Number.isInteger(value) && value >= 0 && value <= IDLE_NETWORK_BYTES_MAX ? [] : [`idleNetworkBytes: must be a whole number from 0 to ${IDLE_NETWORK_BYTES_MAX}, or off`];
}

// A key the workload's kind has not: the waker's for a standalone workload, the idle signals for an HTTP one (design §2, §4).
export const notForKind = (key, kind) => (kind === 'standalone'
  ? `${key}: a standalone workload has no waker: ${key} is for an HTTP workload`
  : `${key}: an HTTP workload naps on its requests: the idle signals are for a standalone workload`);

// A level's settings (null unsets a key); `type` only at a workload's. `idle`: the idle signals are known (AWS's levels: a type, the
// router or the organization may hold both kinds' keys, each applying to its kind); without, they are unknown settings, as on
// Google Cloud. `kind`: a workload's, which refuses the other kind's keys whatever their value.
export function defaultsProblems(defaults, { workload = false, idle = false, kind = null } = {}) {
  if (!isObject(defaults)) return ['settings must be an object'];
  const problems = [];
  const idleKnown = idle || kind !== null;
  for (const [key, value] of Object.entries(defaults)) {
    if (kind !== null && (kind === 'standalone' ? WAKER_KEYS : IDLE_KEYS).includes(key)) {
      problems.push(notForKind(key, kind));
      continue;
    }
    if (idleKnown && IDLE_KEYS.includes(key)) {
      if (value !== null) problems.push(...idleProblems(key, value));
      continue;
    }
    if (value === null && (SCALAR_KEYS.includes(key) || RULE_KEYS.includes(key) || (workload && key === 'type'))) continue;
    if (SETTING_RANGES[key]) {
      const [min, max] = SETTING_RANGES[key];
      if (!Number.isInteger(value) || value < min || value > max) problems.push(`${key}: must be a whole number from ${min} to ${max}`);
    } else if (key === 'wakeMode') {
      if (!WAKE_MODES.includes(value)) problems.push('wakeMode: must be any or browser');
    } else if (RULE_KEYS.includes(key)) {
      problems.push(...rulesProblems(key, value));
    } else if (key === 'type' && workload) {
      if (!isTypeName(value)) problems.push('type: must be a type\'s name (lower-case letters, digits and hyphens) or null');
    } else problems.push(`unknown setting ${key}`);
  }
  return problems;
}

// The organization's types: the built-in ones' defaults (no tags) and at most 20 custom ones, each selected by its tags.
export function typesProblems(types, { idle = false } = {}) {
  if (!Array.isArray(types)) return ['types must be a list'];
  if (custom(types).length > TYPES_MAX) return [`at most ${TYPES_MAX} custom types`];
  const problems = [];
  const seen = new Set();
  for (const type of types) {
    if (!isObject(type) || typeof type.name !== 'string') {
      problems.push('each type needs a name');
      continue;
    }
    const at = `type ${type.name}`;
    if (seen.has(type.name)) problems.push(`${at}: named twice`);
    seen.add(type.name);
    if (BUILT_IN_TYPES.includes(type.name)) {
      if (isSet(type.tags) && !(isObject(type.tags) && !Object.keys(type.tags).length)) problems.push(`${at}: a built-in type has no tags`);
    } else {
      if (!TYPE_NAME.test(type.name)) problems.push(`${at}: a name is lower-case letters, digits and hyphens, starting with a letter (at most 32)`);
      if (!isObject(type.tags) || !Object.keys(type.tags).length || !Object.values(type.tags).every((v) => typeof v === 'string')) {
        problems.push(`${at}: tags must select at least one tag (key and value)`);
      }
    }
    if (isSet(type.description) && (typeof type.description !== 'string' || type.description.length > DESCRIPTION_MAX)) {
      problems.push(`${at}: description must be text of at most ${DESCRIPTION_MAX} characters`);
    }
    if (isSet(type.settings)) problems.push(...defaultsProblems(type.settings, { idle }).map((p) => `${at}: settings: ${p}`));
  }
  return problems;
}

// For people (the status, the router's admin page): each no-wake rule with its level, each wake rule with the level it
// comes from (`level: 'wake'` as before, `from` the level).
export function describedRules(cfg) {
  return {
    // The router's own rules from its Terraform (no_wake_rules) say so (design §6).
    noWakeRules: cfg.ruleLevels.noWake.flatMap(({ level, rules, terraform }) => describeRules([{ level, rules }]).map((rule) => (terraform ? { ...rule, terraform: true } : rule))),
    wakeRules: cfg.ruleLevels.wake.flatMap(({ level, rules }) => describeRules([{ level: 'wake', rules }]).map((rule) => ({ ...rule, from: level }))),
  };
}
