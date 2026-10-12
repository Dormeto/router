// Capacity reactions of a wake (vision docs/specs/2026-10-08-failures-notifications-design.md, R7a): a start refused for
// capacity is tried again within the wake's deadline, and an EC2 instance may fall back to another instance type of its
// workload's list — given back its own type after the next stop (FinOps: a fallback is for this wake only).
import { classify, failureError } from './failures.mjs';
import { startInstances } from './instances.mjs';

export const CAPACITY_WAITS_MS = [30_000, 60_000, 120_000];
export const TYPE_TAG = 'dormeto:instance-type';

// run() again after 30 s, 60 s, then every 120 s while AWS has no capacity, until the wake's deadline; past the invocation's
// budget (timing.deadline) it waits for the budget's end and gives up, so that the wake continues in a new invocation.
export async function retryCapacity(run, timing) {
  const wakeDeadline = timing.wakeDeadline ?? timing.deadline;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (err) {
      if (classify(err).kind !== 'capacity') throw err;
      const wait = CAPACITY_WAITS_MS[Math.min(attempt, CAPACITY_WAITS_MS.length - 1)];
      if (timing.now() + wait >= wakeDeadline) throw err;
      if (timing.now() + wait >= timing.deadline) {
        await timing.sleep(Math.max(0, timing.deadline - timing.now()));
        throw err;
      }
      await timing.sleep(wait);
    }
  }
}

async function describe(ec2, id) {
  const out = await ec2.describeInstances({ InstanceIds: [id] });
  const instance = out.Reservations?.[0]?.Instances?.[0] ?? {};
  return { type: instance.InstanceType, tags: Object.fromEntries((instance.Tags ?? []).map((t) => [t.Key, t.Value])), state: instance.State?.Name };
}

// The next type after the current one, in [its own type, ...the list]; its own type kept in a tag the first time.
async function fallBack(ec2, id, fallbackTypes) {
  const { type, tags } = await describe(ec2, id);
  const own = tags[TYPE_TAG] ?? type;
  const order = [...new Set([own, ...fallbackTypes])];
  const next = order[order.indexOf(type) + 1];
  if (!next) return null;
  try {
    if (!tags[TYPE_TAG]) await ec2.createTags({ Resources: [id], Tags: [{ Key: TYPE_TAG, Value: own }] });
    await ec2.modifyInstanceAttribute({ InstanceId: id, InstanceType: { Value: next } });
  } catch (err) {
    if (classify(err).kind !== 'permission') throw err;
    throw Object.assign(failureError('permission', `instance type fallback refused (${err.message}): the router's role or DmtRouterBoundary lacks ec2:ModifyInstanceAttribute; apply the access module or the AWS CLI script of manager 0.5.0 again in this account`), { backend: `instance:${id}` });
  }
  return { from: own, to: next };
}

// EC2 starts: with fallback types, each instance on its own, changing type on a capacity error; onFallback(id, change).
export async function startWithCapacity(ec2, ids, timing, { fallbackTypes = [], onFallback = () => {} } = {}) {
  if (!fallbackTypes.length) return retryCapacity(() => startInstances(ec2, ids, timing), timing);
  for (const id of ids) {
    await retryCapacity(async () => {
      for (;;) {
        try {
          return await startInstances(ec2, [id], timing);
        } catch (err) {
          if (classify(err).kind !== 'capacity') throw err;
          const change = await fallBack(ec2, id, fallbackTypes);
          if (!change) throw err;
          onFallback(id, change);
        }
      }
    }, timing);
  }
}

// After a stop: each stopped instance that fell back gets its own type back (the tag says it). Returns those changed.
export async function revertInstanceTypes(ec2, ids, log) {
  const reverted = [];
  for (const id of ids) {
    try {
      const { type, tags, state } = await describe(ec2, id);
      if (!tags[TYPE_TAG] || state !== 'stopped') continue;
      if (type !== tags[TYPE_TAG]) await ec2.modifyInstanceAttribute({ InstanceId: id, InstanceType: { Value: tags[TYPE_TAG] } });
      await ec2.deleteTags({ Resources: [id], Tags: [{ Key: TYPE_TAG }] });
      reverted.push({ id, from: type, to: tags[TYPE_TAG] });
    } catch (err) {
      log?.warn('InstanceTypeNotReverted', { instance: id, error: err.message });
    }
  }
  return reverted;
}
