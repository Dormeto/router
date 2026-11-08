// Cloud Logging: the load balancer's request logs (vision docs/specs/2026-11-07-google-cloud-fixes-design.md, section 5), what
// the idle check reads of a backend service that logs every request (its `logConfig`). Read through the router's log view
// (`dmtr-<region>-lb` on the `_Default` bucket, which the install creates, filtered to the load balancers' resource types), on
// which alone the router holds `roles/logging.viewAccessor`: never the project's logs, the applications' among them.
//
// By the load balancer's kind: global and classic log as `http_load_balancer`, the service's name in `backend_service_name`; a
// regional one as its own resource, whose labels are its metric's (monitoring.mjs, M5: `backend_target_name`, the plain name),
// and the region, as a regional service's name is unique only there. M2 (2026-11-08) read both kinds so.
//
// The entries are the requests, as many as the view holds: no count is compared with them, as Monitoring's is sampled and batched
// (M2: its points late and in lumps, 13 for minutes that logged 4, gaps of six minutes). `null` past the limit, when they cannot be
// read, or when their pages do not end within 10 (or 3 of them empty): then the count decides.
const LOGGING = 'https://logging.googleapis.com/v2';
// The resource type of the entries and the label naming the backend service, by kind; the view's filter names the same types.
const LOG_RESOURCES = {
  global: { type: 'http_load_balancer', service: 'backend_service_name' },
  regional: { type: 'http_external_regional_lb_rule', service: 'backend_target_name' },
};

export const CALLS = {
  requests: ['logging.views.access'],
};

// The pages of one read, and those of them that carry a token and no entry (Logging's partial answers): past either, the read is cut
// short, null, and the count decides. It runs on an idle nap's path while visitors may be at the waker, and every page spends the
// project's entries.list quota, which other workloads' reads need in the same minute.
const PAGES_MAX = 10;
const EMPTY_PAGES_MAX = 3;

function filterOf(backendService, lb, from, to) {
  const regional = lb?.kind === 'regional';
  if (regional && !lb.region) throw new Error(`backend service ${backendService}: a regional load balancer with no region reads no request logs`);
  const { type, service } = LOG_RESOURCES[regional ? 'regional' : 'global'];
  return [
    `resource.type="${type}"`,
    `resource.labels.${service}="${backendService}"`,
    ...(regional ? [`resource.labels.region="${lb.region}"`] : []),
    `timestamp>="${new Date(from).toISOString()}"`,
    `timestamp<"${new Date(to).toISOString()}"`,
  ].join(' AND ');
}

// The path as the load balancer received it, as the waker reads its own (node:http's): what follows the scheme and the host, up to
// the query, not normalized. None: `/`.
const pathOf = (url) => (url ?? '').replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '').split(/[?#]/)[0] || '/';

// The client's address without the port the regional load balancer logs with it (M2: `82.127.11.49:56212`; the global and classic
// ones log none): IPv4 `a.b.c.d:port`, IPv6 `[addr]:port`. A bare IPv6 address is left as it is, its colons its own.
const addressOf = (remoteIp) => remoteIp?.replace(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/, '$1').replace(/^\[([^\]]+)\](?::\d+)?$/, '$1');

const requestOf = ({ httpRequest: h = {} }) => ({
  method: h.requestMethod, url: h.requestUrl, path: pathOf(h.requestUrl), userAgent: h.userAgent, remoteIp: addressOf(h.remoteIp),
});

export function createLogs({ google, view, log }) {
  const unread = (level, backendService, reason) => {
    log[level]('LogsUnread', { backendService, reason });
    return null;
  };

  // The requests the backend service's entries hold over [from, to) (ms), oldest first, at most `limit`, through any URL map:
  // `[{ method, url, path, userAgent, remoteIp }]`, or null. `lb`: the workload's load balancer, absent for a global one.
  async function requests({ backendService, lb, from, to, limit }) {
    const entries = [];
    try {
      const filter = filterOf(backendService, lb, from, to);
      let page = '';
      let pages = 0;
      let empty = 0;
      do {
        const answer = await google.request('POST', `${LOGGING}/entries:list`, {
          resourceNames: [view], filter, orderBy: 'timestamp asc', pageSize: limit - entries.length, ...(page ? { pageToken: page } : {}),
        });
        const found = answer.entries ?? [];
        entries.push(...found);
        page = answer.nextPageToken ?? '';
        pages += 1;
        if (page && !found.length) empty += 1;
        if (entries.length > limit || (page && entries.length >= limit)) return unread('info', backendService, `more than ${limit} entries`);
        if (page && empty > EMPTY_PAGES_MAX) return unread('info', backendService, `more than ${EMPTY_PAGES_MAX} empty pages`);
        if (page && pages >= PAGES_MAX) return unread('info', backendService, `more than ${PAGES_MAX} pages`);
      } while (page);
    } catch (err) {
      return unread('warn', backendService, err.message);
    }
    return entries.map(requestOf);
  }

  return { requests };
}
