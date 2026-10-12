// What a nap stops (vision docs/specs/2026-10-08-savings-design.md, R9a): each backend by what prices it — instance type
// and OS, Fargate task size, database class — for the manager's savings. A backend that cannot be described is said
// (an unknown item), never guessed; describing never stops the nap.
const ITEMS_MAX = 50;

const osOf = (platform) => (!platform || platform === 'Linux/UNIX' ? 'Linux' : platform.startsWith('Windows') ? 'Windows' : platform);
const unknown = (backend, err) => ({ kind: 'unknown', backend, reason: String(err?.message ?? err).slice(0, 200) });

async function instances(ec2, ids) {
  if (!ids.length) return new Map();
  const out = await ec2.describeInstances({ InstanceIds: ids });
  return new Map((out.Reservations ?? []).flatMap((r) => r.Instances ?? []).map((i) => [i.InstanceId, { type: i.InstanceType, os: osOf(i.PlatformDetails) }]));
}

async function instanceItems(ec2, backend) {
  const [found] = (await instances(ec2, [backend.id])).values();
  return found ? [{ kind: 'ec2', type: found.type, count: 1, os: found.os }] : [];
}

// An Auto Scaling group: its desired capacity before the nap, by the types of its instances.
async function groupItems(ec2, backend) {
  const desired = backend.desired ?? 0;
  if (!desired) return [];
  const described = [...(await instances(ec2, backend.instances ?? [])).values()];
  if (!described.length) return [unknown(`asg:${backend.name}`, 'no instance to read its type from')];
  const counts = new Map();
  for (const i of described) {
    const key = `${i.type}|${i.os}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const items = [...counts].map(([key, count]) => { const [type, os] = key.split('|'); return { kind: 'ec2', type, count, os }; });
  const missing = desired - described.length;
  if (missing > 0) items[0].count += missing;
  return items;
}

// A service on Fargate (its launch type, or a Fargate capacity provider): its task size × its desired count. On EC2
// capacity, the cluster's instances are not stopped by Dormeto: nothing to count.
async function serviceItems(ecs, backend) {
  const { services: [service] = [] } = await ecs.describeServices({ cluster: backend.cluster, services: [backend.id] });
  const fargate = service?.launchType === 'FARGATE' || (service?.capacityProviderStrategy ?? []).some((s) => /^FARGATE/.test(s.capacityProvider));
  if (!service || !fargate || !(backend.desired > 0)) return [];
  const { taskDefinition: task } = await ecs.describeTaskDefinition({ taskDefinition: service.taskDefinition });
  const family = task?.runtimePlatform?.operatingSystemFamily ?? 'LINUX';
  return [{
    kind: 'fargate', vcpu: Number(task.cpu) / 1024, memoryGb: Number(task.memory) / 1024, count: backend.desired,
    arch: task?.runtimePlatform?.cpuArchitecture === 'ARM64' ? 'arm64' : 'x86_64', os: family === 'LINUX' ? 'Linux' : family.startsWith('WINDOWS') ? 'Windows' : family,
  }];
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

export async function describeStopped({ ec2, ecs, rds }, backends) {
  const items = [];
  for (const backend of backends) {
    const name = backend.kind === 'asg' ? `asg:${backend.name}` : `${backend.kind}:${backend.id}`;
    try {
      if (backend.kind === 'instance') items.push(...(await instanceItems(ec2, backend)));
      else if (backend.kind === 'asg') items.push(...(await groupItems(ec2, backend)));
      else if (backend.kind === 'ecs') items.push(...(await serviceItems(ecs, backend)));
      else if (backend.kind === 'rds-instance' || backend.kind === 'rds-cluster') items.push(...(await databaseItems(rds, backend)));
    } catch (err) {
      items.push(unknown(name, err));
    }
  }
  return items.slice(0, ITEMS_MAX);
}
