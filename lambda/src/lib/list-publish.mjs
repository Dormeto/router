// The manager's list function (vision docs/specs/2026-10-08-reliability-security-design.md, R6b): each list of the
// catalog downloaded once for every router, checked, packed into one object of the manager's bucket with its manifest,
// and its state in status.json. Runs in the manager's account from the router bundle: the format has one owner.
import { createHash } from 'node:crypto';
import { FORMAT, dropReserved, packList, parseList } from './ip-lists.mjs';

const HOUR_MS = 3_600_000;
// A failed download of the same URL is retried at most once an hour.
const RETRY_MS = HOUR_MS;
// The data objects expire 30 days after they are written (bucket lifecycle): a version kept longer is written again.
const REWRITE_MS = 20 * 24 * HOUR_MS;
// A new version with fewer than half the entries of the current one, from the same URL, is refused.
const SHRINK = 0.5;

// s3: { getObjectIf({ bucket, key }), putObject({ bucket, key, body, contentType }), deleteObject({ bucket, key }) }.
export function createListPublisher({ s3, bucket, prefix = '', download, now = Date.now, log }) {
  const key = (k) => `${prefix}${k}`;
  const readJson = async (k, fallback) => {
    try {
      return JSON.parse((await s3.getObjectIf({ bucket, key: key(k) })).body.toString('utf8'));
    } catch (err) {
      if (err.name === 'NoSuchKey') return fallback;
      throw err;
    }
  };
  const putJson = (k, value) => s3.putObject({ bucket, key: key(k), body: `${JSON.stringify(value)}\n`, contentType: 'application/json' });
  const iso = (ms) => new Date(ms).toISOString();

  const due = (list, line, t) => {
    const stale = line?.url !== list.url || line?.format !== FORMAT || t - Date.parse(line?.fetchedAt ?? 0) >= list.refreshHours * HOUR_MS;
    const retry = line?.attemptUrl !== list.url || t - Date.parse(line?.lastAttemptAt ?? 0) >= RETRY_MS;
    return stale && retry;
  };

  async function refresh(list, line, t) {
    const attempt = { name: list.name, url: list.url, refreshHours: list.refreshHours, lastAttemptAt: iso(t), attemptUrl: list.url };
    try {
      const { entries, invalid } = parseList(await download(list.url));
      const { kept, dropped } = dropReserved(entries);
      if (!kept.length) throw new Error(`no usable entry (${dropped} reserved, ${invalid} invalid)`);
      if (line?.url === list.url && line.entries && kept.length < SHRINK * line.entries) {
        throw new Error(`shrank from ${line.entries} to ${kept.length} entries: the previous version is kept`);
      }
      const data = Buffer.concat(packList(kept));
      const version = String(t);
      const dataKey = `${list.name}/${version}.bin`;
      const manifest = {
        name: list.name, version, format: FORMAT, entries: kept.length, dropped, invalid, bytes: data.length,
        sha256: createHash('sha256').update(data).digest('hex'), fetchedAt: iso(t), refreshHours: list.refreshHours, key: dataKey,
      };
      // The data first, then its manifest: a router never reads a manifest whose data is missing.
      await s3.putObject({ bucket, key: key(dataKey), body: data, contentType: 'application/octet-stream' });
      await putJson(`${list.name}/manifest.json`, manifest);
      log.info('ListPublished', { name: list.name, entries: kept.length, dropped, invalid, bytes: data.length });
      return { ...attempt, version, format: FORMAT, entries: kept.length, dropped, invalid, fetchedAt: iso(t), writtenAt: iso(t), key: dataKey };
    } catch (err) {
      log.error('ListNotPublished', { name: list.name, url: list.url, error: err.message });
      return { ...line, ...attempt, error: err.message, errorAt: iso(t) };
    }
  }

  // The current data written again under a new key, the same version: routers keep what they loaded.
  async function rewrite(list, line, t) {
    const manifest = await readJson(`${list.name}/manifest.json`, null);
    if (!manifest?.key) return line;
    const data = (await s3.getObjectIf({ bucket, key: key(manifest.key) })).body;
    const dataKey = `${list.name}/${manifest.version}-${t}.bin`;
    await s3.putObject({ bucket, key: key(dataKey), body: data, contentType: 'application/octet-stream' });
    await putJson(`${list.name}/manifest.json`, { ...manifest, key: dataKey });
    log.info('ListRewritten', { name: list.name, version: manifest.version });
    return { ...line, writtenAt: iso(t), key: dataKey };
  }

  return {
    async run() {
      const t = now();
      const catalog = await readJson('catalog.json', { lists: [] });
      const status = await readJson('status.json', { lists: [] });
      const lines = new Map((status.lists ?? []).map((l) => [l.name, l]));
      const lists = (catalog.lists ?? []).map((l) => ({ name: l.name, url: l.url, refreshHours: Number(l.refreshHours) || 24 }));
      const save = () => putJson('status.json', { lists: lists.map((l) => lines.get(l.name)).filter(Boolean) });
      for (const list of lists) {
        const line = lines.get(list.name);
        try {
          let next = due(list, line, t) ? await refresh(list, line, t) : line;
          // Still the old version (no refresh due, or a failed one): written again before its data expires.
          if (next?.writtenAt && t - Date.parse(next.writtenAt) >= REWRITE_MS) next = await rewrite(list, next, t);
          if (next === line) continue;
          lines.set(list.name, next);
        } catch (err) {
          // The bucket itself failed (refresh records its own errors): the next run tries again.
          log.error('ListNotPublished', { name: list.name, error: err.message });
          continue;
        }
        // Saved after each list: a run cut short keeps what it did.
        await save();
      }
      // Lists removed from the catalog: out of the status, their manifest deleted (their data expires).
      const removed = [...lines.keys()].filter((name) => !lists.some((l) => l.name === name));
      for (const name of removed) {
        await s3.deleteObject({ bucket, key: key(`${name}/manifest.json`) });
        lines.delete(name);
        log.info('ListRemoved', { name });
      }
      if (removed.length) await save();
      return { lists: lists.length, removed: removed.length };
    },
  };
}
