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

// The levels of joinMinutes above a workload's (design, section 11), their readers giving each level's record: { router,
// manager }, each its value or null. A level that cannot be read is logged and counts as unset: unlike hibernation's,
// joining has no safety side, and it never fails a check or a wake.
export async function joinLevels({ router, manager, log, fields = {} }) {
  const read = async (level, reader) => {
    try {
      return (await reader?.())?.joinMinutes ?? null;
    } catch (err) {
      log.warn('JoinLevelUnreadable', { ...fields, level, error: err.message });
      return null;
    }
  };
  const [routerValue, managerValue] = await Promise.all([read('router', router), read('organization', manager)]);
  return { router: routerValue, manager: managerValue };
}

// The same levels for the waker, kept in its instance: they sit on the partition of the check and the health, and a request
// must not read them each time. levels(fields) → { router, manager }. A value (unset is one) is kept ttlMs from the moment
// it was asked for, so a change shows within ttlMs. A failed read keeps the last value (unset before any), logged once, and
// is tried again after retryMs, not at each request of a burst. Requests at once share a read.
export function createJoinLevelsCache({ router, manager, now = Date.now, log, ttlMs = 60_000, retryMs = 5_000 }) {
  const slots = { router: { reader: router, value: null, until: -Infinity }, organization: { reader: manager, value: null, until: -Infinity } };
  const read = async (level, fields) => {
    const slot = slots[level];
    if (now() < slot.until) return slot.value;
    const asked = now();
    slot.loading ??= Promise.resolve().then(() => slot.reader?.()).then((record) => {
      slot.value = record ?? null;
      slot.until = asked + ttlMs;
    }, (err) => {
      // The last record read stays until a read succeeds (review, 2026-11-04): none read yet, the level is unset.
      log.warn('JoinLevelUnreadable', { ...fields, level, error: err.message });
      slot.until = asked + retryMs;
    }).finally(() => { slot.loading = null; });
    await slot.loading;
    return slot.value;
  };
  return {
    async levels(fields = {}) {
      const { router: routerRecord, manager: managerRecord } = await this.records(fields);
      return { router: routerRecord?.joinMinutes ?? null, manager: managerRecord?.joinMinutes ?? null };
    },
    // The whole records (settings at scale design §6: the defaults and types beside the join), kept the same way.
    async records(fields = {}) {
      const [routerRecord, managerRecord] = await Promise.all([read('router', fields), read('organization', fields)]);
      return { router: routerRecord, manager: managerRecord };
    },
  };
}

// s3.getObjectIf({ bucket, key, etag }) → { notModified: true } | { body: Buffer, etag }: the S3 port of lib/catalog.mjs.
// catalogUrl: the catalog the router reads, which proves an AccessDenied on settings.json means "missing".
export function createManagerSettings({ s3, url, catalogUrl = null, store, now = Date.now, log, checkMs = CHECK_MS }) {
  const where = parseUrl(url);
  const catalog = parseUrl(catalogUrl);
  // Nothing read yet: the level is unknown (null), never the built-in true, until a read succeeds (naps stop plainly).
  const initial = { hibernate: null, joinMinutes: null, endedWindowDays: null, defaults: {}, types: [], etag: null, readAt: null, error: null };

  const catalogReads = async () => {
    if (!catalog) return false;
    try {
      await s3.getObjectIf({ bucket: catalog.bucket, key: catalog.key, etag: null });
      return true;
    } catch {
      return false;
    }
  };

  async function refresh() {
    if (!where) return;
    const stored = await store.getManagerSettings();
    // Due from the last attempt, success or failure: a failing S3 is tried again every 5 minutes, not at every check.
    // A minute early: readAt is taken mid-check, so a due read is not skipped by the next check and delayed by a whole period.
    if (stored?.readAt != null && now() - stored.readAt < checkMs - 60_000) return;
    const last = stored ?? initial;
    const at = now();
    let next;
    try {
      // A copy from before joinMinutes or endedWindowDays is read in full: its ETag would answer 304 and hide a value already in the file.
      // So is a copy from before the defaults and types (settings at scale): every copy since holds both keys.
      const older = last.joinMinutes === undefined || last.endedWindowDays === undefined || last.defaults === undefined;
      const out = await s3.getObjectIf({ bucket: where.bucket, key: where.key, etag: older ? null : last.etag });
      // Unchanged: an invalid part it holds is still its error (one read with the file's own ETag); an unparseable file kept
      // the last good one's, so a 304 says it is back (review, 2026-11-04).
      if (out.notModified) next = { ...last, readAt: at, error: last.error?.startsWith('settings.json: ') ? last.error : null };
      else {
        try {
          const { problems, defaults = {}, types = [], ...values } = parseManagerSettings(out.body.toString('utf8'));
          // An invalid part is dropped and its first problem is the error: the rest applies.
          next = { ...values, defaults, types, etag: out.etag, readAt: at, error: problems ? `settings.json: ${problems[0]}` : null };
        } catch (err) {
          next = { ...last, readAt: at, error: `settings.json is invalid: ${err.message}` };
        }
      }
    } catch (err) {
      // Without s3:ListBucket (the routers' roles have none), a missing object answers AccessDenied: never set, but only
      // in a bucket whose catalog the router reads (as lib/catalog.mjs).
      const neverSet = err.name === 'NoSuchKey' || (err.name === 'AccessDenied' && await catalogReads());
      if (neverSet) next = { hibernate: true, joinMinutes: null, endedWindowDays: null, defaults: {}, types: [], etag: null, readAt: at, error: null };
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
    // The last known values, from the table: { hibernate, joinMinutes, endedWindowDays, readAt, error }, hibernate null while
    // every read failed; null without a settings URL or before any read. A copy stored before endedWindowDays has no such key:
    // not known yet, which removes nothing, where null (unset) is the default.
    async current() {
      if (!where) return null;
      const stored = await store.getManagerSettings();
      if (!stored) return null;
      return {
        hibernate: stored.hibernate, joinMinutes: stored.joinMinutes ?? null,
        ...(stored.endedWindowDays === undefined ? {} : { endedWindowDays: stored.endedWindowDays }),
        // The organization's defaults and types (settings at scale design §6), each only when there is one.
        ...(stored.defaults && Object.keys(stored.defaults).length ? { defaults: stored.defaults } : {}),
        ...(stored.types?.length ? { types: stored.types } : {}),
        readAt: stored.readAt, error: stored.error,
      };
    },
  };
}
