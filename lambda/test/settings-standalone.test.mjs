// A standalone workload's settings (vision standalone workloads design §4): the idle window and the three idle signals,
// resolved by the same levels as an HTTP workload's, each with its range and `off`; the waker's settings refused for it,
// the idle signals refused for an HTTP workload. An HTTP workload resolves exactly as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILT_IN, IDLE_KEYS, SCALAR_KEYS, STANDALONE_BUILT_IN, STANDALONE_KEYS, builtInTypeOf, defaultsProblems, effectiveConfig, ownSettings, resolveSettings, typesProblems,
} from '../src/lib/settings-levels.mjs';
import { parseManagerSettings, settingsProblems, workloadSettingsProblems } from '../src/lib/hibernation.mjs';
import { createManagerSettings } from '../src/lib/manager-settings.mjs';
import { resolvedSettings, withSettings } from '../src/lib/settings-writes.mjs';
import { createController } from '../src/lib/controller-core.mjs';
import { fakeClock, fakeStore, silentLog, testConfig } from './fakes.mjs';

const INSTANCE_ARN = 'arn:aws:ec2:eu-west-1:111122223333:instance/i-0123456789abcdef0';
const DB_ARN = 'arn:aws:rds:eu-west-1:111122223333:db:orders';
const CLUSTER_ARN = 'arn:aws:rds:eu-west-1:111122223333:cluster:ledger';
const standalone = (overrides = {}) => ({
  workloadId: 'batch', kind: 'standalone', resourceArn: INSTANCE_ARN, name: 'Batch', tags: {}, databases: [], source: 'manager', inherits: STANDALONE_KEYS, ...overrides,
});
const metric = (overrides = {}) => ({ namespace: 'Batch', name: 'QueueDepth', dimensions: { Queue: '${resource}' }, statistic: 'Maximum', below: 1, ...overrides });
const connections = (dimensions) => ({ namespace: 'AWS/RDS', name: 'DatabaseConnections', dimensions, statistic: 'Maximum', below: 1 });

test('a standalone workload\'s keys are the idle window, the wake timeout and the three idle signals, with their built-in values', () => {
  assert.deepEqual(STANDALONE_BUILT_IN, { idleMinutes: 120, wakeTimeoutSeconds: 600, idleCpuPercent: 5, idleNetworkBytes: 'off', idleMetric: 'off' });
  assert.deepEqual(STANDALONE_KEYS, Object.keys(STANDALONE_BUILT_IN));
  assert.deepEqual(IDLE_KEYS, ['idleCpuPercent', 'idleNetworkBytes', 'idleMetric']);
  // An HTTP workload's keys and built-in values are unchanged.
  assert.deepEqual(SCALAR_KEYS, ['idleMinutes', 'waitSeconds', 'drainSeconds', 'wakeTimeoutSeconds', 'maxHolders', 'failedRetrySeconds', 'wakeMode']);
  assert.deepEqual(BUILT_IN, { idleMinutes: 15, waitSeconds: 60, drainSeconds: 30, wakeTimeoutSeconds: 600, maxHolders: 50, failedRetrySeconds: 60, wakeMode: 'any' });
});

test('resolveSettings for a standalone workload: each key from the most specific level, `off` an inherited signal\'s value like any other', () => {
  const { values, from } = resolveSettings({
    kind: 'standalone', own: { idleNetworkBytes: 1000 }, type: { idleCpuPercent: 'off' }, router: { idleMinutes: 60, waitSeconds: 5 }, organization: { idleMetric: metric(), maxHolders: 3 },
  });
  assert.deepEqual(values, { idleMinutes: 60, wakeTimeoutSeconds: 600, idleCpuPercent: 'off', idleNetworkBytes: 1000, idleMetric: metric() });
  assert.deepEqual(from, { idleMinutes: 'router', wakeTimeoutSeconds: 'default', idleCpuPercent: 'type', idleNetworkBytes: 'workload', idleMetric: 'organization' });
  // `off` at a level turns off what a level above sets.
  const off = resolveSettings({ kind: 'standalone', own: { idleCpuPercent: 'off' }, organization: { idleCpuPercent: 20 } });
  assert.deepEqual([off.values.idleCpuPercent, off.from.idleCpuPercent], ['off', 'workload']);
  // Nothing set: the built-in values.
  assert.deepEqual(resolveSettings({ kind: 'standalone' }).values, STANDALONE_BUILT_IN);
});

test('the type databases: CPU off, the database\'s connections under 1, the slow start\'s wake timeout', () => {
  const values = (cfg) => effectiveConfig(cfg, {});
  const own = values(standalone({ resourceArn: DB_ARN }));
  assert.deepEqual(own.type, { name: 'databases', from: 'backends' });
  assert.deepEqual([own.idleCpuPercent, own.idleNetworkBytes, own.idleMetric, own.wakeTimeoutSeconds, own.idleMinutes], ['off', 'off', connections({ DBInstanceIdentifier: 'orders' }), 1800, 120]);
  assert.equal(own.settingsFrom.idleMetric, 'default');
  assert.deepEqual(values(standalone({ resourceArn: CLUSTER_ARN })).idleMetric, connections({ DBClusterIdentifier: 'ledger' }));
  // A server with a companion database: its database's connections.
  const companion = values(standalone({ databases: [{ kind: 'rds-cluster', id: 'ledger' }] }));
  assert.deepEqual([companion.type.name, companion.idleCpuPercent, companion.idleMetric], ['databases', 'off', connections({ DBClusterIdentifier: 'ledger' })]);
  // A level's value wins over the type's built-in one.
  const set = effectiveConfig(standalone({ resourceArn: DB_ARN }), { router: { defaults: { idleCpuPercent: 10, idleMetric: 'off' } } });
  assert.deepEqual([set.idleCpuPercent, set.idleMetric, set.settingsFrom.idleMetric], [10, 'off', 'router']);
});

test('a standalone workload\'s built-in type follows its resource', () => {
  assert.equal(builtInTypeOf(standalone(), null), 'instance');
  assert.equal(builtInTypeOf(standalone({ resourceArn: 'arn:aws:autoscaling:eu-west-1:111122223333:autoScalingGroup:0000:autoScalingGroupName/workers' }), null), 'asg');
  assert.equal(builtInTypeOf(standalone({ resourceArn: 'arn:aws:ecs:eu-west-1:111122223333:service/jobs/worker' }), null), 'ecs');
  assert.equal(builtInTypeOf(standalone({ resourceArn: DB_ARN }), null), 'databases');
});

test('effectiveConfig of a standalone workload: its keys resolved through workload, type, router and organization, said in settingsFrom; no waker key, no rule', () => {
  const organization = {
    defaults: { idleMinutes: 240, waitSeconds: 30, noWakeRules: [{ name: 'health', pathPrefixes: ['/health'] }] },
    types: [{ name: 'nightly', tags: { team: 'data' }, settings: { idleNetworkBytes: 5000, wakeMode: 'browser' } }],
  };
  const router = { defaults: { idleCpuPercent: 'off', drainSeconds: 0 } };
  const cfg = standalone({ tags: { team: 'data' }, idleMetric: metric(), inherits: ['idleMinutes', 'wakeTimeoutSeconds', 'idleCpuPercent', 'idleNetworkBytes'] });
  const effective = effectiveConfig(cfg, { router, organization, terraformRules: [{ name: 'tf', pathPrefixes: ['/x'] }] });
  assert.deepEqual(effective.settingsFrom, { idleMinutes: 'organization', wakeTimeoutSeconds: 'default', idleCpuPercent: 'router', idleNetworkBytes: 'type', idleMetric: 'workload' });
  assert.deepEqual([effective.idleMinutes, effective.idleCpuPercent, effective.idleNetworkBytes, effective.idleMetric], [240, 'off', 5000, metric()]);
  assert.deepEqual(effective.type, { name: 'nightly', from: 'tags' });
  for (const key of ['waitSeconds', 'drainSeconds', 'maxHolders', 'failedRetrySeconds', 'wakeMode']) assert.equal(key in effective, false, key);
  assert.deepEqual(effective.ruleLevels, { noWake: [], wake: [] });
  assert.deepEqual(ownSettings(cfg), { idleMetric: metric() });
});

test('an HTTP workload resolves exactly as before, whatever idle signals its levels hold', () => {
  const cfg = testConfig({ source: 'manager', inherits: ['idleMinutes'], tags: { team: 'data' } });
  const levels = (idle) => ({
    run: { backendKinds: 'instance' },
    router: { defaults: { drainSeconds: 5, ...(idle ? { idleCpuPercent: 'off', idleNetworkBytes: 10 } : {}) } },
    organization: { defaults: { idleMinutes: 30, ...(idle ? { idleMetric: metric() } : {}) }, types: [{ name: 'nightly', tags: { team: 'data' }, settings: { maxHolders: 9, ...(idle ? { idleCpuPercent: 50 } : {}) } }] },
  });
  const before = effectiveConfig(cfg, levels(false));
  const after = effectiveConfig(cfg, levels(true));
  assert.equal(JSON.stringify(after), JSON.stringify(before));
  assert.equal(JSON.stringify(resolvedSettings(after)), JSON.stringify(resolvedSettings(before)));
  assert.deepEqual(Object.keys(before.settingsFrom), SCALAR_KEYS);
  assert.equal(JSON.stringify(resolveSettings({ typeName: 'databases' })), JSON.stringify(resolveSettings({ typeName: 'databases', kind: 'http' })));
});

// The four levels' checks: a type, the router and the organization may hold both kinds' keys (each applies to its kind); a
// workload holds its kind's only.
const LEVELS = {
  workload: (settings) => workloadSettingsProblems(settings, standalone()),
  type: (settings) => typesProblems([{ name: 'nightly', tags: { team: 'data' }, settings }], { idle: true }).map((p) => p.replace('type nightly: settings: ', 'settings: ')),
  router: (settings) => settingsProblems({ defaults: settings }, { idle: true }).map((p) => p.replace('settings: defaults: ', 'settings: ')),
  organization: (settings) => (parseManagerSettings(JSON.stringify({ workloads: { defaults: settings } }), { idle: true }).problems ?? []).map((p) => p.replace('workloads.defaults: ', 'settings: ')),
};

for (const [level, problems] of Object.entries(LEVELS)) {
  test(`each idle key's range and off at the ${level} level`, () => {
    for (const ok of [{ idleCpuPercent: 0 }, { idleCpuPercent: 100 }, { idleCpuPercent: 2.5 }, { idleCpuPercent: 'off' }, { idleNetworkBytes: 0 }, { idleNetworkBytes: 10_000_000_000 },
      { idleNetworkBytes: 'off' }, { idleMetric: 'off' }, { idleMetric: metric() }, { idleMetric: metric({ dimensions: {}, statistic: 'Sum', below: 0.5 }) },
      { idleMinutes: 5 }, { idleMinutes: 1440 }, { idleCpuPercent: null }, { idleMetric: null }]) {
      assert.deepEqual(problems(ok), [], JSON.stringify(ok));
    }
    const refused = [
      [{ idleCpuPercent: -1 }, 'settings: idleCpuPercent: must be a number from 0 to 100, or off'],
      [{ idleCpuPercent: 101 }, 'settings: idleCpuPercent: must be a number from 0 to 100, or off'],
      [{ idleCpuPercent: 'none' }, 'settings: idleCpuPercent: must be a number from 0 to 100, or off'],
      [{ idleNetworkBytes: 10_000_000_001 }, 'settings: idleNetworkBytes: must be a whole number from 0 to 10000000000, or off'],
      [{ idleNetworkBytes: 1.5 }, 'settings: idleNetworkBytes: must be a whole number from 0 to 10000000000, or off'],
      [{ idleMetric: 'on' }, 'settings: idleMetric: must be off or a metric { namespace, name, dimensions, statistic, below }'],
      [{ idleMetric: [] }, 'settings: idleMetric: must be off or a metric { namespace, name, dimensions, statistic, below }'],
      [{ idleMetric: metric({ namespace: '' }) }, 'settings: idleMetric: namespace must be text of 1 to 255 characters'],
      [{ idleMetric: metric({ name: 'x'.repeat(256) }) }, 'settings: idleMetric: name must be text of 1 to 255 characters'],
      [{ idleMetric: metric({ dimensions: ['Queue'] }) }, 'settings: idleMetric: dimensions must be an object of at most 30 names, each with text of 1 to 1024 characters'],
      [{ idleMetric: metric({ dimensions: { Queue: '' } }) }, 'settings: idleMetric: dimensions must be an object of at most 30 names, each with text of 1 to 1024 characters'],
      [{ idleMetric: metric({ dimensions: { Queue: '${instance}' } }) }, 'settings: idleMetric: dimensions: only ${resource} is replaced'],
      [{ idleMetric: metric({ statistic: 'p99' }) }, 'settings: idleMetric: statistic must be Maximum, Average or Sum'],
      [{ idleMetric: metric({ below: '1' }) }, 'settings: idleMetric: below must be a number'],
      [{ idleMetric: metric({ unit: 'Count' }) }, 'settings: idleMetric: unknown field unit'],
    ];
    for (const [settings, text] of refused) assert.deepEqual(problems(settings), [text], JSON.stringify(settings));
  });
}

test('a workload refuses the other kind\'s keys: the waker\'s for a standalone one, the idle signals for an HTTP one', () => {
  for (const key of ['waitSeconds', 'drainSeconds', 'maxHolders', 'failedRetrySeconds', 'wakeMode', 'noWakeRules', 'wakeRules']) {
    assert.deepEqual(workloadSettingsProblems({ [key]: null }, standalone()), [`settings: ${key}: a standalone workload has no waker: ${key} is for an HTTP workload`], key);
  }
  assert.deepEqual(workloadSettingsProblems({ wakeTimeoutSeconds: 900, idleMinutes: 60, hibernate: false, type: 'nightly' }, standalone()), []);
  for (const key of IDLE_KEYS) {
    assert.deepEqual(workloadSettingsProblems({ [key]: 'off' }, testConfig()), [`settings: ${key}: an HTTP workload naps on its requests: the idle signals are for a standalone workload`], key);
  }
  assert.deepEqual(workloadSettingsProblems({ waitSeconds: 30, wakeMode: 'browser' }, testConfig()), []);
});

test('without the idle signals asked for, the checks are as before: an idle key is an unknown setting (Google Cloud\'s)', () => {
  assert.deepEqual(defaultsProblems({ idleCpuPercent: 5 }), ['unknown setting idleCpuPercent']);
  assert.deepEqual(defaultsProblems({ idleMetric: 'off' }, { workload: true }), ['unknown setting idleMetric']);
  assert.deepEqual(typesProblems([{ name: 'databases', settings: { idleNetworkBytes: 1 } }]), ['type databases: settings: unknown setting idleNetworkBytes']);
  assert.deepEqual(parseManagerSettings('{"workloads":{"defaults":{"idleCpuPercent":5,"idleMinutes":30}}}').problems, ['workloads.defaults: unknown setting idleCpuPercent']);
  assert.deepEqual(parseManagerSettings('{"workloads":{"defaults":{"idleCpuPercent":5,"idleMinutes":30}}}', { idle: true }).defaults, { idleCpuPercent: 5, idleMinutes: 30 });
});

test('the AWS router reads the organization\'s idle signals from settings.json', async () => {
  const stored = {};
  const store = { getManagerSettings: async () => stored.value ?? null, putManagerSettings: async (value) => { stored.value = value; } };
  const body = Buffer.from(JSON.stringify({ workloads: { defaults: { idleCpuPercent: 'off', idleMinutes: 30 }, types: [{ name: 'databases', settings: { idleMetric: 'off' } }] } }));
  const s3 = { getObjectIf: async () => ({ body, etag: '"1"' }) };
  const settings = createManagerSettings({ s3, url: 's3://b/settings.json', store, now: () => 1, log: silentLog });
  await settings.refresh();
  const current = await settings.current();
  assert.deepEqual([current.defaults, current.types, current.error], [{ idleCpuPercent: 'off', idleMinutes: 30 }, [{ name: 'databases', settings: { idleMetric: 'off' } }], null]);
});

test('withSettings writes a standalone workload\'s keys: a value its own, null back to the levels', () => {
  const next = withSettings(standalone(), { idleCpuPercent: 'off', idleMetric: metric() });
  assert.deepEqual([next.idleCpuPercent, next.idleMetric], ['off', metric()]);
  assert.deepEqual(next.inherits, ['idleMinutes', 'wakeTimeoutSeconds', 'idleNetworkBytes']);
  const back = withSettings(next, { idleCpuPercent: null });
  assert.deepEqual([back.idleCpuPercent, back.inherits], [5, ['idleMinutes', 'wakeTimeoutSeconds', 'idleCpuPercent', 'idleNetworkBytes']]);
  assert.deepEqual(resolvedSettings(effectiveConfig(back, {})).settings, { idleMinutes: 120, wakeTimeoutSeconds: 600, idleCpuPercent: 5, idleNetworkBytes: 'off', idleMetric: metric() });
});

test('the settings action of the AWS router: a router level holding both kinds, a standalone workload refusing the waker\'s keys', async () => {
  const clock = fakeClock();
  const store = fakeStore({ config: standalone(), run: { state: 'AWAKE' }, clock });
  const handler = createController({ store, log: silentLog, now: clock.now, sleep: clock.sleep });
  const routerAnswer = await handler({ action: 'settings', settings: { defaults: { idleCpuPercent: 'off', waitSeconds: 30 } }, by: 'ana' });
  assert.deepEqual(routerAnswer.settings.defaults, { idleCpuPercent: 'off', waitSeconds: 30 });
  assert.deepEqual(await handler({ action: 'settings', workloadId: 'batch', settings: { waitSeconds: 30 }, by: 'ana' }),
    { problems: ['settings: waitSeconds: a standalone workload has no waker: waitSeconds is for an HTTP workload'] });
  assert.equal('waitSeconds' in await store.getConfig('batch'), false);
});

test('the HTTP onboarding refuses the idle signals with the same words', async () => {
  const { createOnboarding } = await import('../src/lib/onboarding.mjs');
  const { WAKER_ARN, fakeAccount } = await import('./account-fake.mjs');
  const a = fakeAccount();
  const tg = a.customer.targetGroup('shop-app', { type: 'instance', targets: [{ Id: 'i-0aaa' }] });
  a.customer.instance('i-0aaa', { tags: { Name: 'shop' } });
  a.customer.rule(10, tg, { host: 'shop.example.com' });
  const onboarding = createOnboarding({
    elbv2: a.elbv2, ec2: a.ec2, autoscaling: a.autoscaling, ecs: a.ecs, rds: a.rds, lambda: a.lambda, store: a.store,
    router: { name: 'dmt-dev', wakerFunctionName: 'dmt-dev-waker', wakerFunctionArn: WAKER_ARN }, now: () => 1_700_000_000_000, sleep: async () => {}, log: silentLog,
  });
  const bad = await onboarding.preview({ workloadId: 'shop', targetGroupArn: tg, settings: { idleCpuPercent: 5, idleMinutes: 30 } });
  assert.deepEqual(bad.problems.filter((p) => p.startsWith('settings')), ['settings: idleCpuPercent: an HTTP workload naps on its requests: the idle signals are for a standalone workload']);
});
