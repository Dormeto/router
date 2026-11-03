// A workload's settings, resolved per field from its own, its type's, its router's, its organization's or the built-in
// value (vision settings at scale design §4–§7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILT_IN, BUILT_IN_TYPES, SCALAR_KEYS, builtInTypeOf, defaultsProblems, effectiveConfig, ownSettings, resolveSettings, typeOf, typesProblems,
} from '../src/lib/settings-levels.mjs';

const rule = (name, path = '/health') => ({ name, pathPrefixes: [path] });

test('resolves each field from the most specific level that sets it', () => {
  const { values, from } = resolveSettings({
    own: { idleMinutes: 30 }, type: { waitSeconds: 20 }, router: { idleMinutes: 45, drainSeconds: 10 }, organization: { maxHolders: 5 }, typeName: 'ecs',
  });
  assert.deepEqual(values, { idleMinutes: 30, waitSeconds: 20, drainSeconds: 10, wakeTimeoutSeconds: 600, maxHolders: 5, failedRetrySeconds: 60, wakeMode: 'any' });
  assert.deepEqual(from, { idleMinutes: 'workload', waitSeconds: 'type', drainSeconds: 'router', wakeTimeoutSeconds: 'default', maxHolders: 'organization', failedRetrySeconds: 'default', wakeMode: 'default' });
  assert.deepEqual(SCALAR_KEYS, Object.keys(BUILT_IN));
});

test('the databases type\'s built-in wake timeout is 1800, never Kubernetes\' 300', () => {
  assert.equal(resolveSettings({ typeName: 'databases' }).values.wakeTimeoutSeconds, 1800);
  assert.equal(resolveSettings({ typeName: 'databases' }).from.wakeTimeoutSeconds, 'default');
  assert.equal(resolveSettings({ typeName: 'k8s' }).values.wakeTimeoutSeconds, 600);
  assert.equal(resolveSettings({ typeName: 'databases', router: { wakeTimeoutSeconds: 900 } }).values.wakeTimeoutSeconds, 900);
});

test('a workload\'s built-in type: databases first, then its primary backend, then its configuration', () => {
  assert.equal(builtInTypeOf({}, { backendKinds: 'ecs,rds-instance' }), 'databases');
  assert.equal(builtInTypeOf({ databases: [{ id: 'db' }] }, { backendKinds: 'instance' }), 'databases');
  assert.equal(builtInTypeOf({}, { backendKinds: 'asg' }), 'asg');
  assert.equal(builtInTypeOf({ kubernetes: { cluster: 'c' } }, null), 'k8s');
  assert.equal(builtInTypeOf({}, null), null);
  assert.deepEqual(BUILT_IN_TYPES, ['instance', 'asg', 'ecs', 'k8s', 'databases']);
});

test('a workload\'s type: its own, then the first custom type its tags match, then its backends', () => {
  const types = [{ name: 'api', tags: { kind: 'api' }, settings: {} }, { name: 'web', tags: { team: 'shop' }, settings: {} }, { name: 'ecs', settings: { idleMinutes: 20 } }];
  assert.deepEqual(typeOf({ tags: { team: 'shop', kind: 'api' } }, null, types), { name: 'api', from: 'tags' });
  assert.deepEqual(typeOf({ type: 'web', tags: { kind: 'api' } }, null, types), { name: 'web', from: 'workload' });
  assert.deepEqual(typeOf({ type: 'ecs' }, null, types), { name: 'ecs', from: 'workload' });
  // A type removed since: its backends decide, and the status says which name it lost.
  assert.deepEqual(typeOf({ type: 'gone' }, { backendKinds: 'ecs,rds-instance' }, types), { name: 'databases', from: 'backends', missing: 'gone' });
  assert.deepEqual(typeOf({ tags: { team: 'blog' } }, { backendKinds: 'ecs' }, types), { name: 'ecs', from: 'backends' });
  assert.deepEqual(typeOf({}, null, types), { name: null, from: null });
});

test('inherits drops a key; a manager configuration without inherits drops what equals the onboarder\'s old default', () => {
  assert.deepEqual(ownSettings({ source: 'manager', idleMinutes: 15, waitSeconds: 30, drainSeconds: 30, wakeTimeoutSeconds: 300, maxHolders: 50, failedRetrySeconds: 60, wakeMode: 'any', kubernetes: {} }), { waitSeconds: 30 });
  assert.deepEqual(ownSettings({ source: 'manager', wakeTimeoutSeconds: 1800, databases: [{ id: 'db' }] }), {});
  assert.deepEqual(ownSettings({ source: 'manager', wakeTimeoutSeconds: 1800 }), { wakeTimeoutSeconds: 1800 });
  // Terraform is explicit until its module is upgraded.
  assert.deepEqual(ownSettings({ idleMinutes: 15, waitSeconds: 60 }), { idleMinutes: 15, waitSeconds: 60 });
  assert.deepEqual(ownSettings({ source: 'manager', idleMinutes: 20, waitSeconds: 60, inherits: ['idleMinutes'] }), { waitSeconds: 60 });
  assert.deepEqual(ownSettings({ idleMinutes: 15, inherits: ['idleMinutes'] }), {});
});

test('the effective configuration: resolved values in place, their sources, the type, and the rules of every level', () => {
  const cfg = { workloadId: 'shop', source: 'manager', name: 'Shop', idleMinutes: 15, inherits: ['idleMinutes', 'wakeMode'], wakeMode: 'any', tags: { kind: 'api' }, noWakeRules: [rule('same', '/w')], wakeRules: [] };
  const organization = {
    defaults: { idleMinutes: 40, noWakeRules: [rule('same', '/o')], wakeRules: [rule('key', '/k')] },
    types: [{ name: 'api', tags: { kind: 'api' }, settings: { wakeMode: 'browser', noWakeRules: [rule('t')] } }],
  };
  const router = { defaults: { noWakeRules: [rule('r')] } };
  const effective = effectiveConfig(cfg, { run: { backendKinds: 'ecs' }, router, organization, terraformRules: [rule('tf')] });
  assert.equal(effective.idleMinutes, 40);
  assert.equal(effective.wakeMode, 'browser');
  assert.equal(effective.name, 'Shop');
  assert.deepEqual([effective.settingsFrom.idleMinutes, effective.settingsFrom.wakeMode], ['organization', 'type']);
  assert.deepEqual(effective.type, { name: 'api', from: 'tags' });
  // Rules add up, the most general first; the router's Terraform rules before its manager rules.
  assert.deepEqual(effective.ruleLevels.noWake.map(({ level, rules }) => [level, rules.map((r) => r.name)]), [
    ['organization', ['same']], ['router', ['tf']], ['router', ['r']], ['type', ['t']], ['workload', ['same']],
  ]);
  assert.deepEqual(effective.ruleLevels.wake.map(({ level, rules }) => [level, rules.map((r) => r.name)]), [['organization', ['key']]]);
  // The stored configuration is never changed.
  assert.equal(cfg.idleMinutes, 15);
  // Without any level: the configuration's own values, its rules alone.
  const alone = effectiveConfig({ workloadId: 'blog', idleMinutes: 25, noWakeRules: [], wakeRules: [rule('w')] }, { run: null, router: null, organization: null, terraformRules: [] });
  assert.deepEqual([alone.idleMinutes, alone.settingsFrom.idleMinutes, alone.waitSeconds, alone.settingsFrom.waitSeconds], [25, 'workload', 60, 'default']);
  assert.deepEqual(alone.ruleLevels.wake.map((l) => l.level), ['workload']);
});

test('defaults are checked: ranges, wake mode, rules; null unsets; type only for a workload', () => {
  assert.deepEqual(defaultsProblems({ idleMinutes: 30, wakeMode: 'browser', noWakeRules: [rule('a')], waitSeconds: null }), []);
  assert.match(defaultsProblems({ idleMinutes: 4 })[0], /idleMinutes must be a whole number from 5 to 1440/);
  assert.match(defaultsProblems({ drainSeconds: 1.5 })[0], /drainSeconds must be a whole number from 0 to 300/);
  assert.match(defaultsProblems({ wakeMode: 'never' })[0], /wakeMode must be any or browser/);
  assert.match(defaultsProblems({ noWakeRules: Array.from({ length: 21 }, (_, i) => rule(`r${i}`)) })[0], /noWakeRules: at most 20 rules/);
  assert.match(defaultsProblems({ wakeRules: [{ name: 'empty' }] })[0], /wakeRules: rule empty: no condition/);
  assert.match(defaultsProblems({ wakeRules: [{ pathPrefixes: ['/x'] }] })[0], /wakeRules: each rule needs a name/);
  assert.match(defaultsProblems({ pollSeconds: 3 })[0], /unknown setting pollSeconds/);
  assert.match(defaultsProblems({ type: 'api' })[0], /unknown setting type/);
  assert.deepEqual(defaultsProblems({ type: 'api' }, { workload: true }), []);
  assert.deepEqual(defaultsProblems({ type: null }, { workload: true }), []);
  assert.match(defaultsProblems({ type: 'Bad' }, { workload: true })[0], /type must be a type's name/);
  assert.match(defaultsProblems([])[0], /an object/);
});

test('types are checked: names, selectors, built-in names, their number', () => {
  const custom = (name, tags = { kind: name }) => ({ name, tags, settings: {} });
  assert.deepEqual(typesProblems([custom('api'), { name: 'databases', settings: { idleMinutes: 30 } }]), []);
  assert.match(typesProblems([{ name: 'ecs', tags: { kind: 'x' }, settings: {} }])[0], /type ecs: a built-in type has no tags/);
  assert.match(typesProblems([custom('api'), custom('api')])[0], /type api: named twice/);
  assert.match(typesProblems([custom('Bad_Name')])[0], /type Bad_Name: a name is lower-case letters, digits and hyphens/);
  assert.match(typesProblems([custom('api', {})])[0], /type api: tags must select at least one tag/);
  assert.match(typesProblems([{ name: 'api', tags: { kind: 'x' }, settings: { idleMinutes: 1 } }])[0], /type api: settings: idleMinutes must be/);
  assert.match(typesProblems(Array.from({ length: 21 }, (_, i) => custom(`t${i}`)))[0], /at most 20 custom types/);
  assert.match(typesProblems({})[0], /types must be a list/);
});
