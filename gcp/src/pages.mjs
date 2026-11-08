// The waiting page on Google Cloud (vision docs/specs/2026-11-08-google-cloud-router-features-design.md, section 5.2), beside AWS's
// shared code (page-settings.mjs, waiting-pages.mjs, favicon.mjs).
//
// Custom HTML runs on the application's address. On AWS only an administrator may set it; here anyone who can invoke the controller is
// an operator, so custom pages are off unless the install turns them on: `dormeto gcp install --custom-pages` sets DMT_CUSTOM_PAGES=1 on
// the controller and the waker. Off, a custom page is refused at its write, and one already stored is read as absent: the template
// levels or the default page show. It stays stored, and its level's answer says it is not served, until it is cleared or the switch
// comes back: turning the switch off stops customer HTML at once.

export const CUSTOM_PAGES_REFUSED = 'custom pages are off on this router: an administrator turns them on with dormeto gcp install --custom-pages';
export const CUSTOM_PAGE_NOT_SERVED = 'custom pages are off on this router: this page is not served';

// The install's switch, from a service's environment.
export const customPagesOf = (env) => env.DMT_CUSTOM_PAGES === '1';

const isCustom = (page) => page?.mode === 'custom';

// The page as visitors may be shown it: a custom one is none while custom pages are off.
export const servedPage = (customPages) => (page) => (!customPages && isCustom(page) ? null : page ?? null);

// Whether a level's own page is a custom one the switch keeps from visitors.
export const notServed = (customPages, page) => !customPages && isCustom(page);

// The store as the waiting page reads its levels (waiting-pages.mjs): each page through servedPage.
export function servedStore(store, customPages) {
  const served = servedPage(customPages);
  return {
    getWaitingPage: async (level, options) => {
      const doc = await store.getWaitingPage(level, options);
      return doc && { ...doc, page: served(doc.page) };
    },
    getFavicon: (workloadId, options) => store.getFavicon(workloadId, options),
  };
}

// The load balancers visitors reach from the internet, as the nap's favicon read does. An internal one gets no icon, as on AWS: a kind
// not named here (internal, cross-region-internal) reads none.
const FROM_THE_INTERNET = new Set(['global', 'regional', 'classic']);
export const faviconReachable = (lb) => FROM_THE_INTERNET.has(lb?.kind ?? 'global');
