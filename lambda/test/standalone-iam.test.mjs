// No new permission for standalone workloads (vision standalone workloads design §5): every AWS call a standalone workload makes is
// allowed to the function that makes it, in the router module's iam.tf, in an installed router's roles (install/blueprint.mjs) and
// by the account's permissions boundary (routerBoundary). The calls are the code's: lib/backends.mjs, ecs.mjs, rds.mjs,
// instances.mjs, capacity.mjs, wake-watch.mjs, stopped.mjs, activity.mjs (the controller) and lib/onboarding.mjs (the onboarder).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { blueprint, routerBoundary } from '../../install/blueprint.mjs';

const IAM_TF = new URL('../../terraform/modules/router/iam.tf', import.meta.url);

const CALLS = {
  controller: [
    // An instance: its state and tags, the stop (or hibernation) and start, a fallback instance type and its tag.
    'ec2:DescribeInstances', 'ec2:StartInstances', 'ec2:StopInstances', 'ec2:ModifyInstanceAttribute', 'ec2:CreateTags', 'ec2:DeleteTags',
    // An Auto Scaling group: its size, the scale to 0 and back with its processes, its activities while it wakes.
    'autoscaling:DescribeAutoScalingGroups', 'autoscaling:UpdateAutoScalingGroup', 'autoscaling:SuspendProcesses', 'autoscaling:ResumeProcesses', 'autoscaling:DescribeScalingActivities',
    // An ECS service: found by its tag, its desired count and its scalable target, its task size for the savings.
    'tag:GetResources', 'ecs:DescribeServices', 'ecs:UpdateService', 'ecs:DescribeTaskDefinition', 'application-autoscaling:DescribeScalableTargets', 'application-autoscaling:RegisterScalableTarget',
    // A database, the resource or a companion.
    'rds:DescribeDBInstances', 'rds:DescribeDBClusters', 'rds:StartDBInstance', 'rds:StopDBInstance', 'rds:StartDBCluster', 'rds:StopDBCluster',
    // The idle signals.
    'cloudwatch:GetMetricData',
  ],
  onboarder: [
    // The preview: the resource, and whether an instance feeds a target group (the only ELB calls of the path).
    'ec2:DescribeInstances', 'elasticloadbalancing:DescribeTargetGroups', 'elasticloadbalancing:DescribeTargetHealth', 'autoscaling:DescribeAutoScalingGroups',
    'ecs:DescribeServices', 'rds:DescribeDBInstances', 'rds:DescribeDBClusters',
    // The workload tag and the marker, on and off.
    'ec2:CreateTags', 'ec2:DeleteTags', 'autoscaling:CreateOrUpdateTags', 'autoscaling:DeleteTags', 'ecs:TagResource', 'ecs:UntagResource', 'rds:AddTagsToResource', 'rds:RemoveTagsFromResource',
  ],
};

const covers = (pattern, action) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(action);

// The actions of a policy document of iam.tf (its dynamic statements included).
async function terraformActions(name) {
  const text = await readFile(IAM_TF, 'utf8');
  const start = text.indexOf(`data "aws_iam_policy_document" "${name}" {`);
  assert.ok(start >= 0, name);
  let depth = 0;
  let end = text.indexOf('{', start);
  do {
    if (text[end] === '{') depth += 1;
    if (text[end] === '}') depth -= 1;
    end += 1;
  } while (depth > 0);
  return [...text.slice(start, end).matchAll(/actions\s*=\s*\[([^\]]*)\]/g)].flatMap((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((a) => a[1]));
}

for (const [role, calls] of Object.entries(CALLS)) {
  test(`every call of a standalone workload by the ${role} is allowed: iam.tf, an installed router's role and the boundary`, async () => {
    const terraform = await terraformActions(role);
    const installed = blueprint({ version: '0.42.0' }).roles.find((r) => r.key === role).policy.Statement.flatMap((s) => [].concat(s.Action));
    const boundary = routerBoundary().Statement.flatMap((s) => [].concat(s.Action));
    for (const call of calls) {
      assert.ok(terraform.some((p) => covers(p, call)), `${role} in iam.tf: ${call}`);
      assert.ok(installed.some((p) => covers(p, call)), `${role} in the blueprint: ${call}`);
      assert.ok(boundary.some((p) => covers(p, call)), `the boundary: ${call}`);
    }
  });
}

test('the onboarder writes no other tag key on a standalone resource than those its tag statement allows', async () => {
  const text = await readFile(IAM_TF, 'utf8');
  assert.match(text, /onboarder_tag_keys = \["dormeto:workload", "dormeto:tagged", "dormeto:router", "dormeto:shadows"\]/);
  const statement = text.slice(text.indexOf('# Backends: the workload tag and the onboarder marker only.'));
  for (const arn of ['instance/\\*', 'autoScalingGroup:\\*:autoScalingGroupName/\\*', 'service/\\*/\\*', 'db:\\*', 'cluster:\\*']) assert.match(statement.slice(0, 900), new RegExp(arn), arn);
});
