// While a wake waits for a healthy target (R7a): the failures AWS reports on its backends, read at most every 30 seconds,
// so that a launch or a placement that cannot happen ends the wake at once instead of at its timeout.
import { classifyText, failureError } from './failures.mjs';
import { ownerPods } from './kubernetes.mjs';

const EVERY_MS = 30_000;
const ACTIVITY_FAILED = new Set(['Failed', 'Cancelled']);
// ECS service events that mean a task will not run (steady states and started tasks are not).
const ECS_FAILURE = /unable to (place|consistently start|start)|insufficient|capacity is unavailable|failed to launch|cannot pull|stopped \d+ running task.*(error|failed)/i;

// Pod Events (vision docs/specs/2026-10-11-kubernetes-design.md, section 7): an image that cannot be pulled or a container
// that keeps crashing will not fix itself; a pod the scheduler cannot place yet waits for a node (Karpenter launches one).
const POD_FAILURE = /ErrImagePull|ImagePullBackOff|Failed to pull image|InvalidImageName|Back-off pulling image|Back-off restarting failed container|CrashLoopBackOff/i;
const POD_WAIT = new Set(['FailedScheduling']);

const time = (value) => (value instanceof Date ? value.getTime() : Date.parse(value ?? 0));
const eventTime = (e) => time(e.lastTimestamp ?? e.eventTime ?? e.firstTimestamp ?? e.metadata?.creationTimestamp) || 0;

export function createWakeWatch({ autoscaling, ecs, kubernetesOf }, records, { since, now, everyMs = EVERY_MS }) {
  const groups = records.filter((r) => r.kind === 'asg');
  const services = records.filter((r) => r.kind === 'ecs');
  const owners = records.filter((r) => r.kind === 'k8s');
  let last = -Infinity;

  async function groupFailure(group) {
    const { Activities = [] } = await autoscaling.describeScalingActivities({ AutoScalingGroupName: group.name, MaxRecords: 10 });
    const failed = Activities.find((a) => ACTIVITY_FAILED.has(a.StatusCode) && time(a.StartTime) >= since);
    if (!failed) return null;
    const message = failed.StatusMessage ?? failed.Description ?? failed.StatusCode;
    return Object.assign(failureError(classifyText(message), `Auto Scaling group ${group.name}: ${message}`), { backend: `asg:${group.name}` });
  }

  async function serviceFailure(service) {
    const { services: [found] = [] } = await ecs.describeServices({ cluster: service.cluster, services: [service.id] });
    const event = (found?.events ?? []).find((e) => time(e.createdAt) >= since && ECS_FAILURE.test(e.message ?? ''));
    if (!event) return null;
    const kind = classifyText(event.message);
    return Object.assign(failureError(kind === 'unknown' ? 'configuration' : kind, `ECS service: ${event.message}`), { backend: `ecs:${service.id}` });
  }

  // The latest warning on the owner's pods since the wake started: a failure first, else the scheduler's wait.
  async function ownerFailure(record) {
    const k8s = await kubernetesOf(record.cluster);
    const pods = new Set((await ownerPods(k8s, record)).map((p) => p.metadata.name));
    const listed = await k8s.list(`/api/v1/namespaces/${record.namespace}/events`, { fieldSelector: 'involvedObject.kind=Pod' });
    const recent = listed.filter((e) => e.type === 'Warning' && pods.has(e.involvedObject?.name) && eventTime(e) >= since).sort((a, b) => eventTime(b) - eventTime(a));
    const failed = recent.find((e) => POD_FAILURE.test(`${e.reason} ${e.message}`));
    const event = failed ?? recent.find((e) => POD_WAIT.has(e.reason));
    if (!event) return null;
    return Object.assign(failureError(failed ? 'configuration' : 'capacity', `pod ${event.involvedObject.name}: ${event.reason}: ${event.message}`), { backend: `k8s:${record.id}` });
  }

  const watch = {
    // No capacity: Auto Scaling and ECS keep trying on their own, so the wake waits for its deadline and fails with it.
    capacity: null,
    // The first failure seen that will not fix itself, as an error the wake fails with; null meanwhile.
    async check() {
      if (!groups.length && !services.length && !owners.length) return null;
      if (now() - last < everyMs) return null;
      last = now();
      const seen = [];
      for (const group of groups) seen.push(await groupFailure(group).catch(() => null));
      for (const service of services) seen.push(await serviceFailure(service).catch(() => null));
      for (const owner of owners) seen.push(await ownerFailure(owner).catch(() => null));
      for (const error of seen.filter(Boolean)) {
        if (error.kind !== 'capacity') return error;
        watch.capacity = error;
      }
      return null;
    },
  };
  return watch;
}

// At the deadline: why no target is healthy (unhealthy, with the targets' reason), or that none is registered.
export async function unhealthyError(elbv2, targetGroupArn) {
  const { TargetHealthDescriptions: targets = [] } = await elbv2.describeTargetHealth({ TargetGroupArn: targetGroupArn }).catch(() => ({}));
  if (!targets.length) return failureError('timeout', 'no target registered in the target group when the wake timed out');
  const worst = targets.find((t) => t.TargetHealth?.State === 'unhealthy') ?? targets[0];
  const reason = [worst.TargetHealth?.Reason, worst.TargetHealth?.Description && `(${worst.TargetHealth.Description})`].filter(Boolean).join(' ');
  return failureError('unhealthy', `${targets.length} target${targets.length === 1 ? '' : 's'}, none healthy${reason ? `: ${reason}` : ''}`);
}
