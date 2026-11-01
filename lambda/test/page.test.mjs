import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { PAGE_CSP, failureMessage, languageOf, napMessage, renderJson, renderPage } from '../src/lib/page.mjs';

test('renderPage is a self-contained page that probes the same URL', () => {
  const html = renderPage({ state: 'WAKING', pollSeconds: 3 });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /const pollMs = 3000;/);
  assert.match(html, /'x-dormeto-probe': '1'/);
  assert.match(html, /location\.reload\(\)/);
  assert.match(html, /<noscript><meta http-equiv="refresh" content="6"><\/noscript>/);
  assert.match(html, /Waking up the application/);
  assert.doesNotMatch(html, /<link|<script src|<img/, 'no external asset');
});

test('renderPage shows the failure message and escapes unknown states', () => {
  assert.match(renderPage({ state: 'FAILED', pollSeconds: 3 }), /could not be started/);
  assert.doesNotMatch(renderPage({ state: '<script>', pollSeconds: 3 }), /<h1[^>]*><script>/);
});

test('renderJson returns the lower-case status and retry delay', () => {
  assert.deepEqual(JSON.parse(renderJson({ state: 'WAKING', pollSeconds: 3 })), { status: 'waking', retryAfter: 3 });
});

test('the failure message says the kind and the next attempt (R7a)', async () => {
  const { renderPage } = await import('../src/lib/page.mjs');
  const capacity = renderPage({ state: 'FAILED', pollSeconds: 3, failure: 'capacity', retryInMs: 4 * 60_000 });
  assert.match(capacity, /AWS has no capacity for this application right now: the start is retried, next attempt in 4 minutes/);
  const other = renderPage({ state: 'FAILED', pollSeconds: 3, failure: 'unhealthy', retryInMs: 30_000 });
  assert.match(other, /The application could not be started; its team is notified\. Next attempt in less than a minute/);
  assert.match(renderPage({ state: 'FAILED', pollSeconds: 3 }), /The application could not be started\. Retrying shortly/);
});

test('on Google Cloud the failure message promises no notification: nothing sends one before the manager', async () => {
  const { renderPage } = await import('../src/lib/page.mjs');
  const other = renderPage({ state: 'FAILED', pollSeconds: 3, failure: 'permission', retryInMs: 30_000, cloud: 'Google Cloud' });
  assert.match(other, /The application could not be started\. Next attempt in less than a minute/);
  assert.doesNotMatch(other, /notified/);
});

test('renderPage probes probeUrl, and only then reloads once AWAKE; without it the page keeps probing its own address', () => {
  const page = renderPage({ state: 'WAKING', pollSeconds: 3 });
  assert.match(page, /fetch\(location\.href, /);
  assert.doesNotMatch(page, /state === 'AWAKE'/);
  const elsewhere = renderPage({ state: 'WAKING', pollSeconds: 3, probeUrl: '/_dormeto/wake' });
  assert.match(elsewhere, /fetch\("\/_dormeto\/wake", /);
  assert.doesNotMatch(elsewhere, /fetch\(location\.href/);
  assert.match(elsewhere, /state === 'AWAKE'/);
});

test('renderPage names the cloud that has no capacity, in the page and in its script; AWS by default', () => {
  const capacity = { state: 'FAILED', pollSeconds: 3, failure: 'capacity', retryInMs: 30_000 };
  assert.match(renderPage(capacity), /<h1[^>]*>AWS has no capacity for this application right now: the start is retried, next attempt in less than a minute\.<\/h1>/);
  const google = renderPage({ ...capacity, cloud: 'Google Cloud' });
  assert.match(google, /<h1[^>]*>Google Cloud has no capacity for this application right now: the start is retried, next attempt in less than a minute\.<\/h1>/);
  assert.match(google, /const failures = \{"capacity":"Google Cloud has no capacity/);
  assert.doesNotMatch(google, /AWS/);
});

// R2: the bilingual page, its template and custom modes, and the progress bar
// (spec 2026-11-01-branded-waiting-page §7 to §9).
const unescape = (text) => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const part = (html, re) => unescape(re.exec(html)?.[1] ?? '');
const status = (html) => part(html, /<[^>]* id="message"[^>]*>([^<]*)</);
const scriptOf = (html) => /<script>([\s\S]*)<\/script>/.exec(html)[1];
const bodyOf = (html) => html.replace(/<script>[\s\S]*<\/script>/, '');
const PNG = `data:image/png;base64,${Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24)]).toString('base64')}`;
const waking = { state: 'WAKING', pollSeconds: 3 };
const template = (fields) => ({ page: { mode: 'template', ...fields } });

test('languageOf reads the q values and the primary subtag; English otherwise', () => {
  assert.equal(languageOf('fr-CA,en;q=0.5'), 'fr');
  assert.equal(languageOf('en;q=0.1,fr'), 'fr');
  assert.equal(languageOf('fr;q=0.4, en;q=0.8'), 'en');
  assert.equal(languageOf('FR'), 'fr');
  assert.equal(languageOf('de, fr;q=0.2'), 'fr');
  assert.equal(languageOf('de'), 'en');
  assert.equal(languageOf('de,es;q=0.5'), 'en');
  assert.equal(languageOf('fr;q=0, en'), 'en', 'q=0 is not acceptable');
  assert.equal(languageOf('fra'), 'en', 'a primary subtag is the whole tag before the dash');
  for (const junk of [undefined, null, '', ' ', ',,,', ';q=1', '*', 'fr;q=abc', 12, {}, 'x'.repeat(10_000)]) assert.equal(languageOf(junk), 'en', String(junk).slice(0, 10));
});

test('in French, every state and every failure speaks French', () => {
  const states = { ASLEEP: "Démarrage de l'application…", WAKING: "Démarrage de l'application…", NAPPING: "L'application allait s'endormir, elle redémarre…", AWAKE: "C'est presque prêt…", FAILED: "L'application n'a pas pu démarrer. Nouvel essai sous peu…" };
  for (const [state, text] of Object.entries(states)) {
    const html = renderPage({ state, pollSeconds: 3, language: 'fr' });
    assert.match(html, /<html lang="fr">/);
    assert.equal(status(html), text, state);
  }
  assert.match(renderPage({ ...waking, language: 'fr' }), /<title>Démarrage…<\/title>/);
  assert.match(unescape(renderPage({ ...waking, language: 'fr' })), /Cette page se recharge d'elle-même dès que l'application est prête\./);
  const failed = (failure, retryInMs, cloud) => failureMessage(failure, retryInMs, cloud, 'fr');
  assert.equal(failed('capacity', 4 * 60_000), "AWS n'a plus de capacité pour cette application pour le moment : le démarrage sera retenté, prochain essai dans 4 minutes.");
  assert.equal(failed('capacity', 60_000, 'Google Cloud'), "Google Cloud n'a plus de capacité pour cette application pour le moment : le démarrage sera retenté, prochain essai dans 1 minute.");
  assert.equal(failed('capacity', 1000), "AWS n'a plus de capacité pour cette application pour le moment : le démarrage sera retenté, prochain essai dans moins d'une minute.");
  assert.equal(failed('unhealthy', 30_000), "L'application n'a pas pu démarrer ; son équipe est prévenue. Prochain essai dans moins d'une minute.");
  assert.equal(failed('unhealthy', 2 * 60_000, 'Google Cloud'), "L'application n'a pas pu démarrer. Prochain essai dans 2 minutes.");
  assert.equal(failed('unhealthy'), "L'application n'a pas pu démarrer ; son équipe est prévenue.");
  assert.equal(failed(undefined, 5), "L'application n'a pas pu démarrer. Nouvel essai sous peu…");
  const html = renderPage({ state: 'FAILED', pollSeconds: 3, failure: 'capacity', retryInMs: 3 * 60_000, language: 'fr' });
  assert.match(status(html), /prochain essai dans 3 minutes\.$/);
});

test('English with nothing set is what it was; the failure and nap helpers keep their arguments', () => {
  assert.equal(failureMessage('capacity', 4 * 60_000, 'AWS'), 'AWS has no capacity for this application right now: the start is retried, next attempt in 4 minutes.');
  assert.equal(failureMessage('x', 60_000), 'The application could not be started; its team is notified. Next attempt in 1 minute.');
  assert.equal(napMessage({ local: 'Mon 08:00', timeZone: 'Europe/Paris' }), 'Napping on schedule until Mon 08:00 (Europe/Paris).');
  const html = renderPage(waking);
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<title>Waking up…<\/title>/);
  assert.match(html, /<h1 id="message" aria-live="polite" data-dormeto="status">Waking up the application…<\/h1>/);
  assert.match(html, /This page reloads by itself as soon as the application is ready\./);
  assert.match(html, /<span class="dot"/);
  assert.doesNotMatch(bodyOf(html), /progressbar|<img/);
});

test('a nap window names its day in French; the time and the zone stay', () => {
  const days = { Mon: 'lun.', Tue: 'mar.', Wed: 'mer.', Thu: 'jeu.', Fri: 'ven.', Sat: 'sam.', Sun: 'dim.' };
  for (const [en, fr] of Object.entries(days)) {
    assert.equal(napMessage({ local: `${en} 08:00`, timeZone: 'Europe/Paris' }, 'fr'), `En pause programmée jusqu'à ${fr} 08:00 (Europe/Paris).`, en);
    assert.equal(napMessage({ local: `${en} 08:00`, timeZone: 'UTC' }, 'en'), `Napping on schedule until ${en} 08:00 (UTC).`);
  }
  assert.equal(napMessage({ local: '2026-11-02 08:00', timeZone: 'UTC' }, 'fr'), "En pause programmée jusqu'à 2026-11-02 08:00 (UTC).", 'a local time with no day is left alone');
  const html = renderPage({ ...waking, language: 'fr', napUntil: { at: 'x', local: 'Tue 07:00', timeZone: 'Europe/Paris' } });
  assert.equal(status(html), "En pause programmée jusqu'à mar. 07:00 (Europe/Paris).");
});

test('the script receives the sentences of its language only', () => {
  const fr = scriptOf(renderPage({ state: 'FAILED', pollSeconds: 3, language: 'fr', failure: 'capacity', retryInMs: 1 }));
  assert.match(fr, /Démarrage de l'application/);
  assert.doesNotMatch(fr, /Waking up|could not be started|next attempt|less than a minute/);
  const en = scriptOf(renderPage(waking));
  assert.doesNotMatch(en, /Démarrage|prochain essai|moins d/);
});

test('the content security policy is the spec\'s, to the letter', () => {
  assert.equal(PAGE_CSP, "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
});

test('template: a title makes the heading and the title, and the status moves to a paragraph', () => {
  const html = renderPage({ ...waking, ...template({ title: 'Acme portal', description: 'Our test environment\nsleeps at night.' }) });
  assert.match(html, /<title>Acme portal<\/title>/);
  assert.match(html, /<h1>Acme portal<\/h1>\s*<p id="message" aria-live="polite" data-dormeto="status">Waking up the application…<\/p>/);
  assert.match(html, /<p class="note">Our test environment\nsleeps at night\.<\/p>/);
  assert.match(html, /\.note\{[^}]*white-space:pre-line/);
  assert.doesNotMatch(html, /<h1 id="message"/);
  assert.match(html, /<html lang="en">/);
  const french = renderPage({ ...waking, language: 'fr', ...template({ title: 'Acme portal' }) });
  assert.match(french, /<html lang="fr">/);
  assert.equal(status(french), "Démarrage de l'application…", 'Dormeto\'s sentences stay in the visitor\'s language');
});

test('template: without a title the status stays the heading and the built-in title stays', () => {
  const html = renderPage({ ...waking, language: 'fr', ...template({ description: 'Bonjour' }) });
  assert.match(html, /<h1 id="message" aria-live="polite" data-dormeto="status">/);
  assert.match(html, /<title>Démarrage…<\/title>/);
  assert.match(html, /<p class="note">Bonjour<\/p>/);
});

test('template: the icon replaces the dot, an empty-alt image bounded in size; the order is the spec\'s', () => {
  const html = renderPage({ ...waking, icon: PNG, ...template({ title: 't', description: 'm' }), progress: { elapsedMs: 1, typicalMs: 2 } });
  assert.match(html, new RegExp(`<img class="icon" alt="" src="${PNG}">`));
  assert.doesNotMatch(html, /<span class="dot"/);
  assert.match(html, /\.icon\{[^}]*max-height:4rem[^}]*max-width:16rem|\.icon\{[^}]*max-width:16rem[^}]*max-height:4rem/);
  const order = ['<img', '<h1', 'id="message"', 'class="note"', 'role="progressbar"', 'This page reloads'];
  const at = order.map((needle) => html.indexOf(needle));
  assert.ok(at.every((n, i) => n > 0 && (i === 0 || n > at[i - 1])), at.join());
  for (const type of ['svg+xml', 'jpeg', 'webp', 'x-icon']) assert.match(renderPage({ ...waking, icon: `data:image/${type};base64,AAAA` }), /<img class="icon"/, type);
});

test('template: nothing a customer wrote can run, in the page or in the script', () => {
  const html = renderPage({ ...waking, icon: PNG, ...template({
    title: '<script>alert("t")</script>', description: `"quoted" & 'single' <img src=x onerror=alert(1)>`,
  }) });
  assert.match(html, /<h1>&lt;script&gt;alert\(&quot;t&quot;\)&lt;\/script&gt;<\/h1>/);
  assert.match(html, /<title>&lt;script&gt;/);
  assert.match(html, /<p class="note">&quot;quoted&quot; &amp; &#39;single&#39; &lt;img src=x onerror=alert\(1\)&gt;<\/p>/);
  assert.doesNotMatch(html, /<script>alert|<img src=x/);
  assert.equal(html.match(/<script>/g).length, 1, 'only the page\'s own script');
  for (const bad of ['javascript:alert(1)', 'data:text/html;base64,PHNjcmlwdD4=', `${PNG}" onload="x`, 'data:image/gif;base64,AAAA', 'auto', 'none', 5, {}]) {
    assert.doesNotMatch(renderPage({ ...waking, icon: bad }), /<img/, String(bad));
  }
  for (const page of ['x', 5, [], { mode: 'x' }, { mode: 'template', title: 5, description: {} }, { mode: 'template', title: '', description: ' ' }, { mode: 'custom' }, { mode: 'custom', html: 5 }, { mode: 'custom', html: '  ' }]) {
    const out = renderPage({ ...waking, page });
    assert.match(out, /Waking up the application…/, JSON.stringify(page));
    assert.match(out, /<title>Waking up…<\/title>/);
  }
});

test('the script holds none of the customer\'s text or icon', () => {
  const script = scriptOf(renderPage({ ...waking, icon: PNG, ...template({ title: 'MARK-TITLE', description: 'MARK-DESCRIPTION' }), progress: { elapsedMs: 1, typicalMs: 2 } }));
  assert.doesNotMatch(script, /MARK|iVBOR/);
  const html = '<!doctype html><html><head></head><body><p>CUSTOM-MARK</p></body></html>';
  assert.doesNotMatch(scriptOf(renderPage({ ...waking, page: { mode: 'custom', html } })), /CUSTOM-MARK/);
});

const bar = (html) => /<div class="track"><div class="bar" role="progressbar" data-dormeto="progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="(\d+)" aria-labelledby="message" style="width:(\d+)%"><\/div><\/div>/.exec(html);

test('the bar: 0, 50, 100 and 300% of the typical time, capped at 95; "longer" only past it', () => {
  const at = (elapsedMs) => renderPage({ ...waking, progress: { elapsedMs, typicalMs: 10_000 } });
  assert.deepEqual(bar(at(0)).slice(1), ['0', '0']);
  assert.deepEqual(bar(at(5000)).slice(1), ['50', '50']);
  assert.deepEqual(bar(at(10_000)).slice(1), ['95', '95']);
  assert.deepEqual(bar(at(30_000)).slice(1), ['95', '95']);
  assert.match(at(10_000), /This page reloads by itself/);
  assert.doesNotMatch(bodyOf(at(10_000)), /taking longer/);
  assert.match(bodyOf(at(10_001)), /This is taking longer than usual\./);
  assert.doesNotMatch(bodyOf(at(10_001)), /This page reloads by itself/);
  assert.match(renderPage({ ...waking, language: 'fr', progress: { elapsedMs: 20_000, typicalMs: 10_000 } }), /Le démarrage prend plus de temps que d&#39;habitude\./);
  assert.match(at(5000), /<span id="elapsed" data-dormeto="elapsed">5 s<\/span>/);
  assert.match(at(4000), /@media \(prefers-reduced-motion:no-preference\)\{[^}]*transition/);
});

test('no bar without usable progress, and none in FAILED, AWAKE, ASLEEP, NAPPING or a nap window', () => {
  const progress = { elapsedMs: 5000, typicalMs: 10_000 };
  assert.doesNotMatch(bodyOf(renderPage(waking)), /progressbar/);
  for (const bad of [null, undefined, {}, { elapsedMs: 5 }, { typicalMs: 5 }, { elapsedMs: 5, typicalMs: 0 }, { elapsedMs: 5, typicalMs: -1 }, { elapsedMs: 'x', typicalMs: 5 }, { elapsedMs: NaN, typicalMs: 5 }, { elapsedMs: 5, typicalMs: Infinity }, 'x']) {
    assert.doesNotMatch(bodyOf(renderPage({ ...waking, progress: bad })), /progressbar/, JSON.stringify(bad));
  }
  for (const state of ['FAILED', 'AWAKE', 'ASLEEP', 'NAPPING']) assert.doesNotMatch(bodyOf(renderPage({ state, pollSeconds: 3, progress })), /progressbar/, state);
  assert.doesNotMatch(bodyOf(renderPage({ ...waking, progress, napUntil: { at: 'x', local: 'Mon 08:00', timeZone: 'UTC' } })), /progressbar/);
  assert.equal(bar(renderPage({ ...waking, progress: { elapsedMs: -5, typicalMs: 10_000 } }))[1], '0');
});

const CUSTOM = '<!doctype html><html lang="de"><head><title>Meins</title></head><body><h1>Gleich</h1><p data-dormeto="status"></p></body></html>';
const custom = (html) => renderPage({ ...waking, page: { mode: 'custom', html } });
const NOSCRIPT = '<noscript><meta http-equiv="refresh" content="6"></noscript>';
// The injected parts taken out, what is left is the customer's page, byte for byte.
const without = (html) => html.replace(NOSCRIPT, '').replace(/<script>[\s\S]*<\/script>/, '');

test('custom: the customer\'s page, with the refresh after <head> and the script before </body>, and nothing else changed', () => {
  const html = custom(CUSTOM);
  assert.equal(without(html), CUSTOM);
  assert.ok(html.includes(`<head>${NOSCRIPT}<title>Meins</title>`));
  assert.match(html, /<\/script><\/body><\/html>$/);
  assert.match(html, /<html lang="de">/, 'its language is its own');
  assert.doesNotMatch(html, /Waking up…|class="dot"|:root\{/, 'none of the template');
  assert.match(html, /const pollMs = 3000;/);
});

test('custom: <HEAD> with attributes, any case; <header> is not a head; no head means no refresh', () => {
  const upper = custom('<HTML><HEAD lang=x data-a="1">\n<TITLE>t</TITLE></HEAD><BODY>x</BODY></HTML>');
  assert.ok(upper.includes(`<HEAD lang=x data-a="1">${NOSCRIPT}\n<TITLE>`));
  assert.ok(/<script>[\s\S]*<\/script><\/BODY>/.test(upper), 'before </BODY>');
  const header = custom('<header>top</header><p>x</p></body>');
  assert.equal(header.includes('<noscript>'), false);
  assert.equal(without(header), '<header>top</header><p>x</p></body>');
  const none = custom('<p data-dormeto="status"></p>');
  assert.equal(none.includes('<noscript>'), false);
  assert.match(none, /^<p data-dormeto="status"><\/p><script>/);
  assert.match(none, /<\/script>$/, 'without a body end, at the end');
});

test('custom: two </body> take the script before the last; the first head only gets the refresh', () => {
  const html = custom('<head></head><body><pre>&lt;/body></pre></body><!-- </body> --></body>');
  assert.equal(html.match(/<noscript>/g).length, 1);
  assert.equal(html.match(/<script>/g).length, 1);
  assert.ok(html.indexOf('<script>') > html.indexOf('<!-- </body> -->'));
  assert.match(html, /<\/script><\/body>$/);
  const two = custom('<head></head><head></head>');
  assert.equal(two.match(/<noscript>/g).length, 1);
  assert.equal(without(two), '<head></head><head></head>');
  assert.equal(without(custom('<p>a</p></body>\n</BODY >')), '<p>a</p></body>\n</BODY >');
  assert.match(custom('<p>a</p></body>\n</BODY >'), /<\/script><\/BODY >$/);
});

test('custom: dollar signs and other replacement patterns in the page survive', () => {
  const page = '<head></head><body>$& $1 $` $\' $$</body>';
  assert.equal(without(custom(page)), page);
});

test('custom: the largest page, and the template with the largest icon, stay under 1 MB', () => {
  const big = `<head></head><body>${'é'.repeat(128 * 1024 - 26)}</body>`;
  assert.equal(Buffer.byteLength(big) <= 256 * 1024, true);
  assert.ok(Buffer.byteLength(custom(big)) < 1_000_000);
  const icon = `data:image/png;base64,${Buffer.alloc(64 * 1024).toString('base64')}`;
  const html = renderPage({ ...waking, icon, ...template({ title: 'é'.repeat(80), description: '"&<>\n'.repeat(100).slice(0, 500) }), progress: { elapsedMs: 1, typicalMs: 2 } });
  assert.ok(Buffer.byteLength(html) < 150_000, String(Buffer.byteLength(html)));
});

// The page's script, run in a vm with a small fake of the document, fetch and the timers.
function runScript(html, answers) {
  const elements = {};
  const events = [];
  const make = (name) => ({
    name, textContent: '', attrs: {}, style: {}, hidden: false, className: '', parentNode: null, children: [],
    setAttribute(k, v) { this.attrs[k] = v; },
    append(...c) { c.forEach((n) => { n.parentNode = this; }); this.children.push(...c); },
    before(n) { document.inserted.push(n); },
  });
  const document = {
    inserted: [],
    getElementById: (id) => elements[id] ?? null,
    querySelector: (selector) => elements[/data-dormeto="(\w+)"/.exec(selector)?.[1]] ?? null,
    createElement: () => make('new'),
    dispatchEvent: (event) => { events.push(event); return true; },
  };
  const hooks = (names) => names.forEach((n) => { elements[n] = make(n); });
  const server = bar(html);
  if (/data-dormeto="status"/.test(html)) hooks(['status']);
  if (/data-dormeto="elapsed"/.test(html)) hooks(['elapsed']);
  if (/id="reload"/.test(html)) { elements.reload = make('reload'); elements.reload.parentNode = { before(n) { document.inserted.push(n); } }; elements.reload.textContent = /<span id="reload">([^<]*)</.exec(html)[1]; }
  if (!server && /data-dormeto="progress"/.test(html)) hooks(['progress']);
  if (server) { hooks(['progress']); elements.progress.style.width = `${server[2]}%`; elements.progress.attrs['aria-valuenow'] = server[1]; elements.progress.parentNode = make('track'); elements.progress.parentNode.className = 'track'; }
  const timers = [];
  const later = [];
  const clock = { now: 1_000_000 };
  const queue = [...answers];
  const context = {
    document, location: { href: 'https://app.example/', reload() { context.reloaded = true; } }, reloaded: false,
    Date: { now: () => clock.now, parse: Date.parse }, Math, Number, Promise, JSON, isFinite,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    setInterval: (fn) => timers.push(fn), setTimeout: (fn) => later.push(fn),
    fetch: async () => { const a = queue.shift() ?? { state: 'WAKING' }; return { type: 'basic', headers: { get: (name) => a.headers?.[name] ?? (name === 'x-dormeto-state' ? a.state : null) } }; },
  };
  vm.runInNewContext(scriptOf(html), context);
  return {
    elements, document, context, events,
    settle: async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); },
    next: async () => { later.splice(0).forEach((fn) => fn()); for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); },
    tick: (ms) => { clock.now += ms; timers.forEach((fn) => fn()); },
    fill: () => elements.progress ?? document.inserted[0]?.children[0],
  };
}
const headers = (elapsed, typical) => ({ 'x-dormeto-wake-elapsed': String(elapsed), 'x-dormeto-wake-typical': String(typical) });

test('script: a probe answer with the headers turns the bar on, one without leaves it', async () => {
  const run = runScript(renderPage(waking), [{ state: 'WAKING', headers: headers(5000, 10_000) }, { state: 'WAKING' }]);
  await run.settle();
  const track = run.document.inserted[0];
  assert.ok(track, 'the bar was added');
  assert.equal(track.className, 'track');
  const fill = track.children[0];
  assert.equal(fill.attrs.role, 'progressbar');
  assert.equal(fill.attrs['aria-valuenow'], '50');
  assert.equal(fill.style.width, '50%');
  run.tick(3000);
  assert.equal(fill.style.width, '80%', 'it moves with the clock');
  assert.equal(fill.attrs['aria-valuenow'], '80');
  assert.equal(run.elements.elapsed.textContent, '8 s', 'the counter now counts from the wake');
  assert.equal(run.document.inserted.length, 1);
  assert.equal(track.hidden, false);
});

test('script: an answer without the headers leaves a bar as it was; a page without one has none', async () => {
  const none = runScript(renderPage(waking), [{ state: 'WAKING' }]);
  await none.settle();
  none.tick(5000);
  assert.equal(none.document.inserted.length, 0);
  assert.equal(none.elements.elapsed.textContent, '5 s', 'since the page opened');
  const served = runScript(renderPage({ ...waking, progress: { elapsedMs: 5000, typicalMs: 10_000 } }), [{ state: 'WAKING' }]);
  await served.settle();
  served.tick(2000);
  assert.equal(served.elements.progress.style.width, '70%');
  assert.equal(served.elements.progress.parentNode.hidden, false);
  assert.equal(served.document.inserted.length, 0, 'the server\'s bar is used, none is added');
});

test('script: past the typical time the bar stops at 95% and the "longer" sentence replaces the reload one', async () => {
  const run = runScript(renderPage({ ...waking, progress: { elapsedMs: 9000, typicalMs: 10_000 } }), [{ state: 'WAKING' }]);
  await run.settle();
  run.tick(500);
  assert.notEqual(run.elements.reload.textContent, 'This is taking longer than usual.');
  run.tick(1000);
  assert.equal(run.elements.progress.style.width, '95%');
  assert.equal(run.elements.reload.textContent, 'This is taking longer than usual.');
});

test('script: AWAKE fills the bar it has, FAILED and a nap hide it', async () => {
  const progress = { elapsedMs: 5000, typicalMs: 10_000 };
  const awake = runScript(renderPage({ ...waking, progress }), [{ state: 'AWAKE' }]);
  await awake.settle();
  assert.equal(awake.elements.progress.style.width, '100%');
  assert.equal(awake.elements.progress.attrs['aria-valuenow'], '100');
  awake.tick(60_000);
  assert.equal(awake.elements.progress.style.width, '100%', 'it stays full');
  const opened = runScript(renderPage(waking), [{ state: 'AWAKE' }]);
  await opened.settle();
  assert.equal(opened.document.inserted.length, 0, 'a page opened at AWAKE has none');
  const failed = runScript(renderPage({ ...waking, progress }), [{ state: 'FAILED', headers: { 'x-dormeto-failure': 'other' } }]);
  await failed.settle();
  assert.equal(failed.elements.progress.parentNode.hidden, true);
  failed.tick(5000);
  assert.equal(failed.elements.progress.parentNode.hidden, true, 'and stays hidden');
  const nap = runScript(renderPage({ ...waking, progress }), [{ state: 'ASLEEP', headers: { 'x-dormeto-nap-until': '2026-11-02T07:00:00Z' } }]);
  await nap.settle();
  assert.equal(nap.elements.progress.parentNode.hidden, true);
});

test('script: unusable headers are ignored', async () => {
  for (const bad of [headers('x', 10_000), headers(5000, 0), headers(5000, -1), headers('', ''), headers(-1, 5000), { 'x-dormeto-wake-elapsed': '5000' }]) {
    const run = runScript(renderPage(waking), [{ state: 'WAKING', headers: bad }]);
    await run.settle();
    assert.equal(run.document.inserted.length, 0, JSON.stringify(bad));
  }
});

test('script: the failure sentences are built in the visitor\'s language', async () => {
  const run = runScript(renderPage({ ...waking, language: 'fr' }), [{ state: 'FAILED', headers: { 'x-dormeto-failure': 'capacity', 'x-dormeto-retry-at': new Date(1_000_000 + 4 * 60_000).toISOString() } }]);
  await run.settle();
  assert.match(run.elements.status.textContent, /^AWS n'a plus de capacité .* retenté, prochain essai dans [34] minutes\.$/);
});

test('custom hooks: the status, the seconds and the bar of the customer\'s page, and the dormeto:state event', async () => {
  const html = custom('<head></head><body><p data-dormeto="status"></p><i data-dormeto="elapsed"></i><div data-dormeto="progress" hidden></div></body>');
  const retryAt = new Date(1_000_000 + 4 * 60_000).toISOString();
  const run = runScript(html, [{ state: 'WAKING', headers: headers(2000, 8000) }, { state: 'FAILED', headers: { 'x-dormeto-failure': 'capacity', 'x-dormeto-retry-at': retryAt } }]);
  run.elements.progress.hidden = true;
  assert.equal(run.elements.status.textContent, 'Waking up the application…', 'the sentence is there at once');
  await run.settle();
  await run.next();
  assert.equal(run.events[0].type, 'dormeto:state');
  assert.deepEqual({ ...run.events[0].detail }, { state: 'WAKING', failure: null, retryAt: null, napUntil: null, elapsedMs: 2000, typicalMs: 8000 });
  assert.equal(run.events[1].detail.state, 'FAILED');
  assert.equal(run.events[1].detail.failure, 'capacity');
  assert.equal(run.events[1].detail.retryAt, retryAt);
  assert.match(run.elements.status.textContent, /^AWS has no capacity .*next attempt in [34] minutes\.$/);
  assert.equal(run.document.inserted.length, 0, 'the customer\'s element is used, none is created');
});

test('custom hooks: the bar element gets its width, and hidden comes off once a bar applies', async () => {
  const html = custom('<head></head><body><p data-dormeto="status"></p><div data-dormeto="progress" hidden></div></body>');
  const run = runScript(html, [{ state: 'WAKING', headers: headers(2000, 8000) }]);
  run.elements.progress.hidden = true;
  assert.equal(run.elements.progress.hidden, true);
  await run.settle();
  assert.equal(run.elements.progress.hidden, false);
  assert.equal(run.elements.progress.style.width, '25%');
  run.tick(2000);
  assert.equal(run.elements.progress.style.width, '50%');
  assert.equal(run.elements.elapsed, undefined);
});

test('custom: a page with no hook still probes, wakes and reloads', async () => {
  const run = runScript(custom('<head></head><body><p>mine</p></body>'), [{ state: 'WAKING' }]);
  await run.settle();
  assert.equal(run.events.length, 1);
  run.tick(1000);
  const gone = runScript(custom('<p>mine</p>'), [{ type: 'x', state: null }]);
  await gone.settle();
  assert.equal(gone.context.reloaded, true, 'an answer that is not the waker\'s reloads the visitor');
});
