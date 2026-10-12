// Crawlers, monitors and internet scanners: they get the waiter page, never a wake.
export const BOT_PATTERN = /bot|crawl|spider|slurp|monitor|uptime|pingdom|ELB-HealthChecker|scan|zgrab|censys|expanse|nmap|nuclei|leakix/i;
// Paths requested by secret and vulnerability scanners (observed on the dev hostnames within minutes of a new
// certificate): they must not wake a workload.
export const SCANNER_PATH = new RegExp([
  '^/\\.(env|git|github|aws|ssh|svn|hg|DS_Store|vscode|idea|docker)',
  '^/(wp-|wordpress|xmlrpc\\.php|phpmyadmin|pma|cgi-bin|actuator|server-status|solr|vendor/|telescope|_profiler)',
  '^/(config\\.(json|js|php|ya?ml)|js/env\\.js|api/config|env\\.js)$',
  '^/(AGENTS|CLAUDE|README|GEMINI)\\.md$',
  '\\.php$',
].join('|'), 'i');

const REASONS = { 200: 'OK', 303: 'See Other', 307: 'Temporary Redirect', 404: 'Not Found', 405: 'Method Not Allowed', 503: 'Service Unavailable' };

export function headerValues(event, name) {
  const key = name.toLowerCase();
  if (event.multiValueHeaders) {
    for (const [k, v] of Object.entries(event.multiValueHeaders)) if (k.toLowerCase() === key) return v;
    return [];
  }
  for (const [k, v] of Object.entries(event.headers ?? {})) if (k.toLowerCase() === key) return [v];
  return [];
}

export const header = (event, name) => headerValues(event, name)[0];

export function workloadIdFromEvent(event, prefix) {
  const arn = event.requestContext?.elb?.targetGroupArn ?? '';
  const name = arn.split(':').pop()?.split('/')[1] ?? '';
  if (!prefix || !name.startsWith(prefix) || name.length === prefix.length) {
    throw new Error(`unexpected target group: ${arn}`);
  }
  return name.slice(prefix.length);
}

// The address the ALB received the connection from: the last X-Forwarded-For entry, appended by the ALB. Earlier
// entries come from the client and can be forged.
export function clientIp(event) {
  const entries = headerValues(event, 'x-forwarded-for').join(',').split(',').map((e) => e.trim()).filter(Boolean);
  return entries.at(-1) ?? '';
}

// { kind: 'probe' | 'normal' } or { kind: 'no-wake', reason }. No-wake rules come first, so that a client they match
// never wakes the workload through the waiter page's probe either.
export function classify(event, rules = []) {
  const rule = rules.find((r) => r.matches(event));
  if (rule) return { kind: 'no-wake', reason: `rule ${rule.name}` };
  if (header(event, 'x-dormeto-probe') === '1') return { kind: 'probe' };
  if (event.httpMethod === 'HEAD') return { kind: 'no-wake', reason: 'HEAD' };
  if (BOT_PATTERN.test(header(event, 'user-agent') ?? '')) return { kind: 'no-wake', reason: 'bot user agent' };
  if (SCANNER_PATH.test(event.path ?? '')) return { kind: 'no-wake', reason: 'scanner path' };
  return { kind: 'normal' };
}

export function requestTarget(event) {
  // A single leading slash prevents protocol-relative redirects such as //evil.example.
  const path = `/${(event.path ?? '').replace(/^[/\\]+/, '')}`;
  const params = event.multiValueQueryStringParameters
    ?? Object.fromEntries(Object.entries(event.queryStringParameters ?? {}).map(([k, v]) => [k, [v]]));
  // ALB passes query parameters URL-encoded: they are reused as-is.
  const pairs = Object.entries(params).flatMap(([k, values]) => values.map((v) => (v === '' ? k : `${k}=${v}`)));
  return pairs.length ? `${path}?${pairs.join('&')}` : path;
}

export function redirectCount(event) {
  for (const cookies of headerValues(event, 'cookie')) {
    for (const part of cookies.split(';')) {
      const [name, value] = part.trim().split('=');
      if (name === 'dmt_r') return Number.parseInt(value, 10) || 0;
    }
  }
  return 0;
}

export const acceptsHtml = (event) => (header(event, 'accept') ?? '').includes('text/html');

export function response(statusCode, headers, body = '') {
  return {
    statusCode,
    statusDescription: `${statusCode} ${REASONS[statusCode] ?? ''}`.trim(),
    isBase64Encoded: false,
    multiValueHeaders: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, [].concat(v)])),
    body,
  };
}

// Who triggered a wake: for the logs (scanners and bots are the usual unwanted wakers).
export function requestOrigin(event, kind) {
  return {
    kind,
    method: event.httpMethod,
    path: String(event.path ?? '').slice(0, 200),
    userAgent: String(header(event, 'user-agent') ?? '').slice(0, 200),
    sourceIp: clientIp(event),
  };
}
