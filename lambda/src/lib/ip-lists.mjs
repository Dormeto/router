// IP reputation lists: downloaded network lists (scanners, cloud ranges) used by the waker as no-wake or deferred
// sources. Parsing and filtering run in the controller at download; lookups run in the waker.
import { isIP } from 'node:net';
import { gunzipSync, gzipSync } from 'node:zlib';

export const MAX_ENTRIES = 200_000;
export const PART_BYTES = 350_000;

const v4ToNumber = (ip) => ip.split('.').reduce((acc, part) => acc * 256 + Number(part), 0);
const fromV4 = (n) => [24, 16, 8, 0].map((shift) => Math.floor(n / 2 ** shift) % 256).join('.');

function v6ToBigInt(ip) {
  let text = ip.toLowerCase();
  if (text.includes('.')) {
    // Embedded IPv4 (::ffff:1.2.3.4): as the last two groups.
    const at = text.lastIndexOf(':');
    const v4 = v4ToNumber(text.slice(at + 1));
    text = `${text.slice(0, at + 1)}${Math.floor(v4 / 65536).toString(16)}:${(v4 % 65536).toString(16)}`;
  }
  const [head, tail] = text.split('::');
  const first = head ? head.split(':') : [];
  const last = tail === undefined ? [] : (tail ? tail.split(':') : []);
  const groups = tail === undefined ? first : [...first, ...Array(8 - first.length - last.length).fill('0'), ...last];
  return groups.reduce((acc, group) => (acc << 16n) | BigInt(Number.parseInt(group, 16)), 0n);
}

function fromV6(n) {
  const groups = Array.from({ length: 8 }, (_, i) => ((n >> BigInt((7 - i) * 16)) & 0xffffn).toString(16));
  let best = { at: -1, length: 0 };
  let run = { at: -1, length: 0 };
  groups.forEach((group, i) => {
    if (group !== '0') {
      run = { at: -1, length: 0 };
      return;
    }
    run = run.at < 0 ? { at: i, length: 1 } : { at: run.at, length: run.length + 1 };
    if (run.length > best.length) best = run;
  });
  if (best.length < 2) return groups.join(':');
  return `${groups.slice(0, best.at).join(':')}::${groups.slice(best.at + best.length).join(':')}`;
}

// { family, start, end, text } for an address or a CIDR range (host bits cleared), or null.
export function parseCidr(entry) {
  const [address, bits, extra] = String(entry).trim().split('/');
  const family = isIP(address ?? '');
  if (!family || extra !== undefined || (bits !== undefined && !/^\d{1,3}$/.test(bits))) return null;
  const width = family === 4 ? 32 : 128;
  const prefix = bits === undefined ? width : Number(bits);
  if (prefix > width) return null;
  if (family === 4) {
    const size = 2 ** (32 - prefix);
    const start = Math.floor(v4ToNumber(address) / size) * size;
    return { family, start, end: start + size - 1, text: `${fromV4(start)}/${prefix}` };
  }
  const hostBits = BigInt(128 - prefix);
  const start = (v6ToBigInt(address) >> hostBits) << hostBits;
  return { family, start, end: start | ((1n << hostBits) - 1n), text: `${fromV6(start)}/${prefix}` };
}

const LOOKS_LIKE_ADDRESS = /^[0-9a-fA-F:.]+(\/\d{1,3})?$/;

function jsonCandidates(value, out) {
  if (typeof value === 'string') {
    if (LOOKS_LIKE_ADDRESS.test(value) && /[.:]/.test(value)) out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) jsonCandidates(item, out);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) jsonCandidates(item, out);
  }
  return out;
}

const textCandidates = (text) => text.split(/\r?\n/).map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#') && !line.startsWith(';'))
  .map((line) => line.split(/[\s,;]+/)[0]);

// JSON (every address or range string) or text (first column of each line). Throws above MAX_ENTRIES.
export function parseList(text) {
  const trimmed = text.trimStart();
  let candidates;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      candidates = jsonCandidates(JSON.parse(trimmed), []);
    } catch {
      candidates = textCandidates(text);
    }
  } else {
    candidates = textCandidates(text);
  }
  const entries = [];
  let invalid = 0;
  for (const candidate of candidates) {
    const range = parseCidr(candidate);
    if (range) entries.push(range.text);
    else invalid += 1;
  }
  if (entries.length > MAX_ENTRIES) throw new Error(`too many entries: ${entries.length} (at most ${MAX_ENTRIES})`);
  return { entries, invalid };
}

// Never defer or ignore these: an internal load balancer sees its clients with such addresses.
const RESERVED = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12',
  '192.168.0.0/16', '198.18.0.0/15', '224.0.0.0/4', '240.0.0.0/4', '::/127', '::ffff:0:0/96', '64:ff9b::/96',
  'fc00::/7', 'fe80::/10', 'ff00::/8'].map(parseCidr);

export function dropReserved(entries) {
  const kept = [];
  let dropped = 0;
  for (const entry of entries) {
    const range = parseCidr(entry);
    const overlaps = !range || RESERVED.some((r) => r.family === range.family && range.start <= r.end && r.start <= range.end);
    if (overlaps) dropped += 1;
    else kept.push(entry);
  }
  return { kept, dropped };
}

function merge(ranges) {
  ranges.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  const merged = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    // Adjacent or overlapping (start <= end + 1); BigInt and Number need their own 1.
    if (last && range.start <= last.end + (typeof last.end === 'bigint' ? 1n : 1)) {
      if (range.end > last.end) last.end = range.end;
    } else {
      merged.push({ start: range.start, end: range.end });
    }
  }
  return merged;
}

function contains(ranges, value) {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (ranges[mid].start <= value) low = mid + 1;
    else high = mid - 1;
  }
  return high >= 0 && value <= ranges[high].end;
}

// Lookup structure: merged, sorted IPv4 and IPv6 ranges, binary search per address.
export function rangeSet(entries) {
  const parsed = entries.map(parseCidr).filter(Boolean);
  const v4 = merge(parsed.filter((r) => r.family === 4));
  const v6 = merge(parsed.filter((r) => r.family === 6));
  return {
    size: v4.length + v6.length,
    has(ip) {
      const family = isIP(ip ?? '');
      if (family === 4) return contains(v4, v4ToNumber(ip));
      if (family === 6) return contains(v6, v6ToBigInt(ip));
      return false;
    },
  };
}

// Storage: gzip of one entry per line, split into parts that fit a DynamoDB item.
export function encodeParts(entries, maxBytes = PART_BYTES) {
  const zipped = gzipSync(Buffer.from(entries.join('\n')), { level: 9 });
  const parts = [];
  for (let at = 0; at < zipped.length; at += maxBytes) parts.push(zipped.subarray(at, at + maxBytes));
  return parts.length ? parts : [zipped];
}

export const decodeParts = (parts) => gunzipSync(Buffer.concat(parts.map((p) => Buffer.from(p)))).toString('utf8')
  .split('\n').filter(Boolean);
