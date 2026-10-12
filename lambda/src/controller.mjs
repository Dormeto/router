import { createAppScaling } from './aws/appscaling.mjs';
import { createAutoScaling } from './aws/autoscaling.mjs';
import { createCloudWatch } from './aws/cloudwatch.mjs';
import { createDynamo } from './aws/dynamo.mjs';
import { createEc2 } from './aws/ec2.mjs';
import { createEcs } from './aws/ecs.mjs';
import { createLambda } from './aws/lambda.mjs';
import { createRds } from './aws/rds.mjs';
import { createS3 } from './aws/s3.mjs';
import { createElbv2 } from './aws/elbv2.mjs';
import { createTagging } from './aws/tagging.mjs';
import { createController } from './lib/controller-core.mjs';
import { createListRefresher, downloadText, parseS3Url } from './lib/list-refresh.mjs';
import { parseLists } from './lib/list-cache.mjs';
import { parseRules } from './lib/no-wake.mjs';
import { logger } from './lib/log.mjs';
import { createStore } from './lib/state.mjs';
import { sleep } from './lib/time.mjs';

const lambda = createLambda();
const store = createStore({ dynamo: createDynamo(), table: process.env.DMT_TABLE });
// IP reputation lists of the router (Terraform ip_lists).
const lists = parseLists(process.env.DMT_IP_LISTS, (error) => logger.error('IpListsUnreadable', { error }));
// Lists given as s3:// URIs are read with the S3 API (controller role: s3:GetObject on their objects).
const s3 = lists.some((l) => parseS3Url(l.url)) ? createS3() : null;
const download = (url) => downloadText(url, { getObject: s3?.getObject });

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
  lists: lists.length ? createListRefresher({ store, lists, download, log: logger }) : null,
  // Manager interface: router identity, router no-wake rules and IP lists in the status.
  router: {
    name: (process.env.DMT_TG_PREFIX ?? '').replace(/-$/, ''), version: process.env.DMT_VERSION, build: process.env.DMT_BUILD,
    checkSchedule: process.env.DMT_CHECK_SCHEDULE,
  },
  defaultRules: parseRules(process.env.DMT_NO_WAKE_RULES, (error) => logger.error('NoWakeRulesUnreadable', { error })),
  ipLists: lists,
});
