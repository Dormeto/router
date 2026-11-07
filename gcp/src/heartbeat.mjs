// The heartbeat of a running wake or nap (vision docs/specs/2026-11-07-google-cloud-fixes-design.md, F5). A wake or a nap
// writes `beatAt` on its run when it starts, then every 60 s until it ends, while the run still holds its id: `wakeId` WAKING,
// `napId` NAPPING. A run whose beat is older than 3 minutes, or absent 90 s after its request, is stale: its task was lost, or its
// request died. The check, and the waker when a visitor polls, act on it at most once a minute (`resentAt`, written by one of them
// only): a wake is sent again with its wakeId, which its transitions guard, so a duplicate is harmless; a nap takes the stuck
// nap's path (controller-core.mjs). The deadlines of a stuck wake and a stuck nap stay, as the last resort.
import { STATES } from '../../lambda/src/lib/state.mjs';

const BEAT_MS = 60_000;
const STALE_MS = 3 * 60_000;
const FIRST_BEAT_MS = 90_000;
const RESEND_MS = 60_000;

// The state each id beats in.
const BEATING = { wakeId: STATES.WAKING, napId: STATES.NAPPING };

// Whether the run still holds that id: the store writes a beat only then.
export const beats = (run, field, id) => Object.hasOwn(BEATING, field) && run.state === BEATING[field] && run[field] === id;

// When the run's wake or nap was asked: a wake's start, a nap's NAPPING (the store dates a state change; a store that does not, its
// last update). Undefined when nothing beats: a nap from before the heartbeat has no napId, and its 35 or 22 minutes alone hold.
function askedAt(run) {
  if (run.state === STATES.WAKING) return run.wakeStartedAt;
  if (run.state === STATES.NAPPING && run.napId !== undefined) return run.stateAt ?? run.updatedAt;
  return undefined;
}

// The running wake's or nap's last beat, else undefined: one from before its request was an earlier one's.
export function beatOf(run) {
  const asked = askedAt(run);
  return asked !== undefined && run.beatAt >= asked ? run.beatAt : undefined;
}

// Why the run's wake or nap is stale at `t`, in words, else null.
export function staleness(run, t) {
  const asked = askedAt(run);
  if (asked === undefined) return null;
  const beat = beatOf(run);
  if (beat !== undefined) return t - beat > STALE_MS ? 'no heartbeat for more than 3 minutes' : null;
  return t - asked > FIRST_BEAT_MS ? 'no heartbeat 90 s after it started' : null;
}

// Whether the wake may be sent again at `t`: still WAKING with that wakeId, and not sent again in the last minute.
export const resendable = (run, wakeId, t) => run.state === STATES.WAKING && run.wakeId === wakeId && (run.resentAt === undefined || run.resentAt < t - RESEND_MS);

// The heartbeat of `field` `id` on the run, from now: its first beat written before this returns, then one every 60 s through
// `every(ms, fn)` (a timer; its answer stops it). Answers the stop, for every way out of the wake or the nap. A beat that fails is
// said, and nothing else: the wake or the nap goes on.
export async function startHeartbeat({ store, every, log }, workloadId, field, id) {
  const beat = async () => {
    try {
      await store.beat(workloadId, field, id);
    } catch (err) {
      log.warn('BeatFailed', { workloadId, [field]: id, error: err.message });
    }
  };
  await beat();
  return every(BEAT_MS, beat);
}

// A stale wake sent again with its wakeId, `enqueue(body)` its task, by the check or the waker (`by`): one resend a minute between
// them, through the run's `resentAt`, read first then written on condition. True when this call sent it. It never throws: a resend
// that fails is said, and the next try is a minute later.
export async function resendStale({ store, enqueue, now, log }, workloadId, run, by) {
  const t = now();
  const reason = run.state === STATES.WAKING ? staleness(run, t) : null;
  if (reason === null || !resendable(run, run.wakeId, t)) return false;
  const { wakeId } = run;
  try {
    if (!(await store.claimResend(workloadId, wakeId))) return false;
    await enqueue({ action: 'wake', workloadId, wakeId });
  } catch (err) {
    log.warn('WakeResendFailed', { workloadId, wakeId, by, error: err.message });
    return false;
  }
  log.warn('WakeResent', { workloadId, wakeId, by, reason });
  return true;
}
