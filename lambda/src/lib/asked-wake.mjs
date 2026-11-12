// The wakes a router asks for itself, not a visitor's request (the waker's own are lib/waker-core.mjs's): an operator's, the
// manager's, a pause's, a schedule's. Both routers' (vision docs/specs/2026-11-12-cloud-duplication-design.md, §5; the research's
// R9): each cloud sends the wake on its own way after the run is WAKING, a Lambda invocation or a task of Cloud Tasks, and counts it.
import { STATES } from './state.mjs';

// Who asked, as the WakeRequested and PendingWake lines say it: the trigger, `{ kind, by }`, the waker's form (B6 of the design).
export const triggerOf = (kind, by) => ({ trigger: { kind, by } });

// The run to WAKING from the state read (`from`), its cause `kind` and who asked (`by`, in its event), `set`: more of the run written
// with it (the schedule's occurrence it applies). The wake's id, said in WakeRequested with its trigger; null when the state changed
// meanwhile. The ports: `transition` (the cloud's: Google Cloud's adds the tags and its StateChanged line), `newId`, `now`, `log`.
export async function beginWake({ transition, newId, now, log }, workloadId, from, { kind, by, set = {} } = {}) {
  const wakeId = newId();
  const next = await transition(workloadId, {
    cond: { state: from }, set: { ...set, state: STATES.WAKING, wakeId, wakeStartedAt: now() }, remove: ['failedAt'], increment: ['wakeCount'], cause: kind,
    ...(by ? { by } : {}),
  });
  if (!next) return null;
  log.info('WakeRequested', { workloadId, wakeId, ...triggerOf(kind, by) });
  return wakeId;
}

// A napping workload's pending wake (its nap ends awake): true when this call set it, one PendingWake line and one counted wake per
// pending wake. `count`: summary.mjs's createCount.
export async function pendingWake({ store, count, log }, workloadId, { kind, by } = {}) {
  if (!(await store.setPendingWake(workloadId))) return false;
  log.info('PendingWake', { workloadId, ...triggerOf(kind, by) });
  await count(workloadId, `wake:${kind}`);
  return true;
}

// A wake asked whatever the retry delay (the manager's force-wake, a pause's): an asleep or failed workload's started, a napping one's
// pending wake set, any other state left as it is. `{ woke, answer }`: whether this call started the wake or set the pending wake (a
// pause's `woken`), and force-wake's answer. The ports: `find(workloadId)`, the configuration or the cloud's refusal; `store.getRun`;
// `start(workloadId, run, trigger)`, the cloud's wake from the run read, `{ woke, answer }`, `answer` null to answer the run read
// again; `pending(workloadId, trigger)`, true when it set the pending wake. `trigger`: `{ kind, by }`, and what the cloud's own wake
// reads (AWS's `inline`).
export async function askedWake({ find, store, start, pending }, workloadId, trigger) {
  await find(workloadId);
  const run = await store.getRun(workloadId);
  if (run?.state === STATES.ASLEEP || run?.state === STATES.FAILED) {
    const { woke, answer } = await start(workloadId, run, trigger);
    return { woke, answer: answer ?? { state: (await store.getRun(workloadId))?.state } };
  }
  if (run?.state === STATES.NAPPING) return { woke: await pending(workloadId, trigger), answer: { state: STATES.NAPPING, pendingWake: true } };
  return { woke: false, answer: { state: run?.state } };
}
