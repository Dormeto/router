// The adapters' calls and the manifest's router grants (access.json) must agree: a permission an adapter needs and the
// manifest lacks is a 403 in production, found by a user.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as compute from '../src/compute.mjs';
import * as urlmaps from '../src/urlmaps.mjs';
import * as monitoring from '../src/monitoring.mjs';
import * as tasks from '../src/tasks.mjs';

const ADAPTERS = { compute, urlmaps, monitoring, tasks };

async function granted() {
  const manifest = JSON.parse(await readFile(new URL('../access.json', import.meta.url), 'utf8'));
  const permissions = new Set();
  for (const { role } of manifest.router) {
    const custom = /\/roles\/(.+)$/.exec(role)?.[1];
    for (const p of custom ? manifest.roles[custom].permissions : manifest.predefined[role]) permissions.add(p);
  }
  return permissions;
}

for (const [name, adapter] of Object.entries(ADAPTERS)) {
  test(`${name}: every permission of CALLS is in the manifest's router grants`, async () => {
    const permissions = await granted();
    assert.ok(Object.keys(adapter.CALLS).length > 0);
    for (const [fn, needed] of Object.entries(adapter.CALLS)) {
      for (const p of needed) assert.ok(permissions.has(p), `${name}.${fn} needs ${p}`);
    }
  });
}
