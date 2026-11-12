// The application's favicon, read while it was awake (branded waiting page design §6): one GET of its home page, the page's icon
// link, else /favicon.ico. Everything inside one time budget, and any error ends the read as a sentence: it never throws, so
// a nap that asks for it is never failed, held or changed by it. Pure but for the injected fetch (tests use none from the network),
// and the nap's step that caches it (cacheFavicon), shared by AWS's controller and Google Cloud's.
import { iconTypeOf, resolvePage } from './page-settings.mjs';
import { STATES } from './state.mjs';

const PAGE_BYTES = 256 * 1024;
// What a read icon may weigh (uploads may be 64 KiB): it travels in every waiting page.
const ICON_BYTES = 32 * 1024;
const REDIRECTS = 3;
const AGENT = 'dormeto-router';
const LIMITS = 'the icon is not a PNG, JPEG, WebP, SVG or ICO image';
// The nap's step: a read at most once in this time, within this budget, and the grace after it that lets the result be written.
const EVERY_MS = 86_400_000;
export const FAVICON_BUDGET_MS = 3000;
const GRACE_MS = 200;

// An error that is a sentence for the dashboard (others are network errors, said as they come).
class Refused extends Error {}
class OutOfTime extends Refused {
  constructor() {
    super('the read did not finish within its time budget');
  }
}

// A literal host name: letters, digits, dots and hyphens. A wildcard, a port or anything else is no host name.
const hostName = (host) => (typeof host === 'string' && /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/i.test(host) ? host.toLowerCase() : null);

const REDIRECT = new Set([301, 302, 303, 307, 308]);
const dropBody = (res) => Promise.resolve(res?.body?.cancel?.()).catch(() => {});

// GET with the redirects followed here (at most 3), each one https. sameHost: a redirect to another host ends the read (a login
// page), as the home page does; an icon may come from a CDN.
async function get(url, ctx, { sameHost }) {
  let current = url;
  for (let followed = 0; ; followed += 1) {
    if (current.protocol !== 'https:') throw new Refused('only https addresses are read');
    if (current.username || current.password) throw new Refused('the address holds credentials');
    ctx.check();
    const res = await ctx.fetch(current.href, { method: 'GET', redirect: 'manual', credentials: 'omit', signal: ctx.signal, headers: { 'user-agent': AGENT, accept: '*/*' } });
    if (!REDIRECT.has(res?.status)) return { res, url: current };
    await dropBody(res);
    if (followed >= REDIRECTS) throw new Refused('too many redirects');
    const location = res.headers?.get?.('location');
    if (!location) throw new Refused('a redirect with no address');
    const next = new URL(location, current);
    if (sameHost && next.hostname !== url.hostname) throw new Refused('the page redirects to another host');
    current = next;
  }
}

// At most `max` bytes of the body; more is cut (truncate) or refused.
async function bytesOf(res, max, { truncate }) {
  const reader = res?.body?.getReader?.();
  if (!reader) throw new Refused('the answer has no content');
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => {});
      if (!truncate) throw new Refused('the icon is larger than 32 KiB');
      return Buffer.concat(chunks).subarray(0, max);
    }
  }
  return Buffer.concat(chunks);
}

// A data URI of the bytes' own type (from their signature, never from a header); the bytes are checked.
function iconOf(bytes) {
  if (bytes.length > ICON_BYTES) throw new Refused('the icon is larger than 32 KiB');
  const type = iconTypeOf(bytes);
  if (!type) throw new Refused(LIMITS);
  return `data:image/${type};base64,${Buffer.from(bytes).toString('base64')}`;
}

function inlineIcon(uri) {
  const found = /^data:([^,]*),([\s\S]*)$/i.exec(uri);
  if (!found) throw new Refused(LIMITS);
  const bytes = /;base64$/i.test(found[1]) ? Buffer.from(found[2], 'base64') : Buffer.from(decodeURIComponent(found[2]));
  return iconOf(bytes);
}

// The page without its comments (a commented-out link is not the page's), cut in linear time.
function withoutComments(text) {
  let out = '';
  let from = 0;
  for (;;) {
    const open = text.indexOf('<!--', from);
    if (open < 0) return out + text.slice(from);
    out += text.slice(from, open);
    const close = text.indexOf('-->', open + 4);
    if (close < 0) return out;
    from = close + 3;
  }
}

const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+))?)?/g;
const RANKS = [(tokens) => tokens.length === 1 && tokens[0] === 'icon', (tokens) => tokens.includes('icon') && tokens.includes('shortcut'),
  (tokens) => tokens.includes('apple-touch-icon') || tokens.includes('apple-touch-icon-precomposed')];
// A tag may hold an inline icon (32 KiB, as base64 or percent-encoded).
const TAG_MAX = 128 * 1024;

// The page's icon address: the first link of rel icon, then shortcut icon, then apple-touch-icon, resolved against the page;
// a data: href as it is. null when there is none. One pass:
// a "<link" inside a tag already read is not a tag, so a page of nothing but "<link" is read in linear time.
function linkOf(html, base) {
  const found = [[], [], []];
  const text = withoutComments(html);
  const opening = /<link\b/gi;
  let end = -1;
  for (let match = opening.exec(text); match; match = opening.exec(text)) {
    const from = match.index + 5;
    // Inside the tag just read (or skipped): not a tag of its own, so each character is read once.
    if (from <= end) continue;
    end = text.indexOf('>', from);
    if (end < 0) break;
    if (end - from > TAG_MAX) continue;
    const attributes = {};
    for (const [, name, double, single, bare] of text.slice(from, end).matchAll(ATTRIBUTE)) attributes[name.toLowerCase()] ??= double ?? single ?? bare ?? '';
    const tokens = String(attributes.rel ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const rank = RANKS.findIndex((is) => is(tokens));
    if (rank >= 0 && attributes.href) found[rank].push(attributes.href.replaceAll('&amp;', '&').trim());
  }
  for (const href of found.flat()) {
    if (/^data:/i.test(href)) return href;
    try {
      const url = new URL(href, base);
      if (!url.username && !url.password) return url.href;
    } catch {
      // Not an address: the next link.
    }
  }
  return null;
}

async function find(name, ctx) {
  const root = new URL(`https://${name}/`);
  let failure = null;
  // A step that fails is the next one's to replace; the first failure is the one said.
  const attempt = async (work) => {
    try {
      return await work();
    } catch (err) {
      if (err instanceof OutOfTime) throw err;
      failure ??= err;
      return null;
    }
  };
  const load = async (target) => {
    if (/^data:/i.test(target)) return inlineIcon(target);
    const { res } = await get(new URL(target), ctx, { sameHost: false });
    if (res.status !== 200) {
      await dropBody(res);
      throw new Refused(`the icon answered ${res.status}`);
    }
    return iconOf(await bytesOf(res, ICON_BYTES, { truncate: false }));
  };
  const linked = await attempt(async () => {
    const { res, url } = await get(root, ctx, { sameHost: true });
    if (res.status !== 200) {
      await dropBody(res);
      throw new Refused(`the page answered ${res.status}`);
    }
    return linkOf((await bytesOf(res, PAGE_BYTES, { truncate: true })).toString('utf8'), url);
  });
  const icon = (linked && await attempt(() => load(linked))) || await attempt(() => load(new URL('/favicon.ico', root).href));
  if (icon) return icon;
  throw failure ?? new Refused('no icon found');
}

const sentence = (err) => (err instanceof Refused ? err.message : `${String(err?.message ?? err)}${err?.cause?.code ? ` (${err.cause.code})` : ''}`.slice(0, 200));

// host: a literal host name. -> { icon: a data URI or null, error: a sentence or null }. Never throws.
// signal: the caller's own budget; once it aborts, nothing more goes out.
export async function readFavicon(host, { fetch: fetcher = globalThis.fetch, now = Date.now, budgetMs = 3000, signal = null } = {}) {
  const name = hostName(host);
  if (!name) return { icon: null, error: 'no rule for the whole of a host name' };
  const control = new AbortController();
  if (signal?.aborted) control.abort();
  else signal?.addEventListener?.('abort', () => control.abort(), { once: true });
  let timer;
  try {
    if (typeof fetcher !== 'function') throw new Refused('no way to read the page');
    const deadline = now() + budgetMs;
    const ctx = {
      fetch: fetcher, signal: control.signal,
      check() {
        if (control.signal.aborted || now() >= deadline) throw new OutOfTime();
      },
    };
    const timeout = new Promise((_, reject) => {
      control.signal.addEventListener('abort', () => reject(new OutOfTime()), { once: true });
      if (control.signal.aborted) reject(new OutOfTime());
      timer = setTimeout(() => control.abort(), budgetMs);
    });
    // The read may end after the budget did (a fetch that ignores the signal): its late error is nobody's.
    timeout.catch(() => {});
    ctx.check();
    const work = find(name, ctx);
    work.catch(() => {});
    return { icon: await Promise.race([work, timeout]), error: null };
  } catch (err) {
    return { icon: null, error: sentence(err) };
  } finally {
    clearTimeout(timer);
  }
}

const literal = (host) => typeof host === 'string' && !/[*?]/.test(host);
const hostsOf = (condition) => condition.HostHeaderConfig?.Values ?? condition.Values ?? [];
const pathsOf = (condition) => condition.PathPatternConfig?.Values ?? condition.Values ?? [];

// The host to read: the first literal host value among the rules whose every condition is a host or the path /* (a rule with a
// path, a header or a method is a part of the host's traffic, maybe another workload's: reading / there could wake it). null: none.
export function hostOfRules(rules) {
  for (const rule of Array.isArray(rules) ? rules : []) {
    const conditions = rule?.Conditions ?? [];
    const plain = conditions.every((c) => c.Field === 'host-header' || (c.Field === 'path-pattern' && pathsOf(c).length === 1 && pathsOf(c)[0] === '/*'));
    if (!plain) continue;
    const host = conditions.filter((c) => c.Field === 'host-header').flatMap(hostsOf).find(literal);
    if (host) return host;
  }
  return null;
}

// The nap's step (design §6): the favicon read and cached when the page would show it (a template with icon auto) and the last read,
// successful or not, is over 24 hours old. The workload must be awake (the route reaches it only then): its run is read first, then
// the favicon's record, the levels only when due, the host after them. One budget for all of it, store calls included: once it is
// spent nothing more is read or sent (a late store answer ends here), the nap goes on and the give-up is logged. Whatever goes wrong
// is logged and never thrown: it never changes the nap. The grace after the budget lets the result be written.
// levels({ signal }) -> [organization, router, workload], each a page or null; host({ signal }) -> the host name to read, or null.
export async function cacheFavicon(workloadId, { store, levels, host, fetch, now, budgetMs = FAVICON_BUDGET_MS, log }) {
  const budget = new AbortController();
  const spent = () => budget.signal.aborted;
  let timers = [];
  const work = (async () => {
    if ((await store.getRun(workloadId))?.state !== STATES.AWAKE || spent()) return spent() ? 'gave up' : 'done';
    const last = await store.getFavicon(workloadId);
    if (spent()) return 'gave up';
    if (last?.fetchedAt > now() - EVERY_MS) return 'done';
    const [organization, router, workload] = await levels({ signal: budget.signal });
    if (spent()) return 'gave up';
    const page = resolvePage(organization, router, workload);
    if (page.mode !== 'template' || page.icon !== 'auto') return 'done';
    const name = await host({ signal: budget.signal });
    if (spent()) return 'gave up';
    const { icon, error } = await readFavicon(name, { fetch, now, budgetMs, signal: budget.signal });
    await store.putFavicon(workloadId, { icon: icon ?? last?.icon ?? null, fetchedAt: now(), error });
    return 'done';
  })();
  work.catch(() => {});
  try {
    const timeout = new Promise((resolve) => {
      timers = [setTimeout(() => budget.abort(), budgetMs), setTimeout(() => resolve('gave up'), budgetMs + GRACE_MS)];
    });
    if ((await Promise.race([work, timeout])) === 'gave up') log.warn('FaviconGaveUp', { workloadId, budgetMs });
  } catch (err) {
    log.warn('FaviconSkipped', { workloadId, error: err.message });
  } finally {
    timers.forEach(clearTimeout);
  }
}

// cacheFavicon's `levels` for a workload, both routers': the organization's page (`organization({ signal })`; null without one), the
// router's and the workload's as the store holds them, the last two as the waker serves them (`served`: Google Cloud's custom pages
// switch, pages.mjs), read at once.
export const pageLevels = (store, workloadId, { organization = null, served = (page) => page } = {}) => async ({ signal } = {}) => {
  const [own, router, workload] = await Promise.all([organization ? organization({ signal }) : null, store.getWaitingPage('router'), store.getWaitingPage({ workloadId })]);
  return [own, served(router?.page), served(workload?.page)];
};
