// RDS DB instances and Aurora DB clusters as companion backends: they do not serve the ALB but must run for the
// application. Stopped after the primary backends, started (and awaited) before them.

const POLL_MS = 10_000;
export const RDS_KINDS = new Set(['rds-instance', 'rds-cluster']);
export const isCompanion = (backend) => RDS_KINDS.has(backend.kind);

const arnId = (arn) => arn.split(':').at(-1);

async function rawStatus(rds, backend) {
  if (backend.kind === 'rds-cluster') {
    const { DBClusters = [] } = await rds.describeDBClusters({ DBClusterIdentifier: backend.id });
    return DBClusters[0]?.Status;
  }
  const { DBInstances = [] } = await rds.describeDBInstances({ DBInstanceIdentifier: backend.id });
  return DBInstances[0]?.DBInstanceStatus;
}

const toStatus = (raw) => (raw === 'available' ? 'running' : raw === 'stopped' ? 'stopped' : 'transitioning');

export async function discoverDatabases({ rds, tagging }, cfg) {
  const { ResourceTagMappingList = [] } = await tagging.getResources({
    TagFilters: [{ Key: 'dormeto:workload', Values: [cfg.workloadId] }],
    ResourceTypeFilters: ['rds:db', 'rds:cluster'],
  });
  const backends = [];
  const ignored = [];
  const arns = ResourceTagMappingList.map((m) => m.ResourceARN);
  for (const arn of arns.filter((a) => a.includes(':db:'))) {
    const id = arnId(arn);
    const { DBInstances = [] } = await rds.describeDBInstances({ DBInstanceIdentifier: id });
    const db = DBInstances[0];
    if (!db) continue;
    if (db.DBClusterIdentifier) continue; // managed through its cluster
    if (db.ReadReplicaSourceDBInstanceIdentifier) {
      ignored.push({ id, reason: 'read replica: cannot be stopped' });
      continue;
    }
    backends.push({ kind: 'rds-instance', id });
  }
  for (const arn of arns.filter((a) => a.includes(':cluster:'))) {
    const id = arnId(arn);
    const { DBClusters = [] } = await rds.describeDBClusters({ DBClusterIdentifier: id });
    const cluster = DBClusters[0];
    if (!cluster) continue;
    if (cluster.EngineMode === 'serverless') {
      ignored.push({ id, reason: 'Aurora Serverless v1: cannot be stopped' });
      continue;
    }
    backends.push({ kind: 'rds-cluster', id });
  }
  return { backends, ignored };
}

export async function rdsStatuses({ rds }, backends) {
  const statuses = {};
  for (const backend of backends) statuses[`${backend.kind}:${backend.id}`] = toStatus(await rawStatus(rds, backend));
  return statuses;
}

const start = (rds, b) => (b.kind === 'rds-cluster'
  ? rds.startDBCluster({ DBClusterIdentifier: b.id })
  : rds.startDBInstance({ DBInstanceIdentifier: b.id }));

const stop = (rds, b) => (b.kind === 'rds-cluster'
  ? rds.stopDBCluster({ DBClusterIdentifier: b.id })
  : rds.stopDBInstance({ DBInstanceIdentifier: b.id }));

// Stop the available databases; a database takes minutes to stop: no wait.
export async function stopDatabases({ rds }, backends) {
  for (const backend of backends) {
    if ((await rawStatus(rds, backend)) === 'available') await stop(rds, backend);
  }
}

// Start the stopped databases (a stopping one is started once stopped) and, with wait, until all are available.
// Raises an error with code DEADLINE when timing.deadline is reached: the caller decides to continue or fail.
export async function startDatabases({ rds }, backends, timing, { wait = true } = {}) {
  const started = new Set();
  for (;;) {
    let available = 0;
    for (const backend of backends) {
      const raw = await rawStatus(rds, backend);
      if (raw === 'available') available += 1;
      else if (raw === 'stopped' && !started.has(backend.id)) {
        await start(rds, backend);
        started.add(backend.id);
      }
    }
    if (!wait || available === backends.length) return;
    if (timing.now() >= timing.deadline) {
      throw Object.assign(new Error(`databases not available yet: ${backends.map((b) => b.id).join(', ')}`), { code: 'DEADLINE' });
    }
    await timing.sleep(POLL_MS);
  }
}
