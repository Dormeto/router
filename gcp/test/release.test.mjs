// R8: the router's image, its build script, its version and its scenario page (vision docs/plans/2026-10-29-google-cloud.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const ROOT = new URL('../../', import.meta.url).pathname;
const read = (path) => readFileSync(`${ROOT}${path}`, 'utf8');
const PACKAGE = JSON.parse(read('package.json'));

test('the router has an x.y.z version and needs the Node that has import.meta.main', () => {
  assert.match(PACKAGE.version, /^\d+\.\d+\.\d+$/);
  assert.equal(PACKAGE.engines.node, '>=24.2');
});

// dormeto-release router (vision tools/release) bumps package.json and these lines; they name the package's version.
test('the README\'s image examples and the scenarios index name the package\'s version', () => {
  const readme = read('README.md');
  const named = [...readme.matchAll(/gcp-image\.sh (\d\S*)|dormeto-router:(\d\S*)/g)].map((m) => m[1] ?? m[2]);
  assert.equal(named.length, 3, 'the build, the local run and the push');
  for (const version of named) assert.equal(version, PACKAGE.version);
  assert.match(read('docs/scenarios/README.md'), new RegExp(`as of router ${PACKAGE.version.replace(/\./g, '\\.')}\\.`));
});

// A release is not a word a released page can keep: dormeto-release router refuses a README.md or docs/ that says it.
test('the README and the scenario pages call nothing unreleased', () => {
  for (const file of ['README.md', 'docs/scenarios/README.md', CE, SQL, GKE]) {
    assert.doesNotMatch(read(file), /unreleased/i, file);
  }
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
  const run = image('1.2.3');
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /podman build --platform linux\/amd64 -f gcp\/Containerfile -t dormeto-router:1\.2\.3 \./);
  assert.doesNotMatch(run.stdout, /push|login/);
});

test('gcp-image.sh --push logs in with the dormeto-dev token, tags and pushes the repository', () => {
  const run = image('1.2.3', '--push', 'europe-west1-docker.pkg.dev/dormeto-dev/dormeto/router');
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /gcloud --configuration dormeto-dev auth print-access-token \| podman login -u oauth2accesstoken --password-stdin europe-west1-docker\.pkg\.dev/);
  assert.match(run.stdout, /podman push dormeto-router:1\.2\.3 docker:\/\/europe-west1-docker\.pkg\.dev\/dormeto-dev\/dormeto\/router:1\.2\.3/);
});

test('gcp-image.sh refuses a missing or odd argument with exit 2', () => {
  for (const args of [[], ['1.2.3', '--push'], ['1.2.3', '--other'], ['v1'], ['1.2.3', '--push', 'a', 'b']]) {
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

// R12 of the coverage plan (vision docs/plans/2026-10-30-google-cloud-coverage.md): the pages of router 0.37.0, each with its limits.
const CE = 'docs/scenarios/google-cloud-compute-engine.md';
const SQL = 'docs/scenarios/google-cloud-sql.md';
const GKE = 'docs/scenarios/google-kubernetes-engine.md';
const PAGE_PARTS = ['```mermaid', '## Services', '## Wake time', '## Behavior', '## Limits'];
// flat() drops the asterisks of the routes and headers: these read the page with its marks, only its spaces made one.
const spaced = (text) => text.replace(/\s+/g, ' ');

// The acceptance of 2026-11-04 (vision docs/plans/2026-10-30-google-cloud-coverage.md, "Acceptance results"): passed but for
// ten workloads on one URL map, which was not run.
const NOT_ACCEPTED = /not accepted yet|acceptance has not run|the acceptance's to check|the acceptance tries it|No wake through the router has been timed yet|no wake of a NEG's VM through the router has been timed yet/;
const ACCEPTED = /From router 0\.37\.0, accepted on 2026-11-04 with CLI 0\.11\.0[,:]/g;

test('the Compute Engine page: what ships in router 0.37.0 says so, and that it was accepted but for ten workloads on one map', () => {
  const page = flat(read(CE));
  assert.doesNotMatch(page, /router 0\.35\.0/);
  assert.doesNotMatch(page, NOT_ACCEPTED);
  assert.equal(page.match(ACCEPTED)?.length, 4, 'the NEGs, the swap, schedules and pauses, IP lists');
  assert.match(page, /but for ten workloads on one URL map, which was not run/);
  assert.match(page, /\(google-cloud-sql\.md\)/);
  assert.match(page, /\(google-kubernetes-engine\.md\)/);
  assert.doesNotMatch(page, /The global external Application Load Balancer only/);
  assert.match(page, /at most 10 instances, 10 concurrent requests, 512 MiB, timeout 1800 s/);
});

test('the Compute Engine page: zonal NEGs, with M1\'s times and their limits', () => {
  const page = flat(read(CE));
  assert.match(page, /## Zonal network endpoint groups/);
  assert.match(page, /A stopped or suspended VM keeps its endpoint/);
  for (const time of ['stopped after 106–107 s', 'healthy after 33–64 s', 'the application answering steadily after 38–75 s', 'suspended after 26–51 s', 'healthy after 11–13 s']) {
    assert.ok(page.includes(time), time);
  }
  assert.match(page, /A nap acts only on what still is the NEG/);
  assert.match(page, /\(cause backends-changed/);
  assert.match(page, /A VM added to or removed from a NEG while the workload sleeps is found at its next nap/);
  assert.match(page, /a VM of a managed group/);
  assert.match(page, /its nap took 8\.5 minutes .*and a browser's probe woke it in 551 s/);
});

test('the Compute Engine page: the swap of regional and classic load balancers, its times and its limits', () => {
  const page = flat(read(CE));
  assert.match(page, /## Regional and classic load balancers: the swap/);
  for (const needle of ['`/_dormeto/backend/*`', '`x-dormeto-switch: swap`', '`x-dormeto-ref: service`', '`Dormeto: the waker of workload <id>`', '`replace: true`']) {
    assert.ok(spaced(read(CE)).includes(needle), needle);
  }
  assert.match(page, /SWAP_WAIT: 100 s on a regional load balancer, 250 s on a classic one/);
  assert.match(page, /The default wake timeout adds SWAP_WAIT: 700 s for VMs on a regional load balancer, 850 s on a classic one/);
  assert.match(page, /\| Classic \| 5\.5 minutes \| 2 min 16 s after a visitor's POST \/_dormeto\/wake; AWAKE after 287 s, the unswap's 250 s included \|/);
  assert.match(page, /\| Regional \| 3\.5 to 6\.5 minutes to ASLEEP \| 62 s after a POST \/_dormeto\/wake; AWAKE 123 to 188 s after a wake by a browser's probe, a POST or a pause, the unswap's 100 s included \|/);
  assert.match(page, /Steady traffic, 45 requests in 15 minutes, kept each kind awake through the router with a 5-minute idle window/);
  assert.match(page, /terraform plan showed no change with a regional workload onboarded/);
  assert.match(page, /ten workloads on one URL map were not run in the acceptance/);
  assert.match(page, /No nap was killed so in the acceptance/);
  assert.match(page, /ignore_changes = \[default_service, default_route_action, host_rule, path_matcher\]/);
  assert.match(page, /answered that load balancer's plain-HTTP requests with a 302 to https:\/\/ for about 40 s/);
  assert.match(page, /A visitor at a nap's start waits up to 2 × SWAP_WAIT with the VMs running/);
  assert.match(page, /A nap that dies under a swap holds visitors up to 15 minutes/);
  assert.match(page, /A request with a body gets the page under a swap/);
  assert.match(page, /Ten naps on one regional URL map/);
  assert.match(spaced(read(CE)), /A header of your own named `x-dormeto-\*` on a regional map's swapped entry is replaced at the swap and not given back/);
  assert.match(page, /about 250 s or more on a regional load balancer and 340 s or more on a classic one/);
});

test('the Compute Engine page: schedules, pauses and IP lists, with what they do not hold', () => {
  const page = flat(read(CE));
  assert.match(page, /## Schedules and pauses/);
  assert.match(page, /## IP lists/);
  assert.match(page, /at most 10 scheduled naps each run, oldest occurrence first/);
  assert.match(page, /With --keep-asleep, a visitor still wakes the workload/);
  assert.match(page, /A scheduled nap's occurrence is spent once its task is accepted/);
  assert.match(page, /on a GKE workload, but for ten workloads on one URL map in one nap window, which was not run/);
  assert.match(page, /with --keep-asleep the workload stayed asleep into an awake window, and a visitor's probe woke it/);
  assert.match(page, /Only the action ignore exists here/);
  assert.match(page, /the page's probe from a Google address got a 202 and the workload slept on \(WakeIgnored\)/);
  assert.match(page, /Behind a regional load balancer it was the client's/);
  assert.match(page, /An IP list stops browsers and scanners on those addresses, not an API client that means to wake/);
  assert.match(page, /called stuck after 35 minutes/);
});

test('the Cloud SQL page is linked from the scenarios index and states its limits', () => {
  const raw = read(SQL);
  const page = flat(raw);
  assert.match(read('docs/scenarios/README.md'), /\]\(google-cloud-sql\.md\)/);
  for (const needle of PAGE_PARTS) assert.ok(raw.includes(needle), needle);
  for (const needle of ['dormetoRouterDatabasesRead', 'dormetoRouterDatabases:', 'cloudsql.instances.update', 'dormeto=managed', '--cloud-sql', '--with cloud-sql']) {
    assert.ok(page.includes(needle), needle);
  }
  assert.doesNotMatch(page, NOT_ACCEPTED);
  assert.equal(page.match(ACCEPTED)?.length, 1);
  assert.match(page, /About 9\.2 minutes through the router \(551 s/);
  assert.match(page, /a wake 5 minutes after the binding's removal was refused/);
  assert.match(page, /no such refusal was met, in the measures or the acceptance/);
  assert.match(page, /done after 104 s/);
  assert.match(page, /done after 562 s/);
  assert.match(page, /The default wake timeout of a workload with a companion is 1700 s/);
  assert.match(page, /a PATCH without the tag was refused \(403\), and accepted 40 s after the tag was bound/);
  assert.match(page, /its replicas keep running, and billing, while the workload sleeps/);
  assert.match(page, /A read replica is refused/);
  assert.match(page, /A database belongs to one router/);
  assert.match(page, /An offboarding of an awake workload leaves a stopped database stopped/);
  assert.match(page, /logged CompanionGone/);
  assert.match(page, /companionsGone/);
  assert.match(page, /DatabaseNotFollowed/);
  assert.match(page, /ignore_changes = \[settings\[0\]\.activation_policy\]/);
});

test('the GKE page is linked from the scenarios index and states its limits', () => {
  const raw = read(GKE);
  const page = flat(raw);
  assert.match(read('docs/scenarios/README.md'), /\]\(google-kubernetes-engine\.md\)/);
  for (const needle of PAGE_PARTS) assert.ok(raw.includes(needle), needle);
  for (const needle of ['cloud.google.com/neg', 'dormetoRouterKubernetes', 'container.clusters.get', 'container.clusters.connect', 'dormeto-<workload>', 'gke.goog',
    'autoscaling.keda.sh/paused-replicas', 'k8s2-', 'gkegw1-', 'gkemcg1-', 'notGivenBack', 'minReplicaCount: 0', 'kubernetes_deployment_v1', 'kubernetes_stateful_set_v1', 'spec[0].replicas']) {
    assert.ok(page.includes(needle), needle);
  }
  // The Role, rule by rule (spec section 8, trimmed 2026-10-31).
  for (const row of [/\| apps \| deployments, statefulsets \| get \|/, /\| apps \| replicasets \| list \|/, /\| apps \| deployments\/scale, statefulsets\/scale \| patch \|/,
    /\| \(core\) \| pods, events \| list \|/, /\| keda\.sh \| scaledobjects \| list, patch \|/]) {
    assert.match(page, row);
  }
  assert.doesNotMatch(page, NOT_ACCEPTED);
  assert.equal(page.match(ACCEPTED)?.length, 1);
  assert.match(page, /on a Standard cluster with no KEDA/);
  assert.match(page, /13 s through the router/);
  assert.match(page, /its nap took about 6 minutes/);
  assert.match(page, /Nothing cluster-wide/);
  assert.match(page, /scaling pods saves money only on Autopilot, or with the node autoscaler freeing a node/);
  assert.match(page, /the application answering steadily 9 s after the scale/);
  assert.match(page, /GKE took it away, without a word, 48 s after the HTTPRoute's rules changed/);
  assert.match(page, /An owner's pods must be behind the NEG to nap/);
  assert.match(page, /A new pod's attach may delay a nap/);
  assert.match(page, /A forced offboarding leaves an asleep owner at 0/);
  assert.match(page, /A wake with no record brings 1 replica/);
  assert.match(page, /A workload at 0 replicas cannot be onboarded/);
  assert.match(page, /The RBAC's lag at the onboarding/);
});

test('the scenarios index has a row for each Google Cloud page', () => {
  const rows = read('docs/scenarios/README.md').split('\n').filter((line) => line.startsWith('| ['));
  const row = (page) => flat(rows.find((line) => line.includes(`](${page})`)) ?? '');
  assert.match(row('google-cloud-compute-engine.md'), /global, regional or classic/);
  assert.match(row('google-cloud-compute-engine.md'), /700 s regional, 850 s classic/);
  assert.match(row('google-cloud-compute-engine.md'), /through a regional load balancer 62 s from POST \/_dormeto\/wake, a classic one 2 min 16 s/);
  assert.match(row('google-cloud-sql.md'), /9\.2 min through the router/);
  assert.match(row('google-cloud-sql.md'), /\| 1700 s \|$/);
  assert.match(row('google-kubernetes-engine.md'), /13 s through the router/);
  assert.match(row('google-kubernetes-engine.md'), /\| 300 s \|$/);
  const index = flat(read('docs/scenarios/README.md'));
  assert.doesNotMatch(index, /what the acceptance has not run yet/);
  assert.match(index, /accepted on 2026-11-04 but for ten workloads on one URL map/);
});

test('the README\'s Google Cloud section names the three pages and what router 0.37.0 adds', () => {
  const readme = read('README.md');
  const section = readme.slice(readme.indexOf('\n## Google Cloud\n'), readme.indexOf('\n## Version\n'));
  for (const page of ['google-cloud-compute-engine.md', 'google-cloud-sql.md', 'google-kubernetes-engine.md']) {
    assert.ok(section.includes(`(docs/scenarios/${page})`), page);
  }
  assert.match(flat(section), /Router 0\.37\.0 adds zonal network endpoint groups/);
  assert.match(flat(section), /--with cloud-sql,gke/);
  assert.doesNotMatch(flat(section), /not accepted yet/);
  assert.match(flat(section), /accepted on 2026-11-04 in dormeto-dev with CLI 0\.11\.0, but for ten workloads on one URL map, which was not run/);
});
