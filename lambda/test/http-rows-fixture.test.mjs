// An HTTP workload's row (list, report) and status are byte-equal to what the router answered before standalone workloads (vision
// standalone workloads design §5): fixtures/http-rows.json was written from the code at router db56f12, before R26 changed
// summary.mjs and status.mjs. DMT_WRITE_FIXTURE=1 writes it again (only ever at such a base).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createController } from '../src/lib/controller-core.mjs';
import { STATES } from '../src/lib/state.mjs';
import { fakeAppScaling, fakeAutoScaling, fakeClock, fakeCloudWatch, fakeEc2, fakeEcs, fakeElbv2, fakeStore, fakeTagging, silentLog, testConfig } from './fakes.mjs';

const FIXTURE = new URL('./fixtures/http-rows.json', import.meta.url);

const SCENARIOS = {
  awake: { cfg: testConfig({ source: 'manager', name: 'Demo', tags: { team: 'shop' }, inherits: ['idleMinutes'] }), run: { state: STATES.AWAKE, awakeSince: 1_699_999_000_000, wakeCount: 3, backendKinds: 'instance' }, instance: 'running', target: 'app' },
  failed: {
    cfg: testConfig(), instance: 'stopped', target: 'waker',
    run: { state: STATES.FAILED, failedAt: 1_699_999_500_000, consecutiveFailures: 2, failure: JSON.stringify({ kind: 'capacity', step: 'wake', message: 'no capacity', at: 1_699_999_500_000 }), instanceTypes: JSON.stringify({ 'i-0123456789abcdef0': { from: 't3.medium', to: 't3a.medium' } }) },
  },
  asleep: { cfg: testConfig({ source: 'manager', wakeMode: 'browser' }), run: { state: STATES.ASLEEP, stateAt: 1_699_998_000_000, hibernated: JSON.stringify({ ids: ['i-0123456789abcdef0'], at: 1 }) }, instance: 'stopped', target: 'waker' },
};

async function answers({ cfg, run, instance, target }) {
  const clock = fakeClock();
  const store = fakeStore({ config: cfg, run, clock });
  const ecs = fakeEcs();
  const handler = createController({
    store, ec2: fakeEc2(cfg.instanceIds, { state: instance }), elbv2: fakeElbv2(cfg, { target, healthy: target === 'app' ? 1 : 0 }), cloudwatch: fakeCloudWatch([0, 0, 0]),
    autoscaling: fakeAutoScaling(), ecs, tagging: fakeTagging(ecs), appscaling: fakeAppScaling(), invokeSelf: async () => {},
    now: clock.now, sleep: clock.sleep, newId: () => 'w1', log: silentLog, router: { name: 'dmt-dev', version: '0.41.0', build: 'b1' },
  });
  return { list: await handler({ action: 'list' }), status: await handler({ action: 'status', workloadId: cfg.workloadId }) };
}

test('an HTTP workload\'s row and status are byte-equal to the router\'s before standalone workloads', async () => {
  const got = {};
  for (const [name, scenario] of Object.entries(SCENARIOS)) got[name] = await answers(scenario);
  const text = `${JSON.stringify(got, null, 2)}\n`;
  if (process.env.DMT_WRITE_FIXTURE === '1') writeFileSync(FIXTURE, text);
  assert.equal(text, readFileSync(FIXTURE, 'utf8'));
});
