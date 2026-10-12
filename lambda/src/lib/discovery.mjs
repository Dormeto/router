// Resolve the standalone EC2 instances of a workload (static list, or discovery from the app target group).
// Kept for the instance-only callers; resolveBackends (backends.mjs) also resolves Auto Scaling groups.
import { WORKLOAD_TAG, resolveBackends } from './backends.mjs';

export { WORKLOAD_TAG };

export async function resolveInstances(ec2, elbv2, cfg) {
  const { mode, backends, ignored } = await resolveBackends({ ec2, elbv2 }, cfg);
  return { mode, managed: backends.map((b) => b.id), ignored };
}
