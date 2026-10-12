// Resolve the EC2 instances of a workload: the static list of the configuration, or the instance targets of the
// app target group tagged dormeto:workload=<workloadId> (discovery mode, used when no static list is configured).

export const WORKLOAD_TAG = 'dormeto:workload';

export async function resolveInstances(ec2, elbv2, cfg) {
  if (cfg.instanceIds?.length) return { mode: 'static', managed: [...cfg.instanceIds], ignored: [] };

  const { TargetHealthDescriptions = [] } = await elbv2.describeTargetHealth({ TargetGroupArn: cfg.appTargetGroupArn });
  const targetIds = TargetHealthDescriptions.map((d) => d.Target?.Id).filter(Boolean);
  const instanceIds = targetIds.filter((id) => id.startsWith('i-'));
  const ignored = [];
  const managed = [];
  if (instanceIds.length) {
    const out = await ec2.describeInstances({ InstanceIds: instanceIds });
    const tags = {};
    for (const reservation of out.Reservations ?? []) {
      for (const instance of reservation.Instances ?? []) {
        tags[instance.InstanceId] = Object.fromEntries((instance.Tags ?? []).map((t) => [t.Key, t.Value]));
      }
    }
    for (const id of instanceIds) {
      const workload = tags[id]?.[WORKLOAD_TAG];
      if (workload === cfg.workloadId) managed.push(id);
      else ignored.push({ id, reason: workload ? `tagged for workload ${workload}` : 'untagged' });
    }
  }
  for (const id of targetIds) if (!id.startsWith('i-')) ignored.push({ id, reason: 'not an instance' });
  return { mode: 'discovery', managed, ignored };
}
