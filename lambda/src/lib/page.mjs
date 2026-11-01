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

const escapeHtml = (value) => String(value).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// In a script element: no "<" can end it.
const json = (value) => JSON.stringify(value).replace(/</g, '\\u003c');

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
  const t = TEXTS[language] ?? TEXTS.en;
  if (!failure) return t.states.FAILED;
  const failures = failuresOn(cloud, t);
  const text = failures[failure] ?? failures.other;
  if (retryInMs === undefined) return text;
  const when = inText(retryInMs, t);
  return failure === 'capacity' ? text + t.nextCapacity.replace('{when}', when) : `${text} ${t.nextOther.replace('{when}', when)}`;
}

// napUntil.local stays as lib/schedule.mjs writes it ('Mon 08:00'); its day is translated here.
export function napMessage(napUntil, language = 'en') {
  const t = TEXTS[language] ?? TEXTS.en;
  const local = String(napUntil.local).replace(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?= )/, (day) => t.days[day] ?? day);
  return t.nap(local, napUntil.timeZone);
}

// The script, for the template and for a custom page alike: it probes, wakes, reloads, and serves the page's hooks
// (data-dormeto="status|elapsed|progress", the dormeto:state event). Nothing a customer wrote enters it.
// initial: the status sentence a custom page's element gets at once; the template already holds it.
function scriptFor({ t, cloud, initial, pollMs, probeUrl, wake }) {
  return `<script>
(() => {
  const pollMs = ${pollMs};
  const failures = ${json(failuresOn(cloud, t))};
  const text = ${json({ messages: t.states, nextCapacity: t.nextCapacity, nextOther: t.nextOther, less: t.less, one: t.one, many: t.many, reload: t.reload, longer: t.longer })};
  const pick = (name) => (document.querySelector && document.querySelector('[data-dormeto="' + name + '"]')) || null;
  const status = pick('status') || document.getElementById('message');
  const elapsedEl = pick('elapsed') || document.getElementById('elapsed');
  const reload = document.getElementById('reload');
  let fill = pick('progress');
  let started = Date.now() - ${wake ? wake.elapsed : 0};
  let typical = ${wake ? wake.typical : 0};
  let shown = ${wake ? 'true' : 'false'};
  const AWAKE = 'AWAKE';
  let full = false;
  const setStatus = (value) => { if (status) status.textContent = value; };
  const track = () => (fill.parentNode && fill.parentNode.className === 'track' ? fill.parentNode : fill);
  const show = () => {
    if (!fill && reload && reload.parentNode) {
      const shell = document.createElement('div');
      shell.className = 'track';
      fill = document.createElement('div');
      fill.className = 'bar';
      fill.setAttribute('role', 'progressbar');
      fill.setAttribute('data-dormeto', 'progress');
      fill.setAttribute('aria-valuemin', '0');
      fill.setAttribute('aria-valuemax', '100');
      fill.setAttribute('aria-labelledby', 'message');
      shell.append(fill);
      reload.parentNode.before(shell);
    }
    if (fill) track().hidden = false;
  };
  const paint = () => {
    const ms = Date.now() - started;
    if (elapsedEl) elapsedEl.textContent = Math.round(ms / 1000) + ' s';
    if (!shown || !fill) return;
    const pct = full ? 100 : Math.min(95, Math.round(ms / typical * 100));
    fill.style.width = pct + '%';
    fill.setAttribute('aria-valuenow', String(pct));
    if (reload && !full) reload.textContent = ms > typical ? text.longer : text.reload;
  };
  const num = (r, name) => {
    const v = r.headers.get(name);
    const n = v === null || v === '' ? NaN : Number(v);
    return isFinite(n) ? n : null;
  };
  ${initial ? `setStatus(${json(initial)});\n  ` : ''}if (shown) { show(); paint(); }
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
        if (state === AWAKE) { if (shown) { full = true; paint(); } }
        else if (nap || state !== 'WAKING') { shown = false; if (fill) track().hidden = true; }
        else if (elapsedMs !== null && typicalMs !== null) { started = Date.now() - elapsedMs; typical = typicalMs; shown = true; show(); paint(); }
        try { document.dispatchEvent(new CustomEvent('dormeto:state', { detail: { state, failure, retryAt, napUntil: nap, elapsedMs, typicalMs } })); } catch (e) { /* a page without events */ }
      }
      ${probeUrl
    ? "if (!state || state === 'AWAKE') { setTimeout(() => location.reload(), Math.max(0, started + pollMs - Date.now())); return; }"
    : ''}
      // Still napping on schedule: the page keeps saying so.
      if (nap) { setTimeout(probe, pollMs); return; }
      if (state === 'FAILED' && failure) {
        const ms = Math.max(0, Date.parse(retryAt) - Date.now());
        const when = !retryAt ? '' : ms < 60000 ? text.less : Math.round(ms / 60000) === 1 ? text.one : Math.round(ms / 60000) + text.many;
        const failed = failures[failure] || failures.other;
        setStatus(!when ? failed : failure === 'capacity' ? failed + text.nextCapacity.replace('{when}', when) : failed + ' ' + text.nextOther.replace('{when}', when));
      } else setStatus(text.messages[state] || text.messages.WAKING);
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

// The customer's HTML, with the refresh for visitors without scripts right after the first <head…> (when there is one) and the
// script before the last </body> (else at the end). Nothing else changes, whatever the page holds.
function customPage(html, noscript, script) {
  const head = /<head(?=[\s>/])[^>]*>/i.exec(html);
  const withNoscript = head ? html.slice(0, head.index + head[0].length) + noscript + html.slice(head.index + head[0].length) : html;
  const last = [...withNoscript.matchAll(/<\/body\s*>/gi)].pop();
  return last ? withNoscript.slice(0, last.index) + script + withNoscript.slice(last.index) : withNoscript + script;
}

// page: the resolved { mode, title, description, html }, already clean; whatever is not usable is left out.
// icon: a data URI to show, or null. progress: { elapsedMs, typicalMs } or null, for a wake that has a typical time.
// probeUrl: where the script probes, when the page is not served at the address it wakes: no redirect comes back then,
// and the script reloads the visitor's address once AWAKE or on an answer not the waker's, at most one reload per poll
// (the page can come back until the load balancer reaches the application). By default it probes its own address.
export function renderPage({ state, pollSeconds, failure, retryInMs, napUntil, probeUrl, cloud = 'AWS', language = 'en', page = null, icon = null, progress = null }) {
  const t = TEXTS[language] ?? TEXTS.en;
  const message = napUntil ? napMessage(napUntil, language) : state === 'FAILED' ? failureMessage(failure, retryInMs, cloud, language) : t.states[state] ?? t.states.WAKING;
  const seconds = Number(pollSeconds);
  const waiting = state === 'WAKING' && !napUntil && finite(progress?.elapsedMs) && finite(progress?.typicalMs) && progress.typicalMs > 0;
  const elapsedMs = waiting ? Math.max(0, progress.elapsedMs) : 0;
  const wake = waiting ? { elapsed: elapsedMs, typical: progress.typicalMs } : null;
  const custom = page?.mode === 'custom' && textOf(page.html);
  const script = scriptFor({ t, cloud, initial: custom ? message : null, pollMs: seconds * 1000, probeUrl, wake });
  const noscript = `<noscript><meta http-equiv="refresh" content="${seconds * 2}"></noscript>`;
  if (custom) return customPage(page.html, noscript, script);

  const own = page?.mode === 'template' ? page : {};
  const title = textOf(own.title);
  const description = textOf(own.description);
  const shown = ICON.test(icon) ? icon : null;
  const longer = waiting && elapsedMs > progress.typicalMs;
  const pct = waiting ? Math.min(95, Math.round(elapsedMs / progress.typicalMs * 100)) : 0;
  const bar = waiting
    ? `<div class="track"><div class="bar" role="progressbar" data-dormeto="progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-labelledby="message" style="width:${pct}%"></div></div>\n`
    : '';
  const heading = title
    ? `<h1>${escapeHtml(title)}</h1>\n<p id="message" aria-live="polite" data-dormeto="status">${escapeHtml(message)}</p>`
    : `<h1 id="message" aria-live="polite" data-dormeto="status">${escapeHtml(message)}</h1>`;
  return `<!doctype html>
<html lang="${language === 'fr' ? 'fr' : 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
${noscript}
<title>${escapeHtml(title ?? t.title)}</title>
<style>
:root{color-scheme:light dark;--bg:#f7f7f8;--fg:#1d1d1f;--muted:#6b6b70;--accent:#5b5bd6;--track:rgba(0,0,0,.1)}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--fg:#ececf0;--muted:#9a9aa3;--accent:#8f8ff0;--track:rgba(255,255,255,.15)}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{max-width:28rem;padding:2rem 1rem;text-align:center}
h1{font-size:1.25rem;font-weight:600}
p{color:var(--muted)}
[hidden]{display:none!important}
.note{white-space:pre-line}
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
${description ? `<p class="note">${escapeHtml(description)}</p>\n` : ''}${bar}<p><span id="reload">${escapeHtml(longer ? t.longer : t.reload)}</span> <span id="elapsed" data-dormeto="elapsed">${waiting ? `${Math.round(elapsedMs / 1000)} s` : ''}</span></p>
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
