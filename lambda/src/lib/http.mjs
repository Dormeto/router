export const BOT_PATTERN = /bot|crawl|spider|slurp|monitor|uptime|pingdom|ELB-HealthChecker/i;

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

export function classify(event) {
  if (header(event, 'x-dormeto-probe') === '1') return 'probe';
  if (event.httpMethod === 'HEAD' || BOT_PATTERN.test(header(event, 'user-agent') ?? '')) return 'no-wake';
  return 'normal';
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
