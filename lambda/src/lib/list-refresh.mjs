// Controller side of the IP reputation lists: download, filter and store a new version of each due list.
import { FORMAT, dropReserved, packList, parseList } from './ip-lists.mjs';

const HOUR_MS = 3_600_000;
// A failed download of the same URL is retried at most once an hour.
const RETRY_MS = HOUR_MS;
// Parts of a version expire 30 days after its download (later versions replace it long before).
const PART_TTL_S = 30 * 86_400;

// s3://bucket/key: a list stored in S3 (private lists, lists prepared elsewhere), read with the S3 API.
const S3_URL = /^s3:\/\/([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])\/(.+)$/;

export function parseS3Url(url) {
  const match = S3_URL.exec(url ?? '');
  return match ? { bucket: match[1], key: match[2] } : null;
}

// Supported list sources: http(s) URLs and S3 URIs.
export const isListUrl = (url) => /^https?:\/\//.test(url ?? '') || parseS3Url(url) !== null;

// getObject({ bucket, key, signal }) returns the object body (async iterable of chunks): the S3 port of the controller.
export async function downloadText(url, { fetch = globalThis.fetch, getObject, timeoutMs = 20_000, maxBytes = 20 * 1024 * 1024 } = {}) {
  const signal = AbortSignal.timeout(timeoutMs);
  const s3 = parseS3Url(url);
  let body;
  if (s3) {
    if (!getObject) throw new Error('S3 lists need the S3 client');
    try {
      body = await getObject({ ...s3, signal });
    } catch (err) {
      // S3 service errors carry their code in the name (NoSuchKey, AccessDenied, NoSuchBucket).
      throw new Error(`S3 ${err.name}`);
    }
  } else {
    const res = await fetch(url, { signal, headers: { 'user-agent': 'dormeto-router' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    body = res.body;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > maxBytes) throw new Error(`larger than ${maxBytes} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createListRefresher({ store, lists, download = downloadText, now = Date.now, log }) {
  async function due() {
    const names = [];
    for (const list of lists) {
      const meta = await store.getListMeta(list.name);
      const stale = meta?.url !== list.url || meta?.format !== FORMAT || now() - (meta?.fetchedAt ?? 0) >= list.refreshHours * HOUR_MS;
      // A new URL or a new stored format (router upgrade) is tried at once, a failure again after RETRY_MS.
      const retry = meta?.attemptUrl !== list.url || meta?.attemptFormat !== FORMAT || now() - (meta?.lastAttemptAt ?? 0) >= RETRY_MS;
      if (stale && retry) names.push(list.name);
    }
    return names;
  }

  async function refreshOne(list) {
    const started = now();
    await store.setListMeta(list.name, { lastAttemptAt: started, attemptUrl: list.url, attemptFormat: FORMAT });
    try {
      const { entries, invalid } = parseList(await download(list.url));
      const { kept, dropped } = dropReserved(entries);
      if (!kept.length) throw new Error(`no usable entry (${dropped} reserved, ${invalid} invalid)`);
      const parts = packList(kept);
      const version = String(started);
      const expiresAt = Math.floor(started / 1000) + PART_TTL_S;
      // Every part of the new version first, then META: readers never see a partial version.
      for (const [index, part] of parts.entries()) await store.putListPart(list.name, version, index, part, expiresAt);
      await store.setListMeta(list.name, {
        version, format: FORMAT, parts: parts.length, entries: kept.length, dropped, invalid, url: list.url, fetchedAt: now(),
      }, ['error', 'errorAt']);
      log.info('ListRefreshed', { name: list.name, entries: kept.length, dropped, invalid, parts: parts.length });
      return { name: list.name, entries: kept.length, dropped };
    } catch (err) {
      await store.setListMeta(list.name, { error: err.message, errorAt: now() });
      log.error('ListRefreshFailed', { name: list.name, url: list.url, error: err.message });
      return { name: list.name, error: err.message };
    }
  }

  async function refresh(names) {
    const results = [];
    for (const list of lists.filter((l) => names.includes(l.name))) results.push(await refreshOne(list));
    return results;
  }

  return { due, refresh };
}
