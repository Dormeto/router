// The check's loop, both routers' (scale design §6; vision docs/specs/2026-11-12-cloud-duplication-design.md, §5): after the passes
// each cloud makes over every workload whatever the budget (the schedules first), the workloads one by one, `concurrency` at a time,
// none started past the deadline, each through the cloud's own check of one workload. A check cut short by its deadline stops after
// the last workload it started, and the next one starts after it, so every workload gets its turn on a crowded router. One that fails
// is said and stops only itself; one whose offboarding ran under the check (its configuration gone) is skipped, its writes failing
// being no failure.
//
// The ports, passed by each controller's check:
// - `store`: the cloud's store, its `getCheck()` and `getConfig(workloadId)` (null once the workload is offboarded), the same on both
//   stores. `getCheck()`'s record holds the cursor, `cursor`, on both: AWS's CHECK item (with its lease and its last scheduled check),
//   Google Cloud's router/check (the check's summary);
// - `workloads`: the configurations in id order; `checkOne(cfg)`: the cloud's check of one workload, answering its result's fields;
// - `deadline`: when no workload starts any more (the check's 240 s, and on AWS its Lambda's time); `concurrency`; `now`; `log`;
// - `chunk`: `{ size, prepare(workloads) }`, the workloads prepared together before they are checked (AWS: their rules, each load
//   balancer listed once); a chunk is not started when its preparation, as long as the last one's, would end past the deadline.
//   None: the workloads are one chunk with nothing to prepare;
// - `passes`: what the passes before the loop did for a workload (id → its result's fields), in its result, and alone in the results
//   for one the loop did not reach;
// - `end()`: what the cloud says once the loop is over, before the budget's line.
// Answers the results; where the next check starts, `cursor`: the last workload this one checked when it stopped short (where this
// one started when it checked none), null when it reached every workload, which each cloud stores right after; and `check`, the record
// the cursor was read from (null: none, or it could not be read).

export async function runCheck({ store, workloads, checkOne, deadline, concurrency = 8, chunk = null, passes = new Map(), end = null, now, log }) {
  // Starting after the workload where the previous check stopped; a cursor that cannot be read starts at the first.
  const check = (await Promise.resolve().then(() => store.getCheck?.()).catch(() => null)) ?? null;
  const cursor = check?.cursor;
  const from = cursor ? workloads.findIndex((c) => c.workloadId > cursor) : 0;
  const order = from > 0 ? [...workloads.slice(from), ...workloads.slice(0, from)] : workloads;
  const size = chunk?.size ?? order.length;
  const results = [];
  let next = 0;
  let preparedMs = 0;
  while (next < order.length && now() < deadline && (next === 0 || now() + preparedMs < deadline)) {
    const batch = order.slice(next, next + size);
    if (chunk) {
      const preparedAt = now();
      await chunk.prepare(batch);
      preparedMs = now() - preparedAt;
    }
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, batch.length) }, async () => {
      while (i < batch.length && now() < deadline) {
        const cfg = batch[i++];
        next += 1;
        try {
          results.push({ workloadId: cfg.workloadId, ...(await checkOne(cfg)), ...passes.get(cfg.workloadId) });
        } catch (err) {
          // An offboarding that ran under this check deleted the workload: its writes failing is no failure. A configuration that
          // cannot be read counts as there.
          if (!(await Promise.resolve().then(() => store.getConfig(cfg.workloadId)).catch(() => cfg))) {
            log.info('CheckSkipped', { workloadId: cfg.workloadId, reason: 'offboarded' });
            results.push({ workloadId: cfg.workloadId, skipped: 'offboarded' });
            continue;
          }
          log.error('CheckFailed', { workloadId: cfg.workloadId, error: err.message });
          results.push({ workloadId: cfg.workloadId, error: err.message });
        }
      }
    }));
  }
  if (end) await end();
  if (next < order.length) log.warn('CheckBudgetReached', { checked: next, workloads: order.length, next: order[next].workloadId });
  // What the passes did for the workloads the loop did not reach.
  const reached = new Set(results.map((r) => r.workloadId));
  for (const [workloadId, passed] of passes) if (!reached.has(workloadId)) results.push({ workloadId, ...passed });
  // Cut short: the next check starts after the last workload checked (where this one started if it checked none).
  return { results, cursor: next < order.length ? (next > 0 ? order[next - 1].workloadId : cursor ?? null) : null, check };
}
