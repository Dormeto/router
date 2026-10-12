const POLL_MS = 3000;

export async function instanceStates(ec2, ids) {
  const out = await ec2.describeInstances({ InstanceIds: ids });
  const states = {};
  for (const reservation of out.Reservations ?? []) {
    for (const instance of reservation.Instances ?? []) states[instance.InstanceId] = instance.State?.Name;
  }
  return states;
}

async function waitFor(ec2, ids, done, { sleep, now, deadline }) {
  for (;;) {
    const states = await instanceStates(ec2, ids);
    if (ids.every((id) => done(states[id]))) return states;
    if (now() >= deadline) throw new Error(`timeout waiting for instances: ${JSON.stringify(states)}`);
    await sleep(POLL_MS);
  }
}

export async function startInstances(ec2, ids, timing) {
  const states = await waitFor(ec2, ids, (s) => s !== 'stopping', timing);
  const toStart = ids.filter((id) => states[id] === 'stopped');
  if (toStart.length) await ec2.startInstances({ InstanceIds: toStart });
}

export async function stopInstances(ec2, ids, timing) {
  const states = await instanceStates(ec2, ids);
  const toStop = ids.filter((id) => states[id] === 'pending' || states[id] === 'running');
  if (toStop.length) await ec2.stopInstances({ InstanceIds: toStop });
  await waitFor(ec2, ids, (s) => s === 'stopped', timing);
}

export async function healthyCount(elbv2, targetGroupArn) {
  const { TargetHealthDescriptions = [] } = await elbv2.describeTargetHealth({ TargetGroupArn: targetGroupArn });
  return TargetHealthDescriptions.filter((d) => d.TargetHealth?.State === 'healthy').length;
}
