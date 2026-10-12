import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveInstances } from '../src/lib/discovery.mjs';
import { fakeEc2, fakeElbv2, testConfig } from './fakes.mjs';

function discoverySetup(targets, tags) {
  const cfg = testConfig({ instanceIds: [] });
  const elbv2 = fakeElbv2(cfg);
  elbv2.state.targets = targets;
  const ec2 = fakeEc2(targets.map((t) => t.Id).filter((id) => id.startsWith('i-')), { state: 'running' });
  ec2.state.tags = tags;
  return { cfg, elbv2, ec2 };
}

test('static mode returns the configured instances without calling AWS', async () => {
  const cfg = testConfig({ instanceIds: ['i-static'] });
  const fail = async () => { throw new Error('must not be called'); };
  const result = await resolveInstances({ describeInstances: fail }, { describeTargetHealth: fail }, cfg);
  assert.deepEqual(result, { mode: 'static', managed: ['i-static'], ignored: [] });
});

test('discovery keeps instances tagged for the workload and ignores the others', async () => {
  const { cfg, elbv2, ec2 } = discoverySetup(
    [{ Id: 'i-a', State: 'healthy' }, { Id: 'i-b', State: 'unused' }, { Id: 'i-c', State: 'healthy' }, { Id: '10.0.0.5', State: 'healthy' }, { Id: 'i-d', State: 'unused' }],
    { 'i-a': { 'dormeto:workload': 'demo' }, 'i-b': { 'dormeto:workload': 'other' }, 'i-d': { 'dormeto:workload': 'demo', Name: 'x' } },
  );
  const result = await resolveInstances(ec2, elbv2, cfg);
  assert.deepEqual(result, {
    mode: 'discovery',
    managed: ['i-a', 'i-d'],
    ignored: [{ id: 'i-b', reason: 'tagged for workload other' }, { id: 'i-c', reason: 'untagged' }, { id: '10.0.0.5', reason: 'not an instance' }],
  });
});

test('discovery without instance targets returns nothing to manage', async () => {
  const { cfg, elbv2, ec2 } = discoverySetup([], {});
  assert.deepEqual(await resolveInstances(ec2, elbv2, cfg), { mode: 'discovery', managed: [], ignored: [] });
});

test('a missing instanceIds field means discovery', async () => {
  const { cfg, elbv2, ec2 } = discoverySetup([{ Id: 'i-a', State: 'healthy' }], { 'i-a': { 'dormeto:workload': 'demo' } });
  delete cfg.instanceIds;
  assert.deepEqual((await resolveInstances(ec2, elbv2, cfg)).managed, ['i-a']);
});
