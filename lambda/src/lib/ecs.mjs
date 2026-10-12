// ECS service backends: discovered by tag (Resource Groups Tagging API), napped by desiredCount 0 with their
// Application Auto Scaling scalable target suspended, woken by restoring both.

const POLL_MS = 3000;
const DIMENSION = 'ecs:service:DesiredCount';
export const ECS_SUSPENDED = { DynamicScalingInSuspended: true, DynamicScalingOutSuspended: true, ScheduledScalingSuspended: true };
const ECS_RESUMED = { DynamicScalingInSuspended: false, DynamicScalingOutSuspended: false, ScheduledScalingSuspended: false };

// arn:aws:ecs:<region>:<account>:service/<cluster>/<service> → service/<cluster>/<service>
export const ecsResourceId = (serviceArn) => `service/${serviceArn.split(':service/')[1]}`;

const clusterOf = (serviceArn) => {
  const [prefix, rest] = serviceArn.split(':service/');
  return `${prefix}:cluster/${rest.split('/')[0]}`;
};

async function describe(ecs, backends) {
  const byCluster = new Map();
  for (const b of backends) byCluster.set(b.cluster, [...(byCluster.get(b.cluster) ?? []), b.id]);
  const found = new Map();
  for (const [cluster, ids] of byCluster) {
    for (let i = 0; i < ids.length; i += 10) { // DescribeServices accepts up to 10 services
      const { services = [] } = await ecs.describeServices({ cluster, services: ids.slice(i, i + 10) });
      for (const service of services) found.set(service.serviceArn, service);
    }
  }
  return found;
}

export async function discoverEcsServices({ ecs, tagging, appscaling }, cfg, wakeTag) {
  const { ResourceTagMappingList = [] } = await tagging.getResources({
    TagFilters: [{ Key: 'dormeto:workload', Values: [cfg.workloadId] }],
    ResourceTypeFilters: ['ecs:service'],
  });
  const tags = new Map(ResourceTagMappingList.map((m) => [m.ResourceARN, Object.fromEntries((m.Tags ?? []).map((t) => [t.Key, t.Value]))]));
  const candidates = [...tags.keys()].map((id) => ({ id, cluster: clusterOf(id) }));
  const described = await describe(ecs, candidates);
  const managed = [];
  const ignored = [];
  for (const { id } of candidates) {
    const service = described.get(id);
    if (!service) continue;
    if (!(service.loadBalancers ?? []).some((lb) => lb.targetGroupArn === cfg.appTargetGroupArn)) {
      ignored.push({ id, reason: 'ECS service does not feed the target group' });
      continue;
    }
    managed.push(service);
  }
  const scalable = new Map();
  if (managed.length && appscaling) {
    const { ScalableTargets = [] } = await appscaling.describeScalableTargets({
      ServiceNamespace: 'ecs', ResourceIds: managed.map((s) => ecsResourceId(s.serviceArn)), ScalableDimension: DIMENSION,
    });
    for (const t of ScalableTargets) scalable.set(t.ResourceId, { min: t.MinCapacity, max: t.MaxCapacity });
  }
  const backends = managed.map((service) => {
    const wake = Number.parseInt(tags.get(service.serviceArn)?.[wakeTag], 10);
    return {
      kind: 'ecs',
      id: service.serviceArn,
      cluster: service.clusterArn,
      desired: service.desiredCount,
      scalable: scalable.get(ecsResourceId(service.serviceArn)) ?? null,
      wakeDesired: Number.isInteger(wake) && wake > 0 ? wake : null,
    };
  });
  return { backends, ignored };
}

function serviceStatus(service) {
  if (!service) return 'transitioning';
  if (service.desiredCount === 0 && service.runningCount === 0 && service.pendingCount === 0) return 'stopped';
  if (service.desiredCount > 0 && service.runningCount > 0) return 'running';
  return 'transitioning';
}

export async function ecsStatuses({ ecs }, backends) {
  const described = await describe(ecs, backends);
  return Object.fromEntries(backends.map((b) => [`ecs:${b.id}`, serviceStatus(described.get(b.id))]));
}

export const ecsRecord = (b) => ({ kind: 'ecs', id: b.id, cluster: b.cluster, desired: b.desired, scalable: b.scalable });

const register = (appscaling, id, fields) => appscaling.registerScalableTarget({
  ServiceNamespace: 'ecs', ResourceId: ecsResourceId(id), ScalableDimension: DIMENSION, ...fields,
});

export async function sleepEcs({ ecs, appscaling }, backends, timing) {
  for (const b of backends) {
    if (b.scalable) await register(appscaling, b.id, { MinCapacity: 0, SuspendedState: ECS_SUSPENDED });
    await ecs.updateService({ cluster: b.cluster, service: b.id, desiredCount: 0 });
  }
  for (;;) {
    const described = await describe(ecs, backends);
    if (backends.every((b) => serviceStatus(described.get(b.id)) === 'stopped')) return;
    if (timing.now() >= timing.deadline) throw new Error(`timeout waiting for ECS services to stop: ${backends.map((b) => b.id).join(', ')}`);
    await timing.sleep(POLL_MS);
  }
}

export async function wakeEcs({ ecs, appscaling }, records) {
  for (const r of records) {
    const desired = r.desired > 0 ? r.desired : (r.wakeDesired ?? 1);
    await ecs.updateService({ cluster: r.cluster, service: r.id, desiredCount: desired });
    if (r.scalable) {
      await register(appscaling, r.id, {
        MinCapacity: r.scalable.min, MaxCapacity: Math.max(r.scalable.max, desired), SuspendedState: ECS_RESUMED,
      });
    }
  }
}

export async function resumeEcs({ ecs, appscaling }, records) {
  const withScalable = records.filter((r) => r.scalable);
  const described = await describe(ecs, withScalable);
  for (const r of withScalable) {
    const desired = described.get(r.id)?.desiredCount ?? r.desired;
    await register(appscaling, r.id, {
      MinCapacity: Math.min(r.scalable.min, desired), MaxCapacity: Math.max(r.scalable.max, desired), SuspendedState: ECS_RESUMED,
    });
  }
}
