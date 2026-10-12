import { createDynamo } from './aws/dynamo.mjs';
import { createLambda } from './aws/lambda.mjs';
import { logger } from './lib/log.mjs';
import { createStore } from './lib/state.mjs';
import { sleep } from './lib/time.mjs';
import { createWaker } from './lib/waker-core.mjs';

const lambda = createLambda();

export const handler = createWaker({
  store: createStore({ dynamo: createDynamo(), table: process.env.DMT_TABLE }),
  invokeController: (payload) => lambda.invokeAsync(process.env.DMT_CONTROLLER, payload),
  prefix: process.env.DMT_TG_PREFIX,
  sleep,
  log: logger,
});
