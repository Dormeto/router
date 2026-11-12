// The idle check's activity (vision docs/specs/2026-11-07-google-cloud-fixes-design.md, section 5): of the requests the load
// balancer logged (logs.mjs), those the waker would not ignore. Each is read as the waker reads its own request (waker.mjs) and
// classified by the shared code (lambda/src/lib/http.mjs): HEAD, the built-in bots and scanner paths, the router's IP lists, and
// the no-wake rules of every level (vision docs/specs/2026-11-08-google-cloud-router-features-design.md, section 4.4). A request the
// waker defers (a deferred list, browser mode) is activity: a visitor's browser behind it wakes the workload through the page's probe.
import { classify } from '../../lambda/src/lib/http.mjs';
import { createRulesFor } from '../../lambda/src/lib/no-wake.mjs';
import { eventOf } from './waker.mjs';

// A logged request as the waker's event: the user agent a header, and the logged address the client's, the last X-Forwarded-For
// entry once the load balancer's own is dropped, as `clientIp` reads it and the lists and rules match it.
export function eventOfRequest({ method, path, userAgent, remoteIp }) {
  const event = eventOf({ method, url: path, headers: userAgent ? { 'user-agent': userAgent } : {} });
  return { ...event, headers: { ...event.headers, 'x-forwarded-for': remoteIp ?? '' } };
}

// The requests `classify` would not ignore. `lists`: the router's lists as the waker's cache holds them; `rules`: no-wake rules.
export function activityOf(requests, { lists = [], rules = [] } = {}) {
  return requests.filter((request) => classify(eventOfRequest(request), rules, { lists }).kind !== 'no-wake').length;
}

// A workload's no-wake rules as the waker gets them (lambda/src/lib/waker-core.mjs): every level of the resolved configuration's
// `ruleLevels`, the most general first, each list compiled once per instance (no-wake.mjs's createRulesFor). An invalid rule is
// skipped, so that its requests are activity (more wakes, never fewer), and said once.
export function createNoWakeRules(log) {
  const rulesFor = createRulesFor(log);
  return (cfg) => (cfg.ruleLevels?.noWake ?? []).flatMap(({ level, rules }) => rulesFor(level, rules));
}
