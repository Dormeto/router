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

test('renderPage probes probeUrl, and only then reloads once AWAKE; without it the page keeps probing its own address', async () => {
  const page = renderPage({ state: 'WAKING', pollSeconds: 3 });
  assert.match(page, /fetch\(location\.href, /);
  const elsewhere = renderPage({ state: 'WAKING', pollSeconds: 3, probeUrl: '/_dormeto/wake' });
  assert.match(elsewhere, /fetch\("\/_dormeto\/wake", /);
  assert.doesNotMatch(elsewhere, /fetch\(location\.href/);
  // By behavior: AWAKE reloads only with probeUrl, one poll after the page was opened.
  const own = runScript(page, [{ state: 'AWAKE' }]);
  await own.settle();
  await own.next();
  assert.equal(own.context.reloaded, false, 'a page probing its own address does not reload on AWAKE');
  const probing = runScript(elsewhere, [{ state: 'AWAKE' }]);
  await probing.settle();
  assert.equal(probing.context.reloaded, false, 'not at once: paced');
  assert.equal(probing.delays[0], 3000, 'one poll after the page was opened');
  await probing.next();
  assert.equal(probing.context.reloaded, true);
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

test('a nap with no end known says so, in both languages, with no until', () => {
  const none = { at: null, local: null, timeZone: 'Europe/Paris' };
  assert.equal(napMessage(none), 'Napping on schedule.');
  assert.equal(napMessage(none, 'fr'), 'En pause programmée.');
  assert.equal(status(renderPage({ ...waking, napUntil: none })), 'Napping on schedule.');
  assert.equal(status(renderPage({ ...waking, language: 'fr', napUntil: none })), 'En pause programmée.');
  assert.doesNotMatch(bodyOf(renderPage({ ...waking, napUntil: none })), /progressbar/);
  assert.deepEqual(JSON.parse(renderJson({ state: 'ASLEEP', pollSeconds: 5, napUntil: none })), { status: 'asleep', retryAfter: 5, napUntil: none });
});

test('a nap\'s end with its date: the day is translated, the date stays', () => {
  const far = { at: 'x', local: 'Mon 2027-01-25 08:00', timeZone: 'Europe/Paris' };
  assert.equal(napMessage(far), 'Napping on schedule until Mon 2027-01-25 08:00 (Europe/Paris).');
  assert.equal(napMessage(far, 'fr'), "En pause programmée jusqu'à lun. 2027-01-25 08:00 (Europe/Paris).");
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
  assert.match(html, /<div class="note"><p>Our test environment<br>sleeps at night\.<\/p><\/div>/);
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
  assert.match(html, /<div class="note"><p>Bonjour<\/p><\/div>/);
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
  assert.match(html, /<div class="note"><p>&quot;quoted&quot; &amp; &#39;single&#39; &lt;img src=x onerror=alert\(1\)&gt;<\/p><\/div>/);
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
const custom = (html, more = {}) => renderPage({ ...waking, page: { mode: 'custom', html }, ...more });
const NOSCRIPT = '<noscript><meta http-equiv="refresh" content="6"></noscript>';
const SCRIPT_END = '})();\n</script>';
// The injected parts taken out (they are one block), what is left is the customer's page, byte for byte.
function without(html) {
  const at = html.indexOf(NOSCRIPT);
  assert.ok(at >= 0, 'the refresh is there');
  const end = html.indexOf(SCRIPT_END, at) + SCRIPT_END.length;
  assert.ok(end > at + NOSCRIPT.length, 'the script follows it');
  return html.slice(0, at) + html.slice(end);
}
const injectedAt = (html) => html.indexOf(NOSCRIPT);

test('custom: the refresh and the script go at the very start, and the page is otherwise byte for byte its own', () => {
  const html = custom(CUSTOM);
  assert.equal(without(html), CUSTOM);
  assert.equal(injectedAt(html), '<!doctype html>'.length, 'after the doctype, so standards mode holds');
  assert.match(html, /<html lang="de">/, 'its language is its own');
  assert.doesNotMatch(html, /Waking up…|class="dot"|:root\{/, 'none of the template');
  assert.match(html, /const pollMs = 3000;/);
});

test('custom: after a BOM, white space, comments and the doctype when they come first; before anything else', () => {
  const cases = {
    plain: ['<p>x</p>', 0],
    bom: ['﻿<p>x</p>', 1],
    space: [' \n\t\r\f<p>x</p>', 5],
    comment: ['<!-- a --><p>x</p>', 10],
    doctype: ['<!DOCTYPE html><p>x</p>', 15],
    lower: ['<!doctype html>\n<p>x</p>', 16],
    all: ['﻿ \n<!-- one -->\n<!-- two --> <!DOCTYPE html>\n<!-- three -->\n<html><p>x</p></html>', 60],
    'comment holding a doctype': ['<!-- <!DOCTYPE html> --><p>x</p>', 24],
    'comment holding </body> and <head>': ['<!-- </body><head> --><html><head></head><body></body></html>', 22],
    'doctype with a public id': ['<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0//EN" "http://x/y.dtd"><html></html>', 67],
    'only a comment': ['<!-- c -->', 10],
    'unclosed comment': ['<p>a</p><!-- todo', 0],
    'unclosed comment first': ['<!-- todo </body>', 0],
    'unclosed doctype': ['<!DOCTYPE html', 0],
    'text after a doctype': ['<!DOCTYPE html>text', 15],
  };
  for (const [name, [page, at]] of Object.entries(cases)) {
    const html = custom(page);
    assert.equal(injectedAt(html), at, name);
    assert.equal(without(html), page, name);
  }
});

test('custom: what the page holds cannot leave the script inert or change a byte of the page', () => {
  const pages = [
    '<html><body><p>x</p></body><!-- old footer </body> --></html>',
    '<html><body><p>x</p><!-- todo',
    '<html><body></body><script>var tail = "</body>"; window.mine = 1;</script></html>',
    '<html><body><template><body>t</body></template></html>',
    '<html><body><p>x</p><textarea>draft',
    '<html><head></head><frameset><frame></frameset></html>',
    '<html><!-- <head> --><head><title>t</title></head>',
    '<html><head data-x=">"><title>t</title>',
    '<script>var h = "<head>"; window.mine = 1;</script><body>',
    '<head></head><head></head><body></body></body>',
    "<head>$& $1 $` $' $$</head>",
    '<p>é€\u{1F600}</p>',
  ];
  for (const page of pages) {
    const html = custom(page);
    assert.equal(without(html), page, page);
    assert.equal(injectedAt(html), 0, page);
  }
});

test('custom: the largest page, and the template with the largest icon, stay under 1 MB', () => {
  const big = `<head></head><body>${'é'.repeat(128 * 1024 - 26)}</body>`;
  assert.equal(Buffer.byteLength(big) <= 256 * 1024, true);
  assert.ok(Buffer.byteLength(custom(big)) < 1_000_000);
  const icon = `data:image/png;base64,${Buffer.alloc(64 * 1024).toString('base64')}`;
  const html = renderPage({ ...waking, icon, ...template({ title: 'é'.repeat(80), description: '"&<>\n'.repeat(100).slice(0, 500) }), progress: { elapsedMs: 1, typicalMs: 2 } });
  assert.ok(Buffer.byteLength(html) < 150_000, String(Buffer.byteLength(html)));
});

test('a hostile 256 KiB custom page is answered quickly: no search for a tag in it', () => {
  const hostile = ['<head '.repeat(43_690), '<!--'.repeat(65_536), '<!---->'.repeat(37_000), `${' '.repeat(262_000)}<p>`, '<!DOCTYPE'.repeat(29_000), '﻿'.repeat(100_000), '</body '.repeat(32_000)];
  for (const page of hostile.map((p) => `${p}<p>`)) {
    const started = performance.now();
    const html = custom(page);
    assert.ok(performance.now() - started < 200, `${page.slice(0, 10)}: ${performance.now() - started} ms`);
    assert.equal(without(html), page);
  }
});

// The page's script, run in a vm with a small fake of the document, fetch and the timers.
function runScript(html, answers) {
  const body = html.replace(/<script>[\s\S]*<\/script>/, '');
  const elements = {};
  const byId = {};
  const events = [];
  const created = [];
  const later = [];
  const delays = [];
  const make = (name) => ({
    name, textContent: '', attrs: {}, style: {}, hidden: false, className: '', parentNode: null, children: [],
    setAttribute(k, v) { this.attrs[k] = v; },
    append(...c) { c.forEach((n) => { n.parentNode = this; }); this.children.push(...c); },
    before(n) { document.inserted.push(n); },
  });
  const document = {
    inserted: [],
    getElementById: (id) => byId[id] ?? null,
    querySelector: (selector) => elements[/data-dormeto="(\w+)"/.exec(selector)?.[1]] ?? null,
    createElement: () => { const el = make('new'); created.push(el); return el; },
    dispatchEvent: (event) => { events.push(event); return true; },
  };
  const addHook = (name) => { elements[name] = make(name); return elements[name]; };
  for (const name of new Set([...body.matchAll(/data-dormeto="(status|elapsed|progress)"/g)].map((m) => m[1]))) addHook(name);
  for (const id of ['message', 'elapsed', 'reload']) {
    const tag = new RegExp(`<[^>]* id="${id}"[^>]*>([^<]*)`).exec(body);
    if (!tag) continue;
    const hooked = /data-dormeto="(status|elapsed)"/.exec(tag[0])?.[1];
    byId[id] = hooked ? elements[hooked] : make(id);
    if (id === 'reload') { byId.reload.textContent = tag[1]; byId.reload.parentNode = { before(n) { document.inserted.push(n); } }; }
    else byId[id].textContent ||= tag[1];
  }
  elements.reload = byId.reload;
  const server = bar(html);
  if (server) { elements.progress.style.width = `${server[2]}%`; elements.progress.attrs['aria-valuenow'] = server[1]; elements.progress.parentNode = make('track'); elements.progress.parentNode.className = 'track'; }
  const timers = [];
  const clock = { now: 1_000_000 };
  const queue = [...answers];
  const context = {
    document, location: { href: 'https://app.example/', reload() { context.reloaded = true; } }, reloaded: false,
    Date: { now: () => clock.now, parse: Date.parse }, Math, Number, Promise, JSON, isFinite,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    setInterval: (fn) => timers.push(fn),
    setTimeout: (fn, ms) => { later.push(fn); delays.push(ms); },
    fetch: async () => { const a = queue.shift() ?? { state: 'WAKING' }; return { type: 'basic', headers: { get: (name) => a.headers?.[name] ?? (name === 'x-dormeto-state' ? a.state : null) } }; },
  };
  vm.runInNewContext(scriptOf(html), context);
  return {
    elements, byId, document, context, events, created, delays, addHook,
    settle: async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); },
    next: async () => { later.splice(0).forEach((fn) => fn()); for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); },
    tick: (ms) => { clock.now += ms; timers.forEach((fn) => fn()); },
  };
}
const headers = (elapsed, typical) => ({ 'x-dormeto-wake-elapsed': String(elapsed), ...(typical === undefined ? {} : { 'x-dormeto-wake-typical': String(typical) }) });
const shown = { ...waking, progress: { elapsedMs: 5000, typicalMs: 10_000 } };

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
  await run.next();
  run.tick(1000);
  assert.equal(fill.style.width, '90%', 'a WAKING answer without the headers leaves it as it was');
  assert.equal(run.document.inserted.length, 1);
  assert.equal(track.hidden, false);
});

test('script: a page without a bar has none, and counts from the page', async () => {
  const none = runScript(renderPage(waking), [{ state: 'WAKING' }]);
  await none.settle();
  none.tick(5000);
  assert.equal(none.document.inserted.length, 0);
  assert.equal(none.elements.elapsed.textContent, '5 s', 'since the page opened');
});

test('script: the server\'s bar is used, none is added, and it moves', async () => {
  const served = runScript(renderPage(shown), [{ state: 'WAKING' }]);
  await served.settle();
  served.tick(2000);
  assert.equal(served.elements.progress.style.width, '70%');
  assert.equal(served.elements.progress.parentNode.hidden, false);
  assert.equal(served.document.inserted.length, 0);
  assert.equal(served.created.length, 0);
});

test('script: past the typical time the bar stops at 95% and "longer" replaces the reload sentence, only past it', async () => {
  const run = runScript(renderPage({ ...waking, progress: { elapsedMs: 9000, typicalMs: 10_000 } }), [{ state: 'WAKING' }]);
  await run.settle();
  run.tick(1000);
  assert.equal(run.elements.reload.textContent, 'This page reloads by itself as soon as the application is ready.', 'at the typical time exactly, not yet');
  run.tick(1);
  run.tick(1000);
  assert.equal(run.elements.progress.style.width, '95%');
  assert.equal(run.elements.reload.textContent, 'This is taking longer than usual.');
});

test('script: AWAKE fills the bar it has and freezes the sentence; a page opened at AWAKE has none', async () => {
  const awake = runScript(renderPage({ ...waking, progress: { elapsedMs: 9000, typicalMs: 10_000 } }), [{ state: 'AWAKE' }]);
  await awake.settle();
  assert.equal(awake.elements.progress.style.width, '100%');
  assert.equal(awake.elements.progress.attrs['aria-valuenow'], '100');
  awake.tick(60_000);
  assert.equal(awake.elements.progress.style.width, '100%', 'it stays full');
  assert.equal(awake.elements.reload.textContent, 'This page reloads by itself as soon as the application is ready.', 'unchanged, even past the typical time');
  const opened = runScript(renderPage(waking), [{ state: 'AWAKE' }]);
  await opened.settle();
  assert.equal(opened.document.inserted.length, 0);
});

test('script: FAILED and a nap take the bar and "longer" away, and the seconds count from the page again', async () => {
  const old = { ...waking, progress: { elapsedMs: 120_000, typicalMs: 10_000 } };
  for (const answer of [
    { state: 'FAILED', headers: { 'x-dormeto-failure': 'other' } },
    { state: 'ASLEEP', headers: { 'x-dormeto-nap-until': '2026-11-02T07:00:00Z' } },
    { state: 'WAKING', headers: { 'x-dormeto-nap-until': '2026-11-02T07:00:00Z' } },
    { state: 'NAPPING' },
  ]) {
    const run = runScript(renderPage(old), [answer]);
    assert.equal(run.elements.reload.textContent, 'This is taking longer than usual.');
    await run.settle();
    assert.equal(run.elements.progress.parentNode.hidden, true, JSON.stringify(answer));
    assert.equal(run.elements.reload.textContent, 'This page reloads by itself as soon as the application is ready.', JSON.stringify(answer));
    run.tick(3000);
    assert.equal(run.elements.elapsed.textContent, '3 s', 'since the page opened');
    assert.equal(run.elements.progress.parentNode.hidden, true, 'and stays hidden');
  }
});

test('script: a new WAKING starts the bar afresh, after AWAKE and after FAILED', async () => {
  for (const between of [{ state: 'AWAKE' }, { state: 'FAILED', headers: { 'x-dormeto-failure': 'other' } }]) {
    const run = runScript(renderPage(shown), [between, { state: 'WAKING', headers: headers(1000, 10_000) }]);
    await run.settle();
    await run.next();
    assert.equal(run.elements.progress.style.width, '10%', between.state);
    assert.equal(run.elements.progress.parentNode.hidden, false, 'the bar is back');
    run.tick(1000);
    assert.equal(run.elements.progress.style.width, '20%', 'and moves');
    assert.equal(run.elements.elapsed.textContent, '2 s');
  }
  const bare = runScript(renderPage(shown), [{ state: 'AWAKE' }, { state: 'WAKING' }]);
  await bare.settle();
  await bare.next();
  assert.equal(bare.elements.progress.parentNode.hidden, true, 'a new WAKING with no headers has no bar');
});

test('script: the elapsed header alone gives the seconds since the wake started; the bar needs both', async () => {
  const run = runScript(renderPage(waking), [{ state: 'WAKING', headers: headers(60_000) }]);
  await run.settle();
  assert.equal(run.elements.elapsed.textContent, '60 s');
  assert.equal(run.document.inserted.length, 0);
  run.tick(2000);
  assert.equal(run.elements.elapsed.textContent, '62 s');
  assert.match(renderPage({ ...waking, progress: { elapsedMs: 60_000 } }), /<span id="elapsed" data-dormeto="elapsed">60 s<\/span>/);
  assert.doesNotMatch(bodyOf(renderPage({ ...waking, progress: { elapsedMs: 60_000, typicalMs: null } })), /progressbar/);
  assert.match(renderPage({ ...waking, progress: { elapsedMs: 60_000, typicalMs: null } }), /60 s/);
});

test('script: unusable headers are ignored', async () => {
  for (const bad of [headers('x', 10_000), headers(5000, 0), headers(5000, -1), headers('', ''), headers(-1, 5000), { 'x-dormeto-wake-typical': '5000' }]) {
    const run = runScript(renderPage(waking), [{ state: 'WAKING', headers: bad }]);
    await run.settle();
    assert.equal(run.document.inserted.length, 0, JSON.stringify(bad));
  }
  const run = runScript(renderPage(waking), [{ state: 'WAKING', headers: headers(-1, 5000) }]);
  await run.settle();
  run.tick(4000);
  assert.equal(run.elements.elapsed.textContent, '4 s', 'a negative elapsed does not move the start');
});

test('script: the failure sentences, with their next attempt, are built in the visitor\'s language', async () => {
  const retryAt = (ms) => new Date(1_000_000 + ms).toISOString();
  const cases = [
    ['en', 'capacity', 4 * 60_000, /^AWS has no capacity for this application right now: the start is retried, next attempt in [34] minutes\.$/],
    ['en', 'unhealthy', 4 * 60_000, /^The application could not be started; its team is notified\. Next attempt in [34] minutes\.$/],
    ['en', 'unhealthy', 30_000, /^The application could not be started; its team is notified\. Next attempt in less than a minute\.$/],
    ['fr', 'capacity', 4 * 60_000, /^AWS n'a plus de capacité .* retenté, prochain essai dans [34] minutes\.$/],
    ['fr', 'unhealthy', 4 * 60_000, /^L'application n'a pas pu démarrer ; son équipe est prévenue\. Prochain essai dans [34] minutes\.$/],
    ['fr', 'unhealthy', 61_000, /Prochain essai dans 1 minute\.$/],
    ['fr', 'unhealthy', 10_000, /Prochain essai dans moins d'une minute\.$/],
  ];
  for (const [language, failure, ms, expected] of cases) {
    const run = runScript(renderPage({ ...waking, language }), [{ state: 'FAILED', headers: { 'x-dormeto-failure': failure, 'x-dormeto-retry-at': retryAt(ms) } }]);
    await run.settle();
    assert.match(run.elements.status.textContent, expected, `${language} ${failure} ${ms}`);
  }
  const inherited = runScript(renderPage(waking), [{ state: 'constructor' }, { state: 'FAILED', headers: { 'x-dormeto-failure': 'constructor' } }]);
  await inherited.settle();
  await inherited.next();
  assert.equal(inherited.elements.status.textContent, 'The application could not be started; its team is notified.', 'a failure that is no kind of ours is "other"');
});

test('script: nothing the page is given can end the script element', () => {
  const html = renderPage({ ...waking, probeUrl: '/w?</script><b>', napUntil: { at: 'x', local: 'Mon 08:00', timeZone: '</script><i>' }, cloud: '</script><u>' });
  assert.equal(html.match(/<\/script>/g).length, 1);
  assert.equal(custom('<p></p>', { napUntil: { at: 'x', local: 'Mon 08:00', timeZone: '</script><i>' } }).match(/<\/script>/g).length, 1);
});

test('script: a negative elapsed time is a bar at 0, not below it', () => {
  assert.equal(bar(renderPage({ ...waking, progress: { elapsedMs: -5000, typicalMs: 10_000 } }))[2], '0');
  assert.match(renderPage({ ...waking, progress: { elapsedMs: -5000, typicalMs: 10_000 } }), /<span id="elapsed" data-dormeto="elapsed">0 s<\/span>/);
});

test('script: on a page with only getElementById, the counter and the message are still served', async () => {
  const messageEl = {};
  const elapsedEl = {};
  const timers = [];
  const context = {
    location: { href: 'x', reload() {} }, Date: { now: () => 5000, parse: Date.parse }, Math, isFinite,
    document: { getElementById: (id) => (id === 'message' ? messageEl : id === 'elapsed' ? elapsedEl : {}) },
    setInterval: (fn) => timers.push(fn), setTimeout: () => 0,
    fetch: async () => ({ type: 'basic', headers: { get: (n) => (n === 'x-dormeto-state' ? 'AWAKE' : null) } }),
  };
  vm.runInNewContext(scriptOf(renderPage(waking)), context);
  timers.forEach((fn) => fn());
  assert.equal(elapsedEl.textContent, '0 s');
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.equal(messageEl.textContent, 'Almost there…');
});

test('the language is en or fr in the page, whatever is passed', () => {
  for (const language of ['de', 'constructor', '"><x', undefined, null, 5, {}]) {
    const html = renderPage({ ...waking, language });
    assert.match(html, /<html lang="en">/, String(language));
    assert.match(html, /Waking up the application…/);
  }
  assert.match(renderPage({ state: 'constructor', pollSeconds: 3 }), /Waking up the application…/, 'a state that is no state of ours is WAKING');
  assert.equal(failureMessage('constructor', undefined, 'AWS', 'constructor'), 'The application could not be started; its team is notified.');
});

test('languageOf: q=1.0, 20 entries and 500 characters are the limits', () => {
  assert.equal(languageOf('fr;q=1.0,en;q=0.5'), 'fr');
  assert.equal(languageOf('fr;q=1,en;q=0.5'), 'fr');
  assert.equal(languageOf('en;q=0.5,fr;q=0.6'), 'fr');
  assert.equal(languageOf('fr;q=1.5'), 'en');
  assert.equal(languageOf('fr;q=-1'), 'en');
  const twenty = Array.from({ length: 20 }, () => 'de').join(',');
  assert.equal(languageOf(`${twenty},fr`), 'en', 'the 21st entry is not read');
  assert.equal(languageOf(`${Array.from({ length: 19 }, () => 'de').join(',')},fr`), 'fr', 'the 20th is');
  assert.equal(languageOf(`${' '.repeat(500)}fr`), 'en', 'past 500 characters nothing is read');
  assert.equal(languageOf(`${' '.repeat(496)}fr`), 'fr');
});

test('custom hooks: only the data-dormeto elements are touched, never ids, and no element is added', async () => {
  const html = custom('<div id="message">Our own message</div><button id="reload">Reload now</button><span id="elapsed">x</span><div class="track"><div id="f" data-dormeto="progress" hidden></div></div><p data-dormeto="status"></p><i data-dormeto="elapsed"></i>');
  const run = runScript(html, [{ state: 'WAKING', headers: headers(5000, 10_000) }]);
  run.elements.progress.hidden = true;
  run.elements.progress.parentNode = make2('track');
  await run.settle();
  assert.equal(run.byId.message.textContent, 'Our own message');
  assert.equal(run.byId.reload.textContent, 'Reload now');
  assert.equal(run.byId.elapsed.textContent, 'x');
  assert.equal(run.created.length, 0);
  assert.equal(run.document.inserted.length, 0);
  assert.equal(run.elements.progress.hidden, false, 'hidden comes off the hook itself, not off its parent');
  assert.equal(run.elements.progress.style.width, '50%');
  assert.equal(run.elements.progress.parentNode.hidden, false);
  assert.equal(run.elements.elapsed.textContent, '5 s');
  assert.equal(run.elements.status.textContent, 'Waking up the application…');
  assert.deepEqual(run.elements.progress.attrs, {}, 'only the width is set on a customer\'s element');
});
function make2(className) { return { className, hidden: false }; }

test('custom hooks: a page without the status hook and without a bar still probes and is left alone', async () => {
  const run = runScript(custom('<p>mine</p>'), [{ state: 'WAKING', headers: headers(5000, 10_000) }]);
  await run.settle();
  assert.equal(run.events.length, 1);
  assert.equal(run.created.length, 0);
  run.tick(1000);
  const gone = runScript(custom('<p>mine</p>'), [{ state: null }]);
  await gone.settle();
  assert.equal(gone.context.reloaded, true, 'an answer that is not the waker\'s reloads the visitor');
});

test('custom hooks: the hooks are looked up at each update, so a page that renders them later is served', async () => {
  const run = runScript(custom('<div id="app"></div>'), [{ state: 'WAKING', headers: headers(2000, 8000) }, { state: 'WAKING', headers: headers(3000, 8000) }]);
  await run.settle();
  run.addHook('status');
  run.addHook('elapsed');
  const bar = run.addHook('progress');
  bar.hidden = true;
  run.tick(1000);
  assert.equal(run.elements.status.textContent, 'Waking up the application…');
  assert.equal(run.elements.elapsed.textContent, '3 s');
  assert.equal(bar.hidden, false);
  assert.equal(bar.style.width, '38%');
});

test('custom hooks: the dormeto:state event, at each probe', async () => {
  const retryAt = new Date(1_000_000 + 4 * 60_000).toISOString();
  const run = runScript(custom('<p data-dormeto="status"></p>'), [{ state: 'WAKING', headers: headers(2000, 8000) }, { state: 'FAILED', headers: { 'x-dormeto-failure': 'capacity', 'x-dormeto-retry-at': retryAt } }]);
  assert.equal(run.elements.status.textContent, 'Waking up the application…', 'the sentence is there at once');
  await run.settle();
  await run.next();
  assert.equal(run.events[0].type, 'dormeto:state');
  assert.deepEqual({ ...run.events[0].detail }, { state: 'WAKING', failure: null, retryAt: null, napUntil: null, elapsedMs: 2000, typicalMs: 8000 });
  assert.equal(run.events[1].detail.state, 'FAILED');
  assert.equal(run.events[1].detail.failure, 'capacity');
  assert.equal(run.events[1].detail.retryAt, retryAt);
  assert.match(run.elements.status.textContent, /^AWS has no capacity .*next attempt in [34] minutes\.$/);
});

test('custom: with probeUrl, the reload keeps its one-per-poll pacing even with wake headers', async () => {
  for (const html of [renderPage({ ...waking, probeUrl: '/_dormeto/wake', progress: { elapsedMs: 60_000, typicalMs: 10_000 } }), custom('<p>x</p>', { probeUrl: '/_dormeto/wake', progress: { elapsedMs: 60_000, typicalMs: 10_000 } })]) {
    const run = runScript(html, [{ state: 'AWAKE', headers: headers(60_000, 10_000) }]);
    await run.settle();
    assert.equal(run.delays[0], 3000);
  }
});

// --- Final review: the scan follows the HTML parser ----------------------------------------------------------------------

test('custom: a comment ends as the HTML parser ends it: <!-->, <!--->, the first --> or --!>; an unterminated one holds the rest', () => {
  const decl = '<?xml version="1.0"?>';
  const cases = {
    'empty comment': ['<!--><p>x</p>', 5],
    'dash comment': ['<!---><p>x</p>', 6],
    'empty comment, then the doctype': ['<!--><!doctype html><p>x</p>', 5 + 15],
    'dash comment, then the doctype': ['<!---><!doctype html><p>x</p>', 6 + 15],
    'bang end': ['<!-- c --!><p>x</p>', 11],
    'bang end, then a dash end that is text': ['<!-- c --!>--><p>x</p>', 11],
    'first end wins': ['<!-- a --> b --!> c --><p>x</p>', 11],
    'the usual end': ['<!----><p>x</p>', 7],
    'conditional': ['<!--[if !IE]><!--><p>x</p>', 18],
    'half an end': ['<!-- a --!', 0],
    'a dash end after a bang': ['<!-- a -- >', 0],
    'unterminated after a doctype': ['<!doctype html><!-- <p>x</p>', 15],
    'an xml declaration': [`${decl}<!DOCTYPE html><p>x</p>`, decl.length + 15],
    'an xml declaration ends at its first >': ['<?a > b ?><!DOCTYPE html>', 6],
    'an xml declaration after a comment and white space': [`<!-- c -->\n${decl}\n<!DOCTYPE html>x`, 11 + decl.length + 1 + 15],
    'an unterminated xml declaration': ['<?xml version="1.0"', 0],
    'an xml declaration holding a comment start': ['<?a <!-- ?><!DOCTYPE html>', 11 + 15],
  };
  for (const [name, [page, at]] of Object.entries(cases)) {
    const html = custom(page);
    assert.equal(injectedAt(html), at, name);
    assert.equal(without(html), page, name);
  }
});

test('custom: the new forms stay linear on a hostile 256 KiB page', () => {
  const hostile = ['<!-->'.repeat(52_000), '<!--->'.repeat(43_000), '<?'.repeat(131_000), '<!-- -->'.repeat(32_000), '<!-- a -->'.repeat(26_000), '<?a>'.repeat(65_000), `<!--${'-->'.repeat(87_000)}`];
  for (const page of hostile.map((p) => `${p}<p>`)) {
    const started = performance.now();
    const html = custom(page);
    assert.ok(performance.now() - started < 200, `${page.slice(0, 10)}: ${performance.now() - started} ms`);
    assert.equal(without(html), page);
  }
});

test('script: its own reference to fetch is taken at its start, so a page that replaces fetch does not strand the visitor', async () => {
  const run = runScript(custom('<p>x</p>'), [{ state: 'WAKING' }, {}]);
  await run.settle();
  assert.equal(run.context.reloaded, false);
  run.context.fetch = async () => { throw new Error('the customer\'s'); };
  await run.next();
  assert.equal(run.context.reloaded, true, 'the later probe used the script\'s own fetch and saw the workload awake');
});

// --- Markdown in a template's title and description ---------------------------------------------------------------------

const withPage = (page) => renderPage({ state: 'WAKING', pollSeconds: 3, page: { mode: 'template', ...page } });
const note = (description) => /<div class="note">([\s\S]*?)<\/div>\n/.exec(withPage({ description }))?.[1];

test('a title takes inline Markdown in its heading, and its bare text in the tab', () => {
  const html = withPage({ title: 'The **Acme** *portal* `v2` [status](https://acme.example/status)' });
  assert.match(html, /<h1>The <strong>Acme<\/strong> <em>portal<\/em> <code>v2<\/code> <a href="https:\/\/acme\.example\/status" rel="noopener noreferrer" target="_blank">status<\/a><\/h1>/);
  assert.match(html, /<title>The Acme portal v2 status<\/title>/);
});

test('a title is one heading: block Markdown stays text in it', () => {
  const html = withPage({ title: '# Acme' });
  assert.match(html, /<h1># Acme<\/h1>/);
  assert.match(html, /<title># Acme<\/title>/);
});

test('a description takes paragraphs, line breaks, headings, lists, quotes, code and inline Markdown', () => {
  assert.equal(note('One\nline two\n\nOther **bold**'), '<p>One<br>line two</p><p>Other <strong>bold</strong></p>');
  assert.equal(note('## About\nText'), '<h2>About</h2><p>Text</p>');
  assert.equal(note('### Small'), '<h3>Small</h3>');
  assert.equal(note('- one\n- *two*\n\n1. first\n2. second'), '<ul><li>one</li><li><em>two</em></li></ul><ol><li>first</li><li>second</li></ol>');
  assert.equal(note('> quoted\n> more'), '<blockquote><p>quoted<br>more</p></blockquote>');
  assert.equal(note('```\nnpm  start\n```'), '<pre><code>npm  start</code></pre>');
});

test('a plain text without Markdown reads as it did: marks that close nothing stay', () => {
  assert.equal(note('5 * 3 = 15, a [note] and `one tick'), '<p>5 * 3 = 15, a [note] and `one tick</p>');
  assert.equal(note('**not closed'), '<p>**not closed</p>');
  assert.equal(note('snake_case_name'), '<p>snake_case_name</p>');
});

test('Markdown makes no HTML from the text: everything is escaped, in every construct', () => {
  for (const hostile of ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>']) {
    for (const wrap of [(x) => x, (x) => `**${x}**`, (x) => `*${x}*`, (x) => `\`${x}\``, (x) => `- ${x}`, (x) => `> ${x}`, (x) => `## ${x}`, (x) => `[${x}](https://a.example)`, (x) => `\`\`\`\n${x}\n\`\`\``]) {
      const out = note(wrap(hostile));
      assert.doesNotMatch(out, /<script|<img/, wrap(hostile));
      assert.match(out, /&lt;(script|img)/, wrap(hostile));
    }
  }
});

test('a link goes only to an https address; its address cannot leave its attribute', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,x', 'http://acme.example', '//acme.example', 'mailto:a@acme.example']) {
    const out = note(`[x](${url})`);
    assert.doesNotMatch(out, /<a /, url);
    assert.ok(out.includes(`[x](${url})`), url);
  }
  const out = note('[x](https://a.example/"onmouseover="alert(1))');
  assert.match(out, /href="https:\/\/a\.example\/&quot;onmouseover=&quot;alert\(1"/);
  assert.doesNotMatch(out, /"onmouseover/);
});

test('quotes nest three deep at most; deeper marks stay text', () => {
  assert.equal(note('> > > > deep'), '<blockquote><blockquote><blockquote><p>&gt; deep</p></blockquote></blockquote></blockquote>');
});

test('a long description of marks stays fast', () => {
  const start = Date.now();
  note(`${'*'.repeat(100000)} ${'['.repeat(100000)} ${'`'.repeat(100001)}`);
  assert.ok(Date.now() - start < 1000);
});
