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

// Target states that can still receive (or be counted for) traffic. A stopped instance stays registered as 'unused'.
const SERVING = new Set(['healthy', 'initial', 'draining', 'unhealthy']);

// After a nap: until the target group has dropped the stopped backends (ECS tasks deregister after the service reports
// no running task). Otherwise a wake right after the nap sees the old target healthy and switches the route to an
// empty target group (ALB 503). Returns false when the deadline is reached first.
export async function waitTargetsReleased(elbv2, targetGroupArn, { sleep, now, deadline, pollMs = 5000 }) {
  for (;;) {
    const { TargetHealthDescriptions = [] } = await elbv2.describeTargetHealth({ TargetGroupArn: targetGroupArn });
    if (!TargetHealthDescriptions.some((d) => SERVING.has(d.TargetHealth?.State))) return true;
    if (now() >= deadline) return false;
    await sleep(pollMs);
  }
}

export async function healthyCount(elbv2, targetGroupArn) {
  const { TargetHealthDescriptions = [] } = await elbv2.describeTargetHealth({ TargetGroupArn: targetGroupArn });
  return TargetHealthDescriptions.filter((d) => d.TargetHealth?.State === 'healthy').length;
}
