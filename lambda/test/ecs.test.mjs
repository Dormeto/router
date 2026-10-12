import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backendStatuses, resolveBackends, resumeBackends, sleepBackends, wakeBackends } from '../src/lib/backends.mjs';
import { ECS_SUSPENDED, ecsResourceId } from '../src/lib/ecs.mjs';
import { ecsService, fakeAppScaling, fakeClock, fakeEc2, fakeEcs, fakeElbv2, fakeTagging, testConfig } from './fakes.mjs';

const TAG = { 'dormeto:workload': 'demo' };

function clients({ services = [], targets = [], scalable = [] } = {}) {
  const cfg = testConfig({ instanceIds: [] });
  const elbv2 = fakeElbv2(cfg);
  elbv2.state.targets = targets;
  const ecs = fakeEcs(services.map((s) => (typeof s === 'function' ? s(cfg) : s)));
  return { cfg, elbv2, ec2: fakeEc2([]), ecs, tagging: fakeTagging(ecs), appscaling: fakeAppScaling(scalable) };
}

const timing = () => { const c = fakeClock(); return { sleep: c.sleep, now: c.now, deadline: c.now() + 300_000 }; };

test('ecsResourceId converts a service ARN to an Application Auto Scaling resource id', () => {
  assert.equal(ecsResourceId('arn:aws:ecs:eu-west-1:111122223333:service/dmt-dev/web'), 'service/dmt-dev/web');
});

test('discovers tagged ECS services feeding the app target group, with their scalable target', async () => {
  const c = clients({
    services: [
      (cfg) => ecsService('web', { desired: 2, targetGroups: [cfg.appTargetGroupArn], tags: TAG }),
      ecsService('other', { targetGroups: ['arn:other'], tags: TAG }),
    ],
    targets: [{ Id: '10.40.0.12', State: 'healthy' }, { Id: '10.40.1.7', State: 'healthy' }],
    scalable: [{ ResourceId: 'service/dmt-dev/web', MinCapacity: 1, MaxCapacity: 4 }],
  });
  const { backends, ignored } = await resolveBackends(c, c.cfg);
  assert.deepEqual(backends, [{
    kind: 'ecs', id: 'arn:aws:ecs:eu-west-1:111122223333:service/dmt-dev/web', cluster: 'arn:aws:ecs:eu-west-1:111122223333:cluster/dmt-dev',
    desired: 2, scalable: { min: 1, max: 4 }, wakeDesired: null,
  }]);
  assert.deepEqual(ignored, [{ id: 'arn:aws:ecs:eu-west-1:111122223333:service/dmt-dev/other', reason: 'ECS service does not feed the target group' }],
    'IP targets of a managed service are not ignored targets');
});

test('discovers a service scaled to zero while the workload sleeps', async () => {
  const c = clients({ services: [(cfg) => ecsService('web', { desired: 0, targetGroups: [cfg.appTargetGroupArn], tags: { ...TAG, 'dormeto:wake-desired': '2' } })] });
  const { backends } = await resolveBackends(c, c.cfg);
  assert.equal(backends[0].desired, 0);
  assert.equal(backends[0].wakeDesired, 2);
  assert.equal(backends[0].scalable, null);
});

test('ECS service statuses', async () => {
  const c = clients({ services: [ecsService('up', {}), ecsService('down', { desired: 0 }), ecsService('starting', { desired: 1, running: 0 })] });
  const statuses = await backendStatuses(c, c.ecs.state.services.map((s) => ({ kind: 'ecs', id: s.serviceArn, cluster: s.clusterArn })));
  assert.deepEqual(Object.values(statuses), ['running', 'stopped', 'transitioning']);
});

test('sleep records the counts, suspends the scalable target and scales the service to zero', async () => {
  const c = clients({ services: [ecsService('web', { desired: 2 })], scalable: [{ ResourceId: 'service/dmt-dev/web', MinCapacity: 1, MaxCapacity: 4 }] });
  const [service] = c.ecs.state.services;
  const records = await sleepBackends(c, [{ kind: 'ecs', id: service.serviceArn, cluster: service.clusterArn, desired: 2, scalable: { min: 1, max: 4 }, wakeDesired: null }], timing());
  assert.deepEqual(records, [{ kind: 'ecs', id: service.serviceArn, cluster: service.clusterArn, desired: 2, scalable: { min: 1, max: 4 } }]);
  assert.deepEqual(c.appscaling.state.registrations, [{
    ServiceNamespace: 'ecs', ResourceId: 'service/dmt-dev/web', ScalableDimension: 'ecs:service:DesiredCount', MinCapacity: 0, SuspendedState: ECS_SUSPENDED,
  }]);
  assert.deepEqual(c.ecs.state.updates, [{ cluster: service.clusterArn, service: service.serviceArn, desiredCount: 0 }]);
  assert.equal(c.ecs.state.services[0].runningCount, 0);
});

test('wake restores the desired count and the scalable target', async () => {
  const c = clients({ services: [ecsService('web', { desired: 0 })], scalable: [{ ResourceId: 'service/dmt-dev/web', MinCapacity: 0, MaxCapacity: 4 }] });
  const [service] = c.ecs.state.services;
  await wakeBackends(c, [{ kind: 'ecs', id: service.serviceArn, cluster: service.clusterArn, desired: 2, scalable: { min: 1, max: 4 } }], timing());
  assert.deepEqual(c.ecs.state.updates, [{ cluster: service.clusterArn, service: service.serviceArn, desiredCount: 2 }]);
  assert.deepEqual(c.appscaling.state.registrations.at(-1), {
    ServiceNamespace: 'ecs', ResourceId: 'service/dmt-dev/web', ScalableDimension: 'ecs:service:DesiredCount', MinCapacity: 1, MaxCapacity: 4,
    SuspendedState: { DynamicScalingInSuspended: false, DynamicScalingOutSuspended: false, ScheduledScalingSuspended: false },
  });
});

test('wake without a recorded count uses dormeto:wake-desired or 1', async () => {
  const c = clients({ services: [ecsService('a', { desired: 0 }), ecsService('b', { desired: 0 })] });
  const [a, b] = c.ecs.state.services;
  await wakeBackends(c, [
    { kind: 'ecs', id: a.serviceArn, cluster: a.clusterArn, desired: 0, scalable: null, wakeDesired: null },
    { kind: 'ecs', id: b.serviceArn, cluster: b.clusterArn, desired: 0, scalable: null, wakeDesired: 3 },
  ], timing());
  assert.deepEqual(c.ecs.state.updates.map((u) => u.desiredCount), [1, 3]);
  assert.equal(c.appscaling.state.registrations.length, 0);
});

test('resume after an external scale-up restores the scalable target, capped by the chosen count', async () => {
  const c = clients({ services: [ecsService('web', { desired: 1 })], scalable: [{ ResourceId: 'service/dmt-dev/web', MinCapacity: 0, MaxCapacity: 4 }] });
  const [service] = c.ecs.state.services;
  await resumeBackends(c, [{ kind: 'ecs', id: service.serviceArn, cluster: service.clusterArn, desired: 2, scalable: { min: 2, max: 4 } }]);
  assert.equal(c.ecs.state.updates.length, 0, 'the chosen count is kept');
  assert.equal(c.appscaling.state.registrations[0].MinCapacity, 1);
  assert.equal(c.appscaling.state.registrations[0].SuspendedState.DynamicScalingOutSuspended, false);
});
