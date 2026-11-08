// The writes of the settings action, shared by AWS's controller and Google Cloud's onboarding: the router's record merged
// with what it holds, and a workload's configuration with the settings sent (vision settings at scale design §8).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveConfig } from '../src/lib/settings-levels.mjs';
import { mergedRouterSettings, resolvedSettings, routerSettingsView, withSettings, writtenRouterView } from '../src/lib/settings-writes.mjs';

const AT = Date.UTC(2026, 10, 8, 10, 0, 0);
const NONE = { hibernate: null, joinMinutes: null, by: null, at: null };
const rule = (name) => ({ name, pathPrefixes: ['/health'] });

test('routerSettingsView: all null when unset; a record\'s time ISO, its defaults only when it has some', () => {
  assert.deepEqual(routerSettingsView(null), NONE);
  assert.deepEqual(routerSettingsView({ hibernate: false, by: 'ops', at: AT }), { hibernate: false, joinMinutes: null, by: 'ops', at: '2026-11-08T10:00:00.000Z' });
  assert.deepEqual(routerSettingsView({ joinMinutes: 15, defaults: { idleMinutes: 30 }, by: 'ops', at: AT }).defaults, { idleMinutes: 30 });
});

test('mergedRouterSettings: what is not sent stays, a key of the defaults sent null goes, by and at are the write\'s', () => {
  const stored = { hibernate: false, joinMinutes: 15, defaults: { idleMinutes: 30, wakeMode: 'browser' }, by: 'ann', at: 1 };
  assert.deepEqual(mergedRouterSettings(stored, { defaults: { idleMinutes: null, maxHolders: 5 } }, { by: 'ops', at: AT }), {
    hibernate: false, joinMinutes: 15, defaults: { wakeMode: 'browser', maxHolders: 5 }, by: 'ops', at: AT,
  });
  assert.deepEqual(mergedRouterSettings(stored, { hibernate: null }, { by: 'ops', at: AT }), {
    hibernate: null, joinMinutes: 15, defaults: { idleMinutes: 30, wakeMode: 'browser' }, by: 'ops', at: AT,
  });
});

test('mergedRouterSettings: defaults null clears them, as defaults left empty; nothing stored reads as unset', () => {
  const stored = { defaults: { idleMinutes: 30 }, by: 'ann', at: 1 };
  assert.equal(mergedRouterSettings(stored, { defaults: null }, { by: 'ops', at: AT }).defaults, null);
  assert.equal(mergedRouterSettings(stored, { defaults: { idleMinutes: null } }, { by: 'ops', at: AT }).defaults, null);
  assert.deepEqual(mergedRouterSettings(null, { joinMinutes: 0 }, { by: 'ops', at: AT }), { hibernate: null, joinMinutes: 0, defaults: null, by: 'ops', at: AT });
});

test('writtenRouterView: a record with none of the three set reads as unset', () => {
  assert.deepEqual(writtenRouterView({ hibernate: null, joinMinutes: null, defaults: null, by: 'ops', at: AT }), NONE);
  assert.deepEqual(writtenRouterView({ hibernate: true, joinMinutes: null, defaults: null, by: 'ops', at: AT }), { hibernate: true, joinMinutes: null, by: 'ops', at: '2026-11-08T10:00:00.000Z' });
});

test('withSettings: a value is the workload\'s own, out of inherits; null gives the key back, its built-in value written for an older router', () => {
  const cfg = { workloadId: 'w', source: 'manager', inherits: ['waitSeconds', 'wakeTimeoutSeconds'], idleMinutes: 20, waitSeconds: 60, wakeTimeoutSeconds: 600 };
  const next = withSettings(cfg, { waitSeconds: 10, idleMinutes: null });
  assert.deepEqual(next.inherits, ['idleMinutes', 'wakeTimeoutSeconds']);
  assert.deepEqual([next.waitSeconds, next.idleMinutes], [10, 15]);
  assert.equal(cfg.waitSeconds, 60, 'the configuration given is not changed');
});

test('withSettings: a key given back takes its type\'s built-in value, the databases\' 1800', () => {
  const cfg = { workloadId: 'w', source: 'manager', inherits: [], databases: [{ id: 'db' }], wakeTimeoutSeconds: 900 };
  assert.equal(withSettings(cfg, { wakeTimeoutSeconds: null }).wakeTimeoutSeconds, 1800);
});

test('withSettings: a configuration from before inherits inherits what equals the onboarder\'s old defaults', () => {
  const cfg = { workloadId: 'w', source: 'manager', idleMinutes: 15, waitSeconds: 30, drainSeconds: 30, wakeTimeoutSeconds: 600, maxHolders: 50, failedRetrySeconds: 60, wakeMode: 'any' };
  assert.deepEqual(withSettings(cfg, { idleMinutes: 45 }).inherits, ['drainSeconds', 'wakeTimeoutSeconds', 'maxHolders', 'failedRetrySeconds', 'wakeMode']);
  assert.equal('inherits' in withSettings(cfg, { noWakeRules: [rule('a')] }), false, 'no scalar sent, inherits not written');
});

test('withSettings: hibernate, the rules and the type, each null for none', () => {
  const cfg = { workloadId: 'w', source: 'manager', inherits: [], hibernate: true, noWakeRules: [rule('a')], wakeRules: [rule('b')], type: 'web' };
  assert.deepEqual(withSettings(cfg, { hibernate: false, noWakeRules: [rule('c')], type: 'api' }), { ...cfg, hibernate: false, noWakeRules: [rule('c')], type: 'api' });
  const cleared = withSettings(cfg, { hibernate: null, noWakeRules: null, wakeRules: null, type: null });
  assert.deepEqual([cleared.noWakeRules, cleared.wakeRules, 'hibernate' in cleared, 'type' in cleared], [[], [], false, false]);
});

test('withSettings: a cloud\'s own reading of a configuration from before inherits, and its own values for a key given back', () => {
  const cfg = { workloadId: 'w', idleMinutes: 15, wakeTimeoutSeconds: 700 };
  const next = withSettings(cfg, { failedRetrySeconds: null }, {
    inheritsOf: () => ['idleMinutes', 'failedRetrySeconds'],
    builtIns: () => ({ failedRetrySeconds: 90 }),
  });
  assert.deepEqual([next.inherits, next.failedRetrySeconds], [['idleMinutes', 'failedRetrySeconds'], 90]);
});

test('resolvedSettings: each setting of a resolved configuration, where it comes from, and the type', () => {
  const resolved = effectiveConfig({ workloadId: 'w', source: 'manager', inherits: ['waitSeconds'], idleMinutes: 30, noWakeRules: [rule('a')] }, { router: { defaults: { waitSeconds: 20 } } });
  assert.deepEqual(resolvedSettings(resolved), {
    settings: { idleMinutes: 30, waitSeconds: 20, drainSeconds: 30, wakeTimeoutSeconds: 600, maxHolders: 50, failedRetrySeconds: 60, wakeMode: 'any' },
    settingsFrom: { idleMinutes: 'workload', waitSeconds: 'router', drainSeconds: 'default', wakeTimeoutSeconds: 'default', maxHolders: 'default', failedRetrySeconds: 'default', wakeMode: 'default' },
    type: { name: null, from: null },
  });
});
