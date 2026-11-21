// The standalone workloads page says both clouds (plan 5, R31): Google Cloud's resources, metrics, custom metric's shape, what marks a
// resource and its limits, once; the manager page and the README name it, in the router's form for what is to come.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { IDLE_METRIC_ALIGNERS, CLOUD_SQL_CONNECTIONS } from '../../lambda/src/lib/settings-levels.mjs';

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const flat = (text) => text.replace(/[`*]/g, '').replace(/\s+/g, ' ');

test('the standalone page says Google Cloud\'s resources, metrics, metric shape, mark and limits, once', () => {
  const page = flat(read('docs/scenarios/standalone.md'));
  for (const said of ['Google Cloud: Compute Engine VM outside a managed instance group', 'Google Cloud: managed instance group', 'Google Cloud: Cloud SQL instance',
    'compute.googleapis.com/instance/cpu/utilization', 'cloudsql.googleapis.com/database/cpu/utilization', 'received_bytes_count + sent_bytes_count', CLOUD_SQL_CONNECTIONS,
    'idleMetric there is { type, filter, aligner, below }', `the aligner ${IDLE_METRIC_ALIGNERS.slice(0, -1).join(', ')} or ${IDLE_METRIC_ALIGNERS.at(-1)}`,
    'the tag dormeto=managed', 'a resource is missing when Google says it is deleted', 'The wake timeout is 1700 s at most on Google Cloud',
    'is a member of a managed instance group (onboard the group: it would repair a stopped VM)', 'holds GKE nodes', 'a read replica', 'Whether a VM or a group backs a backend service the router cannot tell']) {
    assert.ok(page.includes(said.replace(/[`*]/g, '')), said);
  }
});

test('the manager page and the README name standalone workloads, to come in router 0.42.0', () => {
  const manager = flat(read('docs/scenarios/google-cloud-manager.md'));
  assert.match(manager, /## Standalone workloads Not released yet: router 0\.42\.0\. A workload is of one of two kinds/);
  assert.ok(manager.includes('[Standalone workloads](standalone.md)'));
  const readme = flat(read('README.md'));
  assert.ok(readme.includes('[Standalone workloads](docs/scenarios/standalone.md): a Compute Engine VM, a managed instance group or a Cloud SQL instance'));
});

test('the page says the R30 review\'s rulings: a failed wake retried until it succeeds, a permission failure kept', () => {
  const page = flat(read('docs/scenarios/standalone.md'));
  assert.ok(page.includes('A failed wake stays failed and is retried by the check after 60 s, doubled after each failure in a row, at most 30 minutes, until a wake succeeds, everything stopped or not'));
  assert.ok(page.includes('A keepAsleep pause or a nap window holds the retry; a person\'s nap ends it'));
  assert.ok(page.includes('A failure for a permission'));
  assert.doesNotMatch(page, /leaves every backend stopped ends it/);
});

test('the page says what the manager\'s discovery role reads of Cloud SQL, as gcp/access.json has it, and the API it needs', () => {
  const page = flat(read('docs/scenarios/standalone.md'));
  const discovery = JSON.parse(read('gcp/access.json')).manager.roles.dormetoDiscovery.permissions;
  const reads = discovery.filter((p) => p.startsWith('cloudsql.'));
  assert.deepEqual(reads, ['cloudsql.instances.get', 'cloudsql.instances.list']);
  assert.ok(page.includes(`The manager's scan lists a project's Cloud SQL instances (Not released yet: router 0.42.0): its discovery role, dormetoDiscovery, reads them with ${reads.join(' and ')}`));
  assert.ok(page.includes('where the Cloud SQL Admin API is off (only a router installed with --with cloud-sql turns it on), Google refuses the read and the scan says Cloud SQL was not read; nothing turns the API on for it'));
});

test('the page says the final review\'s fixes (plan 5): the group sized 0, Spot on each cloud, cloud-sql-unreadable, the calls a read makes, both sequences, a person\'s nap', () => {
  const raw = read('docs/scenarios/standalone.md');
  const page = flat(raw);
  assert.doesNotMatch(page, /A managed instance group not found, with no VM/);
  assert.ok(page.includes('A group sized 0 is accepted: it is awake with no VM'));
  assert.ok(page.includes('Spot instances are refused on AWS; Google Cloud accepts Spot and preemptible VMs'));
  assert.ok(page.includes('the router\'s health warns cloud-sql-unreadable'));
  assert.ok(page.includes('one GetMetricData call for all its signals'));
  assert.ok(page.includes('one timeSeries.list call a metric type, a managed instance group\'s VMs listed first'));
  assert.ok(page.includes('The status reads them live'));
  assert.match(raw, /participant C as Controller Lambda[\s\S]*participant G as Controller \(Cloud Run\)|participant G as Controller \(Cloud Run\)/);
  assert.ok(raw.includes('participant CM as Cloud Monitoring'));
  assert.ok(page.includes('A person\'s nap asked stops the retry at once'));
  assert.ok(page.includes('a release that fails is recorded as a nap\'s failure, tried again once an idle window, never followed by a wake'));
  assert.ok(page.includes('journaled as the person\'s nap (cause manager, with by)'));
  assert.ok(page.includes('nextAttemptAt is the retry\'s time only while one is coming'));
});
