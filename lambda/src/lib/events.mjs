// Router events to the manager's event bus (vision scale design, section 3): the router's state after each idle check,
// and each workload state change. The envelope's account and region identify the router; publishing never fails the
// work that triggers it (the next check sends the whole state again).
const SOURCE = 'dormeto.router';
const ENTRY_MAX = 64 * 1024; // bytes of one entry's detail: PutEvents allows 256 KB per call
const CALL_MAX = 256 * 1024;
const ENTRIES_MAX = 10;

const size = (entry) => Buffer.byteLength(entry.Detail) + Buffer.byteLength(entry.DetailType) + Buffer.byteLength(entry.Source);

export function createPublisher({ events, busArn, router, log }) {
  if (!busArn) return { enabled: false, checked: async () => {}, stateChanged: async () => {} };
  const region = busArn.split(':')[3];
  const entry = (detailType, detail) => ({ EventBusName: busArn, Source: SOURCE, DetailType: detailType, Detail: JSON.stringify(detail) });

  // Calls of at most 10 entries and 256 KB.
  async function send(entries, what) {
    const calls = [];
    for (const e of entries) {
      const last = calls.at(-1);
      if (last && last.length < ENTRIES_MAX && last.reduce((n, x) => n + size(x), 0) + size(e) <= CALL_MAX) last.push(e);
      else calls.push([e]);
    }
    for (const call of calls) {
      try {
        const out = await events.putEvents({ Entries: call }, { region });
        if (out?.FailedEntryCount) log.warn('PublishFailed', { what, failed: out.FailedEntryCount, error: out.Entries?.find((x) => x.ErrorCode)?.ErrorCode });
      } catch (err) {
        log.warn('PublishFailed', { what, error: err.message });
      }
    }
  }

  return {
    enabled: true,
    // The router's state: one entry per chunk of workloads, each under 64 KB; every chunk carries the rest.
    async checked({ workloads = [], ...rest }) {
      const base = { router, ...rest };
      const baseSize = Buffer.byteLength(JSON.stringify({ ...base, chunk: { index: 9999, total: 9999 }, workloads: [] }));
      const chunks = [[]];
      let used = baseSize;
      for (const w of workloads) {
        const bytes = Buffer.byteLength(JSON.stringify(w)) + 1;
        if (chunks.at(-1).length && used + bytes > ENTRY_MAX) {
          chunks.push([]);
          used = baseSize;
        }
        chunks.at(-1).push(w);
        used += bytes;
      }
      await send(chunks.map((part, index) => entry('Router checked', { ...base, chunk: { index, total: chunks.length }, workloads: part })), 'checked');
    },
    async stateChanged(change) {
      await send([entry('Workload state changed', { router: router.name, ...change })], 'state');
    },
  };
}

// The store, with every successful state transition published (controller and waker): one place, none missed.
export function withTransitionEvents(store, publisher, { now = Date.now, log = null } = {}) {
  return Object.assign(Object.create(store), store, {
    async transition(workloadId, spec) {
      const next = await store.transition(workloadId, spec);
      const to = spec?.set?.state;
      if (next && to) {
        const from = typeof spec.cond?.state === 'string' ? spec.cond.state : null;
        const change = { workloadId, from, to, at: new Date(now()).toISOString(), ...(spec.set.wakeId ? { wakeId: spec.set.wakeId } : {}) };
        try {
          await publisher.stateChanged(change);
        } catch (err) {
          log?.warn('PublishFailed', { what: 'state', error: err.message });
        }
      }
      return next;
    },
  });
}
