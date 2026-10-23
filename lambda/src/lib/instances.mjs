const POLL_MS = 3000;
// An instance's own type while it runs on a fallback type (R7a, lib/capacity.mjs).
export const TYPE_TAG = 'dormeto:instance-type';
// The state reason of a hibernated instance (stopped, or still stopping while EC2 writes its memory).
export const HIBERNATE_REASON = 'Client.UserInitiatedHibernate';

export async function instanceStates(ec2, ids) {
  const out = await ec2.describeInstances({ InstanceIds: ids });
  const states = {};
  for (const reservation of out.Reservations ?? []) {
    for (const instance of reservation.Instances ?? []) states[instance.InstanceId] = instance.State?.Name;
  }
  return states;
}

// One DescribeInstances: what hibernation needs to know of each instance; an instance AWS does not return is absent.
export async function instanceDetails(ec2, ids) {
  const out = await ec2.describeInstances({ InstanceIds: ids });
  const details = new Map();
  for (const reservation of out.Reservations ?? []) {
    for (const instance of reservation.Instances ?? []) {
      const state = instance.State?.Name;
      details.set(instance.InstanceId, {
        state,
        configured: instance.HibernationOptions?.Configured === true,
        hibernated: (state === 'stopped' || state === 'stopping') && instance.StateReason?.Code === HIBERNATE_REASON,
        fallbackType: (instance.Tags ?? []).some((t) => t.Key === TYPE_TAG),
      });
    }
  }
  return details;
}

// settled(states): whether the states at the deadline end the wait anyway.
async function waitFor(ec2, ids, done, { sleep, now, deadline }, settled = () => false) {
  for (;;) {
    const states = await instanceStates(ec2, ids);
    if (ids.every((id) => done(states[id]))) return states;
    if (now() >= deadline) {
      if (settled(states)) return states;
      throw new Error(`timeout waiting for instances: ${JSON.stringify(states)}`);
    }
    await sleep(POLL_MS);
  }
}

export async function startInstances(ec2, ids, timing) {
  const states = await waitFor(ec2, ids, (s) => s !== 'stopping', timing);
  const toStart = ids.filter((id) => states[id] === 'stopped');
  if (toStart.length) await ec2.startInstances({ InstanceIds: toStart });
}

// Running, launched with hibernation, on its own type (one on a fallback type is stopped: it gets its type back).
const canHibernate = (d) => d?.state === 'running' && d.configured && !d.fallbackType;

// hibernate: the instances that can be are hibernated, the others stopped; onHibernated(ids) as soon as AWS accepts.
export async function stopInstances(ec2, ids, timing, { hibernate = false, onHibernated, log } = {}) {
  const details = await instanceDetails(ec2, ids);
  const toStop = ids.filter((id) => ['pending', 'running'].includes(details.get(id)?.state));
  const hibernating = hibernate ? toStop.filter((id) => canHibernate(details.get(id))) : [];
  const hibernated = [];
  const refused = [];
  if (hibernating.length) {
    try {
      await ec2.stopInstances({ InstanceIds: hibernating, Hibernate: true });
      hibernated.push(...hibernating);
    } catch (err) {
      // Too soon after a start, or anything else AWS refuses: the whole call fails, its instances are stopped instead.
      log?.warn('HibernationRefused', { instances: hibernating, error: err.message });
      refused.push(...hibernating);
    }
    if (hibernated.length && onHibernated) {
      try {
        await onHibernated(hibernated);
      } catch (err) {
        log?.error('HibernatedNotRecorded', { instances: hibernated, error: err.message });
      }
    }
  }
  const plain = toStop.filter((id) => !hibernated.includes(id));
  if (plain.length) await ec2.stopInstances({ InstanceIds: plain });
  // An accepted hibernation is a completed nap: EC2 finishes writing the memory on its own, past this wait.
  const ongoing = (states) => ids.filter((id) => states[id] !== 'stopped').every((id) => hibernated.includes(id) && states[id] === 'stopping');
  const states = await waitFor(ec2, ids, (s) => s === 'stopped', timing, ongoing);
  const still = hibernated.filter((id) => states[id] === 'stopping');
  if (still.length) log?.info('HibernationOngoing', { instances: still });
  return { hibernated, refused };
}

// Target states that can still receive (or be counted for) traffic. A stopped instance stays registered as 'unused'.
const SERVING = new Set(['healthy', 'initial', 'draining', 'unhealthy']);

// After a nap: until the target group has dropped the stopped backends (ECS tasks deregister after the service reports
// no running task). Otherwise a wake right after the nap sees the old target healthy and switches the route to an
// empty target group (ALB 503). Returns false when the deadline is reached first. draining: false for pods, whose
// targets the Load Balancer Controller deregisters as they terminate: an IP that never serves again drains for the
// group's deregistration delay (300 s by default), longer than the wait.
export async function waitTargetsReleased(elbv2, targetGroupArn, { sleep, now, deadline, pollMs = 5000, draining = true }) {
  for (;;) {
    const { TargetHealthDescriptions = [] } = await elbv2.describeTargetHealth({ TargetGroupArn: targetGroupArn });
    const serving = (state) => SERVING.has(state) && (draining || state !== 'draining');
    if (!TargetHealthDescriptions.some((d) => serving(d.TargetHealth?.State))) return true;
    if (now() >= deadline) return false;
    await sleep(pollMs);
  }
}

export async function healthyCount(elbv2, targetGroupArn) {
  const { TargetHealthDescriptions = [] } = await elbv2.describeTargetHealth({ TargetGroupArn: targetGroupArn });
  return TargetHealthDescriptions.filter((d) => d.TargetHealth?.State === 'healthy').length;
}
