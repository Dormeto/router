import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const SRC = new URL('../src/', import.meta.url).pathname;
const ALLOWED = [/^\.\.?\//, /^node:/, /^@aws-sdk\/client-[a-z0-9-]+$/];

async function sourceFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map((e) => (e.isDirectory() ? sourceFiles(join(dir, e.name)) : [join(dir, e.name)])));
  return files.flat().filter((f) => f.endsWith('.mjs'));
}

test('lambda sources import only relative modules, node built-ins and runtime AWS SDK clients', async () => {
  const files = await sourceFiles(SRC);
  assert.ok(files.length > 0);
  for (const file of files) {
    const code = await readFile(file, 'utf8');
    for (const [, spec] of code.matchAll(/(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/g)) {
      assert.ok(ALLOWED.some((re) => re.test(spec)), `${file} imports forbidden module ${spec}`);
    }
  }
});

test('package.json declares no runtime dependencies', async () => {
  const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.dependencies, undefined);
});

test('lib modules never import the AWS SDK', async () => {
  for (const file of await sourceFiles(join(SRC, 'lib'))) {
    assert.doesNotMatch(await readFile(file, 'utf8'), /@aws-sdk\//, file);
  }
});
