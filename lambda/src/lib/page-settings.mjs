// The waiting page's setting (spec 2026-11-01-branded-waiting-page §4 and §5): its rules, the resolution of its three
// levels, and the recent wake times the progress bar is drawn from. Terraform and a hand-edited settings.json bypass the
// write's check, so every read goes through cleanPage.
const FIELDS = { template: ['icon', 'title', 'description'], custom: ['html'] };
const ICON_BYTES = 64 * 1024;
const HTML_BYTES = 256 * 1024;
const WAKES_KEPT = 10;
const LEVELS = ['workload', 'router', 'organization'];

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const has = (object, key) => Object.hasOwn(object, key);
// The mode of a document: one of FIELDS' own names, as a string; null for anything else.
const modeOf = (doc) => (isObject(doc) && typeof doc.mode === 'string' && has(FIELDS, doc.mode) ? doc.mode : null);
// A string's length in characters against a limit; a string longer than twice the limit is over it, whatever it holds.
const over = (text, limit) => text.length > 2 * limit || Array.from(text).length > limit;
const SINGLE_LINE = /[\u0000-\u001f\u007f\p{Zl}\p{Zp}]/u;
const MULTI_LINE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const startsWith = (bytes, signature, at = 0) => signature.every((b, i) => bytes[at + i] === b);
const BLANKS = new Set([' ', '\t', '\n', '\r', '\f', '﻿']);
const isBlank = (text, at) => BLANKS.has(text[at]);

// The end of a DOCTYPE starting at `at`: after its '>', skipping quoted strings and an internal subset; -1 when unclosed.
function doctypeEnd(text, at) {
  let quote = null;
  let depth = 0;
  for (let i = at + 9; i < text.length; i += 1) {
    const c = text[i];
    if (quote) { if (c === quote) quote = null; } else if (c === '"' || c === "'") quote = c;
    else if (c === '[') depth += 1;
    else if (c === ']') depth = Math.max(0, depth - 1);
    else if (c === '>' && depth === 0) return i + 1;
  }
  return -1;
}

// Whether the first element of an XML text is <svg: a linear scan over a byte order mark, white space, the XML declaration,
// comments and a DOCTYPE, then `<svg` followed by white space, '/' or '>'. No regular expression: nothing can backtrack.
function startsWithSvg(text) {
  let i = 0;
  for (;;) {
    while (i < text.length && isBlank(text, i)) i += 1;
    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4);
      if (end < 0) return false;
      i = end + 3;
    } else if (text.startsWith('<?xml', i) && isBlank(text, i + 5)) {
      const end = text.indexOf('?>', i + 5);
      if (end < 0) return false;
      i = end + 2;
    } else if (text.slice(i, i + 9).toLowerCase() === '<!doctype') {
      i = doctypeEnd(text, i);
      if (i < 0) return false;
    } else break;
  }
  return text.startsWith('<svg', i) && (isBlank(text, i + 4) || text[i + 4] === '/' || text[i + 4] === '>');
}

const SIGNATURES = {
  png: (bytes) => startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  jpeg: (bytes) => startsWith(bytes, [0xff, 0xd8, 0xff]),
  webp: (bytes) => startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8),
  'x-icon': (bytes) => startsWith(bytes, [0, 0, 1, 0]),
  'svg+xml': (bytes) => startsWithSvg(Buffer.from(bytes).toString('utf8')),
};

// The image type of some bytes, from their signature; null when none of the five.
export function iconTypeOf(bytes) {
  if (!(bytes instanceof Uint8Array)) return null;
  return Object.keys(SIGNATURES).find((type) => SIGNATURES[type](bytes)) ?? null;
}

function checkIcon(icon) {
  if (icon === 'auto' || icon === 'none') return null;
  const found = typeof icon === 'string' && icon.length <= 100_000 && /^data:image\/(png|jpeg|webp|svg\+xml|x-icon);base64,([A-Za-z0-9+/]*={0,2})$/.exec(icon);
  if (!found) return 'icon must be auto, none, or a data:image/png, jpeg, webp, svg+xml or x-icon base64 URI of at most 64 KiB';
  const bytes = Buffer.from(found[2], 'base64');
  if (bytes.toString('base64') !== found[2] || bytes.length === 0) return 'icon is not valid base64';
  if (bytes.length > ICON_BYTES) return 'icon must be at most 64 KiB once decoded';
  if (!SIGNATURES[found[1]](bytes)) return `icon is not a ${found[1]} image`;
  return null;
}

function checkTitle(title) {
  if (typeof title !== 'string' || over(title, 80)) return typeof title === 'string' ? 'title must be at most 80 characters' : 'title must be one line of text';
  if (!title.trim() || SINGLE_LINE.test(title)) return 'title must be one line of text';
  return null;
}

function checkDescription(description) {
  if (typeof description !== 'string' || over(description, 500)) return typeof description === 'string' ? 'description must be at most 500 characters' : 'description must be text';
  return !description.trim() || MULTI_LINE.test(description) ? 'description must be text' : null;
}

function checkHtml(html) {
  if (typeof html !== 'string') return 'html must be a page, not blank';
  // Each UTF-16 unit is at least one byte, so more units than the limit is over it.
  if (html.length > HTML_BYTES || Buffer.byteLength(html) > HTML_BYTES) return 'html must be at most 256 KiB';
  return html.trim() ? null : 'html must be a page, not blank';
}

const CHECKS = { icon: checkIcon, title: checkTitle, description: checkDescription, html: checkHtml };

// Every problem of a document, as sentences; [] when it is fine.
export function validatePage(doc) {
  if (!isObject(doc)) return ['the page must be an object'];
  const mode = modeOf(doc);
  if (!mode) return ['mode must be template or custom'];
  const problems = [];
  for (const key of Object.keys(doc)) if (key !== 'mode' && !FIELDS[mode].includes(key)) problems.push(`${key} is not a field of a ${mode} page`);
  for (const key of FIELDS[mode]) {
    if (has(doc, key)) { const problem = CHECKS[key](doc[key]); if (problem) problems.push(problem); }
    else if (key === 'html') problems.push('html is required in a custom page');
  }
  return problems;
}

// The valid document, or null: a custom one with no valid html is no document. Never throws, whatever the value.
export function cleanPage(doc) {
  const mode = modeOf(doc);
  if (!mode) return null;
  const page = { mode };
  for (const key of FIELDS[mode]) if (has(doc, key) && !CHECKS[key](doc[key])) page[key] = doc[key];
  return mode === 'custom' && !has(page, 'html') ? null : page;
}

// The tag of a `<meta` at `at`, up to its '>' (at most 1000 characters, so a page of open tags is read once).
const META = /<meta[\s/]/gi;
const HOOK_STATUS = /data-dormeto\s*=\s*(?:"status"|'status'|status(?![^\s>/]))/gi;

// What a custom page should fix, without being refused. Linear in the page: a hook inside a comment counts.
export function pageWarnings(doc) {
  const page = cleanPage(doc);
  if (page?.mode !== 'custom') return [];
  const warnings = [];
  // The value is case sensitive, as the script's selector is; the attribute's name is not.
  if (![...page.html.matchAll(HOOK_STATUS)].some((m) => m[0].includes('status'))) warnings.push('the page has no element data-dormeto="status": the visitor will not read why it waits');
  let end = -1;
  for (const m of page.html.matchAll(META)) {
    if (end < m.index) end = page.html.indexOf('>', m.index);
    if (end < 0) break;
    if (/http-equiv\s*=\s*["']?content-security-policy/i.test(page.html.slice(m.index, Math.min(end, m.index + 1000)))) {
      warnings.push('a Content-Security-Policy meta tag may block the script Dormeto adds, and the wake with it in browser mode');
      break;
    }
  }
  return warnings;
}

// The effective page: the most specific level with a document decides the mode. A custom page is that level's html, whole;
// a template takes each field from the most specific template that has it. `from` names the level of each.
export function resolvePage(organization, router, workload) {
  const documents = [workload, router, organization].map((level, i) => [LEVELS[i], cleanPage(level)]).filter(([, page]) => page);
  if (!documents.length) return { mode: 'template', icon: 'auto', from: { mode: 'default', icon: 'default' } };
  const [deciding, first] = documents[0];
  if (first.mode === 'custom') return { mode: 'custom', html: first.html, from: { mode: deciding, html: deciding } };
  const page = { mode: 'template', from: { mode: deciding } };
  for (const key of FIELDS.template) {
    const found = documents.find(([, candidate]) => candidate.mode === 'template' && has(candidate, key));
    if (found) { page[key] = found[1][key]; page.from[key] = found[0]; } else if (key === 'icon') { page.icon = 'auto'; page.from.icon = 'default'; }
  }
  return { mode: page.mode, icon: page.icon, ...(page.title ? { title: page.title } : {}), ...(page.description ? { description: page.description } : {}), from: page.from };
}

const usable = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function medianOf(durations) {
  const sorted = (Array.isArray(durations) ? durations.filter(usable) : []).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// The run item's recentWakes: a JSON string of the last 10 durations in ms. A bad value starts afresh.
export function withWake(recentWakes, durationMs) {
  let list = [];
  try {
    const parsed = typeof recentWakes === 'string' ? JSON.parse(recentWakes) : null;
    if (Array.isArray(parsed)) list = parsed.filter(usable);
  } catch {
    // Starts afresh.
  }
  if (usable(durationMs)) list.push(durationMs);
  return JSON.stringify(list.slice(-WAKES_KEPT));
}
