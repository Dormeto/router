// What the waker shows while a workload waits (branded waiting page design §9): the three levels' documents and the cached favicon,
// read only when a page is about to be answered, kept per warm instance for ttlMs (the router's and the organization's, and at
// most maxEntries workloads', oldest out first). pageOf never throws and never waits for a read that was made already: a
// read that fails keeps the last value (or none) for the same time and is logged, so the page still answers.
import { resolvePage } from './page-settings.mjs';

const STUCK_MS = 10_000;

// organization: the organization's level, read from S3 (lib/organization-page.mjs): { read() } -> a page or null; without it none.
export function createWaitingPages({ store, organizationPage = null, now = Date.now, log, ttlMs = 60_000, maxEntries = 200, readMs = 1000 }) {
  const shared = { organization: { value: null }, router: { value: null } };
  const workloads = new Map();

  // The slot's value, read again when it is older than ttlMs. One read at a time per slot; a failed one keeps the value. The
  // caller waits for it readMs at most (a bound of this read alone, so a slow level costs only its own page): after that the
  // last value (or none) is used, the read goes on and fills the slot when it comes. A read pending for longer than STUCK_MS
  // is replaced.
  async function fresh(slot, what, load) {
    if (slot.at !== undefined && now() - slot.at < ttlMs) return slot.value;
    if (!slot.loading || now() - slot.startedAt > STUCK_MS) {
      slot.startedAt = now();
      const loading = (async () => {
        try {
          slot.value = await load();
        } catch (err) {
          log.warn('WaitingPageUnread', { ...what, error: String(err?.message ?? err).slice(0, 200) });
        } finally {
          if (slot.loading === loading) {
            slot.at = now();
            slot.loading = null;
          }
        }
      })();
      slot.loading = loading;
    }
    let timer;
    try {
      const expiry = new Promise((resolve) => { timer = setTimeout(() => resolve('late'), readMs); });
      if ((await Promise.race([slot.loading.then(() => 'read'), expiry])) !== 'read') {
        slot.at = now();
        log.warn('WaitingPageUnread', { ...what, error: `no answer within ${readMs} ms` });
      }
    } finally {
      clearTimeout(timer);
    }
    return slot.value;
  }

  const pageOfLevel = async (level) => (await store.getWaitingPage(level, { eventual: true }))?.page ?? null;

  function entryOf(workloadId) {
    let entry = workloads.get(workloadId);
    if (!entry) {
      entry = { page: { value: null }, favicon: { value: null } };
      workloads.set(workloadId, entry);
      if (workloads.size > maxEntries) workloads.delete(workloads.keys().next().value);
    }
    return entry;
  }

  // -> { page: { mode, title?, description?, html? }, icon: a data URI or null }, for renderPage.
  async function pageOf(workloadId) {
    try {
      const entry = workloadId ? entryOf(workloadId) : null;
      // The three levels are read together, each within its own bound.
      const [organization, router, workload] = await Promise.all([
        fresh(shared.organization, { level: 'organization' }, async () => (organizationPage ? await organizationPage.read() : null)),
        fresh(shared.router, { level: 'router' }, () => pageOfLevel('router')),
        entry ? fresh(entry.page, { level: 'workload', workloadId }, () => pageOfLevel({ workloadId })) : null,
      ]);
      const { mode, icon, title, description, html } = resolvePage(organization, router, workload);
      const shown = icon === 'auto' && entry
        ? await fresh(entry.favicon, { level: 'favicon', workloadId }, async () => (await store.getFavicon(workloadId, { eventual: true }))?.icon ?? null)
        : icon;
      return {
        page: mode === 'custom' ? { mode, html } : { mode, ...(title ? { title } : {}), ...(description ? { description } : {}) },
        icon: typeof shown === 'string' && shown.startsWith('data:') ? shown : null,
      };
    } catch (err) {
      // Not expected (the reads are guarded): the built-in page.
      log.warn('WaitingPageUnread', { error: String(err?.message ?? err).slice(0, 200) });
      return { page: { mode: 'template' }, icon: null };
    }
  }

  return { pageOf };
}
