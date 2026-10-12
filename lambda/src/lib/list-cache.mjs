// Waker side of the IP reputation lists: one lookup structure per list and container, refreshed when the controller
// stored a new version (META checked every few minutes).
import { FORMAT, unpackList } from './ip-lists.mjs';

const CHECK_MS = 5 * 60_000;
const ACTIONS = new Set(['defer', 'ignore']);

// Router lists from the environment (Terraform ip_lists): [{ name, url, action, refreshHours }].
export function parseLists(text, onError = () => {}) {
  if (!text) return [];
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    onError(err.message);
    return [];
  }
  const lists = [];
  for (const list of Array.isArray(raw) ? raw : []) {
    if (!list?.name || !/^https?:\/\//.test(list.url ?? '') || !ACTIONS.has(list.action ?? 'defer')) {
      onError(`invalid list: ${JSON.stringify(list)}`);
      continue;
    }
    lists.push({ name: list.name, url: list.url, action: list.action ?? 'defer', refreshHours: Number(list.refreshHours) || 24 });
  }
  return lists;
}

export function createListCache({ store, lists, now = Date.now, log, checkMs = CHECK_MS }) {
  const loaded = new Map();

  async function load(list) {
    const current = loaded.get(list.name);
    if (current && now() - current.checkedAt < checkMs) return current;
    try {
      const meta = await store.getListMeta(list.name);
      if (!meta?.version) {
        const entry = { version: null, set: null, meta, checkedAt: now() };
        loaded.set(list.name, entry);
        return entry;
      }
      if (current?.version === meta.version) {
        Object.assign(current, { meta, checkedAt: now(), error: undefined });
        return current;
      }
      if (meta.format !== FORMAT) throw new Error(`stored format ${meta.format ?? 'text'}: waiting for the controller to rewrite it`);
      const started = Date.now();
      const parts = await store.getListParts(list.name, meta.version);
      if (parts.length !== meta.parts) throw new Error(`version ${meta.version}: ${parts.length} of ${meta.parts} parts`);
      const entry = { version: meta.version, set: unpackList(parts), meta, checkedAt: now() };
      loaded.set(list.name, entry);
      log.info('ListLoaded', { name: list.name, version: meta.version, ranges: entry.set.size, ms: Date.now() - started });
      return entry;
    } catch (err) {
      log.warn('ListLoadFailed', { name: list.name, error: err.message });
      // Keep the previous version; without one, wait for the next check instead of retrying on every request.
      const entry = current ?? { version: null, set: null, meta: null };
      Object.assign(entry, { checkedAt: now(), error: err.message });
      loaded.set(list.name, entry);
      return entry;
    }
  }

  const loadAll = () => Promise.all(lists.map(async (list) => ({ list, entry: await load(list) })));

  return {
    // Loaded lists only: [{ name, action, has(ip) }].
    async get() {
      return (await loadAll()).filter(({ entry }) => entry.set)
        .map(({ list, entry }) => ({ name: list.name, action: list.action, has: (ip) => entry.set.has(ip) }));
    },
    // For the dashboard: [{ name, action, entries, fetchedAt, dropped, error }].
    async describe() {
      return (await loadAll()).map(({ list, entry }) => ({
        name: list.name,
        action: list.action,
        entries: entry.set ? entry.meta?.entries ?? 0 : 0,
        dropped: entry.meta?.dropped ?? 0,
        fetchedAt: entry.meta?.fetchedAt ? new Date(entry.meta.fetchedAt).toISOString() : null,
        error: entry.error ?? entry.meta?.error ?? (entry.set ? undefined : 'not downloaded yet'),
      }));
    },
  };
}
