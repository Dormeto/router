import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HIBERNATION_MAX_DAYS, hibernationDue, parseManagerSettings, resolveHibernation, settingsProblems,
} from '../src/lib/hibernation.mjs';

test('the hibernation maintenance wake is 59 days', () => {
  assert.equal(HIBERNATION_MAX_DAYS, 59);
});

test('hibernationDue: the run\'s hibernated.at plus 59 days; null without a record, an unreadable one, or once the run asks for a fresh boot', () => {
  const at = Date.UTC(2026, 7, 1);
  const hibernated = JSON.stringify({ ids: ['i-0123456789abcdef0'], at });
  assert.equal(hibernationDue({ hibernated }), at + 59 * 86_400_000);
  assert.equal(hibernationDue({ hibernated, freshBoot: false }), at + 59 * 86_400_000);
  // Its maintenance wake came (it failed, or the workload was released since): its next stop is plain already.
  assert.equal(hibernationDue({ hibernated, freshBoot: true }), null);
  for (const run of [null, {}, { hibernated: '{not json' }, { hibernated: '{"ids":[]}' }, { hibernated: '{"at":"yesterday"}' }]) {
    assert.equal(hibernationDue(run), null, JSON.stringify(run));
  }
});

test('resolveHibernation follows the order workload, fallback types, router, manager, default', () => {
  const on = { hibernate: true };
  const off = { hibernate: false };
  for (const [name, input, expected] of [
    ['workload false over router true', { workload: false, router: true, manager: on }, { hibernate: false, from: 'workload' }],
    ['workload false over fallback types', { workload: false, fallbackTypes: ['t3.large'] }, { hibernate: false, from: 'workload' }],
    ['workload true with fallback types', { workload: true, fallbackTypes: ['t3.large'] }, { hibernate: true, from: 'workload' }],
    ['fallback types over router true', { router: true, fallbackTypes: ['t3.large'] }, { hibernate: false, from: 'fallback-types' }],
    ['fallback types over manager true', { fallbackTypes: ['t3.large'], manager: on }, { hibernate: false, from: 'fallback-types' }],
    ['empty fallback types do not count', { fallbackTypes: [], router: true }, { hibernate: true, from: 'router' }],
    ['router true', { router: true, manager: off }, { hibernate: true, from: 'router' }],
    ['router false over manager true', { router: false, manager: on }, { hibernate: false, from: 'router' }],
    ['manager true', { manager: on }, { hibernate: true, from: 'manager' }],
    ['manager false', { manager: off }, { hibernate: false, from: 'manager' }],
    ['manager null', { manager: null }, { hibernate: true, from: 'default' }],
    ['nothing at all', {}, { hibernate: true, from: 'default' }],
    ['null levels are unset', { workload: null, router: null, manager: off }, { hibernate: false, from: 'manager' }],
    ['undefined levels are unset', { workload: undefined, router: undefined, manager: on }, { hibernate: true, from: 'manager' }],
    ['a string is unset', { workload: 'true', router: 'false', manager: off }, { hibernate: false, from: 'manager' }],
    ['a non-boolean manager value is unset', { manager: { hibernate: 'false' } }, { hibernate: true, from: 'default' }],
    ['fallback types that are not an array do not count', { fallbackTypes: 'x', router: true }, { hibernate: true, from: 'router' }],
  ]) assert.deepEqual(resolveHibernation(input), expected, name);
});

const JOIN_PROBLEM = 'settings: joinMinutes must be a whole number from 0 to 120, a multiple of 5, or null';

test('settingsProblems accepts only hibernate as true, false or null and joinMinutes as its minutes or null', () => {
  for (const [settings, expected] of [
    [{ hibernate: true }, []],
    [{ hibernate: false }, []],
    [{ hibernate: null }, []],
    [{ joinMinutes: 0 }, []],
    [{ joinMinutes: 120 }, []],
    [{ joinMinutes: null }, []],
    [{ hibernate: true, joinMinutes: 15 }, []],
    [{ joinMinutes: 7 }, [JOIN_PROBLEM]],
    [{ joinMinutes: 125 }, [JOIN_PROBLEM]],
    [{ joinMinutes: '15' }, [JOIN_PROBLEM]],
    [{ hibernate: 'yes', joinMinutes: 7 }, ['settings: hibernate must be true, false or null', JOIN_PROBLEM]],
    [{}, []],
    [{ hibernate: 'yes' }, ['settings: hibernate must be true, false or null']],
    [{ hibernate: 1 }, ['settings: hibernate must be true, false or null']],
    [{ idle: 1 }, ['settings: unknown setting idle']],
    [{ hibernate: 'yes', idle: 1 }, ['settings: hibernate must be true, false or null', 'settings: unknown setting idle']],
    [null, ['settings must be an object']],
    [[], ['settings must be an object']],
    ['x', ['settings must be an object']],
  ]) assert.deepEqual(settingsProblems(settings), expected, JSON.stringify(settings));
});

test('parseManagerSettings reads workloads.hibernate and workloads.joinMinutes and ignores the rest', () => {
  for (const [text, expected] of [
    ['{}', { hibernate: true, joinMinutes: null, endedWindowDays: null }],
    ['{"workloads":{}}', { hibernate: true, joinMinutes: null, endedWindowDays: null }],
    ['{"workloads":{"hibernate":true}}', { hibernate: true, joinMinutes: null, endedWindowDays: null }],
    ['{"workloads":{"hibernate":false},"x":1}', { hibernate: false, joinMinutes: null, endedWindowDays: null }],
    ['{"workloads":{"hibernate":false,"y":2}}', { hibernate: false, joinMinutes: null, endedWindowDays: null }],
    ['{"workloads":{"joinMinutes":30}}', { hibernate: true, joinMinutes: 30, endedWindowDays: null }],
    ['{"workloads":{"joinMinutes":0,"hibernate":false}}', { hibernate: false, joinMinutes: 0, endedWindowDays: null }],
  ]) assert.deepEqual(parseManagerSettings(text), expected, text);
});

test('parseManagerSettings: an invalid joinMinutes is unset, and hibernate stays', () => {
  for (const joinMinutes of ['"15"', '7', '125', '-5', '1.5', 'null', 'true', '[]']) {
    assert.deepEqual(parseManagerSettings(`{"workloads":{"hibernate":false,"joinMinutes":${joinMinutes}}}`), { hibernate: false, joinMinutes: null, endedWindowDays: null }, joinMinutes);
  }
});

// Settings at scale (vision design §5–§6): the organization's defaults and types; an invalid part is dropped and said, never
// losing hibernate or the join.
test('parseManagerSettings reads the organization\'s defaults and types, drops what is invalid and says it', () => {
  const api = { name: 'api', tags: { kind: 'api' }, settings: { idleMinutes: 30 } };
  const parsed = parseManagerSettings(JSON.stringify({ workloads: {
    hibernate: false, joinMinutes: 30, defaults: { idleMinutes: 'x', waitSeconds: 20, wakeMode: 'browser' }, types: [api, { name: 'Bad', tags: {} }, { name: 'databases', settings: { idleMinutes: 45 } }],
  } }));
  assert.deepEqual([parsed.hibernate, parsed.joinMinutes, parsed.defaults, parsed.types], [false, 30, { waitSeconds: 20, wakeMode: 'browser' }, [api, { name: 'databases', settings: { idleMinutes: 45 } }]]);
  assert.deepEqual(parsed.problems, [
    'workloads.defaults: idleMinutes must be a whole number from 5 to 1440',
    'workloads.types: type Bad: a name is lower-case letters, digits and hyphens, starting with a letter (at most 32)',
    'workloads.types: type Bad: tags must select at least one tag (key and value)',
  ]);
  // Without hibernate: on, the rest read all the same.
  assert.deepEqual(parseManagerSettings('{"workloads":{"defaults":{"idleMinutes":20}}}'), { hibernate: true, joinMinutes: null, endedWindowDays: null, defaults: { idleMinutes: 20 } });
  // Not an object, not a list: none, said.
  assert.deepEqual(parseManagerSettings('{"workloads":{"defaults":[],"types":{}}}').problems, ['workloads.defaults: settings must be an object', 'workloads.types: types must be a list']);
  // Twenty-one custom types: none kept, the hibernate still read.
  const many = Array.from({ length: 21 }, (_, i) => ({ name: `t${i}`, tags: { k: `${i}` }, settings: {} }));
  const crowded = parseManagerSettings(JSON.stringify({ workloads: { hibernate: false, types: many } }));
  assert.deepEqual([crowded.hibernate, crowded.types, crowded.problems], [false, undefined, ['workloads.types: at most 20 custom types']]);
});

test('settingsProblems: a router\'s defaults are checked as a level\'s', () => {
  assert.deepEqual(settingsProblems({ defaults: { idleMinutes: 30, noWakeRules: [{ name: 'h', pathPrefixes: ['/health'] }], waitSeconds: null } }), []);
  assert.deepEqual(settingsProblems({ defaults: { idleMinutes: 1 } }), ['settings: defaults: idleMinutes must be a whole number from 5 to 1440']);
  assert.deepEqual(settingsProblems({ defaults: [] }), ['settings: defaults: settings must be an object']);
  assert.deepEqual(settingsProblems({ defaults: { type: 'api' } }), ['settings: defaults: unknown setting type']);
});

test('parseManagerSettings throws on bad settings', () => {
  for (const text of [
    'not json', '', '[]', 'null', '1', '{"workloads":{"hibernate":"no"}}', '{"workloads":{"hibernate":null}}',
    '{"workloads":[]}', '{"workloads":"x"}', '{"workloads":null}',
  ]) assert.throws(() => parseManagerSettings(text), Error, text);
});

test('parseManagerSettings drops a rule of the wrong shape and says it (review, 2026-11-04)', () => {
  const parsed = parseManagerSettings(JSON.stringify({ workloads: { defaults: { idleMinutes: 20, noWakeRules: [{ name: 'health', pathPrefixes: '/health' }] } } }));
  assert.deepEqual(parsed.defaults, { idleMinutes: 20 });
  assert.match(parsed.problems[0], /^workloads\.defaults: noWakeRules: rule health: pathPrefixes must be a list of paths/);
});
