const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const ACTION_MESSAGES = { nap: 'Nap requested.', wake: 'Wake requested.' };

const row = (label, value) => `<tr><th scope="row">${escapeHtml(label)}</th><td>${escapeHtml(value ?? '—')}</td></tr>`;

function napText(nap) {
  if (!nap) return '—';
  const minutes = Math.floor(nap.inSeconds / 60);
  const seconds = nap.inSeconds % 60;
  const eta = nap.inSeconds === 0 ? 'eligible now' : `in ${minutes} min ${seconds} s`;
  return `${eta} (between ${nap.eligibleAt} and ${nap.latestAt})`;
}

export function renderDashboard({ status, base, action }) {
  const message = ACTION_MESSAGES[action];
  const list = (items) => items.map((i) => `${i.id}: ${i.state}`).join(', ') || '—';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta http-equiv="refresh" content="10">
<title>Dormeto · ${escapeHtml(status.workloadId)}</title>
<style>
:root{color-scheme:light dark;--bg:#f7f7f8;--fg:#1d1d1f;--muted:#6b6b70;--line:#d9d9de;--accent:#5b5bd6}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--fg:#ececf0;--muted:#9a9aa3;--line:#2c2c31;--accent:#8f8ff0}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:46rem;margin:0 auto;padding:1.5rem 1rem}
h1{font-size:1.25rem;margin:0 0 1rem}
.state{display:inline-block;padding:.1rem .6rem;border-radius:1rem;background:var(--accent);color:#fff;font-size:.9rem}
table{width:100%;border-collapse:collapse;margin:1rem 0}
th,td{text-align:left;padding:.4rem .5rem;border-bottom:1px solid var(--line);vertical-align:top;overflow-wrap:anywhere}
th{color:var(--muted);font-weight:500;width:12rem}
form{display:inline-block;margin-right:.5rem}
button{font:inherit;padding:.4rem 1rem;border-radius:.4rem;border:1px solid var(--line);background:transparent;color:var(--fg);cursor:pointer}
.note{color:var(--muted)}
</style>
</head>
<body>
<main>
<h1>Dormeto · ${escapeHtml(status.workloadId)} <span class="state">${escapeHtml(status.state)}</span></h1>
${message ? `<p role="status">${escapeHtml(message)}</p>` : ''}
<form method="post" action="${escapeHtml(base)}/nap"><button type="submit">Force nap</button></form>
<form method="post" action="${escapeHtml(base)}/wake"><button type="submit">Force awake</button></form>
<table>
${row('Time before nap', napText(status.nap))}
${row('Last request', status.lastRequestAt)}
${row('Awake since', status.awakeSince)}
${row('Last state change', status.updatedAt)}
${row('Wake started at', status.wakeStartedAt)}
${row('Failed at', status.failedAt)}
${row('Wake count', status.wakeCount)}
${row('Held requests', status.holders)}
${row('Pending wake', status.pendingWake ? 'yes' : 'no')}
${row('Route', status.route)}
${row(`Instances (${status.discovery ?? 'static'})`, list(status.instances))}
${status.ignoredTargets?.length ? row('Ignored targets', status.ignoredTargets.map((t) => `${t.id}: ${t.reason}`).join(', ')) : ''}
${row('Target health', list(status.targets))}
${row('Settings', Object.entries(status.settings).map(([k, v]) => `${k}=${v}`).join(', '))}
</table>
<p class="note">Refreshes every 10 s. JSON: <a href="${escapeHtml(base)}/status.json">status.json</a></p>
</main>
</body>
</html>`;
}
