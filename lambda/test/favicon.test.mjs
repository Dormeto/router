import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostOfRules, readFavicon } from '../src/lib/favicon.mjs';
import { iconTypeOf } from '../src/lib/page-settings.mjs';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PNG_URI = `data:image/png;base64,${PNG.toString('base64')}`;
const SVG = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>');
const ICO = Buffer.from([0, 0, 1, 0, 1, 0]);
const HOST = 'app.example.com';
const html = (head) => `<!doctype html><html><head><title>x</title>${head}</head><body>hi</body></html>`;

// Routes: url → [status, headers, body] or a function (options) → Response. Every call is recorded.
function fakeFetch(routes) {
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const route = routes[String(url)];
    if (typeof route === 'function') return route(options);
    if (!route) return new Response('', { status: 404 });
    const [status, headers, body] = route;
    return new Response(body, { status, headers });
  };
  return { fetch, calls };
}
const read = (routes, options = {}) => {
  const f = fakeFetch(routes);
  return readFavicon(HOST, { fetch: f.fetch, now: Date.now, budgetMs: 3000, ...options }).then((out) => ({ ...out, calls: f.calls.map((c) => c.url), all: f.calls }));
};
const page = (head) => ({ [`https://${HOST}/`]: [200, { 'content-type': 'text/html' }, html(head)] });

test('reads the page, takes its icon link, resolves it against the page and answers a data URI of the bytes\' own type', async () => {
  const out = await read({ ...page('<link rel="icon" href="/static/fav.png">'), [`https://${HOST}/static/fav.png`]: [200, { 'content-type': 'image/jpeg' }, PNG] });
  assert.deepEqual([out.icon, out.error, out.calls], [PNG_URI, null, [`https://${HOST}/`, `https://${HOST}/static/fav.png`]]);
  assert.equal(iconTypeOf(Buffer.from(out.icon.split(',')[1], 'base64')), 'png');
});

test('the requests are plain: https, the router\'s user agent, no credentials, redirects handled here', async () => {
  const out = await read({ ...page('<link rel="icon" href="f.png">'), [`https://${HOST}/f.png`]: [200, {}, PNG] });
  for (const { options } of out.all) {
    assert.equal(options.headers['user-agent'], 'dormeto-router');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.credentials, 'omit');
    assert.ok(options.signal);
    assert.equal(options.headers.cookie, undefined);
    assert.equal(options.headers.authorization, undefined);
  }
});

test('the first link of icon, then shortcut icon, then apple-touch-icon, whatever the document order', async () => {
  const icons = { [`https://${HOST}/a.png`]: [200, {}, PNG], [`https://${HOST}/b.png`]: [200, {}, PNG], [`https://${HOST}/c.png`]: [200, {}, PNG], [`https://${HOST}/d.png`]: [200, {}, PNG] };
  const head = '<link rel="apple-touch-icon" href="/c.png"><link rel="shortcut icon" href="/b.png"><link rel="icon" href="/a.png"><link rel="icon" href="/d.png">';
  assert.equal((await read({ ...page(head), ...icons })).calls[1], `https://${HOST}/a.png`);
  assert.equal((await read({ ...page(head.replace(/<link rel="icon"[^>]*>/g, '')), ...icons })).calls[1], `https://${HOST}/b.png`);
  assert.equal((await read({ ...page('<link rel="apple-touch-icon" href="/c.png"><link rel="mask-icon" href="/d.png">'), ...icons })).calls[1], `https://${HOST}/c.png`);
});

test('odd markup: quotes, case, attribute order, entities in the href, a commented-out link, a link of other kinds', async () => {
  const icon = (path) => ({ [`https://${HOST}${path}`]: [200, {}, PNG] });
  for (const [head, path] of [
    ["<link rel='icon' href='/s.png'>", '/s.png'],
    ['<link rel=icon href=/u.png>', '/u.png'],
    ['<LINK HREF="/h.png" REL="ICON" type="image/png">', '/h.png'],
    ['<link\n  sizes="32x32"\n  href="/n.png?a=1&amp;b=2"\n  rel="icon"/>', '/n.png?a=1&b=2'],
    ['<!-- <link rel="icon" href="/old.png"> --><link rel="stylesheet" href="/x.css"><link rel="icon" href="/real.png">', '/real.png'],
    ['<link rel="ICON  shortcut" href="/m.png">', '/m.png'],
  ]) {
    const out = await read({ ...page(head), ...icon(path) });
    assert.deepEqual([out.icon, out.calls[1]], [PNG_URI, `https://${HOST}${path}`], head);
  }
});

test('an inline data: icon is taken as it is, base64 or percent-encoded, after the same checks', async () => {
  const b64 = await read(page(`<link rel="icon" href="${PNG_URI}">`));
  assert.deepEqual([b64.icon, b64.calls], [PNG_URI, [`https://${HOST}/`]]);
  const svg = await read(page(`<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(SVG.toString())}">`));
  assert.equal(svg.icon, `data:image/svg+xml;base64,${SVG.toString('base64')}`);
  // Not what it says: falls to /favicon.ico.
  const wrong = await read({ ...page('<link rel="icon" href="data:image/png;base64,SGVsbG8=">'), [`https://${HOST}/favicon.ico`]: [200, {}, ICO] });
  assert.deepEqual([wrong.icon, wrong.calls.at(-1)], [`data:image/x-icon;base64,${ICO.toString('base64')}`, `https://${HOST}/favicon.ico`]);
});

test('no link, a login redirect to another host, a 401 or a page that cannot be read: /favicon.ico', async () => {
  const ico = { [`https://${HOST}/favicon.ico`]: [200, {}, ICO] };
  const expected = `data:image/x-icon;base64,${ICO.toString('base64')}`;
  for (const routes of [
    page('<meta name="x">'),
    { [`https://${HOST}/`]: [302, { location: 'https://login.example.org/sso' }, ''] },
    { [`https://${HOST}/`]: [401, {}, 'no'] },
    { [`https://${HOST}/`]: () => { throw new Error('socket hang up'); } },
    { [`https://${HOST}/`]: [200, {}, '<<<<'] },
  ]) {
    const out = await read({ ...routes, ...ico });
    assert.deepEqual([out.icon, out.error, out.calls.at(-1)], [expected, null, `https://${HOST}/favicon.ico`]);
    assert.ok(!out.calls.some((url) => url.includes('login.example.org')), 'the other host is not followed');
  }
});

test('three redirects on the same host are followed, a fourth is not; a redirect to http is refused', async () => {
  const hop = (to) => [302, { location: to }, ''];
  const three = await read({
    [`https://${HOST}/`]: hop('/a'), [`https://${HOST}/a`]: hop('/b'), [`https://${HOST}/b`]: hop('/c'),
    [`https://${HOST}/c`]: [200, {}, html('<link rel="icon" href="/z.png">')], [`https://${HOST}/z.png`]: [200, {}, PNG],
  });
  assert.equal(three.icon, PNG_URI);
  const four = await read({
    [`https://${HOST}/`]: hop('/a'), [`https://${HOST}/a`]: hop('/b'), [`https://${HOST}/b`]: hop('/c'), [`https://${HOST}/c`]: hop('/d'),
    [`https://${HOST}/d`]: [200, {}, html('<link rel="icon" href="/z.png">')], [`https://${HOST}/z.png`]: [200, {}, PNG],
  });
  assert.equal(four.icon, null);
  assert.ok(!four.calls.includes(`https://${HOST}/d`));
  const plain = await read({ [`https://${HOST}/`]: hop(`http://${HOST}/`) });
  assert.equal(plain.icon, null);
  assert.ok(!plain.calls.some((url) => url.startsWith('http:')));
});

test('an http: icon is refused; an icon on another https host (a CDN) is accepted', async () => {
  const plain = await read(page(`<link rel="icon" href="http://${HOST}/p.png">`));
  assert.ok(!plain.calls.some((url) => url.startsWith('http:')));
  const cdn = await read({ ...page('<link rel="icon" href="https://cdn.example.net/i/fav.png">'), 'https://cdn.example.net/i/fav.png': [200, {}, PNG] });
  assert.equal(cdn.icon, PNG_URI);
  const protocolRelative = await read({ ...page('<link rel="icon" href="//cdn.example.net/f.png">'), 'https://cdn.example.net/f.png': [200, {}, PNG] });
  assert.equal(protocolRelative.icon, PNG_URI);
});

test('the page is read up to 256 KiB: a link beyond it is not seen, and the reading stops', async () => {
  let pulled = 0;
  const chunk = Buffer.alloc(16 * 1024, 32);
  const big = () => new Response(new ReadableStream({
    pull(controller) {
      pulled += chunk.length;
      if (pulled > 4 * 1024 * 1024) controller.close(); else controller.enqueue(chunk);
    },
  }), { status: 200 });
  const out = await read({ [`https://${HOST}/`]: big });
  assert.equal(out.icon, null);
  assert.ok(pulled <= 256 * 1024 + 2 * chunk.length, `pulled ${pulled}`);
  // A link inside the first 256 KiB of a larger page is found.
  const long = `<!doctype html><head>${' '.repeat(200 * 1024)}<link rel="icon" href="/in.png">${' '.repeat(100 * 1024)}`;
  const inside = await read({ [`https://${HOST}/`]: [200, {}, long], [`https://${HOST}/in.png`]: [200, {}, PNG] });
  assert.equal(inside.icon, PNG_URI);
});

test('an icon over 32 KiB, or not an image whatever its content-type says, is refused and recorded', async () => {
  const over = await read({ ...page('<link rel="icon" href="/big.png">'), [`https://${HOST}/big.png`]: [200, { 'content-type': 'image/png' }, Buffer.concat([PNG, Buffer.alloc(32 * 1024)])] });
  assert.equal(over.icon, null);
  assert.match(over.error, /32 KiB/);
  const exact = await read({ ...page('<link rel="icon" href="/ok.png">'), [`https://${HOST}/ok.png`]: [200, {}, Buffer.concat([PNG, Buffer.alloc(32 * 1024 - PNG.length)])] });
  assert.ok(exact.icon);
  const wrong = await read({ ...page('<link rel="icon" href="/login">'), [`https://${HOST}/login`]: [200, { 'content-type': 'image/png' }, '<html>sign in</html>'], [`https://${HOST}/favicon.ico`]: [404, {}, ''] });
  assert.equal(wrong.icon, null);
  assert.equal(wrong.error, 'the icon is not a PNG, JPEG, WebP, SVG or ICO image');
  const text = await read({ ...page(''), [`https://${HOST}/favicon.ico`]: [200, { 'content-type': 'image/x-icon' }, 'not an icon'] });
  assert.deepEqual([text.icon, text.error], [null, 'the icon is not a PNG, JPEG, WebP, SVG or ICO image']);
});

test('the whole read is inside its budget: a server that hangs ends it with an error, and the requests are aborted', async () => {
  let signal;
  const hang = (options) => new Promise((resolve, reject) => { signal = options.signal; options.signal.addEventListener('abort', () => reject(new Error('aborted'))); });
  const started = Date.now();
  const out = await read({ [`https://${HOST}/`]: hang }, { budgetMs: 40 });
  assert.equal(out.icon, null);
  assert.match(out.error, /3 seconds|budget|time/i);
  assert.ok(Date.now() - started < 1000);
  assert.equal(signal.aborted, true);
  // A fetch that ignores the signal still cannot hold the caller.
  const stubborn = await read({ [`https://${HOST}/`]: () => new Promise(() => {}) }, { budgetMs: 40 });
  assert.equal(stubborn.icon, null);
});

test('never throws: no host, a wildcard, a bad host, a fetch that throws or answers nonsense', async () => {
  for (const host of [null, undefined, '', '*.example.com', 'a b', 'ex?mple.com', 'http://x', 'a/b', 42]) {
    const f = fakeFetch({});
    assert.deepEqual(await readFavicon(host, { fetch: f.fetch, now: Date.now, budgetMs: 100 }), { icon: null, error: 'no host name' }, String(host));
    assert.equal(f.calls.length, 0);
  }
  const boom = await readFavicon(HOST, { fetch: async () => { throw new TypeError('fetch failed'); }, now: Date.now, budgetMs: 100 });
  assert.deepEqual([boom.icon, typeof boom.error], [null, 'string']);
  const nonsense = await readFavicon(HOST, { fetch: async () => ({ status: 200 }), now: Date.now, budgetMs: 100 });
  assert.equal(nonsense.icon, null);
  const noFetch = await readFavicon(HOST, { fetch: 'nope', now: Date.now });
  assert.equal(noFetch.icon, null);
});

// --- Fix round 1 ------------------------------------------------------------------------------------------------------

test('a page of repeated <link is scanned in linear time, with or without a > at its end', async () => {
  for (const body of ['<link'.repeat(52428), '<link '.repeat(43690), `${'<link '.repeat(43000)}>`, `<link${'x'.repeat(2000)}>`.repeat(100)]) {
    const started = Date.now();
    const out = await read({ [`https://${HOST}/`]: [200, {}, body] });
    assert.equal(out.icon, null);
    assert.ok(Date.now() - started < 500, `${Date.now() - started} ms`);
  }
});

test('an icon read is at most 32 KiB, a page\'s inline data: icon alike', async () => {
  const at = (n) => Buffer.concat([PNG, Buffer.alloc(n - PNG.length)]);
  const ok = await read({ ...page('<link rel="icon" href="/a.png">'), [`https://${HOST}/a.png`]: [200, {}, at(32 * 1024)] });
  assert.ok(ok.icon);
  const over = await read({ ...page('<link rel="icon" href="/a.png">'), [`https://${HOST}/a.png`]: [200, {}, at(32 * 1024 + 1)] });
  assert.deepEqual([over.icon, over.error], [null, 'the icon is larger than 32 KiB']);
  const inline = await read(page(`<link rel="icon" href="data:image/png;base64,${at(32 * 1024 + 1).toString('base64')}">`));
  assert.equal(inline.icon, null);
  assert.match(inline.error, /32 KiB/);
});

test('an address with credentials is refused before any request, and the credentials never reach the error', async () => {
  const out = await read(page('<link rel="icon" href="https://u:secret@cdn.example.net/f.png">'));
  assert.equal(out.icon, null);
  assert.ok(!out.calls.some((url) => url.includes('secret')));
  assert.ok(!String(out.error).includes('secret'), out.error);
});

test('a signal that is aborted, or aborts meanwhile, ends the read and nothing more goes out', async () => {
  const control = new AbortController();
  control.abort();
  const f = fakeFetch(page('<link rel="icon" href="/f.png">'));
  const done = await readFavicon(HOST, { fetch: f.fetch, now: Date.now, budgetMs: 3000, signal: control.signal });
  assert.equal(done.icon, null);
  assert.equal(f.calls.length, 0);
  const later = new AbortController();
  const g = fakeFetch({ [`https://${HOST}/`]: () => { later.abort(); return new Response('<link rel="icon" href="/f.png">'); } });
  const mid = await readFavicon(HOST, { fetch: g.fetch, now: Date.now, budgetMs: 3000, signal: later.signal });
  assert.equal(mid.icon, null);
  assert.deepEqual(g.calls.map((c) => c.url), [`https://${HOST}/`]);
});

test('hostOfRules: the first literal host value of the rules that are all host or path /*, nothing otherwise', () => {
  const host = (...values) => ({ Field: 'host-header', HostHeaderConfig: { Values: values } });
  const path = (...values) => ({ Field: 'path-pattern', PathPatternConfig: { Values: values } });
  const rule = (...Conditions) => ({ Conditions });
  assert.equal(hostOfRules([rule(host('*.a.com', 'app.a.com'))]), 'app.a.com');
  assert.equal(hostOfRules([rule(host('*.a.com')), rule(host('b.a.com'), path('/*'))]), 'b.a.com');
  assert.equal(hostOfRules([rule({ Field: 'host-header', Values: ['legacy.a.com'] })]), 'legacy.a.com');
  assert.equal(hostOfRules([rule(host('shop.a.com'), path('/api/*'))]), null, 'a path other than /*');
  assert.equal(hostOfRules([rule(host('shop.a.com'), { Field: 'http-header', HttpHeaderConfig: { HttpHeaderName: 'x', Values: ['y'] } })]), null);
  assert.equal(hostOfRules([rule(path('/*'))]), null);
  assert.equal(hostOfRules([]), null);
  assert.equal(hostOfRules(undefined), null);
});
