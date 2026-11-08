// What the settings action writes (hibernation design §4, settings at scale design §8): the router's record merged with
// what it holds, and a workload's configuration with the settings sent; and how its answers show them. Pure, shared by
// AWS's controller and Google Cloud's onboarding: the checks, the store and who may write a workload stay theirs.
import { BUILT_IN, RULE_KEYS, SCALAR_KEYS, TYPE_BUILT_IN, builtInTypeOf, ownSettings } from './settings-levels.mjs';

// The router's settings record as people read it (its time ISO): all null when unset.
export const routerSettingsView = (record) => ({
  hibernate: record?.hibernate ?? null, joinMinutes: record?.joinMinutes ?? null, ...(record?.defaults ? { defaults: record.defaults } : {}),
  by: record?.by ?? null, at: record ? new Date(record.at).toISOString() : null,
});

// A resolved configuration's settings (effectiveConfig's), as the workload's answer gives them: each value, where it comes from,
// and the type.
export const resolvedSettings = (resolved) => ({
  settings: Object.fromEntries(SCALAR_KEYS.map((key) => [key, resolved[key]])), settingsFrom: resolved.settingsFrom, type: resolved.type,
});

// The router's record once `settings` (hibernate, joinMinutes and the defaults of its workloads) are written over the stored one:
// what is not sent stays, so setting one never erases the other; a key of the defaults sent null goes, defaults null clears
// them all; no default left is null.
export function mergedRouterSettings(stored, settings, { by, at }) {
  const sent = (name) => (Object.hasOwn(settings, name) ? settings[name] : stored?.[name] ?? null);
  const merged = !Object.hasOwn(settings, 'defaults') ? stored?.defaults ?? null
    : settings.defaults === null ? null
      : Object.fromEntries(Object.entries({ ...stored?.defaults, ...settings.defaults }).filter(([, value]) => value !== null));
  const defaults = merged && Object.keys(merged).length ? merged : null;
  return { hibernate: sent('hibernate'), joinMinutes: sent('joinMinutes'), defaults, by, at };
}

// A written record as people read it: none of the three set, it is unset (the store deletes it).
export const writtenRouterView = (record) => routerSettingsView(record.hibernate === null && record.joinMinutes === null && !record.defaults ? null : record);

// AWS's reading of a configuration from before `inherits` (design §7): it inherits what equals the onboarder's old defaults.
const awsInherits = (cfg) => {
  const own = ownSettings(cfg);
  return Array.isArray(cfg.inherits) ? cfg.inherits : SCALAR_KEYS.filter((key) => !(key in own));
};
// AWS's built-in value of each key: its built-in type's, else the built-in one.
const awsBuiltIns = (cfg) => {
  const typeName = builtInTypeOf(cfg, null);
  return Object.fromEntries(SCALAR_KEYS.map((key) => [key, TYPE_BUILT_IN[typeName]?.[key] ?? BUILT_IN[key]]));
};

// A workload's configuration with `settings` written over it: hibernate (null removes the key), the settings of §4 (null gives
// the key back to the levels: its built-in value stays written for an older router), its rules (null: none) and its type
// (null: inherited). `inherits` is written when a setting of §4 is sent. A cloud passes its own reading of a configuration
// from before `inherits` (`inheritsOf`) and its own built-in values (`builtIns`), AWS's by default. The configuration given is
// not changed.
export function withSettings(cfg, settings, { inheritsOf = awsInherits, builtIns = awsBuiltIns } = {}) {
  const next = { ...cfg };
  if (Object.hasOwn(settings, 'hibernate')) {
    if (typeof settings.hibernate === 'boolean') next.hibernate = settings.hibernate;
    else delete next.hibernate;
  }
  const scalars = SCALAR_KEYS.filter((key) => Object.hasOwn(settings, key));
  if (scalars.length) {
    const inherits = new Set(inheritsOf(cfg));
    const builtIn = builtIns(cfg);
    for (const key of scalars) {
      if (settings[key] === null) {
        next[key] = builtIn[key];
        inherits.add(key);
      } else {
        next[key] = settings[key];
        inherits.delete(key);
      }
    }
    next.inherits = SCALAR_KEYS.filter((key) => inherits.has(key));
  }
  for (const key of RULE_KEYS) if (Object.hasOwn(settings, key)) next[key] = settings[key] ?? [];
  if (Object.hasOwn(settings, 'type')) {
    if (settings.type === null) delete next.type;
    else next.type = settings.type;
  }
  return next;
}
