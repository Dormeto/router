const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const ACTION_MESSAGES = { nap: 'Nap requested.', wake: 'Wake requested.' };

const backendText = (b) => {
  if (b.kind === 'asg') return `${b.id}: ${b.status} (min ${b.min}, desired ${b.desired}, max ${b.max})${b.warmPool ? ', warm pool' : ''}`;
  if (b.kind === 'ecs') {
    const scaling = b.scalable ? `, autoscaling ${b.scalable.min}-${b.scalable.max}` : '';
    return `${b.id.split(':')[5] ?? b.id}: ${b.status} (desired ${b.desired}${scaling})`;
  }
  if (b.companion) return `${b.id} (database): ${b.status}`;
  return `${b.id}: ${b.status}`;
};

// One no-wake rule as text, for example: office (workload): source 198.51.100.0/24, path /health*
const ruleText = (rule) => {
  const c = rule.conditions ?? {};
  const parts = [
    c.sourceIps && `source ${c.sourceIps.join(' | ')}`,
    c.pathPrefixes && `path ${c.pathPrefixes.map((p) => `${p}*`).join(' | ')}`,
    c.pathPattern && `path ~ ${c.pathPattern}`,
    c.userAgentPattern && `user agent ~ ${c.userAgentPattern}`,
    ...(c.headers ?? []).map((h) => (h.pattern ? `header ${h.name} ~ ${h.pattern}` : `header ${h.name} = ${h.value}`)),
  ].filter(Boolean);
  return `${rule.name} (${rule.level}): ${rule.invalid ? `invalid, ${rule.invalid}` : parts.join(', ')}`;
};

// "HEAD 2 · 7, bot user agent 0 · 3": today · last days, for every key seen in the period.
const pairs = (today = {}, total = {}) => Object.keys(total).sort((a, b) => total[b] - total[a])
  .map((k) => `${k} ${today[k] ?? 0} · ${total[k]}`).join(', ') || 'none';

function statsRows(stats) {
  if (!stats) return '';
  if (stats.error) return row('Statistics', `unavailable: ${stats.error}`);
  const period = `(today · ${stats.days} days)`;
  return [
    row(`Ignored requests ${period}`, pairs(stats.today.ignored, stats.total.ignored)),
    row(`Deferred requests ${period}`, pairs(stats.today.deferred, stats.total.deferred)),
    row(`Wakes by trigger ${period}`, pairs(stats.today.wakes, stats.total.wakes)),
  ].join('\n');
}

// ipsum (defer): 109695 entries, 2026-10-04T10:00:00.000Z
const listText = (l) => `${l.name} (${l.action}): ${l.error ? l.error : `${l.entries} entries, ${l.fetchedAt}`}`;

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
<meta http-equiv="refresh" content="10; url=${escapeHtml(base)}/">
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
${row(`Backends (${status.discovery ?? 'static'})`, (status.backends ?? []).map(backendText).join(', ') || '—')}
${status.ignoredTargets?.length ? row('Ignored targets', status.ignoredTargets.map((t) => `${t.id}: ${t.reason}`).join(', ')) : ''}
${row('Target health', list(status.targets))}
${statsRows(status.stats)}
${row('Wake mode', status.wakeMode === 'browser'
    ? `browser: the waiter page probe, the x-dormeto-wake header or a wake rule wakes${(status.wakeRules ?? []).length ? ` (${status.wakeRules.map(ruleText).join('; ')})` : ''}`
    : 'any: every request that passes the filters wakes')}
${status.ipLists?.length ? row('IP lists', status.ipLists.map(listText).join('; ')) : ''}
${row('No-wake rules', (status.noWakeRules ?? []).map(ruleText).join('; ') || 'none (built-in filters only)')}
${row('Settings', Object.entries(status.settings).map(([k, v]) => `${k}=${v}`).join(', '))}
</table>
<p class="note">Router ${escapeHtml(status.router?.version ?? 'unknown')} (build ${escapeHtml(status.router?.build ?? 'unknown')}). Refreshes every 10 s. JSON: <a href="${escapeHtml(base)}/status.json">status.json</a></p>
</main>
</body>
</html>`;
}
