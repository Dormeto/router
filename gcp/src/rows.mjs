// The router's rows and events as the manager reads them: the shapes of AWS's `Workload state changed` detail and of its `list` row,
// built by the shared code (lambda/src/lib/events.mjs's stateChange, summary.mjs's workloadRow) from what Firestore holds.

import { stateChange } from '../../lambda/src/lib/events.mjs';
import { totals, workloadRow } from '../../lambda/src/lib/summary.mjs';
import { effectiveOf } from './levels.mjs';

// The failure the run stores holds `at` in ms; the event's holds it as an ISO string.
const failureOf = (failure) => (typeof failure?.at === 'number' ? { ...failure, at: new Date(failure.at).toISOString() } : failure);

// The `Workload state changed` detail of a transition. `event` is what the transition's caller says of it (the wake id and its duration,
// the failure, the VMs a nap suspended and the items it stopped, the fallbacks, who asked); the rest of it (the names it stopped, the
// autoscalers) stays in the run. `stateAt` is the instant of the change (ms).
export function eventOf({ workloadId, from, to, stateAt, cause, event = {}, router, tags = {} }) {
  const { wakeId, durationMs, failure, fallbacks, by, suspended, items } = event;
  return {
    ...stateChange({
      workloadId, from, to, at: stateAt, wakeId, cause, by, tags,
      event: {
        ...(durationMs === undefined ? {} : { durationMs }),
        ...(failure ? { failure: failureOf(failure) } : {}),
        ...(fallbacks ? { fallbacks } : {}),
        ...(suspended?.length ? { hibernated: suspended } : {}),
        ...(items ? { stopped: items } : {}),
      },
    }),
    router: router.name,
    region: router.region,
    project: router.project,
  };
}

// The AWS kind names of the backends (G5's type names map the same way), in AWS's order; the Cloud SQL twin of `rds-instance`.
export const KIND_OF = { vm: 'instance', mig: 'asg', k8s: 'k8s', cloudsql: 'cloudsql-instance' };
const KINDS = Object.values(KIND_OF);

// The AWS `list` row (lambda/src/lib/summary.mjs's workloadRow) of a workload, from its configuration and run. `stats7d`: the
// store's `getStats(id, 7)`, or null when it could not be read. `router` and `organization`: the router's level and the organization's, for the resolved settings; `pauses`
// and `scheduled`: the workload's active pauses and whether it has a schedule. Instead of `targetGroupArn`, its Google resources.
// Its `hibernated` is true only while it is asleep with a VM suspended, as AWS's.
export function rowOf({ cfg, run, stats7d = null, routerName, router = null, organization = null, pauses = [], scheduled = false }) {
  return workloadRow(effectiveOf(cfg, { run, router, organization }), run, {
    identity: { backendService: cfg.backendService, wakerBackendService: cfg.wakerBackendService, urlMap: cfg.urlMap, lb: cfg.lb ?? { kind: 'global' } },
    defaultSource: 'cli',
    host: cfg.hosts?.length ? cfg.hosts[0] : null,
    backends: KINDS.filter((kind) => (cfg.backends ?? []).some((b) => KIND_OF[b.kind] === kind)),
    hibernated: Boolean(run?.suspended?.length),
    stats7d: totals(stats7d),
    pauses,
    scheduled,
  });
}
