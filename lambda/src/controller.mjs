import { createAutoScaling } from './aws/autoscaling.mjs';
import { createCloudWatch } from './aws/cloudwatch.mjs';
import { createDynamo } from './aws/dynamo.mjs';
import { createEc2 } from './aws/ec2.mjs';
import { createElbv2 } from './aws/elbv2.mjs';
import { createController } from './lib/controller-core.mjs';
import { logger } from './lib/log.mjs';
import { createStore } from './lib/state.mjs';
import { sleep } from './lib/time.mjs';

export const handler = createController({
  store: createStore({ dynamo: createDynamo(), table: process.env.DMT_TABLE }),
  ec2: createEc2(),
  elbv2: createElbv2(),
  cloudwatch: createCloudWatch(),
  autoscaling: createAutoScaling(),
  sleep,
  log: logger,
});
