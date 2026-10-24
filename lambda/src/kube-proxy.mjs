// The Kubernetes proxy function of a private EKS cluster (one per cluster, in its VPC): see lib/kube-proxy-core.mjs.
import { createLogger } from './lib/log.mjs';
import { createKubeProxy } from './lib/kube-proxy-core.mjs';

const logger = createLogger();
const proxy = createKubeProxy({ env: process.env, log: (event, fields) => logger.info(event, fields) });

export const handler = (event) => proxy(event);
