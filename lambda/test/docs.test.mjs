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

// R15 of the AWS and Google Cloud review (vision docs/plans/2026-11-10-aws-google-cloud-review-apis.md): the AWS pages say what the code does.
const read = (path) => readFileSync(join(root, path), 'utf8');
const flat = (text) => text.replace(/[`*]/g, '').replace(/\s+/g, ' ');

test('the README opens without "MVP" and has no note for a release of 0.14 or earlier', () => {
  const readme = read('README.md');
  assert.doesNotMatch(readme, /\bMVP\b/);
  assert.doesNotMatch(readme, /Upgrading from 0\.14/);
  assert.match(flat(readme), /On AWS the router is two Lambda functions/);
});

// Kubernetes: the onboarding stores 300 s but lists wakeTimeoutSeconds in `inherits`, so the levels' built-in 600 s decides (settings-levels.mjs BUILT_IN).
test('Kubernetes\' wake timeout is the levels\' 600 s on every page that gives it', () => {
  const index = read('docs/scenarios/README.md');
  assert.match(index, /\[Kubernetes on EKS\]\(kubernetes\.md\)[^\n]*\| 600 s \|/);
  assert.match(flat(index), /The built-in wake timeout is 600 s, Kubernetes included, and 1800 s for a workload with a database/);
  assert.match(flat(read('README.md')), /Their wake timeout is the built-in 600 s, which leaves room for a node to launch \(the onboarding lists it in inherits, so the levels decide; 1800 s with a database companion\)/);
  assert.match(flat(read('docs/scenarios/kubernetes.md')), /Wake timeout\. 600 s by default \(the levels' built-in; the manager's onboarding leaves it to them\), 1800 s with a database companion/);
  assert.match(flat(read('docs/scenarios/kubernetes.md')), /The wake timeout's 600 s default leaves room for it/);
  for (const file of ['README.md', 'docs/scenarios/README.md', 'docs/scenarios/kubernetes.md']) {
    assert.doesNotMatch(flat(read(file)), /(wake timeout[^.]{0,40}300 s|300 s \(manager onboarding\)|300 s by default|300 s for Kubernetes)/i, file);
  }
});

// settings-levels.mjs TYPE_BUILT_IN: a workload with databases has 1800 s from the levels, whoever wrote it; the module's variable is null.
test('a workload with databases has 1800 s from the levels, written with Terraform or not', () => {
  const databases = flat(read('docs/scenarios/databases.md'));
  assert.match(databases, /A workload written with the Terraform workload module has it too: its wake_timeout_seconds is null, so the levels decide/);
  assert.doesNotMatch(databases, /keeps 600 s|set wake_timeout_seconds = 1800|gives a workload with databases a wake timeout of 1800/);
  const readme = flat(read('README.md'));
  assert.match(readme, /wake_timeout_seconds \(1800 s for a workload with a database, 600 s otherwise: the built-in values of the levels, below, whoever wrote the workload\)/);
  assert.doesNotMatch(readme, /default stays 600 s/);
  const index = flat(read('docs/scenarios/README.md'));
  assert.match(index, /\[RDS and Aurora databases\]\(databases\.md\)[^|]*\|[^|]*\|[^|]*\| 1800 s \|/);
  assert.match(index, /The built-in wake timeout is 600 s, Kubernetes included, and 1800 s for a workload with a database\. The manager's onboarding and the Terraform workload module leave it to the levels/);
  assert.doesNotMatch(index, /keeps 600 s unless/);
});

test('the AWS wake paragraphs say once where Google Cloud\'s probe goes and what asleep answers there', () => {
  const readme = flat(read('README.md'));
  assert.equal(readme.match(/\/_dormeto\/wake/g)?.length, 1);
  assert.match(readme, /On Google Cloud the waiter page's probe goes to \/_dormeto\/wake with the visitor's path in x-dormeto-path\. A workload that sleeps or wakes answers a 202 there, not a 503: see \[the Compute Engine page\]\(docs\/scenarios\/google-cloud-compute-engine\.md#the-waiting-page\)/);
});
