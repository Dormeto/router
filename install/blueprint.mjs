// Router blueprint (vision docs/specs/2026-10-05-onboarding-design.md, R4b): every resource of a router installed by the
// manager with AWS API calls, and their IAM policies, as plain data. `npm run package` publishes it per router version with
// placeholders (${name}, ${region}, ${account}, ${partition}, ${build} and the settings) that the installer fills. The
// Terraform module (terraform/modules/router) stays the definition for development; test/blueprint.test.mjs keeps the
// two IAM definitions equal.

export const PLACEHOLDERS = {
  name: '${name}', region: '${region}', account: '${account}', partition: '${partition}', build: '${build}',
  checkSchedule: '${checkSchedule}', ipLists: '${ipLists}', noWakeRules: '${noWakeRules}', metrics: '${metrics}',
};

const lambdaTrust = { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }] };

export function blueprint({ version, p = PLACEHOLDERS, logRetentionDays = 14, wakerTimeoutSeconds = 70, wakerMemoryMb = 512 }) {
  const arn = (service, resource, region = p.region) => `arn:${p.partition}:${service}:${region}:${p.account}:${resource}`;
  const fn = (role) => `${p.name}-${role}`;
  const table = `${p.name}-router`;
  const tableArn = arn('dynamodb', `table/${table}`);
  const queue = (key) => `${p.name}-${key}`;
  const queueArn = (key) => arn('sqs', queue(key));
  const queueUrl = (key) => `https://sqs.${p.region}.amazonaws.com/${p.account}/${queue(key)}`;
  const functionArn = (role) => arn('lambda', `function:${fn(role)}`);
  const logGroup = (role) => `/aws/lambda/${fn(role)}`;
  const logArn = (role) => `${arn('logs', `log-group:${logGroup(role)}`)}:*`;
  const tagged = { Null: { 'aws:ResourceTag/dormeto:workload': 'false' } };
  const onboarderTagKeys = { 'ForAllValues:StringEquals': { 'aws:TagKeys': ['dormeto:workload', 'dormeto:tagged', 'dormeto:router'] } };
  const allow = (Action, Resource, Condition) => ({ Effect: 'Allow', Action, Resource, ...(Condition ? { Condition } : {}) });
  const policy = (...Statement) => ({ Version: '2012-10-17', Statement });
  const tags = { 'dormeto:router': p.name };
  const roleName = (role) => `${p.name}-${p.region}-${role}`;

  const policies = {
    controller: policy(
      allow(['dynamodb:GetItem', 'dynamodb:UpdateItem', 'dynamodb:Scan', 'dynamodb:Query', 'dynamodb:DeleteItem'], [tableArn]),
      allow(['ec2:DescribeInstances', 'elasticloadbalancing:DescribeRules', 'elasticloadbalancing:DescribeTargetHealth', 'elasticloadbalancing:DescribeTargetGroups', 'elasticloadbalancing:DescribeListeners', 'elasticloadbalancing:DescribeTags', 'cloudwatch:GetMetricData', 'lambda:GetAccountSettings'], ['*']),
      allow(['ec2:StartInstances', 'ec2:StopInstances'], [arn('ec2', 'instance/*')], tagged),
      allow(['elasticloadbalancing:ModifyRule'], [arn('elasticloadbalancing', 'listener-rule/app/*')], tagged),
      allow(['autoscaling:DescribeAutoScalingGroups', 'tag:GetResources', 'ecs:DescribeServices', 'application-autoscaling:DescribeScalableTargets', 'rds:DescribeDBInstances', 'rds:DescribeDBClusters'], ['*']),
      allow(['rds:StartDBInstance', 'rds:StopDBInstance', 'rds:StartDBCluster', 'rds:StopDBCluster'], [arn('rds', 'db:*'), arn('rds', 'cluster:*')], tagged),
      allow(['ecs:UpdateService'], [arn('ecs', 'service/*/*')], tagged),
      allow(['application-autoscaling:RegisterScalableTarget'], [arn('application-autoscaling', 'scalable-target/*')]),
      allow(['autoscaling:UpdateAutoScalingGroup', 'autoscaling:SuspendProcesses', 'autoscaling:ResumeProcesses'], [arn('autoscaling', 'autoScalingGroup:*:autoScalingGroupName/*')], tagged),
      allow(['lambda:InvokeFunction'], [functionArn('controller')]),
      allow(['sqs:SendMessage'], [queueArn('controller-failures')]),
      allow(['sqs:GetQueueAttributes'], [queueArn('controller-failures'), queueArn('check-failures')]),
      allow(['logs:CreateLogStream', 'logs:PutLogEvents'], [logArn('controller')]),
    ),
    waker: policy(
      allow(['dynamodb:GetItem', 'dynamodb:UpdateItem', 'dynamodb:Query'], [tableArn]),
      allow(['lambda:InvokeFunction'], [functionArn('controller')]),
      allow(['logs:CreateLogStream', 'logs:PutLogEvents'], [logArn('waker')]),
    ),
    scheduler: policy(
      allow(['lambda:InvokeFunction'], [functionArn('controller')]),
      allow(['sqs:SendMessage'], [queueArn('check-failures')]),
    ),
    onboarder: policy(
      allow(['dynamodb:GetItem', 'dynamodb:UpdateItem', 'dynamodb:Query', 'dynamodb:Scan', 'dynamodb:DeleteItem'], [tableArn]),
      allow(['elasticloadbalancing:DescribeTargetGroups', 'elasticloadbalancing:DescribeListeners', 'elasticloadbalancing:DescribeRules', 'elasticloadbalancing:DescribeTags', 'elasticloadbalancing:DescribeTargetHealth', 'ec2:DescribeInstances', 'autoscaling:DescribeAutoScalingGroups', 'ecs:ListClusters', 'ecs:ListServices', 'ecs:DescribeServices', 'rds:DescribeDBInstances', 'rds:DescribeDBClusters'], ['*']),
      allow(['elasticloadbalancing:CreateTargetGroup', 'elasticloadbalancing:ModifyTargetGroupAttributes', 'elasticloadbalancing:DeleteTargetGroup', 'elasticloadbalancing:RegisterTargets', 'elasticloadbalancing:DeregisterTargets'], [arn('elasticloadbalancing', `targetgroup/${p.name}-*/*`)]),
      allow(['elasticloadbalancing:ModifyRule'], [arn('elasticloadbalancing', 'listener-rule/app/*')]),
      allow(['elasticloadbalancing:AddTags', 'elasticloadbalancing:RemoveTags'], [arn('elasticloadbalancing', 'listener-rule/app/*'), arn('elasticloadbalancing', `targetgroup/${p.name}-*/*`)], onboarderTagKeys),
      allow(['ec2:CreateTags', 'ec2:DeleteTags', 'autoscaling:CreateOrUpdateTags', 'autoscaling:DeleteTags', 'ecs:TagResource', 'ecs:UntagResource', 'rds:AddTagsToResource', 'rds:RemoveTagsFromResource'], [
        arn('ec2', 'instance/*'), arn('autoscaling', 'autoScalingGroup:*:autoScalingGroupName/*'), arn('ecs', 'service/*/*'), arn('rds', 'db:*'), arn('rds', 'cluster:*'),
      ], onboarderTagKeys),
      allow(['lambda:AddPermission', 'lambda:RemovePermission'], [functionArn('waker')]),
      allow(['logs:CreateLogStream', 'logs:PutLogEvents'], [logArn('onboarder')]),
    ),
  };

  const schedulerTrust = {
    Version: '2012-10-17',
    Statement: [{
      Effect: 'Allow', Principal: { Service: 'scheduler.amazonaws.com' }, Action: 'sts:AssumeRole',
      // EventBridge Scheduler presents its schedule group as the source, not the schedule (2026-10-03 outage).
      Condition: { StringEquals: { 'aws:SourceAccount': p.account }, ArnEquals: { 'aws:SourceArn': arn('scheduler', 'schedule-group/default') } },
    }],
  };

  const common = { DMT_TABLE: table, DMT_TG_PREFIX: `${p.name}-`, DMT_VERSION: version, DMT_BUILD: p.build };
  return {
    router: { name: p.name, region: p.region, account: p.account, version, build: p.build },
    tags,
    roles: ['controller', 'waker', 'scheduler', 'onboarder'].map((role) => ({
      key: role, name: roleName(role), trust: role === 'scheduler' ? schedulerTrust : lambdaTrust, policyName: role, policy: policies[role],
    })),
    table: { name: table, hashKey: 'pk', rangeKey: 'sk', ttlAttribute: 'expiresAt', pointInTimeRecovery: true },
    queues: ['check-failures', 'controller-failures'].map((key) => ({ key, name: queue(key), retentionSeconds: 1_209_600, managedEncryption: true })),
    logGroups: ['controller', 'waker', 'onboarder'].map((role) => ({ name: logGroup(role), retentionDays: logRetentionDays })),
    functions: [
      {
        key: 'controller', name: fn('controller'), role: roleName('controller'), handler: 'controller.handler', timeout: 900, memory: 256,
        environment: {
          ...common, DMT_IP_LISTS: p.ipLists, DMT_NO_WAKE_RULES: p.noWakeRules, DMT_CHECK_SCHEDULE: p.checkSchedule, DMT_METRICS: p.metrics,
          DMT_WAKER_FUNCTION: fn('waker'), DMT_FAILURE_QUEUES: `{"check":"${queueUrl('check-failures')}","controller":"${queueUrl('controller-failures')}"}`,
        },
        // Retries would duplicate wakes and naps; stale events are dropped; failures land in a queue.
        asyncInvoke: { maximumRetryAttempts: 0, maximumEventAgeInSeconds: 120, onFailure: queueArn('controller-failures') },
      },
      {
        key: 'waker', name: fn('waker'), role: roleName('waker'), handler: 'waker.handler', timeout: wakerTimeoutSeconds, memory: wakerMemoryMb,
        environment: { ...common, DMT_CONTROLLER: fn('controller'), DMT_NO_WAKE_RULES: p.noWakeRules, DMT_METRICS: p.metrics, DMT_IP_LISTS: p.ipLists },
      },
      {
        key: 'onboarder', name: fn('onboarder'), role: roleName('onboarder'), handler: 'onboarder.handler', timeout: 300, memory: 256,
        environment: { ...common, DMT_WAKER_FUNCTION: fn('waker'), DMT_WAKER_FUNCTION_ARN: functionArn('waker') },
      },
    ].map((f) => ({ ...f, roleArn: `arn:${p.partition}:iam::${p.account}:role/${f.role}`, runtime: 'nodejs24.x', architectures: ['arm64'] })),
    schedule: {
      name: `${p.name}-check`, expression: p.checkSchedule, target: functionArn('controller'), roleArn: `arn:${p.partition}:iam::${p.account}:role/${roleName('scheduler')}`,
      input: '{"action":"check","source":"schedule"}', deadLetter: queueArn('check-failures'), maximumRetryAttempts: 0,
    },
  };
}

// Permissions boundary of every role the manager creates in an account (DmtRouterBoundary): the services and actions a
// router may ever use, on Dormeto resources where they can be scoped; no IAM, Organizations or data access beyond them.
export function routerBoundary({ p = PLACEHOLDERS } = {}) {
  const any = (service, resource) => `arn:${p.partition}:${service}:*:${p.account}:${resource}`;
  return {
    Version: '2012-10-17',
    Statement: [
      { Sid: 'RouterTables', Effect: 'Allow', Action: 'dynamodb:*', Resource: any('dynamodb', 'table/dmt-*') },
      { Sid: 'RouterQueues', Effect: 'Allow', Action: 'sqs:*', Resource: any('sqs', 'dmt-*') },
      { Sid: 'RouterFunctions', Effect: 'Allow', Action: ['lambda:InvokeFunction', 'lambda:AddPermission', 'lambda:RemovePermission'], Resource: any('lambda', 'function:dmt-*') },
      { Sid: 'RouterLogs', Effect: 'Allow', Action: ['logs:CreateLogStream', 'logs:PutLogEvents'], Resource: any('logs', 'log-group:/aws/lambda/dmt-*') },
      {
        Sid: 'Workloads', Effect: 'Allow',
        Action: [
          'elasticloadbalancing:Describe*', 'elasticloadbalancing:ModifyRule', 'elasticloadbalancing:CreateTargetGroup', 'elasticloadbalancing:ModifyTargetGroupAttributes',
          'elasticloadbalancing:DeleteTargetGroup', 'elasticloadbalancing:RegisterTargets', 'elasticloadbalancing:DeregisterTargets', 'elasticloadbalancing:AddTags', 'elasticloadbalancing:RemoveTags',
          'ec2:DescribeInstances', 'ec2:StartInstances', 'ec2:StopInstances', 'ec2:CreateTags', 'ec2:DeleteTags',
          'autoscaling:Describe*', 'autoscaling:UpdateAutoScalingGroup', 'autoscaling:SuspendProcesses', 'autoscaling:ResumeProcesses', 'autoscaling:CreateOrUpdateTags', 'autoscaling:DeleteTags',
          'ecs:ListClusters', 'ecs:ListServices', 'ecs:DescribeServices', 'ecs:UpdateService', 'ecs:TagResource', 'ecs:UntagResource',
          'application-autoscaling:DescribeScalableTargets', 'application-autoscaling:RegisterScalableTarget',
          'rds:Describe*', 'rds:StartDBInstance', 'rds:StopDBInstance', 'rds:StartDBCluster', 'rds:StopDBCluster', 'rds:AddTagsToResource', 'rds:RemoveTagsFromResource',
          'cloudwatch:GetMetricData', 'tag:GetResources', 's3:GetObject', 'lambda:GetAccountSettings',
        ],
        Resource: '*',
      },
    ],
  };
}
