import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkScope } from '../src/lib/check-scope.mjs';

const tag = (value) => [{ Key: 'dormeto:workload', Value: value }];

test('a check finds the tagged Auto Scaling groups, ECS services and databases of every workload with one listing each', async () => {
  const calls = [];
  const autoscaling = {
    async describeAutoScalingGroups(input) {
      calls.push(['asg', input]);
      // Two pages.
      return input.NextToken
        ? { AutoScalingGroups: [{ AutoScalingGroupName: 'b', Tags: tag('w2') }] }
        : { AutoScalingGroups: [{ AutoScalingGroupName: 'a', Tags: tag('w1') }], NextToken: 't1' };
    },
  };
  const tagging = {
    async getResources(input) {
      calls.push(['tagging', input]);
      return {
        ResourceTagMappingList: [
          { ResourceARN: 'arn:aws:ecs:eu-west-3:111122223333:service/c/s1', Tags: tag('w1') },
          { ResourceARN: 'arn:aws:rds:eu-west-3:111122223333:db:d1', Tags: tag('w1') },
          { ResourceARN: 'arn:aws:rds:eu-west-3:111122223333:cluster:c2', Tags: tag('w2') },
        ],
      };
    },
  };
  const scope = checkScope({ autoscaling, tagging, ec2: 'ec2' });
  const groups = (id) => scope.autoscaling.describeAutoScalingGroups({ Filters: [{ Name: 'tag:dormeto:workload', Values: [id] }] });
  const resources = (id, types) => scope.tagging.getResources({ TagFilters: [{ Key: 'dormeto:workload', Values: [id] }], ResourceTypeFilters: types });
  assert.deepEqual((await groups('w1')).AutoScalingGroups.map((g) => g.AutoScalingGroupName), ['a']);
  assert.deepEqual((await groups('w2')).AutoScalingGroups.map((g) => g.AutoScalingGroupName), ['b']);
  assert.deepEqual((await resources('w1', ['ecs:service'])).ResourceTagMappingList.map((m) => m.ResourceARN), ['arn:aws:ecs:eu-west-3:111122223333:service/c/s1']);
  assert.deepEqual((await resources('w1', ['rds:db', 'rds:cluster'])).ResourceTagMappingList.map((m) => m.ResourceARN), ['arn:aws:rds:eu-west-3:111122223333:db:d1']);
  assert.deepEqual((await resources('w2', ['rds:db', 'rds:cluster'])).ResourceTagMappingList.map((m) => m.ResourceARN), ['arn:aws:rds:eu-west-3:111122223333:cluster:c2']);
  assert.deepEqual(calls.map(([kind, input]) => [kind, input.Filters ?? input.TagFilters, input.NextToken ?? null]), [
    ['asg', [{ Name: 'tag-key', Values: ['dormeto:workload'] }], null],
    ['asg', [{ Name: 'tag-key', Values: ['dormeto:workload'] }], 't1'],
    ['tagging', [{ Key: 'dormeto:workload' }], null],
  ]);
  // Other calls go through; other clients are the same.
  await scope.autoscaling.describeAutoScalingGroups({ AutoScalingGroupNames: ['x'] });
  assert.deepEqual(calls.at(-1), ['asg', { AutoScalingGroupNames: ['x'] }]);
  assert.equal(scope.ec2, 'ec2');
});
