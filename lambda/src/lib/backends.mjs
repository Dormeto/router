// Backends of a workload: standalone EC2 instances and EC2 Auto Scaling groups feeding the app target group.
// Instances of a group are never managed one by one: the group would replace a stopped instance.
import { instanceStates, startInstances, stopInstances } from './instances.mjs';

export const WORKLOAD_TAG = 'dormeto:workload';
export const GROUP_TAG = 'aws:autoscaling:groupName';
export const WAKE_DESIRED_TAG = 'dormeto:wake-desired';
// Processes that could scale a napping group back up.
export const SCALING_PROCESSES = ['AlarmNotification', 'ScheduledActions', 'AZRebalance'];

const POLL_MS = 3000;

export const backendKey = (backend) => `${backend.kind}:${backend.kind === 'asg' ? backend.name : backend.id}`;

const tagMap = (tags = []) => Object.fromEntries(tags.map((t) => [t.Key, t.Value]));

function asgBackend(group) {
  const wake = Number.parseInt(tagMap(group.Tags)[WAKE_DESIRED_TAG], 10);
  return {
    kind: 'asg',
    name: group.AutoScalingGroupName,
    min: group.MinSize,
    max: group.MaxSize,
    desired: group.DesiredCapacity,
    instances: (group.Instances ?? []).map((i) => i.InstanceId),
    warmPool: Boolean(group.WarmPoolConfiguration),
    wakeDesired: Number.isInteger(wake) && wake > 0 ? wake : null,
  };
}

export async function resolveBackends({ ec2, elbv2, autoscaling }, cfg) {
  if (cfg.instanceIds?.length) {
    return { mode: 'static', backends: cfg.instanceIds.map((id) => ({ kind: 'instance', id })), ignored: [] };
  }
  const backends = [];
  const ignored = [];
  const groups = new Map();
  const ignoredGroups = [];
  if (autoscaling) {
    const { AutoScalingGroups = [] } = await autoscaling.describeAutoScalingGroups({
      Filters: [{ Name: `tag:${WORKLOAD_TAG}`, Values: [cfg.workloadId] }],
    });
    for (const group of AutoScalingGroups) {
      if ((group.TargetGroupARNs ?? []).includes(cfg.appTargetGroupArn)) groups.set(group.AutoScalingGroupName, asgBackend(group));
      else ignoredGroups.push({ id: group.AutoScalingGroupName, reason: 'Auto Scaling group does not feed the target group' });
    }
  }

  const { TargetHealthDescriptions = [] } = await elbv2.describeTargetHealth({ TargetGroupArn: cfg.appTargetGroupArn });
  const targetIds = TargetHealthDescriptions.map((d) => d.Target?.Id).filter(Boolean);
  const instanceIds = targetIds.filter((id) => id.startsWith('i-'));
  const tags = {};
  if (instanceIds.length) {
    const out = await ec2.describeInstances({ InstanceIds: instanceIds });
    for (const reservation of out.Reservations ?? []) {
      for (const instance of reservation.Instances ?? []) tags[instance.InstanceId] = tagMap(instance.Tags);
    }
  }
  for (const id of instanceIds) {
    const instanceTags = tags[id] ?? {};
    const group = instanceTags[GROUP_TAG];
    if (group) {
      if (!groups.has(group)) ignored.push({ id, reason: `member of Auto Scaling group ${group} (not managed)` });
      continue;
    }
    const workload = instanceTags[WORKLOAD_TAG];
    if (workload === cfg.workloadId) backends.push({ kind: 'instance', id });
    else ignored.push({ id, reason: workload ? `tagged for workload ${workload}` : 'untagged' });
  }
  for (const id of targetIds) if (!id.startsWith('i-')) ignored.push({ id, reason: 'not an instance' });
  ignored.push(...ignoredGroups);
  backends.push(...groups.values());
  return { mode: 'discovery', backends, ignored };
}

function groupStatus(group) {
  if (!group) return 'transitioning';
  const instances = group.Instances ?? [];
  if (group.DesiredCapacity === 0 && instances.length === 0) return 'stopped';
  if (group.DesiredCapacity > 0 && instances.some((i) => i.LifecycleState === 'InService')) return 'running';
  return 'transitioning';
}

async function describeGroups(autoscaling, names) {
  if (!names.length) return new Map();
  const { AutoScalingGroups = [] } = await autoscaling.describeAutoScalingGroups({ AutoScalingGroupNames: names });
  return new Map(AutoScalingGroups.map((g) => [g.AutoScalingGroupName, g]));
}

const split = (backends) => ({
  ids: backends.filter((b) => b.kind === 'instance').map((b) => b.id),
  groups: backends.filter((b) => b.kind === 'asg'),
});

export async function backendStatuses({ ec2, autoscaling }, backends) {
  const { ids, groups } = split(backends);
  const states = ids.length ? await instanceStates(ec2, ids) : {};
  const described = await describeGroups(autoscaling, groups.map((g) => g.name));
  const statuses = {};
  for (const id of ids) {
    statuses[`instance:${id}`] = states[id] === 'running' ? 'running' : states[id] === 'stopped' ? 'stopped' : 'transitioning';
  }
  for (const group of groups) statuses[`asg:${group.name}`] = groupStatus(described.get(group.name));
  return statuses;
}

export const toRecord = (backend) => (backend.kind === 'asg'
  ? { kind: 'asg', name: backend.name, min: backend.min, max: backend.max, desired: backend.desired }
  : { kind: 'instance', id: backend.id });

export async function sleepBackends({ ec2, autoscaling }, backends, timing) {
  const { ids, groups } = split(backends);
  for (const group of groups) {
    await autoscaling.suspendProcesses({ AutoScalingGroupName: group.name, ScalingProcesses: SCALING_PROCESSES });
    await autoscaling.updateAutoScalingGroup({ AutoScalingGroupName: group.name, MinSize: 0, DesiredCapacity: 0 });
  }
  if (ids.length) await stopInstances(ec2, ids, timing);
  const names = groups.map((g) => g.name);
  for (;;) {
    const described = await describeGroups(autoscaling, names);
    if (names.every((name) => (described.get(name)?.Instances ?? []).length === 0)) break;
    if (timing.now() >= timing.deadline) throw new Error(`timeout waiting for Auto Scaling groups to scale in: ${names.join(', ')}`);
    await timing.sleep(POLL_MS);
  }
  return backends.map(toRecord);
}

export async function wakeBackends({ ec2, autoscaling }, records, timing) {
  const { ids, groups } = split(records);
  for (const group of groups) {
    // A group recorded at 0 (found asleep by a reconcile) wakes with dormeto:wake-desired or 1 instance.
    const recorded = group.desired > 0;
    const desired = recorded ? group.desired : (group.wakeDesired ?? 1);
    const min = recorded ? group.min : 1;
    await autoscaling.updateAutoScalingGroup({
      AutoScalingGroupName: group.name, MinSize: min, MaxSize: Math.max(group.max ?? desired, desired), DesiredCapacity: desired,
    });
    await autoscaling.resumeProcesses({ AutoScalingGroupName: group.name, ScalingProcesses: SCALING_PROCESSES });
  }
  if (ids.length) await startInstances(ec2, ids, timing);
}

// After a wake done outside Dormeto (a group scaled up by hand): resume scaling and restore the recorded limits,
// keeping the capacity that was chosen (MinSize capped by it so that the group is not scaled up again).
export async function resumeBackends({ autoscaling }, records) {
  const groups = records.filter((r) => r.kind === 'asg');
  const described = await describeGroups(autoscaling, groups.map((g) => g.name));
  for (const group of groups) {
    const desired = described.get(group.name)?.DesiredCapacity ?? group.desired;
    await autoscaling.updateAutoScalingGroup({
      AutoScalingGroupName: group.name, MinSize: Math.min(group.min, desired), MaxSize: Math.max(group.max, desired),
    });
    await autoscaling.resumeProcesses({ AutoScalingGroupName: group.name, ScalingProcesses: SCALING_PROCESSES });
  }
}
