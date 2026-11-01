// The waiting page (spec 2026-11-01-branded-waiting-page §6 to §9): Dormeto's template, or the customer's own HTML with the
// probe added. Pure and import-free: the dashboard copies this file into a browser build for its preview.
const TEXTS = {
  en: {
    title: 'Waking up…',
    states: {
      ASLEEP: 'Waking up the application…',
      WAKING: 'Waking up the application…',
      NAPPING: 'The application was going to sleep, waking it up again…',
      AWAKE: 'Almost there…',
      FAILED: 'The application could not be started. Retrying shortly…',
    },
    capacity: '{cloud} has no capacity for this application right now: the start is retried',
    // On Google Cloud nothing notifies anyone before the manager comes (spec G1): the logs and the CLI only.
    otherAws: 'The application could not be started; its team is notified.',
    other: 'The application could not be started.',
    nextCapacity: ', next attempt in {when}.',
    nextOther: 'Next attempt in {when}.',
    less: 'less than a minute',
    one: '1 minute',
    many: ' minutes',
    nap: (local, zone) => `Napping on schedule until ${local} (${zone}).`,
    days: {},
    reload: 'This page reloads by itself as soon as the application is ready.',
    longer: 'This is taking longer than usual.',
  },
  fr: {
    title: 'Démarrage…',
    states: {
      ASLEEP: "Démarrage de l'application…",
      WAKING: "Démarrage de l'application…",
      NAPPING: "L'application allait s'endormir, elle redémarre…",
      AWAKE: "C'est presque prêt…",
      FAILED: "L'application n'a pas pu démarrer. Nouvel essai sous peu…",
    },
    capacity: "{cloud} n'a plus de capacité pour cette application pour le moment : le démarrage sera retenté",
    otherAws: "L'application n'a pas pu démarrer ; son équipe est prévenue.",
    other: "L'application n'a pas pu démarrer.",
    nextCapacity: ', prochain essai dans {when}.',
    nextOther: 'Prochain essai dans {when}.',
    less: "moins d'une minute",
    one: '1 minute',
    many: ' minutes',
    nap: (local, zone) => `En pause programmée jusqu'à ${local} (${zone}).`,
    days: { Mon: 'lun.', Tue: 'mar.', Wed: 'mer.', Thu: 'jeu.', Fri: 'ven.', Sat: 'sam.', Sun: 'dim.' },
    reload: "Cette page se recharge d'elle-même dès que l'application est prête.",
    longer: "Le démarrage prend plus de temps que d'habitude.",
  },
};

// What a template answer must carry as content-security-policy; a custom page gets none (it would break the customer's page).
export const PAGE_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const textsOf = (language) => (language === 'fr' ? TEXTS.fr : TEXTS.en);
const escapeHtml = (value) => String(value).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// In a script element: no "<" can end it.
const json = (value) => JSON.stringify(value).replace(/</g, '\\u003c');

// --- Markdown of a template's title and description. The subset of the dashboard's markdown.ts: headings, paragraphs (a line
// break inside one), bulleted and numbered lists, quotes, fenced code, `code`, **bold**, *italic* and links to https://
// addresses. Every piece of the text goes through `text`, so nothing a customer wrote becomes HTML; a mark that closes nothing
// stays text. A closer is looked for from the last place it was found, and once absent never again: one pass over the text.
const HTML_MARKS = {
  text: escapeHtml,
  tag: (name, inner) => `<${name}>${inner}</${name}>`,
  link: (url, label) => `<a href="${escapeHtml(url)}" rel="noopener noreferrer" target="_blank">${label}</a>`,
};
// For the tab's title: the words alone, escaped once by the caller.
const BARE_MARKS = { text: (value) => value, tag: (name, inner) => inner, link: (url, label) => label };
const MAX_URL = 2000;

function finder(find) {
  let at = -2;
  let last = -1;
  return (from) => {
    if (at === -1) return -1;
    if (at >= from && last <= from) return at;
    at = find(from);
    last = from;
    return at;
  };
}

function inlineOf(text, marks, nested = false) {
  let out = '';
  let plain = '';
  const flush = () => { out += marks.text(plain); plain = ''; };
  const tick = finder((from) => text.indexOf('`', from));
  const strong = finder((from) => text.indexOf('**', from));
  const star = finder((from) => {
    for (let j = text.indexOf('*', from); j !== -1; j = text.indexOf('*', j + 1)) {
      if (text[j - 1] !== ' ' && text[j + 1] !== '*' && text[j - 1] !== '*') return j;
    }
    return -1;
  });
  const bracket = finder((from) => text.indexOf(']', from));
  const paren = finder((from) => text.indexOf(')', from));
  const inner = (from, to) => (nested ? marks.text(text.slice(from, to)) : inlineOf(text.slice(from, to), marks, true));
  for (let i = 0; i < text.length;) {
    const c = text[i];
    if (c === '`') {
      const end = tick(i + 1);
      if (end > i + 1) { flush(); out += marks.tag('code', marks.text(text.slice(i + 1, end))); i = end + 1; continue; }
    } else if (c === '*' && text[i + 1] === '*') {
      const end = strong(i + 3);
      if (end > i + 2) { flush(); out += marks.tag('strong', inner(i + 2, end)); i = end + 2; continue; }
    } else if (c === '*' && text[i + 1] !== ' ' && text[i + 1] !== '*' && text[i - 1] !== '*') {
      const end = star(i + 2);
      if (end > i + 1) { flush(); out += marks.tag('em', inner(i + 1, end)); i = end + 1; continue; }
    } else if (c === '[') {
      const close = bracket(i + 2);
      if (close > i + 1 && text[close + 1] === '(') {
        const end = paren(close + 2);
        const url = end === -1 || end - close > MAX_URL ? '' : text.slice(close + 2, end);
        if (url.startsWith('https://') && !/\s/.test(url)) {
          flush();
          out += marks.link(url, marks.text(text.slice(i + 1, close)));
          i = end + 1;
          continue;
        }
      }
    }
    plain += c;
    i += 1;
  }
  flush();
  return out;
}

const MAX_QUOTE_DEPTH = 3;
const HEADING = /^(#{1,6})[ \t]+(\S.*)$/;
const BULLET = /^[-*+][ \t]+(\S.*)$/;
const NUMBER = /^\d{1,9}[.)][ \t]+(\S.*)$/;

function blocksOf(text, depth = 0) {
  let out = '';
  let paragraph = [];
  let items = [];
  let ordered = false;
  const inline = (line) => inlineOf(line, HTML_MARKS);
  const flush = () => {
    if (paragraph.length) out += `<p>${paragraph.map(inline).join('<br>')}</p>`;
    if (items.length) out += `<${ordered ? 'ol' : 'ul'}>${items.map((item) => `<li>${inline(item)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`;
    paragraph = [];
    items = [];
  };
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (let n = 0; n < lines.length; n += 1) {
    const line = lines[n];
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      flush();
      const code = [];
      for (n += 1; n < lines.length && !lines[n].trim().startsWith('```'); n += 1) code.push(lines[n]);
      out += `<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`;
      continue;
    }
    if (trimmed.startsWith('>') && depth < MAX_QUOTE_DEPTH) {
      flush();
      const quoted = [];
      for (; n < lines.length && lines[n].trim().startsWith('>'); n += 1) quoted.push(lines[n].trim().slice(1).replace(/^ /, ''));
      n -= 1;
      out += `<blockquote>${blocksOf(quoted.join('\n'), depth + 1)}</blockquote>`;
      continue;
    }
    const heading = HEADING.exec(trimmed);
    const bullet = BULLET.exec(trimmed);
    const number = bullet ? null : NUMBER.exec(trimmed);
    if (!trimmed) flush();
    else if (heading) {
      flush();
      const name = heading[1].length <= 2 ? 'h2' : 'h3';
      out += `<${name}>${inline(heading[2])}</${name}>`;
    } else if (bullet || number) {
      if (paragraph.length || (items.length && ordered !== !bullet)) flush();
      ordered = !bullet;
      items.push((bullet ?? number)[1]);
    } else if (items.length && /^\s/.test(line)) items[items.length - 1] += ` ${trimmed}`;
    else {
      if (items.length) flush();
      paragraph.push(trimmed);
    }
  }
  flush();
  return out;
}

// The first supported primary subtag of an Accept-Language, by q; English when none or the header is no use.
export function languageOf(acceptLanguage) {
  if (typeof acceptLanguage !== 'string') return 'en';
  const ranges = acceptLanguage.slice(0, 500).split(',').slice(0, 20).map((entry, order) => {
    const [tag, ...params] = entry.trim().split(';');
    const given = params.find((p) => /^\s*q\s*=/i.test(p));
    const q = given === undefined ? 1 : /^\s*q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)\s*$/i.exec(given)?.[1];
    return { primary: tag.trim().toLowerCase().split('-')[0], q: q === undefined ? 0 : Number(q), order };
  }).filter((r) => r.q > 0 && ['en', 'fr'].includes(r.primary));
  ranges.sort((a, b) => b.q - a.q || a.order - b.order);
  return ranges[0]?.primary ?? 'en';
}

const inText = (ms, t) => {
  const minutes = Math.round(ms / 60_000);
  return ms < 60_000 ? t.less : minutes === 1 ? t.one : `${minutes}${t.many}`;
};
const failuresOn = (cloud, t) => ({
  capacity: t.capacity.replace('{cloud}', () => cloud),
  other: cloud === 'AWS' ? t.otherAws : t.other,
});

// Why a wake failed, for the visitor (R7a); the next attempt is added to it.
export function failureMessage(failure, retryInMs, cloud = 'AWS', language = 'en') {
  const t = textsOf(language);
  if (!failure) return t.states.FAILED;
  const failures = failuresOn(cloud, t);
  const text = own(failures, failure) ? failures[failure] : failures.other;
  if (retryInMs === undefined) return text;
  const when = inText(retryInMs, t);
  return failure === 'capacity' ? text + t.nextCapacity.replace('{when}', when) : `${text} ${t.nextOther.replace('{when}', when)}`;
}

// napUntil.local stays as lib/schedule.mjs writes it ('Mon 08:00'); its day is translated here.
export function napMessage(napUntil, language = 'en') {
  const t = textsOf(language);
  const local = String(napUntil.local).replace(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?= )/, (day) => t.days[day] ?? day);
  return t.nap(local, napUntil.timeZone);
}

// The script, for the template and for a custom page alike: it probes, wakes, reloads, and serves the page's hooks
// (data-dormeto="status|elapsed|progress", the dormeto:state event). Nothing a customer wrote enters it. In the template it
// also uses its own ids and adds its bar; in a custom page it touches the hooks only, looked up at each update.
// initial: the status sentence a custom page's hook gets at once (the template already holds it).
// wake: { elapsed, typical } when the page is rendered while WAKING with numbers; typical is 0 without a recorded wake.
function scriptFor({ t, cloud, initial, pollMs, probeUrl, wake, last, custom }) {
  return `<script>
(() => {
  // Our own reference, before the page's code can replace fetch.
  const fetch = globalThis.fetch;
  const pollMs = ${pollMs};
  const openedAt = Date.now();
  const tpl = ${custom ? 'false' : 'true'};
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const failures = ${json(failuresOn(cloud, t))};
  const text = ${json({ messages: t.states, nextCapacity: t.nextCapacity, nextOther: t.nextOther, less: t.less, one: t.one, many: t.many, reload: t.reload, longer: t.longer })};
  const pick = (name) => (document.querySelector && document.querySelector('[data-dormeto="' + name + '"]')) || null;
  const byId = (id) => (tpl ? document.getElementById(id) : null);
  let made = null;
  let wakeAt = ${wake ? `Date.now() - ${wake.elapsed}` : 'null'};
  let typical = ${wake ? wake.typical : 0};
  let bar = typical > 0;
  let full = false;
  let last = ${json(last)};
  let sentence = ${initial === null ? 'null' : json(initial)};
  const shellOf = (fill) => (tpl && fill.parentNode && fill.parentNode.className === 'track' ? fill.parentNode : fill);
  const make = () => {
    const reload = byId('reload');
    if (!reload || !reload.parentNode) return null;
    const shell = document.createElement('div');
    shell.className = 'track';
    made = document.createElement('div');
    made.className = 'bar';
    made.setAttribute('role', 'progressbar');
    made.setAttribute('data-dormeto', 'progress');
    made.setAttribute('aria-valuemin', '0');
    made.setAttribute('aria-valuemax', '100');
    made.setAttribute('aria-labelledby', 'message');
    shell.append(made);
    reload.parentNode.before(shell);
    return made;
  };
  const paint = () => {
    const ms = Date.now() - (wakeAt === null ? openedAt : wakeAt);
    const elapsed = pick('elapsed') || byId('elapsed');
    if (elapsed) elapsed.textContent = Math.round(ms / 1000) + ' s';
    const status = pick('status') || byId('message');
    if (status && sentence !== null && status.textContent !== sentence) status.textContent = sentence;
    let fill = pick('progress') || made;
    const reload = byId('reload');
    if (bar) {
      if (!fill) fill = make();
      if (fill) {
        const pct = full ? 100 : Math.min(95, Math.round(ms / typical * 100));
        shellOf(fill).hidden = false;
        fill.style.width = pct + '%';
        if (tpl) fill.setAttribute('aria-valuenow', String(pct));
      }
      if (reload && !full) reload.textContent = ms > typical ? text.longer : text.reload;
    } else {
      if (fill) shellOf(fill).hidden = true;
      if (reload && reload.textContent !== text.reload) reload.textContent = text.reload;
    }
  };
  const num = (r, name) => {
    const v = r.headers.get(name);
    const n = v === null || v === '' ? NaN : Number(v);
    return isFinite(n) ? n : null;
  };
  ${custom || wake ? 'paint();' : ''}
  setInterval(paint, 1000);
  const probe = async () => {
    try {
      const r = await fetch(${probeUrl ? json(probeUrl) : 'location.href'}, { cache: 'no-store', credentials: 'same-origin', redirect: 'manual', headers: { 'x-dormeto-probe': '1' } });
      const state = r.type === 'opaqueredirect' ? null : r.headers.get('x-dormeto-state');
      ${probeUrl ? '' : "if (!state) { location.reload(); return; }\n      "}const nap = r.headers.get('x-dormeto-nap-until');
      const failure = r.headers.get('x-dormeto-failure');
      const retryAt = r.headers.get('x-dormeto-retry-at');
      let elapsedMs = num(r, 'x-dormeto-wake-elapsed');
      let typicalMs = num(r, 'x-dormeto-wake-typical');
      if (elapsedMs !== null && elapsedMs < 0) elapsedMs = null;
      if (typicalMs !== null && typicalMs <= 0) typicalMs = null;
      if (state) {
        if (state === 'AWAKE') { if (bar) full = true; }
        else if (nap || state !== 'WAKING') { bar = false; full = false; typical = 0; wakeAt = null; }
        else {
          // A new wake starts afresh; a WAKING answer without the headers leaves the bar as it was.
          if (last !== 'WAKING') { bar = false; full = false; typical = 0; wakeAt = null; }
          if (elapsedMs !== null) wakeAt = Date.now() - elapsedMs;
          if (elapsedMs !== null && typicalMs !== null) { typical = typicalMs; bar = true; }
        }
        last = nap ? 'NAP' : state;
        paint();
        try { document.dispatchEvent(new CustomEvent('dormeto:state', { detail: { state, failure, retryAt, napUntil: nap, elapsedMs, typicalMs } })); } catch (e) { /* a page without events */ }
      }
      ${probeUrl
    ? "if (!state || state === 'AWAKE') { setTimeout(() => location.reload(), Math.max(0, openedAt + pollMs - Date.now())); return; }"
    : ''}
      // Still napping on schedule: the page keeps saying so.
      if (nap) { setTimeout(probe, pollMs); return; }
      if (state === 'FAILED' && failure) {
        const ms = Math.max(0, Date.parse(retryAt) - Date.now());
        const when = !retryAt ? '' : ms < 60000 ? text.less : Math.round(ms / 60000) === 1 ? text.one : Math.round(ms / 60000) + text.many;
        const failed = own(failures, failure) ? failures[failure] : failures.other;
        sentence = !when ? failed : failure === 'capacity' ? failed + text.nextCapacity.replace('{when}', when) : failed + ' ' + text.nextOther.replace('{when}', when);
      } else sentence = own(text.messages, state) ? text.messages[state] : text.messages.WAKING;
      paint();
    } catch (e) {
      // Network error while the route switches: try again.
    }
    setTimeout(probe, pollMs);
  };
  // At once: in browser mode, this probe is what starts the wake.
  probe();
})();
</script>`;
}

const ICON = /^data:image\/(?:png|jpeg|webp|svg\+xml|x-icon);base64,[A-Za-z0-9+/]+={0,2}$/;
const textOf = (value) => (typeof value === 'string' && value.trim() ? value : null);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const BLANKS = new Set([' ', '\t', '\n', '\r', '\f', '﻿']);

// Where the injected block goes in a custom page: the very start, after a BOM, white space, comments, an XML declaration and
// the doctype when they come first (so the doctype stays first and standards mode holds), whatever the rest holds. A linear
// scan, no search for a tag the page can hold in a comment, a string or a template: the probe starts at once, whatever the
// page does. A comment ends as the HTML parser ends it: `<!-->` and `<!--->` at once, otherwise at the first `-->` or `--!>`;
// an unterminated one holds the rest of the document, and the block goes before it. `<?...>` is a bogus comment to the parser,
// ending at its first `>`.
const COMMENT_END = /--!?>/g;
function startOf(html) {
  let at = 0;
  for (let doctype = false; ;) {
    while (at < html.length && BLANKS.has(html[at])) at += 1;
    if (html.startsWith('<!--', at)) {
      if (html[at + 4] === '>') at += 5;
      else if (html.startsWith('->', at + 4)) at += 6;
      else {
        COMMENT_END.lastIndex = at + 4;
        const end = COMMENT_END.exec(html);
        if (!end) return at;
        at = end.index + end[0].length;
      }
    } else if (html.startsWith('<?', at)) {
      const end = html.indexOf('>', at + 2);
      if (end < 0) return at;
      at = end + 1;
    } else if (!doctype && html.slice(at, at + 9).toLowerCase() === '<!doctype') {
      const end = html.indexOf('>', at);
      if (end < 0) return at;
      at = end + 1;
      doctype = true;
    } else return at;
  }
}

// page: the resolved { mode, title, description, html } (cleanPage's job to make it valid; this only prints it, escaped, and
// uses nothing that is not a string). icon: a data URI to show, or null. progress: { elapsedMs, typicalMs } or null, for a
// WAKING answer: the seconds need elapsedMs, the bar both (typicalMs is null without a recorded wake).
// probeUrl: where the script probes, when the page is not served at the address it wakes: no redirect comes back then,
// and the script reloads the visitor's address once AWAKE or on an answer not the waker's, at most one reload per poll
// (the page can come back until the load balancer reaches the application). By default it probes its own address.
export function renderPage({ state, pollSeconds, failure, retryInMs, napUntil, probeUrl, cloud = 'AWS', language = 'en', page = null, icon = null, progress = null }) {
  const t = textsOf(language);
  const lang = language === 'fr' ? 'fr' : 'en';
  const message = napUntil ? napMessage(napUntil, lang) : state === 'FAILED' ? failureMessage(failure, retryInMs, cloud, lang) : own(t.states, state) ? t.states[state] : t.states.WAKING;
  const seconds = Number(pollSeconds);
  const waiting = state === 'WAKING' && !napUntil && finite(progress?.elapsedMs);
  const elapsedMs = waiting ? Math.max(0, progress.elapsedMs) : 0;
  const typicalMs = waiting && finite(progress.typicalMs) && progress.typicalMs > 0 ? progress.typicalMs : 0;
  const isCustom = page?.mode === 'custom' && textOf(page.html) !== null;
  const script = scriptFor({
    t, cloud, initial: isCustom ? message : null, pollMs: seconds * 1000, probeUrl, custom: isCustom,
    wake: waiting ? { elapsed: elapsedMs, typical: typicalMs } : null, last: waiting ? 'WAKING' : napUntil ? 'NAP' : String(state),
  });
  const noscript = `<noscript><meta http-equiv="refresh" content="${seconds * 2}"></noscript>`;
  if (isCustom) { const at = startOf(page.html); return page.html.slice(0, at) + noscript + script + page.html.slice(at); }

  const own_ = page?.mode === 'template' ? page : {};
  const title = textOf(own_.title);
  const description = textOf(own_.description);
  const shown = typeof icon === 'string' && ICON.test(icon) ? icon : null;
  const longer = typicalMs > 0 && elapsedMs > typicalMs;
  const pct = typicalMs > 0 ? Math.min(95, Math.round(elapsedMs / typicalMs * 100)) : 0;
  const bar = typicalMs > 0
    ? `<div class="track"><div class="bar" role="progressbar" data-dormeto="progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-labelledby="message" style="width:${pct}%"></div></div>\n`
    : '';
  const heading = title
    ? `<h1>${inlineOf(title, HTML_MARKS)}</h1>\n<p id="message" aria-live="polite" data-dormeto="status">${escapeHtml(message)}</p>`
    : `<h1 id="message" aria-live="polite" data-dormeto="status">${escapeHtml(message)}</h1>`;
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
${noscript}
<title>${escapeHtml(title ? inlineOf(title, BARE_MARKS) : t.title)}</title>
<style>
:root{color-scheme:light dark;--bg:#f7f7f8;--fg:#1d1d1f;--muted:#6b6b70;--accent:#5b5bd6;--track:rgba(0,0,0,.1)}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--fg:#ececf0;--muted:#9a9aa3;--accent:#8f8ff0;--track:rgba(255,255,255,.15)}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{max-width:28rem;padding:2rem 1rem;text-align:center}
h1{font-size:1.25rem;font-weight:600}
p{color:var(--muted)}
[hidden]{display:none!important}
a{color:var(--accent)}
code{font:.9em ui-monospace,monospace}
.note h2,.note h3{margin:.75rem 0 .25rem;font-size:1rem;font-weight:600;color:var(--fg)}
.note p{margin:.5rem 0}
.note ul,.note ol{display:inline-block;margin:.5rem 0;padding-left:1.25rem;color:var(--muted);text-align:left}
.note blockquote{margin:.5rem 0;padding-left:.75rem;border-left:2px solid var(--track);text-align:left}
.note pre{margin:.5rem 0;padding:.5rem .75rem;overflow:auto;border-radius:.25rem;background:var(--track);text-align:left}
.icon{display:block;margin:0 auto;max-height:4rem;max-width:16rem}
.dot{width:.75rem;height:.75rem;border-radius:50%;background:var(--accent);display:inline-block;animation:pulse 1.2s infinite ease-in-out}
.track{height:.375rem;margin:1rem 0;border-radius:.1875rem;background:var(--track);overflow:hidden}
.bar{height:100%;background:var(--accent)}
@keyframes pulse{50%{opacity:.25}}
@media (prefers-reduced-motion:reduce){.dot{animation:none}}
@media (prefers-reduced-motion:no-preference){.bar{transition:width 1s linear}}
</style>
</head>
<body>
<main>
${shown ? `<img class="icon" alt="" src="${escapeHtml(shown)}">` : '<span class="dot" aria-hidden="true"></span>'}
${heading}
${description ? `<div class="note">${blocksOf(description)}</div>\n` : ''}${bar}<p><span id="reload">${escapeHtml(longer ? t.longer : t.reload)}</span> <span id="elapsed" data-dormeto="elapsed">${waiting ? `${Math.round(elapsedMs / 1000)} s` : ''}</span></p>
</main>
${script}
</body>
</html>`;
}

// wakeHeader: in browser mode, tells API clients how to wake the workload.
// napUntil: { at, local, timeZone }, while a nap window keeps the workload asleep.
export const renderJson = ({ state, pollSeconds, wakeHeader, napUntil }) => JSON.stringify({
  status: String(state).toLowerCase(), retryAfter: pollSeconds, ...(wakeHeader ? { wakeHeader } : {}), ...(napUntil ? { napUntil } : {}),
});
