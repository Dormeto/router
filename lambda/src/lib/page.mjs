const MESSAGES = {
  ASLEEP: 'Waking up the application…',
  WAKING: 'Waking up the application…',
  NAPPING: 'The application was going to sleep, waking it up again…',
  AWAKE: 'Almost there…',
  FAILED: 'The application could not be started. Retrying shortly…',
};

const escapeHtml = (value) => String(value).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function renderPage({ state, pollSeconds }) {
  const message = MESSAGES[state] ?? MESSAGES.WAKING;
  const seconds = Number(pollSeconds);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<noscript><meta http-equiv="refresh" content="${seconds * 2}"></noscript>
<title>Waking up…</title>
<style>
:root{color-scheme:light dark;--bg:#f7f7f8;--fg:#1d1d1f;--muted:#6b6b70;--accent:#5b5bd6}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--fg:#ececf0;--muted:#9a9aa3;--accent:#8f8ff0}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{max-width:28rem;padding:2rem 1rem;text-align:center}
h1{font-size:1.25rem;font-weight:600}
p{color:var(--muted)}
.dot{width:.75rem;height:.75rem;border-radius:50%;background:var(--accent);display:inline-block;animation:pulse 1.2s infinite ease-in-out}
@keyframes pulse{50%{opacity:.25}}
@media (prefers-reduced-motion:reduce){.dot{animation:none}}
</style>
</head>
<body>
<main>
<span class="dot" aria-hidden="true"></span>
<h1 id="message" aria-live="polite">${escapeHtml(message)}</h1>
<p>This page reloads by itself as soon as the application is ready. <span id="elapsed"></span></p>
</main>
<script>
(() => {
  const pollMs = ${seconds * 1000};
  const messages = ${JSON.stringify(MESSAGES)};
  const started = Date.now();
  const message = document.getElementById('message');
  const elapsed = document.getElementById('elapsed');
  setInterval(() => { elapsed.textContent = Math.round((Date.now() - started) / 1000) + ' s'; }, 1000);
  const probe = async () => {
    try {
      const r = await fetch(location.href, { cache: 'no-store', credentials: 'same-origin', redirect: 'manual', headers: { 'x-dormeto-probe': '1' } });
      const state = r.type === 'opaqueredirect' ? null : r.headers.get('x-dormeto-state');
      if (!state) { location.reload(); return; }
      message.textContent = messages[state] || messages.WAKING;
    } catch (e) {
      // Network error while the route switches: try again.
    }
    setTimeout(probe, pollMs);
  };
  setTimeout(probe, pollMs);
})();
</script>
</body>
</html>`;
}

export const renderJson = ({ state, pollSeconds }) => JSON.stringify({ status: String(state).toLowerCase(), retryAfter: pollSeconds });
