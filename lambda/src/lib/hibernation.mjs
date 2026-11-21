// Whether a nap hibernates EC2 instances (hibernation design): the first level that is set decides. Pure.
import { isEndedDays, isJoinMinutes, JOIN_MINUTES_MAX } from './schedule.mjs';
import { IDLE_KEYS, defaultsProblems, kindOf, typesProblems } from './settings-levels.mjs';

// The longest an instance may stay hibernated: the maintenance wake comes before AWS's 60-day limit.
export const HIBERNATION_MAX_DAYS = 59;
const DAY_MS = 86_400_000;

// When that maintenance wake is due: the run's `hibernated.at` (JSON, written when AWS accepted a nap's hibernation)
// plus HIBERNATION_MAX_DAYS days; null without a record, an unreadable one, or once the run asks for a fresh boot (the
// wake came, its next stop is plain: a wake that failed is not tried again every check).
export function hibernationDue(run) {
  if (run?.freshBoot === true) return null;
  try {
    const at = run?.hibernated ? JSON.parse(run.hibernated)?.at : null;
    return Number.isFinite(at) ? at + HIBERNATION_MAX_DAYS * DAY_MS : null;
  } catch {
    return null;
  }
}

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const isBoolean = (value) => typeof value === 'boolean';

// Workload boolean; else fallback instance types (a hibernation-ready type may not be available) → off; else router;
// else manager; else the built-in default. Anything that is not a boolean is unset.
export function resolveHibernation({ workload, fallbackTypes, router, manager } = {}) {
  if (isBoolean(workload)) return { hibernate: workload, from: 'workload' };
  if (Array.isArray(fallbackTypes) && fallbackTypes.length > 0) return { hibernate: false, from: 'fallback-types' };
  if (isBoolean(router)) return { hibernate: router, from: 'router' };
  if (isBoolean(manager?.hibernate)) return { hibernate: manager.hibernate, from: 'manager' };
  return { hibernate: true, from: 'default' };
}

// The settings of a router or a workload: `hibernate`, true, false or null (inherit); `joinMinutes`, its minutes or null
// (inherit), which only a router's take (a workload's is on its schedule). `idle`: its defaults may hold the idle signals (AWS's).
export function settingsProblems(settings, { idle = false } = {}) {
  if (!isObject(settings)) return ['settings must be an object'];
  const problems = [];
  for (const [key, value] of Object.entries(settings)) {
    if (key === 'joinMinutes') {
      if (value !== null && !isJoinMinutes(value)) problems.push(`settings: joinMinutes: must be a whole number from 0 to ${JOIN_MINUTES_MAX}, a multiple of 5, or null`);
    } else if (key === 'defaults') {
      if (value !== null) problems.push(...defaultsProblems(value, { idle }).map((p) => `settings: defaults: ${p}`));
    } else if (key !== 'hibernate') problems.push(`settings: unknown setting ${key}`);
    else if (value !== null && !isBoolean(value)) problems.push('settings: hibernate must be true, false or null');
  }
  return problems;
}

// The settings of a workload the manager onboarded (settings at scale design §8): `hibernate` (true, false or null), the
// settings of the levels and `type`, each a value or null; its joinMinutes is on its schedule. With its configuration `cfg`, the
// keys of its kind only (standalone workloads design §2, §4).
export function workloadSettingsProblems(settings, cfg = null) {
  if (!isObject(settings)) return ['settings must be an object'];
  const problems = [];
  for (const [key, value] of Object.entries(settings)) {
    if (key === 'joinMinutes') problems.push('settings: a workload\'s joinMinutes is on its schedule');
    else if (key === 'hibernate') {
      if (value !== null && !isBoolean(value)) problems.push('settings: hibernate must be true, false or null');
    } else problems.push(...defaultsProblems({ [key]: value }, { workload: true, kind: cfg ? kindOf(cfg) : null }).map((p) => `settings: ${p}`));
  }
  return problems;
}

// The manager's settings.json: `workloads.hibernate`, true when absent; `workloads.joinMinutes` and
// `workloads.endedWindowDays`, null when absent or invalid (they have no safety side, so they never lose hibernate); other keys
// belong to the manager. `idle`: the defaults and types may hold the idle signals (AWS's).
// `cloud` ('aws', the default, or 'gcp'): the shape of idleMetric this router reads; one of the other cloud's is ignored silently.
export function parseManagerSettings(text, { idle = false, cloud = 'aws' } = {}) {
  const doc = JSON.parse(text);
  if (!isObject(doc)) throw new Error('settings.json must be an object');
  if (!('workloads' in doc)) return { hibernate: true, joinMinutes: null, endedWindowDays: null };
  if (!isObject(doc.workloads)) throw new Error('settings.json: workloads must be an object');
  const { hibernate } = doc.workloads;
  const joinMinutes = isJoinMinutes(doc.workloads.joinMinutes) ? doc.workloads.joinMinutes : null;
  const endedWindowDays = isEndedDays(doc.workloads.endedWindowDays) ? doc.workloads.endedWindowDays : null;
  const levels = levelsOf(doc.workloads, { idle, cloud });
  if (hibernate === undefined) return { hibernate: true, joinMinutes, endedWindowDays, ...levels };
  if (!isBoolean(hibernate)) throw new Error('settings.json: workloads.hibernate must be true or false');
  return { hibernate, joinMinutes, endedWindowDays, ...levels };
}

// The organization's defaults and types (settings at scale design §6): what is valid of them, each key and each type on its
// own; what is not is dropped and said in `problems` (never failing hibernate). Each key only when there is one.
// Without `idle` (a router with no standalone workload: Google Cloud's), the idle signals the organization sets for AWS routers are
// none of its business: ignored silently, never a reason to drop a type or to report an error (final review, Important 2).
const withoutIdle = (settings) => (settings && typeof settings === 'object' && !Array.isArray(settings)
  ? Object.fromEntries(Object.entries(settings).filter(([key]) => !IDLE_KEYS.includes(key))) : settings);

// An idleMetric in the other cloud's shape is that cloud's routers' business: ignored silently, as above. AWS's names a CloudWatch
// `namespace`, Google Cloud's a Cloud Monitoring `type`; a level holds one metric, so a custom metric for both clouds takes one type a
// cloud. Read in settings.json only: set at the router's or a workload's level, it is refused (its check says why).
const OTHER_SHAPE = { aws: (m) => Object.hasOwn(m, 'type') && !Object.hasOwn(m, 'namespace'), gcp: (m) => Object.hasOwn(m, 'namespace') };
const withoutOtherMetric = (cloud) => (settings) => (isObject(settings) && isObject(settings.idleMetric) && OTHER_SHAPE[cloud](settings.idleMetric)
  ? Object.fromEntries(Object.entries(settings).filter(([key]) => key !== 'idleMetric')) : settings);

function levelsOf(source, { idle, cloud }) {
  const strip = idle ? withoutOtherMetric(cloud) : withoutIdle;
  const workloads = {
    ...source,
    ...('defaults' in source ? { defaults: strip(source.defaults) } : {}),
    ...(Array.isArray(source.types) ? { types: source.types.map((t) => (isObject(t) && isObject(t.settings) ? { ...t, settings: strip(t.settings) } : t)) } : {}),
  };
  const problems = [];
  const levels = {};
  if ('defaults' in workloads) {
    if (!isObject(workloads.defaults)) problems.push('workloads.defaults: settings must be an object');
    else {
      const defaults = {};
      for (const [key, value] of Object.entries(workloads.defaults)) {
        const found = defaultsProblems({ [key]: value }, { idle, cloud });
        if (found.length) problems.push(...found.map((p) => `workloads.defaults: ${p}`));
        else if (value !== null) defaults[key] = value;
      }
      if (Object.keys(defaults).length) levels.defaults = defaults;
    }
  }
  if ('types' in workloads) {
    const whole = typesProblems(workloads.types, { idle, cloud });
    if (!Array.isArray(workloads.types) || whole.some((p) => p.startsWith('at most'))) problems.push(...whole.map((p) => `workloads.types: ${p}`));
    else {
      const kept = [];
      for (const type of workloads.types) {
        const found = typesProblems([...kept, type], { idle, cloud }).filter((p) => !typesProblems(kept, { idle, cloud }).includes(p));
        if (found.length) problems.push(...found.map((p) => `workloads.types: ${p}`));
        else kept.push(type);
      }
      if (kept.length) levels.types = kept;
    }
  }
  return problems.length ? { ...levels, problems } : levels;
}
