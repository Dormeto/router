// The manager's global settings (hibernation design §3): settings.json beside the IP lists catalog, read with a
// conditional GET at most every 5 minutes by the check, and mirrored in the router table so a cold Lambda and a nap read
// the last known value from the table, never from S3.
import { parseManagerSettings } from './hibernation.mjs';

const CHECK_MS = 5 * 60_000;

// s3://bucket/[prefix/]object (the bucket's name is S3's to judge: a wrong one shows as the read's error).
const parseUrl = (url) => {
  const match = /^s3:\/\/([^/]+)\/((?:.+\/)?)([^/]+)$/.exec(url ?? '');
  return match ? { bucket: match[1], prefix: match[2], key: `${match[2]}${match[3]}` } : null;
};

// The catalog's prefix + settings.json; null without a catalog.
export function settingsUrlOf(catalogUrl) {
  const where = parseUrl(catalogUrl);
  return where ? `s3://${where.bucket}/${where.prefix}settings.json` : null;
}

// s3.getObjectIf({ bucket, key, etag }) → { notModified: true } | { body: Buffer, etag }: the S3 port of lib/catalog.mjs.
export function createManagerSettings({ s3, url, store, now = Date.now, log, checkMs = CHECK_MS }) {
  const where = parseUrl(url);
  const initial = { hibernate: true, etag: null, readAt: null, error: null };

  async function refresh() {
    if (!where) return;
    const stored = await store.getManagerSettings();
    // Due from the last attempt, success or failure: a failing S3 is tried again every 5 minutes, not at every check.
    if (stored?.readAt != null && now() - stored.readAt < checkMs) return;
    const last = stored ?? initial;
    const at = now();
    let next;
    try {
      const out = await s3.getObjectIf({ bucket: where.bucket, key: where.key, etag: last.etag });
      if (out.notModified) next = { ...last, readAt: at, error: null };
      else {
        try {
          next = { hibernate: parseManagerSettings(out.body.toString('utf8')).hibernate, etag: out.etag, readAt: at, error: null };
        } catch (err) {
          next = { ...last, readAt: at, error: `settings.json is invalid: ${err.message}` };
        }
      }
    } catch (err) {
      // Without s3:ListBucket (the routers' roles have none), a missing object answers AccessDenied: never set.
      if (err.name === 'NoSuchKey' || err.name === 'AccessDenied') next = { hibernate: true, etag: null, readAt: at, error: null };
      else {
        next = { ...last, readAt: at, error: `S3 ${err.name}` };
        log.warn('ManagerSettingsUnreadable', { url, error: next.error });
      }
    }
    await store.putManagerSettings(next);
  }

  return {
    url,
    refresh,
    // The last known value, from the table: { hibernate, readAt, error }; null without a settings URL or before any read.
    async current() {
      if (!where) return null;
      const stored = await store.getManagerSettings();
      return stored ? { hibernate: stored.hibernate, readAt: stored.readAt, error: stored.error } : null;
    },
  };
}
