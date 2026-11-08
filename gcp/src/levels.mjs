// A Google Cloud workload's settings through AWS's levels (design §3): the shared resolution, with what Google imposes
// applied on top and named `fixed`. Pure: no store, no Google.
import { defaultsProblems, effectiveConfig } from '../../lambda/src/lib/settings-levels.mjs';
import { SWAP_WAIT_MS } from './switch.mjs';

// What Google Cloud fixes whatever the level says; the swap's wait + 60 s is the wake's floor behind a swap.
const FIXED_ZERO = ['waitSeconds', 'maxHolders', 'drainSeconds'];
export const WAKE_TIMEOUT_MAX = 1700;
const SWAP_WAKE_ROOM_SECONDS = 60;
// The workload's backends' kinds, by the names AWS gives its types.
const TYPE_NAMES = { vm: 'instance', mig: 'asg', k8s: 'k8s', cloudsql: 'databases' };
// What a manager-less configuration stored before `inherits`: it inherits what equals these.
const LEGACY_DEFAULTS = { idleMinutes: 15, failedRetrySeconds: 60 };

const REASONS = {
  waitSeconds: 'waitSeconds is 0 on Google Cloud: the waker holds no request (behind a swap the switch back takes longer than any hold; behind the policy it receives only the error fetch)',
  maxHolders: 'maxHolders is 0 on Google Cloud: no request is held',
  drainSeconds: 'drainSeconds is 0 on Google Cloud: the nap\'s switch is a URL map change, and the backend service\'s own connection draining applies',
};
const BROWSER_ONLY = 'the global load balancer\'s waiting page can\'t see the visitor\'s request, so only the page\'s probe, an explicit wake or a wake rule wakes it (wake mode browser)';

// The global load balancer's policy: the default, when the configuration names no kind.
export const isPolicy = (lb) => !lb || lb.kind === 'global';

// The smallest whole number of seconds above the swap's wait + 60 s; null where the load balancer is no swap.
export const swapFloorOf = (lb) => (Object.hasOwn(SWAP_WAIT_MS, lb?.kind) ? SWAP_WAIT_MS[lb.kind] / 1000 + SWAP_WAKE_ROOM_SECONDS + 1 : null);

// The shared code reads a type from the run's kinds and `databases`: give it those, from the backends.
function sharedView(cfg, run) {
  const backends = Array.isArray(cfg?.backends) ? cfg.backends : [];
  const names = backends.map((b) => TYPE_NAMES[b?.kind]).filter(Boolean);
  const databases = backends.filter((b) => b?.kind === 'cloudsql');
  const inherits = Array.isArray(cfg?.inherits) ? cfg.inherits : Object.keys(LEGACY_DEFAULTS).filter((key) => cfg?.[key] === undefined || cfg[key] === LEGACY_DEFAULTS[key]);
  return {
    cfg: { ...cfg, inherits, ...(databases.length ? { databases } : {}) },
    run: { ...run, backendKinds: names.join(',') },
  };
}

export function effectiveOf(cfg, { run = null, router = null } = {}) {
  const view = sharedView(cfg, run);
  const got = effectiveConfig(view.cfg, { run: view.run, router });
  // The result is the configuration's own, not the view's.
  if (Array.isArray(cfg?.inherits)) got.inherits = cfg.inherits;
  else delete got.inherits;
  if (!cfg?.databases) delete got.databases;
  const fix = (key, value) => {
    got[key] = value;
    got.settingsFrom[key] = 'fixed';
  };
  for (const key of FIXED_ZERO) fix(key, 0);
  if (isPolicy(cfg?.lb)) fix('wakeMode', 'browser');
  const floor = swapFloorOf(cfg?.lb) ?? 0;
  const bounded = Math.min(Math.max(got.wakeTimeoutSeconds, floor), WAKE_TIMEOUT_MAX);
  if (bounded !== got.wakeTimeoutSeconds) fix('wakeTimeoutSeconds', bounded);
  return got;
}

// The configuration the shared waker gets, from the STORED one (as the store returns it) and the router level: every key
// Google Cloud fixes is the workload's own value there, out of `inherits`, so whatever the waker then resolves, it gets the
// fixed values. `wakeMode` is browser on the policy's error fetch (and behind the policy, where effectiveOf fixes it).
export function wakerConfigOf(cfg, { run = null, router = null, policyFetch = false } = {}) {
  const effective = effectiveOf(cfg, { run, router });
  const fixed = new Set(Object.entries(effective.settingsFrom).filter(([, origin]) => origin === 'fixed').map(([key]) => key));
  if (policyFetch) fixed.add('wakeMode');
  const out = { ...cfg };
  for (const key of fixed) out[key] = key === 'wakeMode' ? 'browser' : effective[key];
  out.inherits = sharedView(cfg, run).cfg.inherits.filter((key) => !fixed.has(key));
  return out;
}

// The shared checks, and what Google Cloud refuses at a level. `cfg` is the workload's, for its load balancer.
export function levelProblems(settings, { level, cfg } = {}) {
  const workload = level === 'workload';
  const isObject = !!settings && typeof settings === 'object' && !Array.isArray(settings);
  const fixed = isObject ? FIXED_ZERO.filter((key) => settings[key] !== undefined && settings[key] !== null) : [];
  const rest = isObject ? Object.fromEntries(Object.entries(settings).filter(([key]) => !fixed.includes(key))) : settings;
  const problems = [...fixed.map((key) => REASONS[key]), ...defaultsProblems(rest, { workload })];
  if (!isObject) return problems;
  const asked = settings.wakeTimeoutSeconds;
  if (Number.isInteger(asked)) {
    const floor = workload ? swapFloorOf(cfg?.lb) : null;
    if (asked > WAKE_TIMEOUT_MAX) problems.push(`wakeTimeoutSeconds must be at most ${WAKE_TIMEOUT_MAX}: one controller request lasts at most 1800 s`);
    else if (floor && asked < floor) {
      const change = SWAP_WAIT_MS[cfg.lb.kind] / 1000;
      problems.push(`wakeTimeoutSeconds ${asked} is too short for a ${cfg.lb.kind} load balancer: its wake includes the URL map's change, ${change} s: use more than ${floor - 1}`);
    }
  }
  if (workload && settings.wakeMode === 'any' && isPolicy(cfg?.lb)) problems.push(BROWSER_ONLY);
  return problems;
}
