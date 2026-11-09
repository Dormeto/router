// The router's rows and events as the manager reads them: the shapes of AWS's `Workload state changed` detail (lambda/src/lib/events.mjs)
// and of its `list` row, built from what Firestore holds.

const iso = (ms) => new Date(ms).toISOString();

// The failure the run stores holds `at` in ms; the event's holds it as an ISO string.
const failureOf = (failure) => (typeof failure?.at === 'number' ? { ...failure, at: iso(failure.at) } : failure);

// The `Workload state changed` detail of a transition. `event` is what the transition's caller says of it (the wake id and its duration,
// the failure, the VMs a nap suspended, the fallbacks, who asked); the rest of it (the items a nap stopped, the autoscalers) stays in the
// run. `stateAt` is the instant of the change (ms).
export function eventOf({ workloadId, from, to, stateAt, cause, event = {}, router, tags = {} }) {
  const { wakeId, durationMs, failure, fallbacks, by, suspended } = event;
  return {
    workloadId,
    from,
    to,
    router: router.name,
    region: router.region,
    project: router.project,
    at: iso(stateAt),
    ...(cause ? { cause } : {}),
    ...(wakeId ? { wakeId } : {}),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(failure ? { failure: failureOf(failure) } : {}),
    ...(by ? { by } : {}),
    ...(fallbacks ? { fallbacks } : {}),
    ...(suspended?.length ? { hibernated: suspended } : {}),
    tags,
  };
}
