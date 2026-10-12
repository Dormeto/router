import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWakeWatch, unhealthyError } from '../src/lib/wake-watch.mjs';

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

test('a failed Auto Scaling launch since the wake started ends the wake with its kind; an older one is ignored', async () => {
  let now = SINCE + 40_000;
  const c = clients({ activities: [
    { StartTime: at(-600), StatusCode: 'Failed', StatusMessage: 'an older launch failure' },
    { StartTime: at(5), StatusCode: 'Failed', StatusMessage: 'We currently do not have sufficient t3.micro capacity in the Availability Zone you requested (eu-west-1a).' },
  ] });
  const watch = createWakeWatch(c, [ASG], { since: SINCE, now: () => now });
  const error = await watch.check();
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
  const error = await failing.check();
  assert.deepEqual([error.kind, error.backend], ['capacity', 'ecs:arn:aws:ecs:eu-west-1:1:service/dmt-dev/demo']);
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
