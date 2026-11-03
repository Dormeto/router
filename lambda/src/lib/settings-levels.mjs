// A workload's settings at scale (vision settings at scale design §4–§7): each field from the most specific level that
// sets it, workload → type → router → organization → built-in; the rules of every level add up. Pure: the levels are
// read elsewhere (the router's record, its mirror of the manager's settings.json).
import { compileRules } from './no-wake.mjs';

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
export const RULES_MAX = 20;
export const TYPES_MAX = 20;
const TYPE_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const RULE_NAME_MAX = 64;
const DESCRIPTION_MAX = 200;

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const isSet = (value) => value !== undefined && value !== null;
const isTypeName = (value) => typeof value === 'string' && (TYPE_NAME.test(value) || BUILT_IN_TYPES.includes(value));

// Derived from the kinds the last check found, else from the configuration: databases first (the slow start decides).
export function builtInTypeOf(cfg, run) {
  const kinds = typeof run?.backendKinds === 'string' ? run.backendKinds.split(',') : [];
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
  for (const key of SCALAR_KEYS) {
    if (!isSet(cfg?.[key])) continue;
    if (inherits ? inherits.includes(key) : cfg.source === 'manager' && cfg[key] === legacyDefault(cfg, key)) continue;
    own[key] = cfg[key];
  }
  return own;
}

// Each scalar from the first level that sets it, else the type's built-in value, else the built-in value.
export function resolveSettings({ own = {}, type = {}, router = {}, organization = {}, typeName = null } = {}) {
  const values = {};
  const from = {};
  const levels = [['workload', own], ['type', type], ['router', router], ['organization', organization]];
  for (const key of SCALAR_KEYS) {
    const level = levels.find(([, set]) => isSet(set?.[key]));
    if (level) {
      values[key] = level[1][key];
      from[key] = level[0];
    } else {
      values[key] = TYPE_BUILT_IN[typeName]?.[key] ?? BUILT_IN[key];
      from[key] = 'default';
    }
  }
  return { values, from };
}

// The configuration a wake, a nap, a check, a status or a request acts on: the stored one with each scalar resolved, where
// each comes from, the type, and the rules of every level, the most general first (the first that matches decides).
// router: ROUTER/SETTINGS ({ defaults }); organization: the mirror of settings.json ({ defaults, types }); either null.
export function effectiveConfig(cfg, { run = null, router = null, organization = null, terraformRules = [] } = {}) {
  const types = Array.isArray(organization?.types) ? organization.types : [];
  const type = typeOf(cfg, run, types);
  const typeSettings = types.find((t) => isObject(t) && t.name === type.name)?.settings ?? {};
  const { values, from } = resolveSettings({ own: ownSettings(cfg), type: typeSettings, router: router?.defaults, organization: organization?.defaults, typeName: type.name });
  const levels = (key, routerOwn = []) => [
    ['organization', organization?.defaults?.[key]], ['router', routerOwn], ['router', router?.defaults?.[key]], ['type', typeSettings[key]], ['workload', cfg?.[key]],
  ].filter(([, rules]) => Array.isArray(rules) && rules.length).map(([level, rules]) => ({ level, rules }));
  return { ...cfg, ...values, settingsFrom: from, type, ruleLevels: { noWake: levels('noWakeRules', terraformRules), wake: levels('wakeRules') } };
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

// A level's settings (null unsets a key); `type` only at a workload's.
export function defaultsProblems(defaults, { workload = false } = {}) {
  if (!isObject(defaults)) return ['settings must be an object'];
  const problems = [];
  for (const [key, value] of Object.entries(defaults)) {
    if (value === null && (SCALAR_KEYS.includes(key) || RULE_KEYS.includes(key) || (workload && key === 'type'))) continue;
    if (SETTING_RANGES[key]) {
      const [min, max] = SETTING_RANGES[key];
      if (!Number.isInteger(value) || value < min || value > max) problems.push(`${key} must be a whole number from ${min} to ${max}`);
    } else if (key === 'wakeMode') {
      if (!WAKE_MODES.includes(value)) problems.push('wakeMode must be any or browser');
    } else if (RULE_KEYS.includes(key)) {
      problems.push(...rulesProblems(key, value));
    } else if (key === 'type' && workload) {
      if (!isTypeName(value)) problems.push('type must be a type\'s name (lower-case letters, digits and hyphens) or null');
    } else problems.push(`unknown setting ${key}`);
  }
  return problems;
}

// The organization's types: the built-in ones' defaults (no tags) and at most 20 custom ones, each selected by its tags.
export function typesProblems(types) {
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
    if (isSet(type.settings)) problems.push(...defaultsProblems(type.settings).map((p) => `${at}: settings: ${p}`));
  }
  return problems;
}
