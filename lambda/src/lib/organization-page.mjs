// The organization's waiting page (branded waiting page design §5): the `waitingPage` key of the manager's settings.json, read
// by the waker and the controller directly from S3 with a conditional GET. No copy in the router's table; the callers cache it
// (waiting-pages.mjs, 60 s) and bound it. Apart from hibernate (manager-settings.mjs): neither key unreads the other.
import { cleanPage } from './page-settings.mjs';

const parseUrl = (url) => {
  const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(url ?? '');
  return match ? { bucket: match[1], key: match[2] } : null;
};

// s3.getObjectIf({ bucket, key, etag, signal }) → { notModified: true } | { body: Buffer, etag }.
// catalogUrl: proves an AccessDenied on settings.json means "missing" (the routers' roles have no s3:ListBucket).
export function createOrganizationPage({ s3, url, catalogUrl = null, log }) {
  const where = parseUrl(url);
  const catalog = parseUrl(catalogUrl);
  let last = { etag: null, page: null };

  const catalogReads = async () => {
    if (!catalog) return false;
    try {
      await s3.getObjectIf({ ...catalog, etag: null });
      return true;
    } catch {
      return false;
    }
  };

  return {
    // The page: what is valid of the key, or null (none, a router without a catalog). The last page while the file is not
    // JSON or unchanged (304); a failed read throws, for the caller to keep its last value and log.
    async read({ signal } = {}) {
      if (!where) return null;
      let out;
      try {
        out = await s3.getObjectIf({ ...where, etag: last.etag, signal });
      } catch (err) {
        if (err.name === 'NoSuchKey' || (err.name === 'AccessDenied' && await catalogReads())) {
          last = { etag: null, page: null };
          return null;
        }
        throw err;
      }
      if (out.notModified) return last.page;
      try {
        const doc = JSON.parse(out.body.toString('utf8'));
        const isObject = doc && typeof doc === 'object' && !Array.isArray(doc);
        last = { etag: out.etag, page: isObject ? cleanPage(doc.waitingPage) : null };
      } catch (err) {
        // Not JSON: the check reports it for hibernate; the page stays as it was.
        log?.warn('WaitingPageSettingsInvalid', { error: err.message });
      }
      return last.page;
    },
  };
}
