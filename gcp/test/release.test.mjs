// R8: the router's image, its build script, its version and its scenario page (vision docs/plans/2026-10-29-google-cloud.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { JOIN_DEFAULT_MINUTES } from '../../lambda/src/lib/schedule.mjs';
import { SWAP_WAKE_ROOM_SECONDS } from '../src/levels.mjs';
import { SWAP_WAIT_MS } from '../src/switch.mjs';

const ROOT = new URL('../../', import.meta.url).pathname;
const read = (path) => readFileSync(`${ROOT}${path}`, 'utf8');
const PACKAGE = JSON.parse(read('package.json'));
// The pages' numbers and quoted texts, from the code: a change there fails a test here instead of leaving a page stale.
const SWAP = Object.fromEntries(Object.entries(SWAP_WAIT_MS).map(([kind, ms]) => [kind, ms / 1000]));
const REFUSED = Object.fromEntries(Object.entries(SWAP).map(([kind, s]) => [kind, s + SWAP_WAKE_ROOM_SECONDS]));
const ONBOARDING = read('gcp/src/onboarding.mjs');
const SERIES = JSON.parse(`[${/const CHANGEABLE_SERIES = new Set\(\[([^\]]+)\]\)/.exec(ONBOARDING)[1].replace(/'/g, '"')}]`).map((s) => s.toUpperCase());
const PODS_REFUSAL = /`(fallback machine types are for VMs of unmanaged instance groups: the pods of a GKE cluster have no machine type of their own)`/.exec(ONBOARDING)[1];
const TWO_VMS = /`backend service \$\{service\.name\} has two VMs named \$\{name\} \(zones \$\{first\} and \$\{second\}\): ([^`]+)`/.exec(ONBOARDING)[1];

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

test('gcp-image.sh --push logs in with the named configuration\'s token and pushes router:<version> to the repository', () => {
  const run = image('1.2.3', '--push', '--configuration', 'dormeto-dev', '--repository', 'europe-west1-docker.pkg.dev/dormeto-dev/dormeto');
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /gcloud --configuration dormeto-dev auth print-access-token \| podman login -u oauth2accesstoken --password-stdin europe-west1-docker\.pkg\.dev/);
  assert.match(run.stdout, /podman push --digestfile \S+ dormeto-router:1\.2\.3 docker:\/\/europe-west1-docker\.pkg\.dev\/dormeto-dev\/dormeto\/router:1\.2\.3/);
});

test('gcp-image.sh --push pushes to every repository given, logging in once per registry', () => {
  const hosts = ['europe', 'us', 'asia'].map((location) => `${location}-docker.pkg.dev`);
  const run = image('1.2.3', '--push', '--configuration', 'dormeto-releases', ...hosts.flatMap((host) => ['--repository', `${host}/dormeto-releases/router`]), '--repository', `${hosts[0]}/dormeto-releases/other`);
  assert.equal(run.status, 0, run.stderr);
  for (const host of hosts) {
    assert.equal(run.stdout.match(new RegExp(`--configuration dormeto-releases auth print-access-token \\| podman login .* ${host.replace(/\./g, '\\.')}$`, 'gm'))?.length, 1, host);
    assert.match(run.stdout, new RegExp(`docker://${host.replace(/\./g, '\\.')}/dormeto-releases/router/router:1\\.2\\.3$`, 'm'));
  }
  assert.match(run.stdout, /docker:\/\/europe-docker\.pkg\.dev\/dormeto-releases\/other\/router:1\.2\.3$/m);
});

test('gcp-image.sh --push has no default configuration and no default project', () => {
  const repository = ['--repository', 'europe-docker.pkg.dev/dormeto-releases/router'];
  for (const args of [['--push', ...repository], ['--push', '--configuration', 'dormeto-releases'], ['--push', '--configuration', 'dormeto-releases', '--repository', 'europe-docker.pkg.dev/router']]) {
    const run = image('1.2.3', ...args);
    assert.equal(run.status, 2, args.join(' '));
    assert.match(run.stderr, /usage: /);
    assert.doesNotMatch(run.stdout, /podman push|auth print-access-token/);
  }
});

// The dev image (0.38.0-dev.<n>) and the release candidate (0.38.0-rc.<n>): a SemVer pre-release, never the release's own tag,
// which immutable repositories would keep for good.
test('gcp-image.sh takes a SemVer pre-release version: the dev image and the release candidate', () => {
  for (const version of ['0.38.0-dev.1', '0.38.0-rc.1', '1.2.3-alpha', '1.2.3-x-1.2.b']) {
    const run = image(version, '--push', '--configuration', 'dormeto-dev', '--repository', 'europe-west1-docker.pkg.dev/dormeto-dev/dormeto');
    assert.equal(run.status, 0, `${version}: ${run.stderr}`);
    const tag = version.replace(/\./g, '\\.');
    assert.match(run.stdout, new RegExp(`-t dormeto-router:${tag} \\.$`, 'm'), version);
    assert.match(run.stdout, new RegExp(`docker://europe-west1-docker\\.pkg\\.dev/dormeto-dev/dormeto/router:${tag}$`, 'm'), version);
  }
  for (const version of ['0.38.0-', '0.38.0-.1', '0.38.0-dev.', '0.38.0-dev..1', '0.38.0+build.1', '0.38.0-rc_1', '0.38.0-rc;id', '0.38', 'v0.38.0-rc.1']) {
    const run = image(version);
    assert.equal(run.status, 2, version);
    assert.match(run.stderr, /usage: /);
    assert.equal(run.stdout, '', version);
  }
});

// --configuration reaches eval (the login's pipe): only a configuration's name gets there.
test('gcp-image.sh refuses a configuration that is not a plain name, before anything runs', () => {
  for (const configuration of ['dormeto-dev; echo pwned', '$(id)', '`id`', 'a b', 'dormeto.dev', 'dormeto-dev|cat', 'a/b']) {
    const run = image('1.2.3', '--push', '--configuration', configuration, '--repository', 'europe-west1-docker.pkg.dev/dormeto-dev/dormeto');
    assert.equal(run.status, 2, configuration);
    assert.match(run.stderr, /usage: /);
    assert.equal(run.stdout, '', configuration);
  }
  for (const configuration of ['dormeto-dev', 'dormeto_releases', 'Dev2']) {
    assert.equal(image('1.2.3', '--push', '--configuration', configuration, '--repository', 'europe-west1-docker.pkg.dev/dormeto-dev/dormeto').status, 0, configuration);
  }
});

test('gcp-image.sh refuses a missing or odd argument with exit 2', () => {
  for (const args of [[], ['1.2.3', '--push'], ['1.2.3', '--other'], ['v1'], ['1.2.3', '--configuration', 'c'], ['1.2.3', '--repository', 'a/b/c'], ['1.2.3', '--push', '--configuration'], ['1.2.3', '--push', '--configuration', 'c', '--repository', 'a/b/c', 'd']]) {
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
  for (const needle of ['scripts/gcp-image.sh', 'gcp/Containerfile', 'europe-west1-docker.pkg.dev/dormeto-dev2/dormeto/router', 'gcloud artifacts repositories create dormeto']) {
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

// The acceptance of 2026-11-04 (vision docs/plans/2026-10-30-google-cloud-coverage.md, "Acceptance results") passed; the ten
// workloads on one URL map were accepted on 2026-11-08, with router 0.38.0-dev.2.
const NOT_ACCEPTED = /not accepted yet|acceptance has not run|the acceptance's to check|the acceptance tries it|No wake through the router has been timed yet|no wake of a NEG's VM through the router has been timed yet/;
const ACCEPTED = /From router 0\.37\.0, accepted on 2026-11-04 with CLI 0\.11\.0[,:]/g;

test('the Compute Engine page: what ships in router 0.37.0 says so, and that ten workloads on one map were accepted on 2026-11-08', () => {
  const page = flat(read(CE));
  assert.doesNotMatch(page, /router 0\.35\.0/);
  assert.doesNotMatch(page, NOT_ACCEPTED);
  assert.equal(page.match(ACCEPTED)?.length, 4, 'the NEGs, the swap, schedules and pauses, IP lists');
  assert.match(page, /and for ten workloads on one URL map on 2026-11-08/);
  assert.doesNotMatch(page, /which was not run|were not run in the acceptance/);
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
  assert.ok(page.includes(`SWAP_WAIT: ${SWAP.regional} s on a regional load balancer, ${SWAP.classic} s on a classic one, ${SWAP.internal} s on an internal one and ${SWAP['cross-region-internal']} s on a cross-region internal one`), 'switch.mjs\'s SWAP_WAIT_MS');
  // G5: the built-in wake timeout is 600 s for every kind; the swap's wait is a floor, not an addition.
  assert.doesNotMatch(page, /The default wake timeout adds SWAP_WAIT|700 s for VMs on a regional/);
  assert.match(page, /The built-in wake timeout is 600 s, whatever the load balancer; behind a swap it can't be less than SWAP_WAIT plus 60 s/);
  assert.match(page, /\| Classic \| 5\.5 minutes \| 2 min 16 s after a visitor's POST \/_dormeto\/wake; AWAKE after 287 s, the unswap's 250 s included \|/);
  assert.match(page, /\| Regional \| 3\.5 to 6\.5 minutes to ASLEEP \| 62 s after a POST \/_dormeto\/wake; AWAKE 123 to 188 s after a wake by a browser's probe, a POST or a pause, the unswap's 100 s included \|/);
  assert.match(page, /Steady traffic, 45 requests in 15 minutes, kept each kind awake through the router with a 5-minute idle window/);
  assert.match(page, /terraform plan showed no change with a regional workload onboarded/);
  assert.match(page, /Ten naps asked at once on one map were all asleep, none failed, within 509 s global and 283 s regional \(the acceptance of 2026-11-08\)/);
  assert.match(page, /a regional nap through an upgrade to a new revision\. Cloud Run let the in-flight request finish on the old revision, and the workload slept 165 s after the nap was asked\. A nap that does die is caught by its heartbeat/);
  assert.match(page, /ignore_changes = \[default_service, default_route_action, host_rule, path_matcher\]/);
  assert.match(page, /answered that load balancer's plain-HTTP requests with a 302 to https:\/\/ for about 40 s/);
  assert.match(page, /A visitor at a nap's start waits up to 2 × SWAP_WAIT with the VMs running/);
  assert.match(page, /A nap that dies under a swap holds visitors for minutes/);
  assert.match(page, /A request with a body gets the page under a swap/);
  assert.match(page, /Ten naps on one regional URL map/);
  assert.match(spaced(read(CE)), /A header of your own named `x-dormeto-\*` on a regional map's swapped entry is replaced at the swap and not given back/);
  assert.match(page, /about 250 s or more on a regional load balancer and 340 s or more on a classic one/);
  assert.ok(page.includes(`A wake timeout of SWAP_WAIT plus ${SWAP_WAKE_ROOM_SECONDS} s or less (${REFUSED.regional} s regional, ${REFUSED.classic} s classic, ${REFUSED.internal} s internal, ${REFUSED['cross-region-internal']} s cross-region internal) is refused`), 'levels.mjs\'s floor');
});

test('the Compute Engine page: schedules, pauses and IP lists, with what they do not hold', () => {
  const page = flat(read(CE));
  assert.match(page, /## Schedules and pauses/);
  assert.match(page, /## IP lists/);
  assert.match(page, /at most 10 scheduled naps each run, oldest occurrence first/);
  assert.match(page, /With --keep-asleep, a visitor still wakes the workload/);
  assert.match(page, /A scheduled nap's occurrence is spent once its task is accepted/);
  assert.match(page, /on a GKE workload, and on 2026-11-08 for ten workloads on one URL map in one nap window/);
  assert.match(page, /with --keep-asleep the workload stayed asleep into an awake window, and a visitor's probe woke it/);
  assert.match(page, /Only the action ignore exists here/);
  assert.match(page, /the page's probe from a Google address got a 202 and the workload slept on \(WakeIgnored\)/);
  // M5 (2026-11-08): the client's behind the global and classic load balancers too, a forged header included.
  // A forged header was measured behind the global and classic ones only; the regional one, from real wakes (G3's acceptance).
  assert.match(page, /The address the waker reads is the last entry of X-Forwarded-For before the load balancer's own: the client's behind the global, regional and classic load balancers, a forged X-Forwarded-For included behind the global and classic ones \(measured: the regional one in the acceptance of 2026-11-04, from real wakes, with no forged header; the global one and the classic one on the Standard tier on 2026-11-08, with a forged header\)/);
  assert.match(page, /The idle check reads the same address in the request logs, without the port that the regional load balancer logs with it/);
  assert.doesNotMatch(page, /with a forged header, it was not read on Google/);
  assert.match(page, /An IP list stops browsers and scanners on those addresses, not an API client that means to wake/);
  assert.match(page, /called stuck after 35 minutes/);
});

test('the Compute Engine page: the fixes of router 0.38.0 and the idle check that reads request logs', () => {
  const page = flat(read(CE));
  assert.match(page, /A running wake or nap beats on its run every minute/);
  assert.match(page, /a beat that fails is tried again once, 10 s later/);
  assert.match(page, /sent again or called stuck within minutes/);
  assert.match(page, /A stale wake is sent again with its wakeId, twice at most, which a duplicate cannot disturb: after that, its deadline alone acts/);
  assert.match(page, /22 minutes under a swap/);
  assert.doesNotMatch(page, /up to 15 minutes/);
  assert.match(page, /At most 20 naps in flight per router \(NapDeferred\)/);
  assert.match(page, /gives up as map-busy, the workload left awake/);
  assert.match(page, /The metric's delay is 210 s/);
  assert.match(page, /reads the traffic again before it stops anything/);
  assert.match(page, /napAborted/);
  // cli 7040b64: workloads show prints it, --json carries napAborted.
  assert.match(page, /The run says why, until a nap commits: dormeto gcp workloads show prints it in a nap given up: line \(its reason and time\), and --json carries it as napAborted \(reason and at\)/);
  assert.doesNotMatch(page, /napAborted \(reason and at\), in dormeto gcp workloads show --json/);
  assert.match(page, /backends-changed/);
  assert.match(page, /kept 35 days/);
  assert.match(page, /Standard network tier/);
  // M1 (2026-11-08): Google accepts it, at classic's times.
  assert.doesNotMatch(page, /for the swap is unmeasured/);
  assert.match(page, /Google accepts such a load balancer for the swap \(measured on 2026-11-08/);
  assert.match(page, /On the Standard network tier \(2026-11-08\), the nap's task took 316 s, an operator's nap 325 s to ASLEEP, and a POST \/_dormeto\/wake woke the workload to AWAKE in 289 s and 297 s, the unswap's 250 s included: classic's times on the Premium tier/);
  assert.match(page, /dormeto gcp workloads onboard --request-logs/);
  // A one-line block takes one argument: the two are on lines of their own, as HCL wants.
  assert.ok(read(CE).includes('  log_config {\n    enable      = true\n    sample_rate = 1.0\n  }\n'), 'log_config, multi-line');
  assert.doesNotMatch(read(CE), /log_config \{[^\n}]*=/);
  assert.match(page, /dmtr-<region>-lb/);
  assert.match(page, /Cloud Logging charges past 50 GiB a month/);
  // M2 (2026-11-08): the logs decide alone, Monitoring's count being sampled.
  assert.match(page, /On a backend service that logs every request \(logConfig enabled, sample rate 1\.0\), any entry in the window's request logs makes them decide alone, whatever Monitoring counts/);
  assert.doesNotMatch(page, /the request logs decide alone, whatever Monitoring counts, none included/);
  assert.match(page, /The check reads the log entries from a minute before the window to its end: the extra minute can only add requests/);
  assert.match(page, /With logs that cannot be read or hold more than 1,000 entries, or with logging off or sampled, Monitoring's count decides/);
  // The controller's ruling (2026-11-08): an empty log naps no busy workload.
  assert.match(page, /An empty log while Monitoring counts requests leaves the count deciding: a log lost upstream \(a _Default sink's exclusion of the load balancers' logs, say\) is caught that way, said in LogsEmpty at most once an hour per workload and controller instance/);
  // Caught only when nothing of the window was logged.
  assert.match(page, /A log lost only in part is not caught: an exclusion that keeps part of the load balancers' logs, one added during the window, or a long ingestion delay leaves entries, and the logs decide on what is left/);
  assert.match(page, /the count decides while the window's logs are empty/);
  assert.doesNotMatch(page, /When Monitoring counts 1 to 1,000 requests|fewer entries than Monitoring counted/);
  assert.match(page, /Monitoring's request_count is sampled and batched: its one-minute points came late and in lumps \(13 for minutes that logged 4\), with gaps of six minutes/);
  assert.match(page, /0\.6 to 1\.5 s later on a classic load balancer, about 10 s on a regional one/);
  assert.match(page, /an idle nap's last read, before anything stops/);
  assert.match(page, /On a regional load balancer, logging begins a few minutes after the change \(2 to 5 minutes, measured\)/);
  assert.match(page, /Scanners that send a browser's user agent to the application's own paths count as activity/);
  assert.match(page, /\/, \/favicon\.ico, \/geoserver\/web\/, seen within minutes on a bare address/);
  assert.match(page, /IP lists catch known scanner networks/);
  // The CLI's install on a 404 of the global _Default bucket: a notice, and no view.
  assert.match(page, /A project whose _Default log bucket isn't in global gets no log view: the install says so and goes on, and the idle check counts every request/);
  assert.doesNotMatch(page, /stores its _Default bucket elsewhere gets no view, and the count decides/);
  assert.match(flat(read(GKE)), /KEDA scales <owner> to zero itself \(minReplicaCount: 0\): set it to 1 or more for Dormeto to nap it/);
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
  assert.match(row('google-cloud-compute-engine.md'), /global, regional, classic or internal/);
  assert.doesNotMatch(row('google-cloud-compute-engine.md'), /700 s regional, 850 s classic/);
  assert.match(row('google-cloud-compute-engine.md'), /\| 600 s \|$/);
  assert.match(row('google-cloud-compute-engine.md'), /global, regional, classic or internal/);
  assert.match(row('google-cloud-compute-engine.md'), /through a regional load balancer 62 s from POST \/_dormeto\/wake, a classic one 2 min 16 s/);
  assert.match(row('google-cloud-sql.md'), /9\.2 min through the router/);
  assert.match(row('google-cloud-sql.md'), /\| 1700 s \|$/);
  assert.match(row('google-kubernetes-engine.md'), /13 s through the router/);
  assert.match(row('google-kubernetes-engine.md'), /\| 600 s \|$/);
  const index = flat(read('docs/scenarios/README.md'));
  assert.doesNotMatch(index, /what the acceptance has not run yet/);
  assert.match(index, /accepted on 2026-11-04, and say what was not run/);
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
  assert.match(flat(section), /accepted on 2026-11-04 in dormeto-dev with CLI 0\.11\.0: each page says what was accepted and measured/);
  assert.match(flat(section), /Router 0\.40\.0 fixes the limits of 0\.37\.0 on Google Cloud, .* GKE refuses a KEDA minReplicaCount: 0\. The fixes' acceptance passed on 2026-11-08 in dormeto-dev, with the image 0\.38\.0-dev\.2 and the CLI built from main/);
  assert.doesNotMatch(flat(section), /which was not run/);
  // M1 and M2 (2026-11-08).
  assert.doesNotMatch(flat(section), /unmeasured/);
  assert.match(flat(section), /a classic load balancer on the Standard tier is found, and Google accepts it for the swap \(measured\)/);
  assert.match(flat(section), /the logs decide alone, as Monitoring's count is sampled, but an empty log leaves the count to decide/);
});

// G5 (vision docs/specs/2026-11-08-google-cloud-router-features-design.md, sections 3 to 8): the Compute Engine page says what the
// settings levels, the wake mode and the rules, the waiting page, the capacity retry and the fallback machine types, and the internal
// kinds do, and what Google Cloud fixes, with its reasons, once.
test('the Compute Engine page: the settings by level, what Google Cloud fixes and why, the wake mode by load balancer', () => {
  const page = flat(read(CE));
  // A failed read keeps the last record the instance read; only a level never read takes AWS's never-read rule (controller-core.mjs routerLevel).
  assert.match(page, /A failed read of the router level keeps the last record this controller instance read/);
  assert.match(page, /A router level never read on this controller instance takes no idle nap or release decision, waits the longest wake timeout \(1700 s\) and stops plainly, logged SettingsLevelUnreadable, as on AWS/);
  assert.doesNotMatch(page, /A level that cannot be read counts as unset/);
  assert.match(page, /## Settings and their levels/);
  // levels.mjs's effectiveOf: the organization's level (router/manager) between the router's and the built-in value.
  assert.match(page, /A workload's settings come from AWS's levels: the workload, its type, the router, the organization, then the built-in value/);
  assert.match(page, /PUT \/v1\/workloads\/\{id\}\/settings/);
  assert.match(page, /GET and PUT \/v1\/settings/);
  assert.match(page, /The organization level and the custom types are the manager's: it pushes its settings\.json to the router \(see \[the manager page\]\(google-cloud-manager\.md\)\), and until it does the organization level reads as unset and only the built-in types exist/);
  assert.match(page, /instance is a VM of an unmanaged instance group or of a zonal network endpoint group, asg a managed instance group, k8s GKE pods and databases a Cloud SQL companion/);
  assert.match(page, /The built-in wake timeout is 600 s for every kind, but the databases type's built-in is AWS's 1800 s/);
  for (const row of [
    '| waitSeconds | 0 | The waker holds no request: it answers the waiting page at once, and the page waits for the wake. |',
    '| maxHolders | 0 | No request is held. |',
    '| drainSeconds | 0 | The nap\'s switch is a URL map change, and the backend service\'s own connection draining applies. |',
    '| wakeMode | browser behind the global load balancer\'s policy |',
    '| wakeTimeoutSeconds | at most 1700 | One controller request lasts at most 1800 s. |',
    '| wakeTimeoutSeconds | more than the swap\'s wait + 60 s behind a swap |',
  ]) assert.ok(page.includes(row), row);
  assert.match(page, /The origin is fixed/);
  assert.match(page, /An explicit workload value outside these bounds is refused; an inherited one is brought into them and shown with the origin fixed, so a router's value never makes a workload unwakeable/);
  assert.match(page, /the global load balancer's waiting page can't see the visitor's request, so only the page's probe, an explicit wake or a wake rule wakes it \(wake mode browser\)/);
  assert.match(page, /At the router's level, any is accepted: it applies to the workloads behind a swap/);
  assert.match(page, /A configuration written before the levels has no inherits: an idleMinutes of 15 and a failedRetrySeconds of 60 are read as inherited, its wake timeout stays its own, and nothing is rewritten/);
  assert.match(page, /The check, the nap, the wake and the release use the resolved values/);
  assert.match(page, /A router level never read on this controller instance takes no idle nap or release decision, waits the longest wake timeout \(1700 s\) and stops plainly, logged SettingsLevelUnreadable/);
  assert.match(page, /Behind the global load balancer's policy the wake mode is browser, fixed/);
  assert.match(page, /Behind a swap \(regional, classic and the internal kinds\) the default wake mode is any: a request the filters let through wakes the workload and is answered with the waiting page at once, with no hold/);
  assert.match(page, /In browser, only the page's probe, an explicit wake or a wake rule wakes it/);
  assert.match(page, /scanners' requests count as deferred:browser mode/);
  assert.match(page, /A visitor on a \.php URL or on a path a no-wake rule keeps gets a page whose probe never wakes the workload/);
  // The wake header on the policy's fetch was measured on 2026-11-09: Google passes a visitor's own header to the error service.
  assert.doesNotMatch(page, /The wake header x-dormeto-wake: 1 and the probe header wake on the policy's fetch and under a swap/);
  assert.match(page, /The wake header x-dormeto-wake: 1 and the probe header wake under a swap and on the policy's fetch, as on AWS\. Google's error fetch passes a visitor's header of its own \(measured on 2026-11-09: a browser's GET \/ with x-dormeto-wake: 1 to the global load balancer woke an asleep workload, trigger header\); the headers it carries are in \[Behavior\]\(#behavior\)/);
  assert.match(page, /A decision that fails is logged WakeDecisionFailed and the page is answered all the same/);
  assert.doesNotMatch(page, /A plain request still does not wake/);
});

test('the Compute Engine page: what a rule sees on each request', () => {
  const page = flat(read(CE));
  assert.match(page, /At most 20 rules per list and level, which add up across the levels, the most general first; the first match decides, and a level's list replaces that level's list as a whole/);
  assert.match(page, /The order is the shared classify's: the no-wake rules, then HEAD, bots and scanner paths, the wake header, the wake rules, the IP lists, the probe and the wake mode/);
  for (const row of [
    '| A visitor\'s request behind a swap | the client\'s address | the request\'s own | the visitor\'s path |',
    '| The page\'s probe | the client\'s address | the browser\'s request | the visitor\'s path, sent by the page in x-dormeto-path from location.pathname |',
    // M1 (2026-11-08): the fetch carries the visitor's accept-language and cookie, among others.
    '| The policy\'s error fetch | the client\'s address | the headers the fetch carries, accept-language, cookie, referer and user-agent among them ([measured](#behavior)) | none: a path condition never matches |',
    '| An explicit POST /_dormeto/wake | the client\'s address | the request\'s own | /_dormeto/wake |',
  ]) assert.ok(page.includes(row), row);
  assert.doesNotMatch(page, /what the fetch carries: Host, User-Agent, Referer/);
  assert.match(page, /with the visitor's query string and address, and these headers \(measured on 2026-11-08; referer in an earlier measure\): accept, accept-language, cookie, forwarded, host, referer, traceparent, user-agent, via, x-cloud-trace-context, x-dormeto-workload, x-forwarded-for and x-forwarded-proto/);
  assert.match(page, /A wake rule on what the fetch does carry \(the user agent, the address, a header such as a cookie\) wakes/);
  assert.match(page, /A forged x-dormeto-path bypasses nothing a client couldn't bypass by requesting another path/);
  assert.match(page, /The router level holds the router-wide rules: there is no Terraform level on Google Cloud/);
});

test('the Compute Engine page: the waiting page, its storage and its custom-pages switch', () => {
  const page = flat(read(CE));
  assert.match(page, /## The waiting page/);
  for (const needle of ['router/settings', 'router/page', 'pages/<id>', 'favicons/<id>', 'recentWakes',
    'GET, PUT and DELETE /v1/workloads/{id}/waiting-page', 'GET, PUT and DELETE /v1/waiting-page']) {
    assert.ok(page.includes(needle), needle);
  }
  assert.match(page, /The answers have AWS's shape: own, inherited, effective, from, favicon, warnings, terraform, by and at/);
  assert.match(page, /icon of 64 KiB at most, a title of 80 characters, a description of 500, HTML of 256 KiB/);
  assert.match(page, /custom pages are off on this router: an administrator turns them on with dormeto gcp routers install --custom-pages/);
  assert.match(page, /DMT_CUSTOM_PAGES=1 on the controller and the waker/);
  assert.match(page, /a custom page already stored is read as absent: the template levels or the default page show/);
  assert.match(page, /WaitingPageSet records the size and the SHA-256 of a page, never its content/);
  assert.match(page, /The waker renders through a cache of 60 s, 1 s per read, which keeps the last value when a read fails/);
  assert.match(page, /the language from Accept-Language, English or French, with vary: accept-language/);
  assert.match(page, /the headers x-dormeto-wake-elapsed and x-dormeto-wake-typical/);
  assert.match(page, /filled from the median of the last 10 wakes/);
  assert.match(page, /The favicon is read at a nap, at most once a day, in 3 s, when the icon is auto and the workload awake/);
  assert.match(page, /from the first host rule whose path matcher sends the whole of \/ to the workload's backend service by the path alone/);
  assert.match(page, /A host whose \/ goes elsewhere or depends on more than the path \(a regex or a path template match, a header\), or a wildcard host, gives no favicon: no rule for the whole of a host name/);
  assert.match(page, /The internal kinds get none/);
  assert.match(page, /An offboarding deletes pages\/<id> and favicons\/<id>/);
  // M1 (2026-11-08) measured what the page said it had not.
  assert.doesNotMatch(page, /not measured yet/i);
  assert.match(page, /Measured on 2026-11-08 behind the global load balancer: the policy's error fetch carries the visitor's Accept-Language and Cookie, the page's Content-Security-Policy and vary: accept-language reach the browser, and a 256 KiB custom page \(268,112 bytes with the probe the router adds\) and a template with a 59,023-byte icon arrived whole/);
});

test('the Compute Engine page: the capacity retry and the fallback machine types', () => {
  const page = flat(read(CE));
  assert.match(page, /## Capacity and fallback machine types/);
  assert.doesNotMatch(page, /There is no fallback machine type/);
  assert.match(page, /every start and resume of a VM or a managed group refused for lack of capacity \(ZONE_RESOURCE_POOL_EXHAUSTED, POOL_CAPACITY_INSUFFICIENT\) is tried again within the wake: after 30 s, 60 s, then every 120 s until the wake's deadline/);
  assert.match(page, /A quota error is never retried this way/);
  assert.match(page, /fallbackInstanceTypes, set at the onboarding with --fallback-type, at most 5, for the VMs of unmanaged instance groups and zonal network endpoint groups/);
  assert.match(page, /fallback machine types are for VMs of unmanaged instance groups: a managed group's machine type is its template's/);
  // The pods get their own text (onboarding.mjs), not the managed group's.
  assert.ok(page.includes(`and so are GKE pods, ${PODS_REFUSAL}`), PODS_REFUSAL);
  assert.doesNotMatch(page, /A managed group is refused, as are GKE pods:/);
  assert.match(page, /Each VM starts on its own type first\. On a capacity error the router sets the next type of its own and the list on the stopped VM \(instances\.setMachineType\) and starts it again/);
  assert.match(page, /Past the list the VM stays on its last type, and the retry's waits apply to it/);
  assert.match(page, /A suspended VM resumes on its own type, with the retry only: Google changes no machine type while a VM is suspended/);
  assert.match(page, /A list turns hibernation off unless the workload says true/);
  // onboarding.mjs's CHANGEABLE_SERIES, F1 and G1 included.
  assert.ok(page.includes(`the type is of the VM's series, or both series are first or second generation ones (${SERIES.join(', ')})`), SERIES.join(', '));
  assert.match(page, /instanceTypes \(\{<vm>: \{from, to\}\}\)/);
  // The Workload view and the offboarding's answer give AWS's shape (fix wave A, I6).
  assert.match(page, /The Workload view and the offboarding's answer list them in AWS's shape, fallbacks: \[\{instance, from, to\}\], while a VM runs on one/);
  assert.match(page, /InstanceTypeFallback/);
  assert.match(page, /InstanceTypeNotReverted/);
  assert.match(page, /The nap, after the VMs stop, and the release give each VM its own type back/);
  assert.match(page, /compute\.instances\.setMachineType, in dormetoRouterBackends under its dormeto=managed condition/);
  assert.match(page, /the router's role lacks compute\.instances\.setMachineType: run dormeto gcp routers install again/);
});

test('the Compute Engine page: the internal Application Load Balancers', () => {
  const page = flat(read(CE));
  assert.match(page, /## Internal load balancers/);
  assert.match(page, /internal: a regional map whose forwarding rules are INTERNAL_MANAGED, in the router's region/);
  assert.match(page, /cross-region-internal: a global map whose rules are INTERNAL_MANAGED, onboardable on any router/);
  assert.match(page, /INTERNAL_SELF_MANAGED \(Cloud Service Mesh\) stays refused/);
  assert.match(page, /Google documents no custom error response on either, so the switch is the swap/);
  assert.match(page, /loadbalancing\.googleapis\.com\/https\/internal\/request_count/);
  assert.match(page, /internal_http_lb_rule/);
  assert.doesNotMatch(page, /are not measured yet: both use a regional load balancer's 100 s|regional's 100 s until measured|to be confirmed by the measure/);
  assert.match(page, /Google accepts an INTERNAL_MANAGED waker backend service, regional and global, on the router's serverless network endpoint group \(measured 2026-11-08\)/);
  assert.ok(page.includes(`SWAP_WAIT is ${SWAP.internal} s on an internal load balancer and ${SWAP['cross-region-internal']} s on a cross-region one`), 'switch.mjs\'s internal waits');
  assert.match(page, /regional internal, the other side's first answer came 0 to 3 s after the map write's operation ended \(six writes, each 5 to 7 s\); cross-region internal, 28 to 120 s \(nine writes, each about 40 s\)/);
  assert.ok(page.includes(`A wake timeout of ${REFUSED.internal} s or less on an internal load balancer, or ${REFUSED['cross-region-internal']} s or less on a cross-region one, is refused`), 'levels.mjs\'s internal floors');
  assert.match(page, /the waker's ingress admits both internal kinds/);
  assert.match(page, /forged X-Forwarded-For of 1\.2\.3\.4 was ignored and the client's private address named, behind both kinds/);
  // M3: 2 to 4 s on the regional internal kind, about 7.5 s on the cross-region one.
  assert.match(page, /Measured 2026-11-08: the resource internal_http_lb_rule, log requests, backend_target_name the plain name, remoteIp with a port, 2 to 4 s late on internal and about 7\.5 s on cross-region-internal/);
  assert.doesNotMatch(page, /remoteIp with a port, about 7\.5 s late\./);
  // R12 removed the client VM: the measures' client is a Cloud Run job with Direct VPC egress.
  assert.doesNotMatch(page, /client VM|through IAP/);
  assert.match(page, /the measures reach them from a Cloud Run job with Direct VPC egress/);
  assert.match(page, /The cross-region kind's entries carry the forwarding rule's region, its metric points region: global/);
  assert.match(page, /wake mode any woke on a plain request behind the cross-region kind/);
  assert.match(page, /The visitors' addresses are private/);
  assert.match(page, /5,000 queries a second/);
  assert.match(page, /A cross-region internal load balancer's waker is in one region/);
  assert.match(page, /enable_internal/);
  assert.doesNotMatch(page, /Internal load balancers and Cloud Run backends are not supported/);
  assert.match(page, /Application Load Balancers only: external \(global, regional and classic\) and internal \(regional and cross-region\)/);
});

test('the GKE page: the exact refusal of GKE\'s own load balancers, and the way', () => {
  const page = flat(read(GKE));
  // gke.mjs's GKE_MAP: mci- and a six-character hash, so a customer's mci-prod is not refused.
  assert.match(read('gcp/src/gke.mjs'), /mci-\[a-z0-9\]\{6\}\(-\|\$\)/);
  assert.match(page, /a URL map named k8s2-, k8s-um-, gkegw1-, gkemcg1-, or mci- and six letters or digits, then a dash or the name's end/);
  assert.match(page, /a map of yours named mci-prod is not taken for one/);
  // M4 (2026-11-09): the names and descriptions GKE writes, read on a Gateway's and an Ingress's load balancers.
  assert.match(page, /Measured on 2026-11-09: a Gateway's map, gkegw1-…, described \{"k8sResource": …\}, and an Ingress's map, k8s2-um-…, with no description, its target proxy and forwarding rule described \{"kubernetes\.io\/ingress-name": …\}/);
  assert.match(page, /a map whose description names k8sResource \(a Gateway's\), or whose target proxy or forwarding rule carries kubernetes\.io\/ingress-name \(an Ingress's\), whatever its name/);
  assert.match(page, /Give the Service a standalone network endpoint group \(cloud\.google\.com\/neg\)/);
  assert.match(page, /The default wake timeout is 600 s, whatever the load balancer; 1700 s with a Cloud SQL companion/);
  assert.doesNotMatch(page, /400 s and 550 s/);
});

test('the README and the Cloud SQL page say the G5 features and the 1700 s fixed value', () => {
  const readme = flat(read('README.md'));
  assert.match(readme, /what was accepted and measured\. Router 0\.40\.0 gives the Google Cloud router AWS's settings by level, the wake mode and the no-wake and wake rules, the branded waiting page, a capacity retry with fallback machine types, and the internal Application Load Balancers/);
  assert.match(readme, /enable_internal/);
  assert.match(flat(read(SQL)), /The wake timeout 1700 s is fixed: the databases type's 1800 s is brought to the most a wake can take/);
});

// D1's fix round: what the controller and the waker read, and what Google's documentation (not a measure) says.
test('the Compute Engine page: the controller reads the router level without a cache, the waker through one; two claims are Google\'s documentation', () => {
  const page = flat(read(CE));
  assert.doesNotMatch(page, /The router level is read once per check, through a 60 s cache/);
  assert.match(page, /The controller reads the router level from the store, once per check and once per wake, nap or release, and keeps the last record it read\./);
  // The waker's 60 s cache: they may disagree for that long after a change.
  assert.doesNotMatch(page, /so the two never disagree/);
  assert.match(page, /the waker resolves the same ones, so the two agree, but for up to 60 s after a change of the router level, which the waker keeps 60 s in a cache/);
  assert.match(page, /the databases type's built-in is AWS's 1800 s, brought to Google Cloud's cap of 1700 s and shown fixed/);
  assert.match(page, /5,000 queries a second \(Google's documentation\)/);
  assert.match(page, /the waker's ingress admits both internal kinds \(measured 2026-11-08\)/);
});

// G5's fix wave A (router c41b16f..f0c86da): what the pages say of the idle check's rules, the router level's join and two VMs of one name.
test('the Compute Engine page: the idle check leaves out what a no-wake rule matches, the router level joins windows, two VMs of one name are refused', () => {
  const page = flat(read(CE));
  // activity.mjs: the no-wake rules of every level; a logged request holds the headers user-agent and x-forwarded-for, and no other.
  assert.match(page, /It counts only the requests the waker would not ignore: not scanners, not HEAD requests, not an IP list's addresses, not what a no-wake rule of any level matches/);
  assert.match(page, /its only headers are user-agent and x-forwarded-for \(the address\): a rule's headers condition on either can match it, and one on any other header never does, so the request counts/);
  // controller-core.mjs and onboarding.mjs's scheduleView: AWS's joinLevels, the organization's from router/manager.
  assert.ok(page.includes(`the schedule's own joinMinutes, else the router level's (dormeto gcp routers settings --join-minutes), else the organization's (the manager's workloads.joinMinutes, pushed to the router), else ${JOIN_DEFAULT_MINUTES}`), 'resolveJoin');
  assert.match(page, /schedule show says which \(joinFrom\)/);
  // onboarding.mjs's refusal, word for word.
  assert.ok(page.includes(`has two VMs named <name> (zones <zone> and <zone>): ${TWO_VMS}`), TWO_VMS);
  assert.match(page, /Two VMs of one name in two zones/);
});

// G5's last docs pass: the acceptance of 2026-11-09 and the measures it settled.
test('the Compute Engine page: G5 was accepted in dormeto-dev on 2026-11-08 and 2026-11-09 and ships in router 0.40.0, the wake header is measured, the waker holds no request', () => {
  const page = flat(read(CE));
  assert.match(page, /These were accepted in dormeto-dev on 2026-11-08 and 2026-11-09, on dev builds of main \(router 0\.39\.0-dev\.2, then 0\.39\.0-dev\.3 with the final review's fixes\)\. Accepted there: the settings by level, the wake mode and rules, the waiting page, the fallback's machine type change through the router's own role, both internal kinds \(measured, napped by the idle check, woken by the page's probe\) and GKE's refusal\. They ship in router 0\.40\.0\. The global load balancer/);
  assert.doesNotMatch(page, /the switch back takes longer than any hold/);
  assert.doesNotMatch(page, /was not measured: the headers/);
});

// G2 (vision docs/specs/2026-11-09-google-cloud-manager-design.md, section 5): the manager's page says what the code does.
const MANAGER = 'docs/scenarios/google-cloud-manager.md';
const ACTIONS_SRC = read('gcp/src/actions.mjs');
const CORE_SRC = read('gcp/src/controller-core.mjs');

test('the manager page is linked from the scenarios index and the Compute Engine page, and calls nothing unreleased', () => {
  assert.match(read('docs/scenarios/README.md'), /\]\(google-cloud-manager\.md\)/);
  assert.match(read(CE), /\]\(google-cloud-manager\.md\)/);
  assert.doesNotMatch(read(MANAGER), /unreleased/i);
});

test('the manager page names every action the router answers, from the code, and the two that are Google Cloud\'s', () => {
  const page = flat(read(MANAGER));
  const table = /const ACTIONS = \{([\s\S]*?)\n  \};/.exec(ACTIONS_SRC)[1];
  const names = [...table.matchAll(/^    (?:'([a-z-]+)'|([a-z]+))[:,]/gm)].map((m) => m[1] ?? m[2]);
  assert.ok(names.length >= 17, names.join());
  for (const name of names) assert.ok(page.includes(name), name);
  assert.match(page, /The Google Cloud one: manager-settings \(below\)\. The journal is no action's answer/);
  assert.match(page, /\{ "error": "unknown action: <name>", "reason": "unknown-action" \}/);
  assert.match(page, /invalid, not_found, conflict and unsupported/);
});

test('the manager page\'s numbers are the code\'s: the journal\'s 7 days, the check every 5 minutes, a year of ended windows', () => {
  const page = flat(read(MANAGER));
  assert.match(CORE_SRC, /const EVENTS_KEPT_DAYS = 7;/);
  assert.match(page, /Events are kept 7 days, for the reports/);
  assert.doesNotMatch(ACTIONS_SRC, /EVENTS_MAX/);
  assert.match(CORE_SRC, /export const CHECK_SCHEDULE = '\*\/5 \* \* \* \*';/);
  assert.ok(read(MANAGER).includes('`checkSchedule` is\n  `*/5 * * * *`'));
  assert.match(page, /\bevents\/ in the router's Firestore database/);
  assert.match(page, /<stateAt padded to 13 digits>-<workloadId>-<state>/);
  assert.match(page, /router\/check/);
  assert.match(page, /router\/manager/);
  assert.match(page, /router\/pause/);
  assert.match(page, /endedWindowDays days ago: the organization's value, 365 days when it sets none, and 0 keeps them/);
  assert.match(page, /\bETag\b.*1 to 256 characters/);
  assert.match(ACTIONS_SRC, /const ETAG_MAX = 256;/);
});

test('the manager page says what a pause and a request-nap do, from the code, and the Compute Engine page says the exclusions pause beside the operator', () => {
  const page = flat(read(MANAGER));
  // request-nap is both routers' (lambda/src/lib/manager-actions.mjs).
  assert.match(ACTIONS_SRC, /'request-nap': \(payload\) => manager\.requestNap\(payload\),/);
  assert.match(read('lambda/src/lib/manager-actions.mjs'), /return \{ requested: false, reason: pauseText\(first\) \};/);
  assert.match(page, /is not a refusal: it answers \{ "requested": false, "reason" \} with the pause's words/);
  // controller-core.mjs's pause (lambda/src/lib/pauses.mjs): its wakes are the wakes of the cause pause, with who paused.
  assert.match(CORE_SRC, /wake: \(workloadId, \{ by \}\) => wakeNow\(workloadId, 'pause', by\)/);
  assert.match(read('lambda/src/lib/pauses.mjs'), /if \(await wake\(id, \{ by: record\.by, router: !workloadId \}\)\) started\.add\(id\);/);
  assert.doesNotMatch(page, /a pause carries by too, and writes no event/);
  assert.match(page, /a pause carries by too: the pause itself writes no event, and the wakes it starts write theirs, with the cause pause and its by/);
  assert.match(page, /plus pauses that cannot be read/);
  assert.match(flat(read(CE)), /The manager's exclusions pause a workload beside the operator's pause, and lifting one leaves the other\./);
  // actions.mjs's exclusionOf: the id is a part of the pause's document id, and a target group has no meaning here.
  assert.match(ACTIONS_SRC, /const EXCLUSION_ID_MAX = 64;/);
  assert.match(ACTIONS_SRC, /const TARGET_GROUP_REFUSED = 'a Google Cloud router has no targetGroupArn: name the backendService';/);
  assert.match(page, /an exclusionId \(1 to 64 characters: letters, digits, \., _ and -\)/);
  assert.match(page, /another backend service, or an unknown workload, is refused workload not configured: <id>/);
  assert.match(read(MANAGER), /^## Exclusions$/m);
  assert.match(page, /A backend service path must be the workload's own: the router's project, its name, and its scope/);
});

// The final review of G2 plan 1: what the pages said that the code no longer does.
test('the manager page says which offboardings are the CLI\'s, with the command the refusal names', () => {
  const page = flat(read(MANAGER));
  // actions.mjs's offboard.
  assert.match(ACTIONS_SRC, /const command = `dormeto gcp workloads offboard \$\{cfg\.workloadId\} --project \$\{router\.project\} --region \$\{router\.region\}`;/);
  assert.match(page, /offboard refuses \(conflict\) a GKE workload, whose Kubernetes access is the operator's, and a workload whose onboarding turned its backend service's request logs on, which the manager's accounts can't set back; the refusal names the command that offboards it, dormeto gcp workloads offboard <id> --project <p> --region <r>/);
});

test('the manager page names the CLI\'s onboarding flags as the CLI has them, --name and --set-tag', () => {
  const page = flat(read(MANAGER));
  assert.match(page, /dormeto gcp workloads onboard --name --set-tag/);
  assert.doesNotMatch(page, /--tag\b/);
});

test('the manager page says router/manager keeps the settings.json as one JSON string, and why', () => {
  // firestore.mjs's putManagerSettings.
  assert.match(read('gcp/src/firestore.mjs'), /const fields = withSettings \? \{ settingsJson: JSON\.stringify\(settings\), etag: etag \?\? null, at, /);
  assert.match(flat(read(MANAGER)), /the manager's whole settings\.json as it pushed it, kept as one JSON string \(Firestore refuses as a field name some keys a settings\.json may hold, such as a custom type's tag key __x__\), with its ETag and the time it was stored/);
});

test('the manager page says which pauses the check summary holds, which keys the rows and status carry', () => {
  const page = flat(read(MANAGER));
  // controller-core.mjs's check: router/check's pauses are the router's own, a workload's are not in it.
  assert.match(CORE_SRC, /pauses: \(pauses \?\? \[\]\)\.filter\(\(p\) => p\.workloadId === null\)/);
  assert.doesNotMatch(page, /the active pauses/);
  assert.match(page, /the router's own pauses \(a workload's are in its row\)/);
  // actions.mjs: list's rows are AWS's rows (rows.mjs), status AWS's status keys, the live ones empty.
  assert.match(page, /The rows of list carry AWS's row keys, and status AWS's status keys: what AWS's status reads live and Google Cloud does not \(the last request, the load balancer's rules, the targets\) keeps its key, empty/);
});

// B1 (vision docs/specs/2026-11-12-cloud-duplication-design.md, §4): the check's cursor, written after its loop and in its summary.
test('the manager and Compute Engine pages say where the next check starts, as the check writes it after its loop and in its summary', () => {
  // controller-core.mjs's recordCheck and check, lambda/src/lib/check-run.mjs's loop.
  assert.match(CORE_SRC, /const CHECK_BUDGET_MS = 240_000;\nconst CHECK_CONCURRENCY = 8;/);
  assert.match(CORE_SRC, /\.\.\.\(cursor \? \{ cursor \} : \{\}\),/);
  assert.match(read('lambda/src/lib/check-run.mjs'), /cursor: next < order\.length \? \(next > 0 \? order\[next - 1\]\.workloadId : cursor \?\? null\) : null/);
  assert.match(CORE_SRC, /if \(cursor !== \(last\?\.cursor \?\? null\)\) await store\.setCheckCursor\?\.\(cursor\)[^\n]*\n    await sweepStats\(\);/);
  assert.match(read('gcp/src/firestore.mjs'), /fields: cursor \? toFields\(\{ cursor \}\) : \{\} \}, updateMask: \{ fieldPaths: \['cursor'\] \}/);
  assert.match(flat(read(MANAGER)), /After a check that ran out of its 240 s before it reached every workload, it holds cursor too, the last workload that check started, written alone right after the check's workloads and again with the summary: the next check starts after it, as an AWS router's does, so every workload is checked in turn, even while the summary cannot be written \(the summary then holds the cursor with the last summary written, or alone with null times\)\. A summary that cannot be written fails nothing: the check's work is done\./);
  // The cursor's write and read that fail, each said (controller-core.mjs, lambda/src/lib/check-run.mjs).
  assert.match(flat(read(MANAGER)), /A cursor that cannot be written is said in CheckCursorNotStored, and one that cannot be read in CheckCursorUnread: that check starts at the first workload\./);
  assert.match(read('gcp/src/controller-core.mjs'), /log\.warn\('CheckCursorNotStored', \{ error: err\.message \}\)/);
  assert.match(read('lambda/src/lib/check-run.mjs'), /log\.warn\('CheckCursorUnread', \{ error: err\.message \}\);/);
  assert.match(flat(read(CE)), /A check takes 8 workloads at a time and starts none after 240 s \(CheckBudgetReached\); the next check starts after the last workload it started \(cursor in \[the check summary\]\(google-cloud-manager\.md#what-the-router-keeps\)\), so on a crowded router every workload is checked in turn, as on AWS \(from router 0\.40\.0\)\./);
});

test('the README and the Compute Engine page give Google Cloud the organization\'s level, its joined windows and its ended windows', () => {
  const readme = flat(read('README.md'));
  // controller-core.mjs's check and onboarding.mjs's scheduleView: the schedule's, the router's, the organization's, the default.
  assert.doesNotMatch(readme, /On Google Cloud: the workload's, else 15/);
  assert.ok(readme.includes(`On Google Cloud the same levels apply: the schedule's, the router's (dormeto gcp routers settings --join-minutes) and the organization's, which the manager pushes to the router, else ${JOIN_DEFAULT_MINUTES}.`));
  // controller-core.mjs's endedDaysOf: the organization's endedWindowDays, a year by default (ENDED_DAYS_DEFAULT), 0 keeps them.
  assert.match(CORE_SRC, /return managerState\?\.level\?\.endedWindowDays \?\? ENDED_DAYS_DEFAULT;/);
  assert.doesNotMatch(readme, /Not on Google Cloud yet\./);
  assert.match(readme, /and when stay as they were\. On Google Cloud too, from router 0\.40\.0, with the endedWindowDays of the settings the manager pushes to the router: 365 days without them, and 0 keeps them\./);
  for (const [file, stale] of [['gcp/src/controller-core.mjs', /comes with G2|wait for G2/], ['gcp/src/onboarding.mjs', /until G2/]]) assert.doesNotMatch(read(file), stale, file);
});

// G2 plan 2 (D2): the onboarder's payload, the backends' ids and who onboarded, from the code.
test('the manager page says what preview and onboard take, and what status keeps, as the code does', () => {
  const page = flat(read(MANAGER));
  // onboarding.mjs's databaseNames and oneOf, actions.mjs's onboardingOf.
  const ONBOARDING_SRC = read('gcp/src/onboarding.mjs');
  assert.match(ONBOARDING_SRC, /databases: a list of names or a list of \{ kind, id \} entries, not both/);
  assert.match(ONBOARDING_SRC, /is not a Cloud SQL instance's kind: the kind is cloudsql-instance/);
  assert.match(ONBOARDING_SRC, /are given and differ: give one/);
  assert.match(ACTIONS_SRC, /source: 'manager', by: by \?\? 'unknown'/);
  assert.match(page, /preview and onboard take AWS's onboarder payload: databases is a list of Cloud SQL instance names \(the CLI's\) or of AWS's entries \{ "kind": "cloudsql-instance", "id": <name> \}, not both in one list, and an entry of another kind is refused \(invalid\)/);
  assert.match(page, /the fallback machine types are settings\.fallbackInstanceTypes, or fallbackInstanceTypes at the top level, and the REST body's cloudSql is accepted beside databases: both forms given and different are refused \(invalid\)/);
  assert.match(page, /GKE access and request logs are not taken: they stay with the CLI/);
  // onboarding.mjs's onboardedBy, actions.mjs's resourceIdOf.
  assert.match(read('gcp/src/onboarding.mjs'), /\.\.\.\(by \? \{ onboardedBy: by \} : \{\}\),/);
  assert.match(page, /An onboarding from the manager records onboardedBy, who asked \(unknown when the payload names no one\), which the workload's status and the REST Workload carry, not the rows of list; one from the CLI records no one/);
  assert.match(ACTIONS_SRC, /\{ resourceId: String\(id\) \}/);
  assert.match(page, /status's instance and asg backends carry resourceId, the numeric id the onboarding stored \(the manager removes the dormeto=managed binding on that id at an offboarding, whoever bound it, the CLI too\), and their location; a backend stored without its id has none/);
  assert.match(page, /status also keeps the workload's requestLogs/);
});

// G2 plan 3 (D3): what a nap's event names, from stopped.mjs.
test('the manager page says what a nap\'s event names, as stopped.mjs builds it', () => {
  const page = flat(read(MANAGER));
  const src = read('gcp/src/stopped.mjs');
  assert.match(src, /const ITEMS_MAX = 50;/);
  assert.match(src, /const SHARED_VCPUS = \{ 'e2-micro': 0\.25, 'e2-small': 0\.5, 'e2-medium': 1, 'f1-micro': 0\.2, 'g1-small': 0\.5 \};/);
  assert.match(src, /type\.startsWith\('custom-'\) \? 'n1' : type\.split\('-'\)\[0\]/);
  assert.match(src, /memoryGb: memoryMb \/ 1024/);
  assert.match(src, /\/projects\/windows-cloud\//);
  assert.match(src, /memoryGb: 8 \* Number\(perf\[1\]\)/);
  assert.match(src, /'GKE pods are not priced'/);
  assert.match(src, /const REASON_MAX = 200;/);
  assert.match(src, /companionGone\(err\) \? \[\]/);
  assert.match(page, /names what the nap stopped as priced items, stopped, at most 50/);
  assert.match(page, /The run keeps the names of the VMs \(and GKE owners\) a nap stopped or suspended, which the row's hibernated reads; the items are only for the event/);
  assert.match(page, /\(cause failed-released\), names them the same way/);
  assert.match(page, /the priced items a nap stopped \(below\)/);
  assert.match(page, /A reason starts with Google's status and message \(the URL left out\)/);
  assert.match(page, /the event holds one unknown item with the backend all \(not an empty list, which would read as nothing running\), and the router says StoppedUndescribed/);
  assert.match(page, /\{ kind, machineType, family, vcpus, memoryGb, count, os, spot\?, suspended\?, zone \}/);
  assert.match(page, /family is the machine type up to its first - \(e2-small is e2, n2d-custom-4-8192 is n2d\), and a custom- type is n1/);
  assert.match(page, /e2-micro 0\.25, e2-small 0\.5, e2-medium 1, f1-micro 0\.2 and g1-small 0\.5/);
  assert.match(page, /memoryGb is the machine type's memoryMb over 1024 \(GiB, as Google bills\)/);
  assert.match(page, /os is Windows when a boot disk's license is in \/projects\/windows-cloud\/, else Linux \(spelled as AWS's items spell it\)/);
  assert.match(page, /VMs of one machine type, zone, system, Spot and suspension are one item, with their count/);
  assert.match(page, /\{ kind, tier, engine, edition, ha, region, vcpus\?, memoryGb\? \}/);
  assert.match(page, /db-perf-optimized-N-K gives K vCPUs and 8 GB each \(Google's Enterprise Plus N tiers have 8 GB a vCPU\); the shared cores and any other tier give neither/);
  assert.match(page, /An instance that no longer exists adds no item/);
  assert.match(page, /\{ kind, backend, reason \}, with the backend as status names it \(instance:<vm>, asg:<group>, k8s:<id>, cloudsql-instance:<name>\) and the reason, cut to 200 characters/);
  assert.match(page, /Each GKE backend is one, with the reason "GKE pods are not priced"/);
  assert.match(page, /Describing never stops a nap: the nap reaches ASLEEP whatever these reads answer/);
});

// R15 of the AWS and Google Cloud review (vision docs/plans/2026-11-10-aws-google-cloud-review-apis.md): the pages say what the code does,
// and what router 0.40.0 adds as router 0.40.0's (its release rewrote the "Not released yet: router 0.40.0" marks).

test('the manager page: the AWS actions Google Cloud answers unsupported, and the refused body', () => {
  const page = flat(read(MANAGER));
  assert.match(page, /AWS's wake, nap, release, check, ensure-awake, refresh-lists, report and clusterCheck, which AWS receives as invocations, and any other name, are answered as AWS's controller does/);
  assert.match(page, /with "refusals": true, a refusal unsupported \(unknown action: <name>\); without it, a 400 \{ "error": "unknown action: <name>", "reason": "unknown-action" \}/);
  assert.doesNotMatch(page, /the wake, nap, release, check and list refresh that AWS receives/);
  const actions = read('gcp/src/actions.mjs');
  assert.match(actions, /code: 'unsupported', message \} \} \}/);
  assert.match(actions, /body: \{ error: message, reason: UNKNOWN_ACTION \}/);
  for (const name of ['wake', 'nap', 'release', 'check', 'ensure-awake', 'refresh-lists', 'report', 'clusterCheck']) {
    assert.doesNotMatch(actions, new RegExp(`^    '?${name}'?: `, 'm'), `${name} is not an action here`);
  }
});

test('the manager page: the REST names, the status\'s settings and what a refusal says', () => {
  const page = flat(read(MANAGER));
  assert.match(page, /The REST Workload carries workloadId beside id and pauses \(a list, as the rows' are\) beside paused \(the first of them\)/);
  assert.match(page, /The onboarding takes databases or cloudSql, settings\.fallbackInstanceTypes or the top-level fallbackInstanceTypes/);
  assert.match(page, /status's settings hold AWS's six keys \(idleMinutes, waitSeconds, drainSeconds, wakeTimeoutSeconds, maxHolders, failedRetrySeconds\), and wakeMode is beside them, at the top of the status/);
  // The REST Workload's settings keep the seven: the Compute Engine page says which of the two holds six.
  assert.match(flat(read(CE)), /and the manager's status has settings of AWS's six keys, wakeMode beside them at the top \(the REST Workload's settings keep seven\)/);
  assert.doesNotMatch(flat(read(CE)), /and the status's settings hold AWS's six keys/);
  assert.match(page, /A pause's keepAsleep that is not true or false is refused/);
  assert.match(page, /A put of a waiting page needs by/);
  assert.match(page, /The waker answers a request with no workload header, or a header that names no valid ID, a 400 \{ "error": "x-dormeto-workload names no workload", "reason": "bad-request" \}/);
});

test('the tag is spelled dormeto=managed on every page', () => {
  for (const file of ['README.md', 'docs/scenarios/README.md', MANAGER, CE, SQL, GKE]) {
    assert.doesNotMatch(read(file), /dormeto\/managed/, file);
  }
  assert.match(flat(read(MANAGER)), /removes the dormeto=managed binding on that id at an offboarding/);
});

test('the Compute Engine page: the waiting page\'s headers and the settings problem text', () => {
  const page = flat(read(CE));
  assert.match(page, /A failed workload's page, and a backoff's \(asleep with its failure\), carry x-dormeto-failure, why it failed, and x-dormeto-retry-at, the next attempt as an ISO date, as AWS's do/);
  assert.match(page, /a value that is not a whole number in its range is the problem <key>: must be a whole number from <min> to <max> \(an onboarding's problem starts with settings: \), as AWS's/);
  assert.match(page, /The page's probe goes to \/_dormeto\/wake and sends the visitor's path in x-dormeto-path; a workload that sleeps or wakes answers a 202 there, where AWS's page answers a 503 to the probe of its own address/);
  assert.match(page, /A put needs by, who sets the page/);
  assert.match(page, /and GKE's refusal\. They ship in router 0\.40\.0\./);
  assert.doesNotMatch(page, /They are not released\./);
});

test('the pages do not call 0.38.0 or 0.39.0 a release, say what router 0.40.0 adds, and call nothing unreleased', () => {
  const index = flat(read('docs/scenarios/README.md'));
  // "as of router <version>" is the package's (the release bumps it); the next sentence names 0.40.0 whatever it is.
  assert.ok(index.includes(`What the router naps and wakes, as of router ${PACKAGE.version}. Router 0.40.0 adds what the Google Cloud pages say beyond 0.37.0, and the manager page. A workload is`));
  assert.match(index, /accepted on 2026-11-04, and say what was not run and what router 0\.40\.0 adds beyond 0\.37\.0\. ## The cycle/);
  const readme = read('README.md');
  const section = flat(readme.slice(readme.indexOf('\n## Google Cloud\n'), readme.indexOf('\n## Version\n')));
  assert.ok(section.includes('(docs/scenarios/google-cloud-manager.md)'), 'the manager page is in the list');
  assert.ok(section.includes('the journal, the check summary and POST /v1/actions, through which the Dormeto manager reads and acts on a Google Cloud router, from 0.40.0. Router 0.37.0 adds'));
  assert.doesNotMatch(section, /Router 0\.38\.0 is not released yet/);
  for (const file of ['README.md', 'docs/scenarios/README.md', MANAGER, CE, SQL, GKE]) {
    assert.doesNotMatch(read(file), /unreleased/i, file);
    // G4's 0.38.0 and G5's 0.39.0 never ship alone (the design's 7.2); only their dev builds are named.
    assert.doesNotMatch(read(file), /(?<![\d.])0\.3[89]\.0(?![-\d])/, file);
  }
  assert.ok(flat(read('README.md')).includes('creates the services, from Dormeto\'s public image by default (router 0.40.0 and CLI 0.14.0 or later) or from your own with --image.'));
  assert.match(flat(read('README.md')), /router 0\.40\.0 \(terraform\/gcp-releases creates the three repositories\), and dormeto gcp routers install uses it by default from CLI 0\.14\.0\. The old names/);
  assert.match(flat(read(MANAGER)), /^# Google Cloud: the router and the manager From router 0\.40\.0, the Dormeto manager reads a Google Cloud router and acts through it as it does an AWS one\. The router keeps its journal/);
});

// The review's final fix wave: what 0.37.0 did not have is said on every page that says it, and the index's sentence is true.
test('the pages that describe what 0.37.0 did not have say what router 0.40.0 adds, each naming it', () => {
  const gke = flat(read(GKE));
  assert.match(gke, /measured on Google beforehand \(below\)\. Router 0\.40\.0 adds, on this page: the refusal of a KEDA ScaledObject whose minReplicaCount is 0, a default wake timeout of 600 s \(300 s in 0\.37\.0\) that behind a swap can't be less than the map's change plus 60 s, the settings by level \(the type here is k8s\) with fallback machine types refused for pods, and a wider reading of the load balancers GKE owns/);
  const sql = flat(read(SQL));
  assert.match(sql, /the tag's condition as the router\. Router 0\.40\.0 adds, on this page: the wake timeout 1700 s of a workload with a companion, fixed, which show says as fixed, within the settings by level/);
  // docs/scenarios/README.md says the Google Cloud pages say what router 0.40.0 adds beyond 0.37.0: each of the three does.
  assert.match(flat(read('docs/scenarios/README.md')), /and say what was not run and what router 0\.40\.0 adds beyond 0\.37\.0\./);
  assert.ok(flat(read(CE)).includes('They ship in router 0.40.0.'), CE);
  for (const file of [SQL, GKE]) assert.ok(flat(read(file)).includes('Router 0.40.0 adds, on this page: '), file);
  const readme = flat(read('README.md'));
  assert.match(readme, /what was accepted and measured\. Router 0\.40\.0 gives the Google Cloud router AWS's settings by level, the wake mode and the no-wake and wake rules, the branded waiting page, a capacity retry with fallback machine types, and the internal Application Load Balancers/);
  assert.doesNotMatch(readme, /The Google Cloud router has AWS's settings by level/);
});

// The push design (vision docs/specs/2026-11-14-google-cloud-router-push-design.md, §4) and the credentials design
// (docs/specs/2026-11-15-router-credentials-design.md, §5): the page says what report.mjs does.
test('the manager page says the router puts its reports on the bus with the manager\'s credentials, with report.mjs\'s bounds, and the manager no longer polls', async () => {
  const page = flat(read(MANAGER));
  const { REPORT_BUDGET_MS, SEND_MS, ATTEMPTS, RENEW_MS, JITTER_MS } = await import('../src/report.mjs');
  const { ENTRIES_MAX, CALL_MAX, ENTRY_MAX } = await import('../../lambda/src/lib/events.mjs');
  assert.deepEqual([REPORT_BUDGET_MS, SEND_MS, ATTEMPTS, RENEW_MS, JITTER_MS], [2000, 2000, 2, 300_000, 300_000]);
  assert.deepEqual([ENTRIES_MAX, CALL_MAX, ENTRY_MAX], [10, 256 * 1024, 64 * 1024]);
  assert.match(page, /so the manager no longer polls it \(router 0\.41\.0 and manager 0\.25\.0\)/);
  assert.match(page, /A failed report holds a state change 2 s at most, a wake's included, and a check too: one report is 2 s at most, its credentials, its calls and their two tries included/);
  assert.match(page, /logged once a check \(ReportRefused\)/);
  assert.match(page, /asks again 5 minutes before it expires, plus up to 5 minutes drawn by instance/);
  assert.match(page, /at most 10 entries and 256 KB a call, a detail under 64 KB/);
  assert.match(page, /the source dormeto\.router\.gcp\/<project>\/<region> only/);
  assert.doesNotMatch(page, /\/routers\/events|puts them on the manager's event bus|1 MB a request/);
  assert.doesNotMatch(page, /pushes nothing|The manager polls/);
  assert.doesNotMatch(flat(read(CE)), /The manager polls/);
  // The `events` action is gone (the pull's removal): the page names no action to read the journal, and keeps the journal for the reports.
  assert.doesNotMatch(page, /### `events`|manager older than 0\.25\.0|does not poll/);
  assert.match(page, /Events are kept 7 days, for the reports/);
  assert.match(page, /\{ "action": "events" \} is refused as any action the router does not serve/);
});

test('the manager page says a router older than 0.40.0 has no /v1/actions, and names the version once there', () => {
  const page = flat(read(MANAGER));
  assert.match(page, /- A router older than 0\.40\.0 has no \/v1\/actions: the manager lists it with its version/);
  assert.doesNotMatch(page, /not released yet\)/);
});

test('the README says what the router does for each kind of backend, not that it stops and starts the instance', () => {
  const readme = flat(read('README.md'));
  assert.doesNotMatch(readme, /stops and starts the instance/);
  assert.match(readme, /controller Lambda: switches the ALB rule weights, naps idle workloads \(scheduled check of the ALB RequestCount\) and wakes them: it stops and starts EC2 instances and databases, scales Auto Scaling groups, ECS services and Kubernetes Deployments to 0 and back, and reconciles external changes/);
});

// A "Not released yet: router X" sentence is true until the package reaches X: the release's npm test lists each one to rewrite.
const versionParts = (version) => {
  const [core, pre] = version.split(/-(.*)/s);
  return { numbers: core.split('.').map(Number), pre: pre ?? null };
};
// Negative when `a` is below `b`; 0.40.0-dev.3 is below 0.40.0.
const compareVersions = (a, b) => {
  const [x, y] = [versionParts(a), versionParts(b)];
  for (let i = 0; i < 3; i += 1) if (x.numbers[i] !== y.numbers[i]) return x.numbers[i] - y.numbers[i];
  if (x.pre === y.pre) return 0;
  return x.pre === null ? 1 : y.pre === null ? -1 : x.pre < y.pre ? -1 : 1;
};

test('compareVersions: a dev version is below its release, and a lower minor is below', () => {
  assert.ok(compareVersions('0.40.0-dev.3', '0.40.0') < 0);
  assert.ok(compareVersions('0.40.0-rc.1', '0.40.0') < 0);
  assert.ok(compareVersions('0.37.0', '0.40.0') < 0);
  assert.ok(compareVersions('0.9.0', '0.40.0') < 0);
  assert.equal(compareVersions('0.40.0', '0.40.0'), 0);
  assert.ok(compareVersions('0.40.0', '0.40.0-dev.3') > 0);
  assert.ok(compareVersions('0.41.0', '0.40.0') > 0);
});

// The versions a text's "Not released yet: router X" sentences name, a sentence split across lines included.
const notYet = (text) => [...spaced(text).matchAll(/Not released yet: router (\d+\.\d+\.\d+)/g)].map(([, version]) => version);
// Every Markdown and Terraform file of the README, docs/ and terraform/ (a variable's description is a doc; not what terraform
// init downloads).
const MARKDOWN = ['README.md', ...['docs', 'terraform'].flatMap((dir) => readdirSync(`${ROOT}${dir}`, { recursive: true })
  .filter((path) => /\.(md|tf)$/.test(path) && !path.split('/').includes('.terraform')).map((path) => `${dir}/${path}`))];

test('notYet finds each "Not released yet: router X" sentence, across a line break too, and nothing else', () => {
  assert.deepEqual(notYet('Done. Not\nreleased yet: router 0.41.0 and CLI 0.15.0. A (Not released yet: router 1.0.0).'), ['0.41.0', '1.0.0']);
  assert.deepEqual(notYet('From router 0.40.0, it does. Not released yet: CLI 0.15.0.'), []);
  assert.ok(MARKDOWN.includes(MANAGER) && MARKDOWN.includes('terraform/gcp-releases/README.md'), MARKDOWN.join());
});

test('every "Not released yet: router X" sentence names a version above the package\'s: the release rewrites it', () => {
  const found = MARKDOWN.flatMap((file) => notYet(read(file)).map((version) => [file, version]));
  const reached = found.filter(([, version]) => compareVersions(PACKAGE.version, version) >= 0);
  assert.deepEqual(reached, [], `the package is at ${PACKAGE.version}: these sentences are released, rewrite them`);
});

// dormeto-release router rewrites each sentence its version reaches ("router X" in parentheses, "From router X" at a sentence's
// start), then runs these tests: one that pins the sentence would fail the release.
test('no other test pins a "Not released yet: router X" sentence: the release rewrites the docs, not the tests', () => {
  const pinned = ['lambda/test', 'gcp/test'].flatMap((dir) => readdirSync(`${ROOT}${dir}`).filter((name) => name.endsWith('.mjs')).map((name) => `${dir}/${name}`))
    .filter((file) => file !== 'gcp/test/release.test.mjs' && /Not released yet: router \\?\d/.test(read(file)));
  assert.deepEqual(pinned, [], 'match the words around the sentence, or the version alone (router 0\\.43\\.0): the release changes the sentence');
});

// The CLI's move of the router commands under `dormeto gcp routers`: the docs name the new ones, and the old names only in one sentence
// of the README, which says what CLI 0.14.0 does with them (cli cmd/dormeto/gcp_test.go: an unknown command, exit 2, nothing run).
const OLD_NAMES_SENTENCE = 'The old names dormeto gcp install, dormeto gcp uninstall and dormeto gcp status of CLI 0.11.0 are gone from CLI 0.14.0: unknown commands, with no alias and no notice.';
test('the docs name dormeto gcp routers install, uninstall and show, and the old names only in one sentence', () => {
  const files = ['README.md', 'terraform/gcp-dev/README.md', 'terraform/gcp-releases/README.md', 'docs/scenarios/README.md', MANAGER, CE, SQL, GKE];
  let sentences = 0;
  for (const file of files) {
    let text = flat(read(file));
    if (text.includes(OLD_NAMES_SENTENCE)) { sentences += 1; text = text.replace(OLD_NAMES_SENTENCE, ''); }
    assert.doesNotMatch(text, /dormeto gcp (install|uninstall|status)\b/, file);
  }
  assert.equal(sentences, 1, 'the one sentence, in the README');
  assert.ok(flat(read('README.md')).includes(OLD_NAMES_SENTENCE));
  assert.match(flat(read('README.md')), /dormeto gcp routers install/);
  assert.match(flat(read('terraform/gcp-dev/README.md')), /dormeto gcp routers uninstall/);
});
