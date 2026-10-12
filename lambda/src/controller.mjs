import { createAppScaling } from './aws/appscaling.mjs';
import { createAutoScaling } from './aws/autoscaling.mjs';
import { createCloudWatch } from './aws/cloudwatch.mjs';
import { createDynamo } from './aws/dynamo.mjs';
import { createEc2 } from './aws/ec2.mjs';
import { createEcs } from './aws/ecs.mjs';
import { createLambda } from './aws/lambda.mjs';
import { createRds } from './aws/rds.mjs';
import { createS3 } from './aws/s3.mjs';
import { createSqs } from './aws/sqs.mjs';
import { createElbv2 } from './aws/elbv2.mjs';
import { createEvents } from './aws/events.mjs';
import { createTagging } from './aws/tagging.mjs';
import { createController } from './lib/controller-core.mjs';
import { createPublisher, withTransitionEvents } from './lib/events.mjs';
import { createListRefresher, downloadText, parseS3Url } from './lib/list-refresh.mjs';
import { parseLists } from './lib/list-cache.mjs';
import { parseRules } from './lib/no-wake.mjs';
import { logger } from './lib/log.mjs';
import { createStore } from './lib/state.mjs';
import { sleep } from './lib/time.mjs';

const lambda = createLambda();
const routerName = (process.env.DMT_TG_PREFIX ?? '').replace(/-$/, '');
// The router's state and state changes to the manager's event bus (scale design §3), when the router has one.
const publisher = createPublisher({
  events: createEvents(), busArn: process.env.DMT_MANAGER_BUS, log: logger,
  router: { region: process.env.AWS_REGION, name: routerName, version: process.env.DMT_VERSION, build: process.env.DMT_BUILD, checkSchedule: process.env.DMT_CHECK_SCHEDULE },
});
const store = withTransitionEvents(createStore({ dynamo: createDynamo(), table: process.env.DMT_TABLE }), publisher, { log: logger });
// IP reputation lists of the router (Terraform ip_lists).
const lists = parseLists(process.env.DMT_IP_LISTS, (error) => logger.error('IpListsUnreadable', { error }));
// Lists given as s3:// URIs are read with the S3 API (controller role: s3:GetObject on their objects).
const s3 = lists.some((l) => parseS3Url(l.url)) ? createS3() : null;
const download = (url) => downloadText(url, { getObject: s3?.getObject });
// Failure queues of the router (router health): { check, controller } queue URLs.
const queues = JSON.parse(process.env.DMT_FAILURE_QUEUES || '{}');
// The work queue (routers 0.22.0 and later): naps and the wakes of a router pause, read 10 at a time.
const workQueue = process.env.DMT_WORK_QUEUE;
const driftQueue = process.env.DMT_DRIFT_QUEUE;
const sqs = Object.values(queues).some(Boolean) || workQueue || driftQueue ? createSqs() : null;

export const handler = createController({
  store,
  ec2: createEc2(),
  elbv2: createElbv2(),
  cloudwatch: createCloudWatch(),
  autoscaling: createAutoScaling(),
  ecs: createEcs(),
  tagging: createTagging(),
  appscaling: createAppScaling(),
  rds: createRds(),
  // Lambda sets AWS_LAMBDA_FUNCTION_NAME: the controller fans naps out to itself.
  invokeSelf: (payload) => lambda.invokeAsync(process.env.AWS_LAMBDA_FUNCTION_NAME, payload),
  sleep,
  log: logger,
  sqs,
  queueWork: workQueue ? (message) => sqs.sendMessage({ QueueUrl: workQueue, MessageBody: JSON.stringify(message) }) : null,
  queueRepair: driftQueue ? (message) => sqs.sendMessage({ QueueUrl: driftQueue, MessageBody: JSON.stringify(message) }) : null,
  lambda,
  publisher,
  // Drift repair of the workloads the manager onboarded (R4c).
  invokeOnboarder: process.env.DMT_ONBOARDER ? (payload) => lambda.invokeAsync(process.env.DMT_ONBOARDER, payload) : null,
  lists: lists.length ? createListRefresher({ store, lists, download, log: logger }) : null,
  // Manager interface: router identity, router no-wake rules and IP lists in the status, health and configuration.
  router: {
    name: routerName, version: process.env.DMT_VERSION, build: process.env.DMT_BUILD,
    checkSchedule: process.env.DMT_CHECK_SCHEDULE,
    metrics: process.env.DMT_METRICS === undefined ? null : process.env.DMT_METRICS === 'true',
    functions: { controller: process.env.AWS_LAMBDA_FUNCTION_NAME, waker: process.env.DMT_WAKER_FUNCTION },
    queues,
  },
  defaultRules: parseRules(process.env.DMT_NO_WAKE_RULES, (error) => logger.error('NoWakeRulesUnreadable', { error })),
  ipLists: lists,
});
