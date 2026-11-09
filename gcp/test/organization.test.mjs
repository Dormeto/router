import assert from 'node:assert/strict';
import { test } from 'node:test';
import { organizationOf } from '../src/organization.mjs';

const at = 1_700_000_000_000;

test('none pushed: unset, no error', () => {
  assert.deepEqual(organizationOf(null), { level: null, page: null, error: null, readAt: null });
});

test('the manager\'s settings.json parsed as AWS parses it: hibernate, joinMinutes, endedWindowDays, defaults, types, and the page', () => {
  const settings = {
    workloads: { hibernate: false, joinMinutes: 10, endedWindowDays: 60, defaults: { idleMinutes: 30 }, types: [{ name: 'batch', tags: { team: 'data' }, settings: { idleMinutes: 60 } }] },
    waitingPage: { mode: 'template', title: 'Acme' },
  };
  const got = organizationOf({ settings, etag: 'e', at });
  assert.deepEqual(got.level, { hibernate: false, joinMinutes: 10, endedWindowDays: 60, defaults: { idleMinutes: 30 }, types: [{ name: 'batch', tags: { team: 'data' }, settings: { idleMinutes: 60 } }] });
  assert.deepEqual(got.page, { mode: 'template', title: 'Acme' });
  assert.deepEqual([got.error, got.readAt], [null, at]);
});

test('a document that is not an object: unset, and the error the health warns of', () => {
  for (const settings of ['oops', 3, null, [1], undefined]) {
    const got = organizationOf({ settings, etag: 'e', at });
    assert.deepEqual([got.level, got.page], [null, null], String(settings));
    assert.match(got.error, /^settings\.json is invalid: /, String(settings));
  }
});

test('an invalid part is dropped and said; the rest applies', () => {
  const got = organizationOf({ settings: { workloads: { defaults: { idleMinutes: 1, waitSeconds: 30 } } }, etag: 'e', at });
  assert.deepEqual(got.level.defaults, { waitSeconds: 30 });
  assert.match(got.error, /^settings\.json: workloads\.defaults: idleMinutes/);
});
