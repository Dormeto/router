import { createDynamo } from './aws/dynamo.mjs';
import { createCatalog } from './lib/catalog.mjs';
import { createEvents } from './aws/events.mjs';
import { createLambda } from './aws/lambda.mjs';
import { createPublisher, withTransitionEvents } from './lib/events.mjs';
import { createLogger } from './lib/log.mjs';
import { memoizeAsync } from './lib/memo.mjs';
import { parseRules } from './lib/no-wake.mjs';
import { createListCache, parseLists } from './lib/list-cache.mjs';
import { createStore } from './lib/state.mjs';
import { sleep } from './lib/time.mjs';
import { createWaker } from './lib/waker-core.mjs';

// Optional CloudWatch metrics (router metrics_enabled), dimension Router = the router name.
const logger = createLogger({
  metrics: process.env.DMT_METRICS === 'true' ? { router: (process.env.DMT_TG_PREFIX ?? '').replace(/-$/, '') } : null,
});
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
  import('./aws/rds.mjs'),
]).then(([{ createAdmin }, { createEc2 }, { createElbv2 }, { createCloudWatch }, { createAutoScaling }, { createEcs }, { createTagging },
  { createAppScaling }, { createRds }]) => createAdmin({
  ec2: createEc2(),
  elbv2: createElbv2(),
  cloudwatch: createCloudWatch(),
  autoscaling: createAutoScaling(),
  ecs: createEcs(),
  tagging: createTagging(),
  appscaling: createAppScaling(),
  rds: createRds(),
  invokeController,
  log: logger,
  version: { version: process.env.DMT_VERSION, build: process.env.DMT_BUILD },
})));

// Wake starts to the manager's event bus (scale design §3), when the router has one.
const publisher = createPublisher({
  events: createEvents(), busArn: process.env.DMT_MANAGER_BUS, log: logger,
  router: { region: process.env.AWS_REGION, name: (process.env.DMT_TG_PREFIX ?? '').replace(/-$/, ''), version: process.env.DMT_VERSION, build: process.env.DMT_BUILD },
});
const store = withTransitionEvents(createStore({ dynamo: createDynamo(), table: process.env.DMT_TABLE }), publisher, { log: logger });
// IP reputation lists of the router (Terraform ip_lists), downloaded by the controller.
const lists = parseLists(process.env.DMT_IP_LISTS, (error) => logger.error('IpListsUnreadable', { error }));
// The manager's lists (R6b): its catalog, manifests and data, read from its bucket; the router's own lists win on a name.
// The S3 client loads on the first read (a cold start of a router without a catalog never pays for it).
const getS3 = memoizeAsync(() => import('./aws/s3.mjs').then(({ createS3 }) => createS3()));
const catalog = process.env.DMT_IP_LISTS_CATALOG
  ? createCatalog({ s3: { getObjectIf: async (input) => (await getS3()).getObjectIf(input) }, url: process.env.DMT_IP_LISTS_CATALOG, own: lists.map((l) => l.name), log: logger })
  : null;

export const handler = createWaker({
  store,
  invokeController,
  prefix: process.env.DMT_TG_PREFIX,
  sleep,
  log: logger,
  getAdmin,
  // Router defaults for every workload (Terraform router module no_wake_rules).
  defaultRules: parseRules(process.env.DMT_NO_WAKE_RULES, (error) => logger.error('NoWakeRulesUnreadable', { error })),
  listCache: lists.length || catalog ? createListCache({ store, lists, catalog, log: logger }) : null,
});
