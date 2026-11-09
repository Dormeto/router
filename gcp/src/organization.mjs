// The organization's level on Google Cloud (G2 spec §5.5): the manager's whole settings.json, pushed to `router/manager`
// ({ settings, etag, at }) and read through AWS's own parsing (lambda/src/lib/hibernation.mjs, page-settings.mjs), so that both clouds
// read the same file alike. One answer for every consumer: the levels read `level` (what AWS's manager settings answer), the waiting
// page `page`, the health `error` and `readAt`.
import { parseManagerSettings } from '../../lambda/src/lib/hibernation.mjs';
import { cleanPage } from '../../lambda/src/lib/page-settings.mjs';

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

// stored: the store's getManagerSettings answer, or null (none pushed: unset, no problem). A document that is not an object (or whose
// hibernate is not a boolean) is unset, and its error is what the health warns of (manager-settings-unreadable); an invalid part
// is dropped and said, the rest applies. `level`: { hibernate, joinMinutes, endedWindowDays, defaults?, types? }, as the AWS router
// mirrors it; `page`: the waitingPage key's valid part, or null.
export function organizationOf(stored) {
  if (!stored) return { level: null, page: null, error: null, readAt: null };
  const readAt = stored.at ? stored.at : null;
  try {
    if (!isObject(stored.settings)) throw new Error('settings.json must be an object');
    const { problems, defaults = {}, types = [], ...values } = parseManagerSettings(JSON.stringify(stored.settings));
    return {
      level: { ...values, ...(Object.keys(defaults).length ? { defaults } : {}), ...(types.length ? { types } : {}) },
      page: cleanPage(stored.settings.waitingPage),
      error: problems ? `settings.json: ${problems[0]}` : null,
      readAt,
    };
  } catch (err) {
    return { level: null, page: null, error: `settings.json is invalid: ${err.message}`, readAt };
  }
}
