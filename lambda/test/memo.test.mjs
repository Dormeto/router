import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoizeAsync } from '../src/lib/memo.mjs';

test('memoizeAsync shares one successful result', async () => {
  let calls = 0;
  const get = memoizeAsync(async () => ++calls);
  assert.equal(await get(), 1);
  assert.equal(await get(), 1);
  assert.equal(calls, 1);
});

test('memoizeAsync retries after a failure instead of caching it', async () => {
  let calls = 0;
  const get = memoizeAsync(async () => { calls += 1; if (calls === 1) throw new Error('import failed'); return 'ok'; });
  await assert.rejects(get(), /import failed/);
  assert.equal(await get(), 'ok');
  assert.equal(calls, 2);
});
