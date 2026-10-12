// Router blueprint (vision docs/specs/2026-10-05-onboarding-design.md, R4b): every resource of a router installed by the
// manager with AWS API calls, and their IAM policies, as plain data. `npm run package` publishes it per router version with
// placeholders (${name}, ${region}, ${account}, ${partition}, ${build} and the settings) that the installer fills. The
// Terraform module (terraform/modules/router) stays the definition for development; test/blueprint.test.mjs keeps the
// two IAM definitions equal.

import driftPattern from './drift-pattern.json' with { type: 'json' };
import forwardPattern from './forward-pattern.json' with { type: 'json' };

export const PLACEHOLDERS = {
  name: '${name}', region: '${region}', account: '${account}', partition: '${partition}', build: '${build}',
  checkSchedule: '${checkSchedule}', ipLists: '${ipLists}', noWakeRules: '${noWakeRules}', metrics: '${metrics}',
  // The manager's event bus (scale design §3): routers send their state and state changes to it.
  managerBus: '${managerBus}',
  // The command role's name (without its path): the forwarder ignores the manager's own calls (packaging design §5).
  commandRole: '${commandRole}',
};

// Installed routers are named dmtr-<env> and their roles live under this path: DmtCommandRole and DmtRouterBoundary are
// scoped to them, so they never reach a router written in Terraform (dmt-<env>) or the manager (dmt-<env>-manager).
export const ROLE_PATH = '/dormeto/router/';

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
  const onboarderTagKeys = { 'ForAllValues:StringEquals': { 'aws:TagKeys': ['dormeto:workload', 'dormeto:tagged', 'dormeto:router', 'dormeto:shadows'] } };
  const allow = (Action, Resource, Condition) => ({ Effect: 'Allow', Action, Resource, ...(Condition ? { Condition } : {}) });
  const policy = (...Statement) => ({ Version: '2012-10-17', Statement });
  const tags = { 'dormeto:router': p.name };
  const roleName = (role) => `${p.name}-${p.region}-${role}`;
  const roleArn = (role) => `arn:${p.partition}:iam::${p.account}:role${ROLE_PATH}${roleName(role)}`;

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
      allow(['lambda:InvokeFunction'], [functionArn('controller'), functionArn('onboarder')]),
      allow(['sqs:SendMessage'], [queueArn('controller-failures'), queueArn('work'), queueArn('drift')]),
      allow(['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes', 'sqs:ChangeMessageVisibility'], [queueArn('work')]),
      allow(['sqs:GetQueueAttributes'], [queueArn('controller-failures'), queueArn('check-failures')]),
      allow(['events:PutEvents'], [p.managerBus]),
      allow(['logs:CreateLogStream', 'logs:PutLogEvents'], [logArn('controller')]),
    ),
    waker: policy(
      allow(['dynamodb:GetItem', 'dynamodb:UpdateItem', 'dynamodb:Query'], [tableArn]),
      allow(['lambda:InvokeFunction'], [functionArn('controller')]),
      allow(['events:PutEvents'], [p.managerBus]),
      allow(['logs:CreateLogStream', 'logs:PutLogEvents'], [logArn('waker')]),
    ),
    scheduler: policy(
      allow(['lambda:InvokeFunction'], [functionArn('controller')]),
      allow(['sqs:SendMessage'], [queueArn('check-failures')]),
    ),
    onboarder: policy(
      allow(['dynamodb:GetItem', 'dynamodb:UpdateItem', 'dynamodb:Query', 'dynamodb:Scan', 'dynamodb:DeleteItem'], [tableArn]),
      allow(['elasticloadbalancing:DescribeTargetGroups', 'elasticloadbalancing:DescribeListeners', 'elasticloadbalancing:DescribeRules', 'elasticloadbalancing:DescribeTags', 'elasticloadbalancing:DescribeTargetHealth', 'elasticloadbalancing:DescribeAccountLimits', 'ec2:DescribeInstances', 'autoscaling:DescribeAutoScalingGroups', 'ecs:ListClusters', 'ecs:ListServices', 'ecs:DescribeServices', 'rds:DescribeDBInstances', 'rds:DescribeDBClusters'], ['*']),
      allow(['elasticloadbalancing:CreateTargetGroup', 'elasticloadbalancing:ModifyTargetGroupAttributes', 'elasticloadbalancing:DeleteTargetGroup', 'elasticloadbalancing:RegisterTargets', 'elasticloadbalancing:DeregisterTargets'], [arn('elasticloadbalancing', `targetgroup/${p.name}-*/*`)]),
      allow(['elasticloadbalancing:ModifyRule'], [arn('elasticloadbalancing', 'listener-rule/app/*')]),
      allow(['elasticloadbalancing:CreateRule'], [arn('elasticloadbalancing', 'listener/app/*'), arn('elasticloadbalancing', 'listener-rule/app/*')]),
      allow(['elasticloadbalancing:DeleteRule', 'elasticloadbalancing:SetRulePriorities'], [arn('elasticloadbalancing', 'listener-rule/app/*')], tagged),
      allow(['elasticloadbalancing:AddTags', 'elasticloadbalancing:RemoveTags'], [arn('elasticloadbalancing', 'listener-rule/app/*'), arn('elasticloadbalancing', `targetgroup/${p.name}-*/*`)], onboarderTagKeys),
      allow(['ec2:CreateTags', 'ec2:DeleteTags', 'autoscaling:CreateOrUpdateTags', 'autoscaling:DeleteTags', 'ecs:TagResource', 'ecs:UntagResource', 'rds:AddTagsToResource', 'rds:RemoveTagsFromResource'], [
        arn('ec2', 'instance/*'), arn('autoscaling', 'autoScalingGroup:*:autoScalingGroupName/*'), arn('ecs', 'service/*/*'), arn('rds', 'db:*'), arn('rds', 'cluster:*'),
      ], onboarderTagKeys),
      // A per-workload invoke permission of a router older than 0.20.0, removed at offboarding.
      allow(['lambda:RemovePermission'], [functionArn('waker')]),
      allow(['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes', 'sqs:ChangeMessageVisibility'], [queueArn('drift')]),
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
      key: role, path: ROLE_PATH, name: roleName(role), trust: role === 'scheduler' ? schedulerTrust : lambdaTrust, policyName: role, policy: policies[role],
    })),
    table: { name: table, hashKey: 'pk', rangeKey: 'sk', ttlAttribute: 'expiresAt', pointInTimeRecovery: true },
    queues: [
      ...['check-failures', 'controller-failures'].map((key) => ({ key, name: queue(key), retentionSeconds: 1_209_600, managedEncryption: true })),
      // The work queue (scale design §6): naps and the wakes of a router pause, read by the controller 10 at a time; a nap
      // is refused after 10 minutes anyway, a wake is kept 4 days (a router pause's wakes wait their turn however many);
      // visible again after the controller's 15 minutes.
      { key: 'work', name: queue('work'), retentionSeconds: 345_600, managedEncryption: true, visibilityTimeoutSeconds: 960, deadLetter: { queue: queueArn('controller-failures'), maxReceiveCount: 3 } },
      // Drift events of the router's rule, read by the onboarder in batches.
      {
        key: 'drift', name: queue('drift'), retentionSeconds: 86_400, managedEncryption: true, visibilityTimeoutSeconds: 360, deadLetter: { queue: queueArn('controller-failures'), maxReceiveCount: 3 },
        policy: policy({ Effect: 'Allow', Principal: { Service: 'events.amazonaws.com' }, Action: 'sqs:SendMessage', Resource: queueArn('drift'), Condition: { ArnEquals: { 'aws:SourceArn': arn('events', `rule/${p.name}-drift`) } } }),
      },
    ],
    logGroups: ['controller', 'waker', 'onboarder'].map((role) => ({ name: logGroup(role), retentionDays: logRetentionDays })),
    functions: [
      {
        key: 'controller', name: fn('controller'), role: roleName('controller'), handler: 'controller.handler', timeout: 900, memory: 256,
        environment: {
          ...common, DMT_IP_LISTS: p.ipLists, DMT_NO_WAKE_RULES: p.noWakeRules, DMT_CHECK_SCHEDULE: p.checkSchedule, DMT_METRICS: p.metrics,
          DMT_WAKER_FUNCTION: fn('waker'), DMT_FAILURE_QUEUES: `{"check":"${queueUrl('check-failures')}","controller":"${queueUrl('controller-failures')}"}`,
          DMT_ONBOARDER: fn('onboarder'), DMT_MANAGER_BUS: p.managerBus, DMT_WORK_QUEUE: queueUrl('work'), DMT_DRIFT_QUEUE: queueUrl('drift'),
        },
        // Retries would duplicate wakes and naps; stale events are dropped; failures land in a queue.
        asyncInvoke: { maximumRetryAttempts: 0, maximumEventAgeInSeconds: 120, onFailure: queueArn('controller-failures') },
      },
      {
        key: 'waker', name: fn('waker'), role: roleName('waker'), handler: 'waker.handler', timeout: wakerTimeoutSeconds, memory: wakerMemoryMb,
        environment: { ...common, DMT_CONTROLLER: fn('controller'), DMT_NO_WAKE_RULES: p.noWakeRules, DMT_METRICS: p.metrics, DMT_IP_LISTS: p.ipLists, DMT_MANAGER_BUS: p.managerBus },
      },
      {
        key: 'onboarder', name: fn('onboarder'), role: roleName('onboarder'), handler: 'onboarder.handler', timeout: 300, memory: 256,
        environment: { ...common, DMT_WAKER_FUNCTION: fn('waker'), DMT_WAKER_FUNCTION_ARN: functionArn('waker') },
      },
    ].map((f) => ({ ...f, roleArn: roleArn(f.key), runtime: 'nodejs24.x', architectures: ['arm64'] })),
    // The load balancers of the account invoke the waker from the router's waker target groups (<name>-<workload id>):
    // one statement whatever the number of workloads (a function's resource policy is limited to 20 KB).
    wakerPermission: {
      function: fn('waker'), statementId: 'dormeto-alb', principal: 'elasticloadbalancing.amazonaws.com',
      sourceArn: `arn:${p.partition}:elasticloadbalancing:${p.region}:${p.account}:targetgroup/${p.name}-*/*`,
    },
    // Drift repair: CloudTrail events on rules, target groups and workload tags, not caused by the router, to the onboarder
    // through its queue (read in batches).
    eventRule: {
      name: `${p.name}-drift`, pattern: JSON.stringify(driftPattern).replaceAll('${name}', p.name).replaceAll('${partition}', p.partition).replaceAll('${account}', p.account), target: queueArn('drift'),
      description: 'Dormeto: rules, target groups and workload tags changed outside the router',
    },
    // The queues' readers: the controller runs naps and wakes 10 at a time (one each per invocation: minutes long); the
    // onboarder repairs the drift events of 60 seconds at once, 2 batches at a time.
    eventSourceMappings: [
      { key: 'work', function: fn('controller'), queue: queueArn('work'), batchSize: 1, maximumBatchingWindowSeconds: 0, maximumConcurrency: 10, reportBatchItemFailures: true },
      { key: 'drift', function: fn('onboarder'), queue: queueArn('drift'), batchSize: 100, maximumBatchingWindowSeconds: 60, maximumConcurrency: 2, reportBatchItemFailures: true },
    ],
    schedule: {
      name: `${p.name}-check`, expression: p.checkSchedule, target: functionArn('controller'), roleArn: roleArn('scheduler'),
      input: '{"action":"check","source":"schedule"}', deadLetter: queueArn('check-failures'), maximumRetryAttempts: 0,
    },
    // Event-driven discovery refresh (vision docs/specs/2026-10-06-packaging-design.md, section 5), installed per account
    // by the manager's connect operation, apart from the routers: one role of the account (EventBridge needs one to
    // deliver to another account's bus) and one rule per region on the default bus, forwarding the ELB changes discovery
    // reads to the manager's bus.
    forwarder: {
      role: {
        name: `${p.name}-forwarder`, path: ROLE_PATH, tags,
        trust: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'events.amazonaws.com' }, Action: 'sts:AssumeRole', Condition: { StringEquals: { 'aws:SourceAccount': p.account } } }] },
        policy: policy(allow(['events:PutEvents'], [p.managerBus])),
      },
      rule: {
        name: `${p.name}-discovery`,
        pattern: JSON.stringify(forwardPattern).replaceAll('${partition}', p.partition).replaceAll('${account}', p.account).replaceAll('${commandRole}', p.commandRole),
        targetBus: p.managerBus, roleArn: `arn:${p.partition}:iam::${p.account}:role${ROLE_PATH}${p.name}-forwarder`,
        description: 'Dormeto: load balancer changes, to the manager\'s discovery',
      },
    },
  };
}

// Permissions boundary of every role the manager creates in an account (DmtRouterBoundary): the services and actions a
// router may ever use, on the resources of installed routers (dmtr-*) where they can be scoped; no IAM, Organizations or
// data access beyond them.
export function routerBoundary({ p = PLACEHOLDERS } = {}) {
  const any = (service, resource) => `arn:${p.partition}:${service}:*:${p.account}:${resource}`;
  return {
    Version: '2012-10-17',
    Statement: [
      { Sid: 'RouterTables', Effect: 'Allow', Action: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:Query', 'dynamodb:Scan'], Resource: any('dynamodb', 'table/dmtr-*') },
      { Sid: 'RouterQueues', Effect: 'Allow', Action: ['sqs:SendMessage', 'sqs:GetQueueAttributes', 'sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:ChangeMessageVisibility'], Resource: any('sqs', 'dmtr-*') },
      { Sid: 'RouterFunctions', Effect: 'Allow', Action: ['lambda:InvokeFunction'], Resource: any('lambda', 'function:dmtr-*') },
      // Onboarding lets the load balancer invoke the waker.
      { Sid: 'WakerPermissions', Effect: 'Allow', Action: ['lambda:RemovePermission'], Resource: any('lambda', 'function:dmtr-*-waker') },
      { Sid: 'RouterLogs', Effect: 'Allow', Action: ['logs:CreateLogStream', 'logs:PutLogEvents'], Resource: any('logs', 'log-group:/aws/lambda/dmtr-*') },
      // The manager's event bus, in the manager's account (its policy admits the organization only).
      { Sid: 'ManagerBus', Effect: 'Allow', Action: ['events:PutEvents'], Resource: `arn:${p.partition}:events:*:*:event-bus/dmt-*-manager` },
      {
        Sid: 'Workloads', Effect: 'Allow',
        Action: [
          'elasticloadbalancing:Describe*', 'elasticloadbalancing:ModifyRule', 'elasticloadbalancing:CreateTargetGroup', 'elasticloadbalancing:ModifyTargetGroupAttributes',
          'elasticloadbalancing:DeleteTargetGroup', 'elasticloadbalancing:RegisterTargets', 'elasticloadbalancing:DeregisterTargets', 'elasticloadbalancing:AddTags', 'elasticloadbalancing:RemoveTags',
          'elasticloadbalancing:CreateRule', 'elasticloadbalancing:DeleteRule', 'elasticloadbalancing:SetRulePriorities',
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
