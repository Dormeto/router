import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../../', import.meta.url).pathname;

function markdown(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return markdown(path);
    return name.endsWith('.md') ? [path] : [];
  });
}

// Private endpoints are served by the proxy function (kube-proxy), so no document waits for an in-cluster agent.
test('the README and docs/ do not mention an in-cluster agent', () => {
  const files = [join(root, 'README.md'), ...markdown(join(root, 'docs'))];
  for (const file of files) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), /in-cluster agent/i, file);
  }
});
