import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HIBERNATION_MAX_DAYS, parseManagerSettings, resolveHibernation, settingsProblems,
} from '../src/lib/hibernation.mjs';

test('the hibernation maintenance wake is 59 days', () => {
  assert.equal(HIBERNATION_MAX_DAYS, 59);
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

test('settingsProblems accepts only the key hibernate as true, false or null', () => {
  for (const [settings, expected] of [
    [{ hibernate: true }, []],
    [{ hibernate: false }, []],
    [{ hibernate: null }, []],
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

test('parseManagerSettings reads workloads.hibernate and ignores the rest', () => {
  for (const [text, expected] of [
    ['{}', { hibernate: true }],
    ['{"workloads":{}}', { hibernate: true }],
    ['{"workloads":{"hibernate":true}}', { hibernate: true }],
    ['{"workloads":{"hibernate":false},"x":1}', { hibernate: false }],
    ['{"workloads":{"hibernate":false,"y":2}}', { hibernate: false }],
  ]) assert.deepEqual(parseManagerSettings(text), expected, text);
});

test('parseManagerSettings throws on bad settings', () => {
  for (const text of [
    'not json', '', '[]', 'null', '1', '{"workloads":{"hibernate":"no"}}', '{"workloads":{"hibernate":null}}',
    '{"workloads":[]}', '{"workloads":"x"}', '{"workloads":null}',
  ]) assert.throws(() => parseManagerSettings(text), Error, text);
});
