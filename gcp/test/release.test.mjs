// R8: the router's image, its build script, its version and its scenario page (vision docs/plans/2026-10-29-google-cloud.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const ROOT = new URL('../../', import.meta.url).pathname;
const read = (path) => readFileSync(`${ROOT}${path}`, 'utf8');
const PACKAGE = JSON.parse(read('package.json'));

test('the router is 0.35.0 and needs the Node that has import.meta.main', () => {
  assert.equal(PACKAGE.version, '0.35.0');
  assert.equal(PACKAGE.engines.node, '>=24.2');
});

test('check parses the Google Cloud entry points too', () => {
  for (const entry of ['server', 'waker', 'controller']) {
    assert.ok(PACKAGE.scripts.check.includes(`node --check gcp/src/${entry}.mjs`), entry);
  }
});

test('the Containerfile builds the one image from a distroless Node 24 and carries only what the roles import', () => {
  const file = read('gcp/Containerfile');
  assert.match(file, /^FROM gcr\.io\/distroless\/nodejs24-debian12\b/m);
  for (const copied of ['package.json', 'lambda/src/lib', 'gcp/src']) assert.ok(file.includes(copied), copied);
  assert.doesNotMatch(file, /gcp\/test|lambda\/test|node_modules/);
  assert.match(file, /^CMD \["gcp\/src\/server\.mjs"\]/m);
});

const image = (...args) => spawnSync('bash', [`${ROOT}scripts/gcp-image.sh`, ...args], { encoding: 'utf8', env: { ...process.env, DMT_IMAGE_DRY_RUN: '1' } });

test('gcp-image.sh builds linux/amd64 with podman and tags the version', () => {
  const run = image('0.35.0');
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /podman build --platform linux\/amd64 -f gcp\/Containerfile -t dormeto-router:0\.35\.0 \./);
  assert.doesNotMatch(run.stdout, /push|login/);
});

test('gcp-image.sh --push logs in with the dormeto-dev token, tags and pushes the repository', () => {
  const run = image('0.35.0', '--push', 'europe-west1-docker.pkg.dev/dormeto-dev/dormeto/router');
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /gcloud --configuration dormeto-dev auth print-access-token \| podman login -u oauth2accesstoken --password-stdin europe-west1-docker\.pkg\.dev/);
  assert.match(run.stdout, /podman push dormeto-router:0\.35\.0 docker:\/\/europe-west1-docker\.pkg\.dev\/dormeto-dev\/dormeto\/router:0\.35\.0/);
});

test('gcp-image.sh refuses a missing or odd argument with exit 2', () => {
  for (const args of [[], ['0.35.0', '--push'], ['0.35.0', '--other'], ['v1'], ['0.35.0', '--push', 'a', 'b']]) {
    const run = image(...args);
    assert.equal(run.status, 2, args.join(' '));
    assert.match(run.stderr, /usage: /);
  }
});

test('the scenario page is linked from the scenarios index and states its limits', () => {
  const page = read('docs/scenarios/google-cloud-compute-engine.md');
  assert.match(read('docs/scenarios/README.md'), /\(google-cloud-compute-engine\.md\)/);
  for (const needle of ['```mermaid', '## Services', '## Wake time', '## Behavior', '## Limits', '/_dormeto/*', 'error response', 'ignore_changes', 'secure tag']) {
    assert.ok(page.includes(needle), needle);
  }
  assert.match(page.replace(/[`*]/g, '').replace(/\s+/g, ' '), /another service too shows the waiting page for that service's own 502 and 503 while the workload is asleep/);
});

const flat = (text) => text.replace(/[`*]/g, '').replace(/\s+/g, ' ');

test('the scenario page: where the policy goes, what the waker answers, and when a nap does not happen', () => {
  const page = flat(read('docs/scenarios/google-cloud-compute-engine.md'));
  assert.doesNotMatch(page, /\(and the map's default\)/);
  assert.doesNotMatch(page, /on the google_compute_url_map and/);
  assert.match(page, /a policy on the map itself would cover the whole load balancer/);
  assert.match(page, /A service that no URL map names any more, or that another URL map names too, is not napped/);
  assert.match(page, /the waker answers the load balancer's fetch with a 200/);
  assert.match(page, /POST \/_dormeto\/wake, answered with a 202/);
  assert.match(page, /retried with a pause, up to 60 s/);
  assert.doesNotMatch(page, /retried 3 times/);
  assert.match(page, /request_count over the idle window, through any URL map/);
  assert.match(page, /regional managed group with the target shape EVEN and instance redistribution on is refused/);
});

test('the scenario page: a managed group recreates a VM suspended for over 60 days', () => {
  const page = flat(read('docs/scenarios/google-cloud-compute-engine.md'));
  assert.match(page, /A managed group recreates a VM suspended for over 60 days, without keeping its name, IP addresses or disks unless they are stateful/);
});

test('the scenario page: what ignoring the map\'s fields costs, and what is only expected without it', () => {
  const page = flat(read('docs/scenarios/google-cloud-compute-engine.md'));
  assert.match(page, /ignore_changes = \[host_rule, path_matcher\]/);
  assert.match(page, /is then expected to show the load balancer's own error page/);
  assert.doesNotMatch(page, /and cannot be woken from its browser/);
  assert.match(page, /later edits of your path matchers must go outside Terraform's plan, or by removing the ignore for that apply/);
});

test('the README does not say the hand-made repository can grant nothing', () => {
  const readme = flat(read('README.md'));
  assert.doesNotMatch(readme, /a repository is not IAM: nothing is granted/);
  assert.match(readme, /can create Artifact Registry's service agent and its binding: Google's own, the CLI shows it at its next run/);
});

test('the README has a Google Cloud section naming the image script and the dev repository', () => {
  const readme = read('README.md');
  assert.match(readme, /^## Google Cloud$/m);
  for (const needle of ['scripts/gcp-image.sh', 'gcp/Containerfile', 'europe-west1-docker.pkg.dev/dormeto-dev/dormeto/router', 'gcloud artifacts repositories create dormeto']) {
    assert.ok(readme.includes(needle), needle);
  }
});
