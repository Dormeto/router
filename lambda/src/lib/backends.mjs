// Backends of a workload: standalone EC2 instances and EC2 Auto Scaling groups feeding the app target group.
// Instances of a group are never managed one by one: the group would replace a stopped instance.
import { retryCapacity, startWithCapacity } from './capacity.mjs';
import { instanceStates, stopInstances } from './instances.mjs';
import { discoverEcsServices, ecsRecord, ecsStatuses, resumeEcs, sleepEcs, wakeEcs } from './ecs.mjs';
import { discoverDatabases, isCompanion, rdsStatuses, startDatabases, stopDatabases } from './rds.mjs';

export { isCompanion };

export const WORKLOAD_TAG = 'dormeto:workload';
export const GROUP_TAG = 'aws:autoscaling:groupName';
export const WAKE_DESIRED_TAG = 'dormeto:wake-desired';
// Processes that could scale a napping group back up.
export const SCALING_PROCESSES = ['AlarmNotification', 'ScheduledActions', 'AZRebalance'];

const POLL_MS = 3000;

export const backendKey = (backend) => `${backend.kind}:${backend.kind === 'asg' ? backend.name : backend.id}`;
const ecsOnly = (list) => list.filter((b) => b.kind === 'ecs');
const companions = (list) => list.filter(isCompanion);

const tagMap = (tags = []) => Object.fromEntries(tags.map((t) => [t.Key, t.Value]));

// Warm pool configuration, as returned by DescribeAutoScalingGroups (null without a pool).
function warmPoolOf(group) {
  const pool = group.WarmPoolConfiguration;
  if (!pool) return null;
  return {
    state: pool.PoolState ?? 'Stopped',
    minSize: pool.MinSize ?? 0,
    maxPrepared: pool.MaxGroupPreparedCapacity ?? null,
    reuseOnScaleIn: pool.InstanceReusePolicy?.ReuseOnScaleIn === true,
    size: group.WarmPoolSize ?? 0,
  };
}

function asgBackend(group) {
  const wake = Number.parseInt(tagMap(group.Tags)[WAKE_DESIRED_TAG], 10);
  return {
    kind: 'asg',
    name: group.AutoScalingGroupName,
    min: group.MinSize,
    max: group.MaxSize,
    desired: group.DesiredCapacity,
    instances: (group.Instances ?? []).map((i) => i.InstanceId),
    warmPool: warmPoolOf(group),
    wakeDesired: Number.isInteger(wake) && wake > 0 ? wake : null,
  };
}

export async function resolveBackends({ ec2, elbv2, autoscaling, ecs, tagging, appscaling, rds }, cfg) {
  if (cfg.instanceIds?.length) {
    // Static primary instances; companions (databases) are still discovered by tag.
    const databases = rds && tagging ? await discoverDatabases({ rds, tagging }, cfg) : { backends: [], ignored: [] };
    return { mode: 'static', backends: [...cfg.instanceIds.map((id) => ({ kind: 'instance', id })), ...databases.backends], ignored: databases.ignored };
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

  const services = ecs && tagging ? await discoverEcsServices({ ecs, tagging, appscaling }, cfg, WAKE_DESIRED_TAG) : { backends: [], ignored: [] };

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
  // IP targets belong to the tasks of a managed ECS service (awsvpc): not ignored targets then.
  if (!services.backends.length) for (const id of targetIds) if (!id.startsWith('i-')) ignored.push({ id, reason: 'not an instance' });
  const databases = rds && tagging ? await discoverDatabases({ rds, tagging }, cfg) : { backends: [], ignored: [] };
  ignored.push(...ignoredGroups, ...services.ignored, ...databases.ignored);
  backends.push(...groups.values(), ...services.backends, ...databases.backends);
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

export async function backendStatuses({ ec2, autoscaling, ecs, rds }, backends) {
  const { ids, groups } = split(backends);
  const states = ids.length ? await instanceStates(ec2, ids) : {};
  const described = await describeGroups(autoscaling, groups.map((g) => g.name));
  const statuses = {};
  for (const id of ids) {
    statuses[`instance:${id}`] = states[id] === 'running' ? 'running' : states[id] === 'stopped' ? 'stopped' : 'transitioning';
  }
  for (const group of groups) statuses[`asg:${group.name}`] = groupStatus(described.get(group.name));
  if (ecsOnly(backends).length) Object.assign(statuses, await ecsStatuses({ ecs }, ecsOnly(backends)));
  if (companions(backends).length) Object.assign(statuses, await rdsStatuses({ rds }, companions(backends)));
  return statuses;
}

export const toRecord = (backend) => {
  if (isCompanion(backend)) return { kind: backend.kind, id: backend.id };
  if (backend.kind === 'ecs') return ecsRecord(backend);
  if (backend.kind === 'asg') return { kind: 'asg', name: backend.name, min: backend.min, max: backend.max, desired: backend.desired };
  return { kind: 'instance', id: backend.id };
};

// Primary backends first (waited), then the companions (databases: stopped without waiting, it takes minutes).
export async function sleepBackends({ ec2, autoscaling, ecs, appscaling, rds }, backends, timing) {
  if (ecsOnly(backends).length) await sleepEcs({ ecs, appscaling }, ecsOnly(backends), timing);
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
  if (companions(backends).length) await stopDatabases({ rds }, companions(backends));
  return backends.map(toRecord);
}

// Companions first, awaited until available (the application needs its database), then the primary backends.
// A step's error names the backend that failed (R7a: the failure record says which one).
async function step(backend, run) {
  try {
    return await run();
  } catch (err) {
    err.backend ??= backend;
    throw err;
  }
}

// options.fallbackTypes: the workload's fallback instance types; options.onFallback(id, { from, to }) (R7a).
export async function wakeBackends({ ec2, autoscaling, ecs, appscaling, rds }, records, timing, options = {}) {
  const dbs = companions(records);
  // A database start refused for capacity is tried again within the deadline (R7a).
  if (dbs.length) await step(dbs.map((d) => `rds:${d.id}`).join(','), () => retryCapacity(() => startDatabases({ rds }, dbs, timing), timing));
  const services = ecsOnly(records);
  if (services.length) await step(services.map((x) => `ecs:${x.id}`).join(','), () => wakeEcs({ ecs, appscaling }, services));
  const { ids, groups } = split(records);
  for (const group of groups) {
    // A group recorded at 0 (found asleep by a reconcile) wakes with dormeto:wake-desired or 1 instance.
    const recorded = group.desired > 0;
    const desired = recorded ? group.desired : (group.wakeDesired ?? 1);
    const min = recorded ? group.min : 1;
    await step(`asg:${group.name}`, async () => {
      await autoscaling.updateAutoScalingGroup({
        AutoScalingGroupName: group.name, MinSize: min, MaxSize: Math.max(group.max ?? desired, desired), DesiredCapacity: desired,
      });
      await autoscaling.resumeProcesses({ AutoScalingGroupName: group.name, ScalingProcesses: SCALING_PROCESSES });
    });
  }
  if (ids.length) await step(ids.map((id) => `instance:${id}`).join(','), () => startWithCapacity(ec2, ids, timing, options));
}

// After a wake done outside Dormeto (a group scaled up by hand): resume scaling and restore the recorded limits,
// keeping the capacity that was chosen (MinSize capped by it so that the group is not scaled up again).
export async function resumeBackends({ autoscaling, ecs, appscaling, rds }, records) {
  if (companions(records).length) await startDatabases({ rds }, companions(records), null, { wait: false });
  if (ecsOnly(records).length) await resumeEcs({ ecs, appscaling }, ecsOnly(records));
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

// Companions that must not run while the workload sleeps (e.g. a database started by AWS after 7 days stopped).
export async function stopCompanions({ rds }, backends) {
  if (companions(backends).length) await stopDatabases({ rds }, companions(backends));
}

export async function startCompanions({ rds }, backends) {
  if (companions(backends).length) await startDatabases({ rds }, companions(backends), null, { wait: false });
}
