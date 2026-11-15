// AWS Signature Version 4, the router's own (vision docs/specs/2026-11-15-router-credentials-design.md, §5): a Google Cloud router signs
// its PutEvents to the manager's bus with the session the manager's API gives it. node:crypto only: the Cloud Run image copies no
// node_modules (gcp/Containerfile). The request is signed in its headers (`Authorization`), with `X-Amz-Date` and, for a session,
// `X-Amz-Security-Token` signed among them; `host` is signed from the URL and left to fetch, which sets it.
import { createHash, createHmac } from 'node:crypto';

const ALGORITHM = 'AWS4-HMAC-SHA256';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();
// RFC 3986's unreserved characters stay; everything else is percent-encoded, upper case.
const encode = (text) => encodeURIComponent(text).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

// `YYYYMMDDTHHMMSSZ` of a time in ms.
export const amzDate = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

// The headers signed, in lower case: the caller's, `host`, `x-amz-date`, and the session's token.
function headersOf({ url, headers = {}, credentials }, date) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) out[name.toLowerCase()] = String(value);
  out.host = new URL(url).host;
  out['x-amz-date'] = date;
  if (credentials.sessionToken) out['x-amz-security-token'] = credentials.sessionToken;
  return out;
}

// The canonical request of `input` ({ method, url, headers, body }) at `date` (amzDate's).
export function canonicalRequest(input, date) {
  const url = new URL(input.url);
  const path = url.pathname.split('/').map((segment) => encode(decodeURIComponent(segment))).join('/') || '/';
  const query = [...url.searchParams].map(([k, v]) => [encode(k), encode(v)]).sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`).join('&');
  const headers = headersOf(input, date);
  const names = Object.keys(headers).sort();
  const canonical = names.map((name) => `${name}:${headers[name].trim().replace(/\s+/g, ' ')}\n`).join('');
  return [input.method, path, query, canonical, names.join(';'), sha256(input.body ?? '')].join('\n');
}

// The headers to send: the caller's in lower case, `x-amz-date`, `x-amz-security-token` for a session, and `authorization`.
// `credentials`: { accessKeyId, secretAccessKey, sessionToken? }; `now`: the signing time, ms.
export function signedHeaders({ method, url, headers = {}, body = '', credentials, region, service, now = Date.now() }) {
  const date = amzDate(now);
  const day = date.slice(0, 8);
  const scope = `${day}/${region}/${service}/aws4_request`;
  const input = { method, url, headers, body, credentials };
  const canonical = canonicalRequest(input, date);
  const toSign = [ALGORITHM, date, scope, sha256(canonical)].join('\n');
  const key = [day, region, service, 'aws4_request'].reduce((k, part) => hmac(k, part), `AWS4${credentials.secretAccessKey}`);
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  const all = headersOf(input, date);
  const names = Object.keys(all).sort().join(';');
  const { host: _host, ...sent } = all;
  return { ...sent, authorization: `${ALGORITHM} Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${names}, Signature=${signature}` };
}
