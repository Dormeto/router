// What a nap stops (vision docs/specs/2026-10-08-savings-design.md, R9a): each backend by what prices it — instance type
// and OS, Fargate task size, database class, Kubernetes pods by node — for the manager's savings. A backend that cannot
// be described is said (an unknown item), never guessed; describing never stops the nap.
import { k8sItems } from './kubernetes.mjs';

const ITEMS_MAX = 50;

const osOf = (platform) => (!platform || platform === 'Linux/UNIX' ? 'Linux' : platform);
const unknown = (backend, err) => ({ kind: 'unknown', backend, reason: String(err?.message ?? err).slice(0, 200) });

async function instances(ec2, ids) {
  if (!ids.length) return new Map();
  const out = await ec2.describeInstances({ InstanceIds: ids });
  return new Map((out.Reservations ?? []).flatMap((r) => r.Instances ?? []).map((i) => [i.InstanceId, { type: i.InstanceType, os: osOf(i.PlatformDetails), spot: i.InstanceLifecycle === 'spot' }]));
}
// An EC2 item; `spot` only when it ran on Spot (R9.5a).
const ec2Item = (type, count, os, spot) => ({ kind: 'ec2', type, count, os, ...(spot ? { spot: true } : {}) });

async function instanceItems(ec2, backend) {
  const [found] = (await instances(ec2, [backend.id])).values();
  return found ? [ec2Item(found.type, 1, found.os, found.spot)] : [];
}

// An Auto Scaling group: its desired capacity before the nap, by the types of its instances, on-demand or Spot.
async function groupItems(ec2, backend) {
  const desired = backend.desired ?? 0;
  if (!desired) return [];
  const described = [...(await instances(ec2, backend.instances ?? [])).values()];
  if (!described.length) return [unknown(`asg:${backend.name}`, 'no instance to read its type from')];
  const counts = new Map();
  for (const i of described) {
    const key = `${i.type}|${i.os}|${i.spot ? 'spot' : ''}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const items = [...counts].map(([key, count]) => { const [type, os, spot] = key.split('|'); return ec2Item(type, count, os, spot === 'spot'); });
  const missing = desired - described.length;
  if (missing > 0) items[0].count += missing;
  return items;
}

// A capacity provider strategy's split of a desired count, as ECS places tasks (R9.5a): the provider with a base gets
// that many first, the rest is shared by weight, rounded with the largest remainder so the counts add up; without any
// weight, the base's provider (else the first) takes the rest.
export function strategyCounts(strategy, desired) {
  const counts = new Map(strategy.map((s) => [s.capacityProvider, 0]));
  if (!strategy.length || !(desired > 0)) return counts;
  const based = strategy.find((s) => (s.base ?? 0) > 0);
  const base = based ? Math.min(based.base, desired) : 0;
  if (based) counts.set(based.capacityProvider, base);
  const rest = desired - base;
  const total = strategy.reduce((n, s) => n + (s.weight ?? 0), 0);
  if (!total) {
    const taker = (based ?? strategy[0]).capacityProvider;
    counts.set(taker, counts.get(taker) + rest);
    return counts;
  }
  const shares = strategy.map((s) => ({ provider: s.capacityProvider, exact: (rest * (s.weight ?? 0)) / total }));
  for (const share of shares) counts.set(share.provider, counts.get(share.provider) + Math.floor(share.exact));
  let left = rest - shares.reduce((n, share) => n + Math.floor(share.exact), 0);
  for (const share of [...shares].sort((a, b) => (b.exact % 1) - (a.exact % 1))) {
    if (left <= 0) break;
    counts.set(share.provider, counts.get(share.provider) + 1);
    left -= 1;
  }
  return counts;
}

// A service on Fargate (its launch type, or Fargate capacity providers): its task size × its desired count, the share on
// Fargate Spot an item of its own. On EC2 capacity, the cluster's instances are not stopped by Dormeto: nothing to count.
async function serviceItems(ecs, backend) {
  const { services: [service] = [] } = await ecs.describeServices({ cluster: backend.cluster, services: [backend.id] });
  const fargate = service?.launchType === 'FARGATE' || (service?.capacityProviderStrategy ?? []).some((s) => /^FARGATE/.test(s.capacityProvider));
  if (!service || !fargate || !(backend.desired > 0)) return [];
  const { taskDefinition: task } = await ecs.describeTaskDefinition({ taskDefinition: service.taskDefinition });
  const family = task?.runtimePlatform?.operatingSystemFamily ?? 'LINUX';
  const size = {
    kind: 'fargate', vcpu: Number(task.cpu) / 1024, memoryGb: Number(task.memory) / 1024,
    arch: task?.runtimePlatform?.cpuArchitecture === 'ARM64' ? 'arm64' : 'x86_64', os: family === 'LINUX' ? 'Linux' : family.startsWith('WINDOWS') ? 'Windows' : family,
  };
  if (service.launchType === 'FARGATE') return [{ ...size, count: backend.desired }];
  const counts = strategyCounts(service.capacityProviderStrategy, backend.desired);
  return [
    ...(counts.get('FARGATE') ? [{ ...size, count: counts.get('FARGATE') }] : []),
    ...(counts.get('FARGATE_SPOT') ? [{ ...size, count: counts.get('FARGATE_SPOT'), spot: true }] : []),
  ];
}

const dbItem = (db, cluster) => (db.DBInstanceClass === 'db.serverless'
  ? { kind: 'aurora-serverless', engine: db.Engine, acu: cluster?.ServerlessV2ScalingConfiguration?.MinCapacity ?? 0.5 }
  : { kind: 'rds', class: db.DBInstanceClass, engine: db.Engine, multiAz: db.MultiAZ === true });

async function databaseItems(rds, backend) {
  if (backend.kind === 'rds-instance') {
    const { DBInstances: [db] = [] } = await rds.describeDBInstances({ DBInstanceIdentifier: backend.id });
    return db ? [dbItem(db)] : [];
  }
  const { DBClusters: [cluster] = [] } = await rds.describeDBClusters({ DBClusterIdentifier: backend.id });
  const { DBInstances = [] } = await rds.describeDBInstances({ Filters: [{ Name: 'db-cluster-id', Values: [backend.id] }] });
  return DBInstances.map((db) => dbItem(db, cluster));
}

export async function describeStopped({ ec2, ecs, rds, kubernetesOf }, backends) {
  const items = [];
  for (const backend of backends) {
    const name = backend.kind === 'asg' ? `asg:${backend.name}` : `${backend.kind}:${backend.id}`;
    try {
      if (backend.kind === 'instance') items.push(...(await instanceItems(ec2, backend)));
      else if (backend.kind === 'asg') items.push(...(await groupItems(ec2, backend)));
      else if (backend.kind === 'ecs') items.push(...(await serviceItems(ecs, backend)));
      else if (backend.kind === 'k8s') items.push(...(await k8sItems({ kubernetesOf }, backend)));
      else if (backend.kind === 'rds-instance' || backend.kind === 'rds-cluster') items.push(...(await databaseItems(rds, backend)));
    } catch (err) {
      items.push(unknown(name, err));
    }
  }
  return items.slice(0, ITEMS_MAX);
}
