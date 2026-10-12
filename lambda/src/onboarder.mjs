import { createAutoScaling } from './aws/autoscaling.mjs';
import { createDynamo } from './aws/dynamo.mjs';
import { createEc2 } from './aws/ec2.mjs';
import { createEcs } from './aws/ecs.mjs';
import { createElbv2 } from './aws/elbv2.mjs';
import { createLambda } from './aws/lambda.mjs';
import { createRds } from './aws/rds.mjs';
import { createOnboarding } from './lib/onboarding.mjs';
import { logger } from './lib/log.mjs';
import { createStore } from './lib/state.mjs';

// Onboarding of workloads, invoked synchronously by the manager (its own role: it changes customer rules and tags).
const onboarding = createOnboarding({
  elbv2: createElbv2(),
  ec2: createEc2(),
  autoscaling: createAutoScaling(),
  ecs: createEcs(),
  rds: createRds(),
  lambda: createLambda(),
  store: createStore({ dynamo: createDynamo(), table: process.env.DMT_TABLE }),
  router: {
    name: (process.env.DMT_TG_PREFIX ?? '').replace(/-$/, ''),
    wakerFunctionName: process.env.DMT_WAKER_FUNCTION,
    wakerFunctionArn: process.env.DMT_WAKER_FUNCTION_ARN,
  },
  log: logger,
});

export async function handler(event) {
  // CloudTrail events forwarded by the router's EventBridge rule (drift of what onboarding added).
  if (event?.['detail-type'] === 'AWS API Call via CloudTrail') return onboarding.repairAll({ by: `event:${event.detail?.eventName ?? 'unknown'}` });
  switch (event?.action) {
    case 'preview': return onboarding.preview(event);
    case 'onboard': return onboarding.onboard(event);
    case 'offboard': return onboarding.offboard(event);
    case 'repair': return onboarding.repair(event);
    default: throw new Error(`unknown action: ${event?.action}`);
  }
}
