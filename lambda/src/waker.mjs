import { createDynamo } from './aws/dynamo.mjs';
import { createLambda } from './aws/lambda.mjs';
import { logger } from './lib/log.mjs';
import { memoizeAsync } from './lib/memo.mjs';
import { createStore } from './lib/state.mjs';
import { sleep } from './lib/time.mjs';
import { createWaker } from './lib/waker-core.mjs';

const lambda = createLambda();
const invokeController = (payload) => lambda.invokeAsync(process.env.DMT_CONTROLLER, payload);

// The admin dashboard is a cold path: its SDK clients load on the first admin request only.
const getAdmin = memoizeAsync(() => Promise.all([
  import('./lib/admin.mjs'),
  import('./aws/ec2.mjs'),
  import('./aws/elbv2.mjs'),
  import('./aws/cloudwatch.mjs'),
  import('./aws/autoscaling.mjs'),
  import('./aws/ecs.mjs'),
  import('./aws/tagging.mjs'),
  import('./aws/appscaling.mjs'),
]).then(([{ createAdmin }, { createEc2 }, { createElbv2 }, { createCloudWatch }, { createAutoScaling }, { createEcs }, { createTagging },
  { createAppScaling }]) => createAdmin({
  ec2: createEc2(),
  elbv2: createElbv2(),
  cloudwatch: createCloudWatch(),
  autoscaling: createAutoScaling(),
  ecs: createEcs(),
  tagging: createTagging(),
  appscaling: createAppScaling(),
  invokeController,
  log: logger,
  version: { version: process.env.DMT_VERSION, build: process.env.DMT_BUILD },
})));

export const handler = createWaker({
  store: createStore({ dynamo: createDynamo(), table: process.env.DMT_TABLE }),
  invokeController,
  prefix: process.env.DMT_TG_PREFIX,
  sleep,
  log: logger,
  getAdmin,
});
