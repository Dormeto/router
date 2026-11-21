// Backends of a workload: EC2 instances outside an Auto Scaling group and EC2 Auto Scaling groups feeding the app target group, ECS
// services, a Kubernetes owner (its configuration names it), and their databases.
// Instances of a group are never managed one by one: the group would replace a stopped instance.
import { retryCapacity, startWithCapacity } from './capacity.mjs';
import { instanceStates, stopInstances } from './instances.mjs';
import { discoverEcsServices, ecsCounts, ecsRecord, ecsStatuses, resumeEcs, sleepEcs, wakeEcs } from './ecs.mjs';
import { discoverDatabases, isCompanion, rdsStatuses, startDatabases, stopDatabases } from './rds.mjs';
import { k8sBackend, k8sRecord, k8sStatus, resumeK8s, sleepK8s, wakeK8s } from './kubernetes.mjs';
import { resourceKindOf } from './settings-levels.mjs';

export { isCompanion };

export const WORKLOAD_TAG = 'dormeto:workload';
export const GROUP_TAG = 'aws:autoscaling:groupName';
export const WAKE_DESIRED_TAG = 'dormeto:wake-desired';
// Processes that could scale a napping group back up.
export const SCALING_PROCESSES = ['AlarmNotification', 'ScheduledActions', 'AZRebalance'];

const POLL_MS = 3000;

export const backendKey = (backend) => `${backend.kind}:${backend.kind === 'asg' ? backend.name : backend.id}`;
const ecsOnly = (list) => list.filter((b) => b.kind === 'ecs');
const k8sOnly = (list) => list.filter((b) => b.kind === 'k8s');
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

// A standalone workload's (vision standalone workloads design §5): the backend its record names, while it carries the workload tag,
// and its companions (databases) by tag; no target group. Its resource is its primary backend, a database too.
export const isStandalone = (cfg) => cfg?.kind === 'standalone';
export function isResourceOf(cfg, backend) {
  const resource = resourceKindOf(cfg.resourceArn);
  if (!resource || resource.kind !== backend.kind) return false;
  if (backend.kind === 'asg') return backend.name === resource.id;
  if (backend.kind === 'ecs') return backend.id === cfg.resourceArn;
  return backend.id === resource.id;
}
// The backends whose states decide the workload's, and those that follow them.
export const primariesOf = (cfg, backends) => backends.filter((b) => (isStandalone(cfg) ? isResourceOf(cfg, b) : !isCompanion(b)));
export const companionsOf = (cfg, backends) => backends.filter((b) => (isStandalone(cfg) ? !isResourceOf(cfg, b) : isCompanion(b)));

async function standaloneBackends({ ec2, autoscaling, ecs, tagging, appscaling, rds }, cfg) {
  const resource = resourceKindOf(cfg.resourceArn);
  const databases = rds && tagging ? await discoverDatabases({ rds, tagging }, cfg) : { backends: [], ignored: [] };
  const ignored = [...databases.ignored];
  const untagged = (id, tags = {}) => {
    const workload = tags[WORKLOAD_TAG];
    ignored.push({ id, reason: workload ? `tagged for workload ${workload}` : 'untagged' });
    return null;
  };
  const own = (tags) => tags[WORKLOAD_TAG] === cfg.workloadId;
  let primary = null;
  if (!resource) ignored.push({ id: cfg.resourceArn ?? null, reason: 'not a resource Dormeto can nap' });
  else if (resource.kind === 'instance') {
    let instance;
    try {
      const out = await ec2.describeInstances({ InstanceIds: [resource.id] });
      instance = (out.Reservations ?? []).flatMap((r) => r.Instances ?? []).find((i) => i.InstanceId === resource.id);
    } catch (err) {
      // Deleted: not a backend, as a group gone is not (the check says it, never fails on it).
      if (err?.name !== 'InvalidInstanceID.NotFound') throw err;
    }
    const tags = tagMap(instance?.Tags);
    if (!instance || ['terminated', 'shutting-down'].includes(instance.State?.Name)) primary = (ignored.push({ id: resource.id, reason: 'not found' }), null);
    else primary = own(tags) ? { kind: 'instance', id: resource.id } : untagged(resource.id, tags);
  } else if (resource.kind === 'asg') {
    const { AutoScalingGroups: [group] = [] } = await autoscaling.describeAutoScalingGroups({ AutoScalingGroupNames: [resource.id] });
    const tags = tagMap(group?.Tags);
    primary = group && own(tags) ? asgBackend(group) : untagged(resource.id, tags);
  } else if (resource.kind === 'ecs') {
    const services = ecs && tagging ? await discoverEcsServices({ ecs, tagging, appscaling }, cfg, WAKE_DESIRED_TAG) : { backends: [], ignored: [] };
    primary = services.backends.find((b) => b.id === cfg.resourceArn) ?? untagged(cfg.resourceArn);
  } else primary = databases.backends.find((b) => isResourceOf(cfg, b)) ?? untagged(resource.id);
  const companions = databases.backends.filter((b) => !isResourceOf(cfg, b));
  // Without its resource it has no backend at all: its companions are never stopped nor started alone.
  if (!primary) return { mode: 'standalone', backends: [], ignored: [...ignored, ...companions.map((b) => ({ id: b.id, reason: 'the workload\'s resource is missing' }))] };
  return { mode: 'standalone', backends: [primary, ...companions], ignored };
}

// The size a woken group or service must reach (what wakeBackends sets): the nap's record, else dormeto:wake-desired, else 1.
export const wakeSizeOf = (record) => (record.desired > 0 ? record.desired : (record.wakeDesired ?? 1));

// A standalone workload's backend statuses (vision standalone workloads design §3): a group runs at its size with every instance in
// service, a service at its desired count with every task running. `sizes`: the size each must reach (backendKey → size, a wake's);
// else its own desired capacity or count.
export async function standaloneStatuses(clients, backends, sizes = new Map()) {
  const statuses = backends.length ? await backendStatuses(clients, backends) : {};
  const groups = backends.filter((b) => b.kind === 'asg' && statuses[backendKey(b)] === 'running');
  const described = await describeGroups(clients.autoscaling, groups.map((g) => g.name));
  for (const g of groups) {
    const found = described.get(g.name);
    const size = sizes.get(backendKey(g)) ?? found?.DesiredCapacity ?? 0;
    const inService = (found?.Instances ?? []).filter((i) => i.LifecycleState === 'InService').length;
    if (!found || found.DesiredCapacity < size || inService < Math.max(size, found.DesiredCapacity)) statuses[backendKey(g)] = 'transitioning';
  }
  const services = backends.filter((b) => b.kind === 'ecs' && statuses[backendKey(b)] === 'running');
  const counts = services.length ? await ecsCounts(clients, services) : new Map();
  for (const svc of services) {
    const { desired, running } = counts.get(svc.id);
    const size = sizes.get(backendKey(svc)) ?? desired;
    if (desired < size || running < Math.max(size, desired)) statuses[backendKey(svc)] = 'transitioning';
  }
  return statuses;
}

export async function resolveBackends({ ec2, elbv2, autoscaling, ecs, tagging, appscaling, rds, kubernetesOf }, cfg) {
  if (isStandalone(cfg)) return standaloneBackends({ ec2, autoscaling, ecs, tagging, appscaling, rds }, cfg);
  if (cfg.kubernetes) {
    // Kubernetes objects carry no AWS tags: the owner is the one the configuration names; databases still by tag.
    const owner = await k8sBackend({ elbv2, kubernetesOf }, cfg);
    const databases = rds && tagging ? await discoverDatabases({ rds, tagging }, cfg) : { backends: [], ignored: [] };
    return { mode: 'kubernetes', backends: [...owner.backends, ...databases.backends], ignored: [...owner.ignored, ...databases.ignored] };
  }
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

export async function backendStatuses({ ec2, autoscaling, ecs, rds, kubernetesOf }, backends) {
  const { ids, groups } = split(backends);
  const states = ids.length ? await instanceStates(ec2, ids) : {};
  const described = await describeGroups(autoscaling, groups.map((g) => g.name));
  const statuses = {};
  for (const id of ids) {
    statuses[`instance:${id}`] = states[id] === 'running' ? 'running' : states[id] === 'stopped' ? 'stopped' : 'transitioning';
  }
  for (const group of groups) statuses[`asg:${group.name}`] = groupStatus(described.get(group.name));
  if (ecsOnly(backends).length) Object.assign(statuses, await ecsStatuses({ ecs }, ecsOnly(backends)));
  for (const b of k8sOnly(backends)) statuses[backendKey(b)] = await k8sStatus({ kubernetesOf }, b);
  if (companions(backends).length) Object.assign(statuses, await rdsStatuses({ rds }, companions(backends)));
  return statuses;
}

export const toRecord = (backend) => {
  if (isCompanion(backend)) return { kind: backend.kind, id: backend.id };
  if (backend.kind === 'ecs') return ecsRecord(backend);
  if (backend.kind === 'k8s') return k8sRecord(backend);
  if (backend.kind === 'asg') return { kind: 'asg', name: backend.name, min: backend.min, max: backend.max, desired: backend.desired };
  return { kind: 'instance', id: backend.id };
};

// Primary backends first (waited), then the companions (databases: stopped without waiting, it takes minutes).
// options: { hibernate, onHibernated, log } of the instance stop (lib/instances.mjs).
export async function sleepBackends({ ec2, autoscaling, ecs, appscaling, rds, kubernetesOf }, backends, timing, options = {}) {
  if (ecsOnly(backends).length) await sleepEcs({ ecs, appscaling }, ecsOnly(backends), timing);
  for (const b of k8sOnly(backends)) await sleepK8s({ kubernetesOf }, b, timing);
  const { ids, groups } = split(backends);
  for (const group of groups) {
    await autoscaling.suspendProcesses({ AutoScalingGroupName: group.name, ScalingProcesses: SCALING_PROCESSES });
    await autoscaling.updateAutoScalingGroup({ AutoScalingGroupName: group.name, MinSize: 0, DesiredCapacity: 0 });
  }
  if (ids.length) await stopInstances(ec2, ids, timing, options);
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
export async function wakeBackends({ ec2, autoscaling, ecs, appscaling, rds, kubernetesOf }, records, timing, options = {}) {
  const dbs = companions(records);
  // A database start refused for capacity is tried again within the deadline (R7a).
  if (dbs.length) await step(dbs.map((d) => `rds:${d.id}`).join(','), () => retryCapacity(() => startDatabases({ rds }, dbs, timing), timing));
  const services = ecsOnly(records);
  if (services.length) await step(services.map((x) => `ecs:${x.id}`).join(','), () => wakeEcs({ ecs, appscaling }, services));
  for (const r of k8sOnly(records)) await step(`k8s:${r.id}`, () => wakeK8s({ kubernetesOf }, r, timing));
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
export async function resumeBackends({ autoscaling, ecs, appscaling, rds, kubernetesOf }, records) {
  if (companions(records).length) await startDatabases({ rds }, companions(records), null, { wait: false });
  if (ecsOnly(records).length) await resumeEcs({ ecs, appscaling }, ecsOnly(records));
  for (const r of k8sOnly(records)) await resumeK8s({ kubernetesOf }, r);
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
