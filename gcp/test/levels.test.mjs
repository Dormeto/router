import assert from 'node:assert/strict';
import { test } from 'node:test';
import { effectiveOf, isPolicy, levelProblems, swapFloorOf, wakerConfigOf } from '../src/levels.mjs';

const vm = { kind: 'vm', name: 'web', zone: 'europe-west1-b' };
const global = { backends: [vm], lb: { kind: 'global' } };
const regional = { backends: [vm], lb: { kind: 'regional', region: 'europe-west1' } };
const classic = { backends: [vm], lb: { kind: 'classic' } };

test('an inherited key reads the router\'s value, from router', () => {
  const got = effectiveOf({ ...regional, inherits: ['idleMinutes'] }, { router: { defaults: { idleMinutes: 5 } } });
  assert.deepEqual([got.idleMinutes, got.settingsFrom.idleMinutes], [5, 'router']);
});

test('an own value wins over the router\'s', () => {
  const got = effectiveOf({ ...regional, inherits: [], idleMinutes: 30 }, { router: { defaults: { idleMinutes: 5 } } });
  assert.deepEqual([got.idleMinutes, got.settingsFrom.idleMinutes], [30, 'workload']);
});

test('no level sets it: 15, default', () => {
  const got = effectiveOf({ ...regional, inherits: ['idleMinutes'] }, { router: null });
  assert.deepEqual([got.idleMinutes, got.settingsFrom.idleMinutes], [15, 'default']);
});

test('a legacy configuration reads 15 and 60 as inherited, another value as its own', () => {
  const router = { defaults: { idleMinutes: 5, failedRetrySeconds: 90 } };
  const legacy = effectiveOf({ ...regional, idleMinutes: 15, failedRetrySeconds: 60 }, { router });
  assert.deepEqual([legacy.idleMinutes, legacy.settingsFrom.idleMinutes, legacy.failedRetrySeconds, legacy.settingsFrom.failedRetrySeconds], [5, 'router', 90, 'router']);
  const own = effectiveOf({ ...regional, idleMinutes: 20 }, { router });
  assert.deepEqual([own.idleMinutes, own.settingsFrom.idleMinutes], [20, 'workload']);
});

test('behind a swap the wake timeout is at least the swap\'s wait + 60 s, fixed', () => {
  const got = effectiveOf({ ...regional, inherits: ['wakeTimeoutSeconds'] }, { router: { defaults: { wakeTimeoutSeconds: 60 } } });
  assert.deepEqual([got.wakeTimeoutSeconds, got.settingsFrom.wakeTimeoutSeconds], [161, 'fixed']);
  assert.equal(effectiveOf({ ...classic, inherits: [] }, { router: { defaults: { wakeTimeoutSeconds: 60 } } }).wakeTimeoutSeconds, 311);
});

test('the wake timeout is at most 1700, fixed', () => {
  const got = effectiveOf({ ...global, inherits: ['wakeTimeoutSeconds'] }, { router: { defaults: { wakeTimeoutSeconds: 3600 } } });
  assert.deepEqual([got.wakeTimeoutSeconds, got.settingsFrom.wakeTimeoutSeconds], [1700, 'fixed']);
});

test('a wake timeout inside the bounds keeps its origin', () => {
  const got = effectiveOf({ ...global, inherits: ['wakeTimeoutSeconds'] }, { router: { defaults: { wakeTimeoutSeconds: 900 } } });
  assert.deepEqual([got.wakeTimeoutSeconds, got.settingsFrom.wakeTimeoutSeconds], [900, 'router']);
});

test('the wake mode is browser, fixed, behind the policy; any, default, behind a swap', () => {
  const policy = effectiveOf({ ...global, inherits: [] }, {});
  assert.deepEqual([policy.wakeMode, policy.settingsFrom.wakeMode], ['browser', 'fixed']);
  const absent = effectiveOf({ backends: [vm], inherits: [] }, { router: { defaults: { wakeMode: 'any' } } });
  assert.deepEqual([absent.wakeMode, absent.settingsFrom.wakeMode], ['browser', 'fixed']);
  const swap = effectiveOf({ ...regional, inherits: [] }, {});
  assert.deepEqual([swap.wakeMode, swap.settingsFrom.wakeMode], ['any', 'default']);
});

test('waitSeconds, maxHolders and drainSeconds are 0, fixed', () => {
  const got = effectiveOf({ ...regional, inherits: [], waitSeconds: 30 }, { router: { defaults: { maxHolders: 9, drainSeconds: 10 } } });
  assert.deepEqual(['waitSeconds', 'maxHolders', 'drainSeconds'].map((k) => [got[k], got.settingsFrom[k]]), [[0, 'fixed'], [0, 'fixed'], [0, 'fixed']]);
});

test('the type comes from the backends: vm instance, mig asg, k8s k8s, cloudsql databases', () => {
  const type = (kind) => effectiveOf({ backends: [{ kind, name: 'x' }], inherits: [] }, {}).type;
  assert.deepEqual(type('vm'), { name: 'instance', from: 'backends' });
  assert.deepEqual(type('mig'), { name: 'asg', from: 'backends' });
  assert.deepEqual(type('k8s'), { name: 'k8s', from: 'backends' });
  assert.deepEqual(type('cloudsql'), { name: 'databases', from: 'backends' });
});

test('a cloudsql backend makes the type databases, its timeout 1700, fixed', () => {
  const cfg = { backends: [vm, { kind: 'cloudsql', name: 'db' }], lb: { kind: 'global' }, inherits: ['wakeTimeoutSeconds'] };
  const got = effectiveOf(cfg, {});
  assert.deepEqual([got.type, got.wakeTimeoutSeconds, got.settingsFrom.wakeTimeoutSeconds], [{ name: 'databases', from: 'backends' }, 1700, 'fixed']);
  assert.equal('databases' in got, false);
  assert.equal(cfg.databases, undefined);
});

test('isPolicy and swapFloorOf', () => {
  assert.deepEqual([isPolicy(undefined), isPolicy({ kind: 'global' }), isPolicy({ kind: 'regional', region: 'r' }), isPolicy({ kind: 'classic' })], [true, true, false, false]);
  assert.deepEqual([swapFloorOf(undefined), swapFloorOf({ kind: 'global' }), swapFloorOf({ kind: 'regional' }), swapFloorOf({ kind: 'classic' })], [null, null, 161, 311]);
});

test('the waker\'s configuration holds the fixed keys as its own values', () => {
  const cfg = effectiveOf({ ...regional, inherits: ['idleMinutes', 'waitSeconds', 'maxHolders', 'drainSeconds', 'wakeTimeoutSeconds'] }, { router: { defaults: { wakeTimeoutSeconds: 60, idleMinutes: 5 } } });
  const waker = wakerConfigOf(cfg, { policyFetch: false });
  assert.deepEqual(waker.inherits, ['idleMinutes']);
  assert.deepEqual([waker.waitSeconds, waker.maxHolders, waker.drainSeconds, waker.wakeTimeoutSeconds, waker.wakeMode], [0, 0, 0, 161, 'any']);
});

test('the waker\'s configuration is browser on the policy\'s fetch', () => {
  const waker = wakerConfigOf({ ...regional, inherits: ['wakeMode'], wakeMode: 'any' }, { policyFetch: true });
  assert.deepEqual([waker.wakeMode, waker.inherits], ['browser', []]);
});

test('levelProblems refuses what Google Cloud fixes, with the reason', () => {
  const [waits] = levelProblems({ waitSeconds: 30 }, { level: 'workload', cfg: regional });
  assert.match(waits, /^waitSeconds is 0 on Google Cloud: the waker holds no request/);
  assert.equal(levelProblems({ maxHolders: 5 }, { level: 'router' }).length, 1);
  assert.equal(levelProblems({ drainSeconds: 5 }, { level: 'router' }).length, 1);
  assert.deepEqual(levelProblems({ waitSeconds: null, maxHolders: null }, { level: 'router' }), []);
});

test('levelProblems refuses a wake timeout above 1700, or below a swap\'s floor', () => {
  assert.deepEqual(levelProblems({ wakeTimeoutSeconds: 1800 }, { level: 'router' }), ['wakeTimeoutSeconds must be at most 1700: one controller request lasts at most 1800 s']);
  assert.deepEqual(levelProblems({ wakeTimeoutSeconds: 1800 }, { level: 'workload', cfg: global }).length, 1);
  assert.equal(levelProblems({ wakeTimeoutSeconds: 161 }, { level: 'workload', cfg: regional }).length, 0);
  assert.match(levelProblems({ wakeTimeoutSeconds: 160 }, { level: 'workload', cfg: regional })[0], /too short for a regional load balancer.*100 s.*use more than 160/);
  assert.deepEqual(levelProblems({ wakeTimeoutSeconds: 100 }, { level: 'workload', cfg: global }), []);
});

test('levelProblems refuses wakeMode any behind the policy, accepts it at the router', () => {
  const text = 'the global load balancer\'s waiting page can\'t see the visitor\'s request, so only the page\'s probe, an explicit wake or a wake rule wakes it (wake mode browser)';
  assert.deepEqual(levelProblems({ wakeMode: 'any' }, { level: 'workload', cfg: global }), [text]);
  assert.deepEqual(levelProblems({ wakeMode: 'any' }, { level: 'workload', cfg: { backends: [vm] } }), [text]);
  assert.deepEqual(levelProblems({ wakeMode: 'browser' }, { level: 'workload', cfg: global }), []);
  assert.deepEqual(levelProblems({ wakeMode: 'any' }, { level: 'workload', cfg: regional }), []);
  assert.deepEqual(levelProblems({ wakeMode: 'any' }, { level: 'router' }), []);
});

test('levelProblems keeps AWS\'s messages: 21 rules, a type at the router', () => {
  const rules = Array.from({ length: 21 }, (_, i) => ({ name: `r${i}`, path: '/x' }));
  assert.deepEqual(levelProblems({ noWakeRules: rules }, { level: 'router' }), ['noWakeRules: at most 20 rules']);
  assert.deepEqual(levelProblems({ type: 'databases' }, { level: 'router' }), ['unknown setting type']);
  assert.deepEqual(levelProblems({ type: 'databases' }, { level: 'workload', cfg: global }), []);
});
