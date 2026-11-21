// The docs of standalone workloads say what the code does (vision standalone workloads design §10's router side): the scenario
// page linked from the index and the README, its links resolved, its built-in values and lag the code's, each eligibility case
// named, and the Terraform module's variables for each idle setting the guard names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { STANDALONE_BUILT_IN } from '../src/lib/settings-levels.mjs';
import { METRIC_LAG_MS } from '../src/lib/activity.mjs';

const root = new URL('../../', import.meta.url).pathname;
const read = (path) => readFileSync(join(root, path), 'utf8');
const flat = (text) => text.replace(/[`*]/g, '').replace(/\s+/g, ' ');
const PAGE = 'docs/scenarios/standalone.md';

test('the standalone page is linked from the scenarios index and the README, and its own links resolve', () => {
  assert.match(read('docs/scenarios/README.md'), /\[Standalone workloads\]\(standalone\.md\)/);
  assert.match(read('README.md'), /\(docs\/scenarios\/standalone\.md\)/);
  for (const file of [PAGE, 'docs/scenarios/README.md', 'README.md']) {
    for (const [, target] of read(file).matchAll(/\]\(([^)#:]+\.md)(#[^)]*)?\)/g)) assert.ok(existsSync(join(root, dirname(file), target)), `${file}: ${target}`);
  }
});

test('the index says the two kinds, and every standalone sentence about what is to come names the version after the package\'s', () => {
  const index = flat(read('docs/scenarios/README.md'));
  assert.match(index, /A workload is of one of two kinds\. An HTTP workload is an Application Load Balancer target group/);
  assert.match(index, /A standalone workload is one stoppable resource no load balancer serves/);
  for (const file of [PAGE, 'docs/scenarios/README.md', 'README.md']) assert.match(flat(read(file)), /Not released yet: router 0\.42\.0/, file);
  assert.doesNotMatch(read(PAGE), /unreleased/i);
});

test('the page gives the code\'s built-in values, its lag and what is refused', () => {
  const page = flat(read(PAGE));
  assert.equal(STANDALONE_BUILT_IN.idleMinutes, 120);
  assert.match(page, /\| idleMinutes \| 5 to 1440 \| 120 \(an HTTP workload's: 15\)/);
  assert.match(page, new RegExp(`\\| idleCpuPercent \\| 0 to 100, or off \\| ${STANDALONE_BUILT_IN.idleCpuPercent};`));
  assert.match(page, /\| idleNetworkBytes \| 0 to 10,000,000,000, or off \| off \|/);
  assert.match(page, /\| idleMetric \| \{ namespace, name, dimensions, statistic, below \}, or off \| off;/);
  assert.match(page, new RegExp(`ends ${METRIC_LAG_MS / 60_000} minutes behind, at a 5-minute boundary`));
  assert.match(page, /10 to 15 minutes after the idle window/);
  assert.match(page, /Nothing wakes it on demand/);
  // findings-final-2.md: a workload whose resource is gone is offboarded in any state.
  assert.match(page, /Offboarding removes the tags and the configuration; it needs the workload awake, unless its resource is gone \(deleted, or its tag removed\), when it is offboarded in any state/);
  // The final review's fix wave: a person's nap is theirs; every listed companion is read.
  assert.match(page, /A queued idle nap delivered more than a minute after it was asked reads the signals again and is skipped if the workload is busy; a person's nap is never read against the signals/);
  assert.match(page, /read for each companion its configuration lists \(databases at onboarding or in the workload module\): each must be under 1\. A companion found by its tag alone is napped and woken with the workload but not read/);
  for (const reason of ['a target of a target group', 'attached to a target group', 'registered with one', 'another workload\'s dormeto:workload tag', 'a companion database of another workload',
    'onboarded already', 'not found or terminated', 'is in an Auto Scaling group', 'instance store', 'Spot instance', 'holds EKS nodes', 'daemon scheduling strategy',
    'member of an Aurora cluster', 'read replica', 'Aurora Serverless v1']) {
    assert.ok(page.includes(reason), reason);
  }
});

test('the workload module has a variable for each idle setting the Terraform guard names', () => {
  const variables = read('terraform/modules/workload/variables.tf');
  const controller = read('lambda/src/lib/controller-core.mjs');
  for (const [key, variable] of [['idleCpuPercent', 'idle_cpu_percent'], ['idleNetworkBytes', 'idle_network_bytes'], ['idleMetric', 'idle_metric']]) {
    assert.match(controller, new RegExp(`${key}: '${variable}'`), key);
    assert.match(variables, new RegExp(`variable "${variable}"`), variable);
  }
  assert.match(variables, /variable "resource_arn"/);
});

test('the page says the limit of a Classic Load Balancer (the user, 2026-11-21: ignored)', () => {
  const page = flat(read(PAGE));
  assert.ok(page.includes('A resource behind a Classic Load Balancer, which uses no target group, is not told apart: the router refuses what feeds a target group only, so an instance, an Auto Scaling group or an ECS service behind a Classic Load Balancer can be onboarded as a standalone workload, and its schedule or its idle signals would stop it'));
});
