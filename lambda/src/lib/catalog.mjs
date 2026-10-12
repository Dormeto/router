// IP lists distributed by the manager (vision docs/specs/2026-10-08-reliability-security-design.md, R6b): its catalog,
// and each list's manifest and data, read from its bucket with conditional GETs at most every 5 minutes. Nothing goes to
// the router table; a list's data is read only when its manifest names a new version, and checked against it.
import { createHash } from 'node:crypto';
import { FORMAT, unpackList } from './ip-lists.mjs';

const CHECK_MS = 5 * 60_000;
const ACTIONS = new Set(['defer', 'ignore']);
const NAME = /^[A-Za-z0-9._-]{1,64}$/;

// s3://bucket/[prefix/]catalog.json: the manifests and data are under the catalog's prefix.
export function parseCatalogUrl(url) {
  const match = /^s3:\/\/([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])\/((?:.+\/)?)([^/]+)$/.exec(url ?? '');
  return match ? { bucket: match[1], key: `${match[2]}${match[3]}`, prefix: match[2] } : null;
}

const s3Error = (err) => (err.name === 'NoSuchKey' ? 'NoSuchKey' : `S3 ${err.name}`);

// s3.getObjectIf({ bucket, key, etag }) → { notModified: true } | { body: Buffer, etag }: the S3 port.
// own: names of the router's own lists (Terraform ip_lists), which win over the catalog's.
export function createCatalog({ s3, url, own = [], now = Date.now, log, checkMs = CHECK_MS }) {
  const where = parseCatalogUrl(url);
  const catalog = { etag: null, entries: [], checkedAt: -Infinity, error: null };
  const lists = new Map();
  const shadowedLogged = new Set();
  const read = (key, etag) => s3.getObjectIf({ bucket: where.bucket, key, etag });

  async function readCatalog() {
    try {
      const out = await read(where.key, catalog.etag);
      if (out.notModified) return;
      const parsed = JSON.parse(out.body.toString('utf8'));
      const entries = [];
      for (const l of Array.isArray(parsed?.lists) ? parsed.lists : []) {
        if (!NAME.test(l?.name ?? '') || !ACTIONS.has(l.action ?? 'defer')) {
          log.warn('CatalogListInvalid', { list: JSON.stringify(l) });
          continue;
        }
        if (own.includes(l.name)) {
          if (!shadowedLogged.has(l.name)) log.info('CatalogListShadowed', { name: l.name });
          shadowedLogged.add(l.name);
          continue;
        }
        entries.push({ name: l.name, action: l.action ?? 'defer', refreshHours: Number(l.refreshHours) || 24 });
      }
      Object.assign(catalog, { etag: out.etag, entries, error: null });
    } catch (err) {
      catalog.error = err instanceof SyntaxError ? `catalog is not JSON: ${err.message}` : s3Error(err);
      log.warn('CatalogUnreadable', { url, error: catalog.error });
    }
  }

  async function readManifest(entry) {
    const state = lists.get(entry.name) ?? { manifestEtag: null, manifest: null, version: null, set: null, error: null, pending: false };
    lists.set(entry.name, state);
    try {
      const out = await read(`${where.prefix}${entry.name}/manifest.json`, state.manifestEtag);
      if (!out.notModified) Object.assign(state, { manifest: JSON.parse(out.body.toString('utf8')), manifestEtag: out.etag });
      Object.assign(state, { pending: false });
      if (state.version === state.manifest?.version) state.error = null;
    } catch (err) {
      // Without s3:ListBucket (the routers' roles have none), a missing object answers AccessDenied: in the bucket whose
      // catalog was just read, that is a list not published yet.
      const pending = err.name === 'NoSuchKey' || (err.name === 'AccessDenied' && !catalog.error);
      Object.assign(state, { pending, error: pending ? 'not published by the manager yet' : s3Error(err) });
    }
    return state;
  }

  // The list's data for the manifest's version: its size, SHA-256 and format checked before it replaces the loaded one.
  async function loadData(entry, state) {
    const m = state.manifest;
    if (!m?.version || state.version === m.version) return;
    try {
      if (m.format !== FORMAT) throw new Error(`format ${m.format}, this router reads ${FORMAT}`);
      const out = await read(`${where.prefix}${m.key ?? `${entry.name}/${m.version}.bin`}`, null);
      const data = out.body;
      if (data.length !== m.bytes) throw new Error(`${data.length} bytes, the manifest says ${m.bytes}`);
      if (createHash('sha256').update(data).digest('hex') !== m.sha256) throw new Error('SHA-256 differs from the manifest');
      const started = Date.now();
      Object.assign(state, { set: unpackList([data]), version: m.version, error: null });
      log.info('ListLoaded', { name: entry.name, version: m.version, ranges: state.set.size, ms: Date.now() - started, source: 'manager' });
    } catch (err) {
      state.error = `version ${m.version}: ${err.name === 'Error' ? err.message : s3Error(err)}`;
      log.warn('ListLoadFailed', { name: entry.name, error: state.error, source: 'manager' });
    }
  }

  let checking = null;
  async function sync({ data }) {
    if (now() - catalog.checkedAt >= checkMs) {
      // One check at a time per container: requests arriving meanwhile wait for it.
      checking ??= (async () => {
        catalog.checkedAt = now();
        await readCatalog();
        await Promise.all(catalog.entries.map(readManifest));
      })().finally(() => { checking = null; });
    }
    await checking;
    if (data) await Promise.all(catalog.entries.map((e) => loadData(e, lists.get(e.name))));
  }

  return {
    url,
    // Loaded lists: [{ name, action, has(ip) }].
    async get() {
      await sync({ data: true });
      return catalog.entries.map((e) => ({ e, state: lists.get(e.name) })).filter(({ state }) => state?.set)
        .map(({ e, state }) => ({ name: e.name, action: e.action, has: (ip) => state.set.has(ip) }));
    },
    // The catalog and its lists from their manifests (the data is not read): { url, error, lists: [...] }.
    async describe() {
      await sync({ data: false });
      return {
        url,
        error: catalog.error,
        lists: catalog.entries.map((e) => {
          const state = lists.get(e.name) ?? {};
          const m = state.manifest;
          return {
            name: e.name, action: e.action, source: 'manager', refreshHours: e.refreshHours,
            entries: m?.entries ?? 0,
            ...(m ? { dropped: m.dropped ?? 0, version: m.version, fetchedAt: m.fetchedAt } : {}),
            ...(state.pending ? { pending: true } : {}),
            ...(state.error ? { error: state.error } : {}),
          };
        }),
      };
    },
  };
}
