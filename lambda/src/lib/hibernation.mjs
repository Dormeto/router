// Whether a nap hibernates EC2 instances (hibernation design): the first level that is set decides. Pure.
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

// The settings of a router or a workload: only `hibernate`, true, false or null (inherit).
export function settingsProblems(settings) {
  if (!isObject(settings)) return ['settings must be an object'];
  const problems = [];
  for (const [key, value] of Object.entries(settings)) {
    if (key !== 'hibernate') problems.push(`settings: unknown setting ${key}`);
    else if (value !== null && !isBoolean(value)) problems.push('settings: hibernate must be true, false or null');
  }
  return problems;
}

// The manager's settings.json: `workloads.hibernate`, true when absent; other keys belong to the manager.
export function parseManagerSettings(text) {
  const doc = JSON.parse(text);
  if (!isObject(doc)) throw new Error('settings.json must be an object');
  if (!('workloads' in doc)) return { hibernate: true };
  if (!isObject(doc.workloads)) throw new Error('settings.json: workloads must be an object');
  const { hibernate } = doc.workloads;
  if (hibernate === undefined) return { hibernate: true };
  if (!isBoolean(hibernate)) throw new Error('settings.json: workloads.hibernate must be true or false');
  return { hibernate };
}
