import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tagsProblem } from '../src/lib/tags.mjs';

const many = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, 'v']));

test('no tags, and up to 50, are accepted; 51 are refused', () => {
  assert.equal(tagsProblem({}), null);
  assert.equal(tagsProblem(many(50)), null);
  assert.match(tagsProblem(many(51)), /tags: at most 50/);
});

test('a key is 1 to 128 characters and a value at most 256', () => {
  assert.match(tagsProblem({ '': 'x' }), /tag "": key of 1 to 128 characters/);
  assert.equal(tagsProblem({ ['k'.repeat(128)]: 'x' }), null);
  assert.match(tagsProblem({ ['k'.repeat(129)]: 'x' }), /key of 1 to 128 characters/);
  assert.equal(tagsProblem({ team: 'v'.repeat(256) }), null);
  assert.match(tagsProblem({ team: 'v'.repeat(257) }), /tag "team": value of at most 256 characters/);
});

test('only the characters AWS allows: letters, digits, spaces and _ . : / = + - @', () => {
  assert.equal(tagsProblem({ 'cost center': 'é-ü 日本_.:/=+-@1' }), null);
  assert.match(tagsProblem({ team: 'a,b' }), /tag "team": value characters/);
  assert.match(tagsProblem({ team: 'a\tb' }), /tag "team": value characters/);
  assert.match(tagsProblem({ 'a,b': 'x' }), /tag "a,b": key characters/);
});

test('the dormeto: prefix is reserved, in any case, and keys are case-sensitive', () => {
  assert.match(tagsProblem({ 'dormeto:x': '1' }), /tag "dormeto:x": the dormeto: prefix is reserved/);
  assert.match(tagsProblem({ 'Dormeto:x': '1' }), /reserved/);
  assert.equal(tagsProblem({ Team: 'a', team: 'b' }), null);
});

test('tags must be an object of strings', () => {
  assert.match(tagsProblem(null), /tags: an object/);
  assert.match(tagsProblem([]), /tags: an object/);
  assert.match(tagsProblem({ a: 1 }), /tag "a": value must be a string/);
});
