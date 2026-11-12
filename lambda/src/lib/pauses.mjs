// Pauses, both routers' (vision docs/specs/2026-11-12-cloud-duplication-design.md, §5): a workload's, its router's (no workloadId)
// and the manager's exclusions' (an `exclusionId`, several per workload beside the operator's). A paused workload, or every
// workload of a paused router, is never napped; a keepAsleep pause also holds the scheduled and maintenance wakes. A pause past
// its `until` no longer holds, and the check deletes it.
//
// Each controller passes an adapter of its store, built where it is created:
// - `listPauses()`: every pause, expired ones included, `[{ workloadId (null: the router's), by, at, reason, until?, keepAsleep,
//   exclusionId? }]`;
// - `getPauses(workloadId)`: a workload's own pauses (its operator's and its exclusions'), or the router's for null;
// - `putPause(workloadId, record)`: an exclusion's (`record.exclusionId`) beside the operator's, which a new one replaces;
// - `deletePause(workloadId, { exclusionId, at })`: true when this call removed that pause; false when there was none, or when
//   `at` is given and the stored pause has another (a newer pause is kept);
// - `listConfigs()`: the workloads a router pause wakes.
// `wake(workloadId, { by, router })`: the cloud's wake for a pause, true when this call started the wake or set a napping workload's
// pending wake (`router`: a router pause asks it), `concurrency` of them at a time; `refuse(message)`: the cloud's error for a pause
// asked wrong.
const PAUSE_MAX_MS = 366 * 86_400_000;
const REASON_MAX = 256;

const iso = (ms) => new Date(ms).toISOString();
// Exclusions first, then the workload's own pause, then the router's.
const rank = (p) => (p.exclusionId ? 0 : p.workloadId ? 1 : 2);

// A pause as people read it: its scope (the workload's or the router's), and an exclusion's id.
export const shownPause = ({ workloadId, by, at, reason, until, keepAsleep, exclusionId }) => ({
  scope: workloadId ? 'workload' : 'router', by, at: iso(at), reason, until: until === undefined ? null : iso(until), keepAsleep: keepAsleep === true,
  ...(exclusionId ? { exclusionId } : {}),
});

// A shown pause in the words of a refused request-nap.
export const pauseText = (p) => `${p.scope === 'router' ? 'router ' : ''}paused by ${p.by}: ${p.reason}`;

// What the active pauses hold of a workload: its naps when one applies to it (its own or its router's), its scheduled and
// maintenance wakes too when that one keeps asleep. Pauses that could not be read (null) hold every workload.
export function pauseHolds(pauses) {
  const applies = (p, workloadId) => p.workloadId === null || p.workloadId === workloadId;
  return {
    paused: (workloadId) => pauses === null || pauses.some((p) => applies(p, workloadId)),
    keptAsleep: (workloadId) => pauses === null || pauses.some((p) => p.keepAsleep && applies(p, workloadId)),
  };
}

export function createPauses({ store, wake, refuse, concurrency = 1, now = Date.now, log }) {
  const expired = (p) => p.until !== undefined && p.until <= now();
  // The pauses that still hold, as shown, in their order: the newest first within each.
  const shownPauses = (pauses) => pauses.filter((p) => !expired(p)).sort((a, b) => rank(a) - rank(b) || b.at - a.at).map(shownPause);

  // A workload's active pauses, as shown: its exclusions', its own, then its router's.
  async function pausesFor(workloadId) {
    const [own, router] = await Promise.all([store.getPauses(workloadId), store.getPauses(null)]);
    return shownPauses([...own, ...router]);
  }

  // A nap needs to know: pauses that cannot be read count as a pause.
  async function isPaused(workloadId) {
    try {
      return (await pausesFor(workloadId)).length > 0;
    } catch (err) {
      log.warn('PausesUnreadable', { workloadId, error: err.message });
      return true;
    }
  }

  // Every active pause, `{ pauses }`; when they cannot be read, `{ pauses: null, error }` (the read's). The expired ones are deleted
  // (unless a newer pause replaced them).
  async function activePauses() {
    let pauses;
    try {
      pauses = await store.listPauses();
    } catch (err) {
      log.warn('PausesUnreadable', { error: err.message });
      return { pauses: null, error: err.message };
    }
    for (const p of pauses.filter(expired)) {
      const named = p.exclusionId ? { exclusionId: p.exclusionId } : {};
      const deleted = await store.deletePause(p.workloadId, { exclusionId: p.exclusionId, at: p.at }).catch((err) => {
        log.warn('PauseDeleteFailed', { workloadId: p.workloadId, ...named, error: err.message });
        return false;
      });
      if (deleted) log.info('PauseExpired', { workloadId: p.workloadId, by: p.by, reason: p.reason, ...named });
    }
    return { pauses: pauses.filter((p) => !expired(p)) };
  }

  // The record as stored. No `until` when none is asked for: a store may make `undefined` a null, read as expired.
  function pauseRecord({ by, reason, until, keepAsleep }, exclusionId) {
    const text = typeof reason === 'string' ? reason.trim() : '';
    if (!text || text.length > REASON_MAX) throw refuse(`reason required (1 to ${REASON_MAX} characters)`);
    if (keepAsleep !== undefined && typeof keepAsleep !== 'boolean') throw refuse('keepAsleep must be true or false');
    let untilMs;
    if (until !== undefined && until !== null) {
      untilMs = typeof until === 'number' ? until : Date.parse(until);
      if (!(untilMs > now() && untilMs <= now() + PAUSE_MAX_MS)) throw refuse('until must be in the future, within 366 days');
    }
    return {
      by: by ?? 'unknown', at: now(), reason: text, ...(untilMs === undefined ? {} : { until: untilMs }), keepAsleep: keepAsleep === true,
      ...(exclusionId ? { exclusionId: String(exclusionId) } : {}),
    };
  }

  // Pauses the workload, or the router when `workloadId` is null (its caller has checked the workload). Unless keepAsleep, the
  // workload, or each one of a paused router, goes to the cloud's wake. Answers the pause as shown and the workloads woken, those the
  // wake says this call woke, in the store's order.
  async function pause(workloadId, input, { exclusionId } = {}) {
    const record = pauseRecord(input, exclusionId);
    await store.putPause(workloadId, record);
    log.info('Paused', { workloadId, ...record });
    const ids = record.keepAsleep ? [] : workloadId ? [workloadId] : (await store.listConfigs()).map((c) => c.workloadId);
    const started = new Set();
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, async () => {
      while (next < ids.length) {
        const id = ids[next++];
        try {
          if (await wake(id, { by: record.by, router: !workloadId })) started.add(id);
        } catch (err) {
          log.error('PauseWakeFailed', { workloadId: id, error: err.message });
        }
      }
    }));
    return { pause: shownPause({ workloadId, ...record }), woken: ids.filter((id) => started.has(id)) };
  }

  // Removes one pause: the workload's operator's (the exclusion's when `exclusionId` is given), or the router's when `workloadId` is
  // null. Answers whether there was one.
  async function resume(workloadId, by, { exclusionId } = {}) {
    const resumed = Boolean(await store.deletePause(workloadId, { exclusionId }));
    if (resumed) log.info('Resumed', { workloadId, by, ...(exclusionId ? { exclusionId } : {}) });
    return { resumed };
  }

  return { expired, shownPauses, pausesFor, isPaused, activePauses, pause, resume };
}
