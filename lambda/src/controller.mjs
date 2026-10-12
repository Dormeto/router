import { createAppScaling } from './aws/appscaling.mjs';
import { createAutoScaling } from './aws/autoscaling.mjs';
import { createCloudWatch } from './aws/cloudwatch.mjs';
import { createDynamo } from './aws/dynamo.mjs';
import { createEc2 } from './aws/ec2.mjs';
import { createEcs } from './aws/ecs.mjs';
import { createLambda } from './aws/lambda.mjs';
import { createElbv2 } from './aws/elbv2.mjs';
import { createTagging } from './aws/tagging.mjs';
import { createController } from './lib/controller-core.mjs';
import { logger } from './lib/log.mjs';
import { createStore } from './lib/state.mjs';
import { sleep } from './lib/time.mjs';

const lambda = createLambda();

export const handler = createController({
  store: createStore({ dynamo: createDynamo(), table: process.env.DMT_TABLE }),
  ec2: createEc2(),
  elbv2: createElbv2(),
  cloudwatch: createCloudWatch(),
  autoscaling: createAutoScaling(),
  ecs: createEcs(),
  tagging: createTagging(),
  appscaling: createAppScaling(),
  // Lambda sets AWS_LAMBDA_FUNCTION_NAME: the controller fans naps out to itself.
  invokeSelf: (payload) => lambda.invokeAsync(process.env.AWS_LAMBDA_FUNCTION_NAME, payload),
  sleep,
  log: logger,
});
