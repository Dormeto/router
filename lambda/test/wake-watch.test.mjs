import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWakeWatch, unhealthyError } from '../src/lib/wake-watch.mjs';
import { fakeKubernetes, k8sOwner, k8sPod } from './fakes.mjs';

const SINCE = Date.UTC(2026, 9, 8, 12, 0);
const at = (s) => new Date(SINCE + s * 1000);

function clients({ activities = [], events = [], targets = [] } = {}) {
  const calls = [];
  return {
    calls,
    autoscaling: { async describeScalingActivities(input) { calls.push(['activities', input.AutoScalingGroupName]); return { Activities: activities }; } },
    ecs: { async describeServices(input) { calls.push(['services', input.services[0]]); return { services: [{ serviceArn: input.services[0], events }] }; } },
    elbv2: { async describeTargetHealth() { return { TargetHealthDescriptions: targets }; } },
  };
}
const ASG = { kind: 'asg', name: 'dmt-dev-demo-asg' };
const ECS = { kind: 'ecs', id: 'arn:aws:ecs:eu-west-1:1:service/dmt-dev/demo', cluster: 'arn:aws:ecs:eu-west-1:1:cluster/dmt-dev' };

test('a failed Auto Scaling launch since the wake started is noted (capacity) or ends the wake; an older one is ignored', async () => {
  let now = SINCE + 40_000;
  const c = clients({ activities: [
    { StartTime: at(-600), StatusCode: 'Failed', StatusMessage: 'an older launch failure' },
    { StartTime: at(5), StatusCode: 'Failed', StatusMessage: 'We currently do not have sufficient t3.micro capacity in the Availability Zone you requested (eu-west-1a).' },
  ] });
  const watch = createWakeWatch(c, [ASG], { since: SINCE, now: () => now });
  // No capacity: Auto Scaling keeps trying, so the wake goes on, the failure noted for its deadline (R7a).
  assert.equal(await watch.check(), null);
  const error = watch.capacity;
  assert.equal(error.kind, 'capacity');
  assert.equal(error.backend, 'asg:dmt-dev-demo-asg');
  assert.match(error.message, /^Auto Scaling group dmt-dev-demo-asg: We currently do not have sufficient t3\.micro capacity/);
  const old = createWakeWatch(clients({ activities: [{ StartTime: at(-600), StatusCode: 'Failed', StatusMessage: 'old' }] }), [ASG], { since: SINCE, now: () => now });
  assert.equal(await old.check(), null);
});

test('an ECS event saying a task cannot be placed ends the wake; a steady or started event does not', async () => {
  const now = () => SINCE + 40_000;
  const failing = createWakeWatch(clients({ events: [
    { createdAt: at(20), message: '(service demo) was unable to place a task because no container instance met all of its requirements.' },
    { createdAt: at(3), message: '(service demo) has started 1 tasks: (task abc).' },
  ] }), [ECS], { since: SINCE, now });
  assert.equal(await failing.check(), null, 'ECS keeps trying to place it');
  assert.deepEqual([failing.capacity.kind, failing.capacity.backend], ['capacity', 'ecs:arn:aws:ecs:eu-west-1:1:service/dmt-dev/demo']);
  const fine = createWakeWatch(clients({ events: [{ createdAt: at(30), message: '(service demo) has reached a steady state.' }] }), [ECS], { since: SINCE, now });
  assert.equal(await fine.check(), null);
});

test('reads at most every 30 seconds, whatever the wait polls', async () => {
  let now = SINCE;
  const c = clients();
  const watch = createWakeWatch(c, [ASG, ECS], { since: SINCE, now: () => now });
  for (let s = 0; s < 70; s += 3) { now = SINCE + s * 1000; await watch.check(); }
  assert.equal(c.calls.filter(([what]) => what === 'activities').length, 3, 'at 0, 30 and 60 s');
});

test('at the deadline, unhealthy targets say why; no target says so', async () => {
  const unhealthy = await unhealthyError(clients({ targets: [
    { Target: { Id: 'i-1' }, TargetHealth: { State: 'unhealthy', Reason: 'Target.FailedHealthChecks', Description: 'Health checks failed with these codes: [502]' } },
    { Target: { Id: 'i-2' }, TargetHealth: { State: 'initial', Reason: 'Elb.RegistrationInProgress' } },
  ] }).elbv2, 'arn:tg');
  assert.equal(unhealthy.kind, 'unhealthy');
  assert.equal(unhealthy.message, '2 targets, none healthy: Target.FailedHealthChecks (Health checks failed with these codes: [502])');
  const none = await unhealthyError(clients().elbv2, 'arn:tg');
  assert.deepEqual([none.kind, none.message], ['timeout', 'no target registered in the target group when the wake timed out']);
});

// A Kubernetes workload: the Events of its pods since the wake started.
const K8S = { kind: 'k8s', id: 'eks-demo/demo/Deployment/web', cluster: 'eks-demo', namespace: 'demo', owner: { kind: 'Deployment', name: 'web' }, replicas: 2 };
const podEvent = (pod, reason, message, s, type = 'Warning') => ({ involvedObject: { kind: 'Pod', name: pod }, type, reason, message, lastTimestamp: at(s).toISOString() });
function kubeWatch(events) {
  const k8s = fakeKubernetes({
    owners: [k8sOwner('web', { replicas: 2 }), k8sOwner('web-api', { replicas: 1 })],
    pods: [k8sPod('web-5d9c-a1', { labels: { app: 'web' }, phase: 'Pending', ready: false, owner: { kind: 'ReplicaSet', name: 'web-5d4f8' } }), k8sPod('web-api-77f-b2', { labels: { app: 'web-api' }, owner: { kind: 'ReplicaSet', name: 'web-api-5d4f8' } })],
    events,
  });
  return createWakeWatch({ kubernetesOf: async () => k8s }, [K8S], { since: SINCE, now: () => SINCE + 40_000 });
}

test('pods the scheduler cannot place yet are noted as capacity while the wake waits (Karpenter launching a node); older events and other owners\' pods are ignored', async () => {
  const watch = kubeWatch([
    podEvent('web-5d9c-a1', 'FailedScheduling', '0/2 nodes are available: 2 Insufficient cpu. preemption: 0/2 nodes are available.', 10),
    podEvent('web-5d9c-a1', 'FailedScheduling', 'an older one', -600),
    podEvent('web-api-77f-b2', 'Failed', 'Failed to pull image "api:nope": not found', 12),
  ]);
  assert.equal(await watch.check(), null, 'the scheduler keeps trying');
  assert.deepEqual([watch.capacity.kind, watch.capacity.backend], ['capacity', `k8s:${K8S.id}`]);
  assert.equal(watch.capacity.message, 'pod web-5d9c-a1: FailedScheduling: 0/2 nodes are available: 2 Insufficient cpu. preemption: 0/2 nodes are available.');
});

test('image pull errors and crash loops end the wake as configuration, quoting the Event', async () => {
  const cases = [
    [podEvent('web-5d9c-a1', 'Failed', 'Failed to pull image "web:nope": rpc error: code = NotFound desc = not found', 8), /pod web-5d9c-a1: Failed: Failed to pull image "web:nope"/],
    [podEvent('web-5d9c-a1', 'Failed', 'Error: ErrImagePull', 8), /ErrImagePull/],
    [podEvent('web-5d9c-a1', 'BackOff', 'Back-off pulling image "web:nope"', 9), /Back-off pulling image/],
    [podEvent('web-5d9c-a1', 'Failed', 'Error: ImagePullBackOff', 9), /ImagePullBackOff/],
    [podEvent('web-5d9c-a1', 'BackOff', 'Back-off restarting failed container app in pod web-5d9c-a1_demo', 30), /Back-off restarting failed container/],
  ];
  for (const [event, message] of cases) {
    const error = await kubeWatch([event]).check();
    assert.equal(error?.kind, 'configuration', event.message);
    assert.equal(error.backend, `k8s:${K8S.id}`);
    assert.match(error.message, message);
  }
  assert.equal(await kubeWatch([podEvent('web-5d9c-a1', 'Pulled', 'Successfully pulled image "web:1"', 9, 'Normal')]).check(), null);
});
