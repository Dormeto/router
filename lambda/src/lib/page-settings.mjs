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
const size = (text) => Array.from(text).length;
const SINGLE_LINE = /[\u0000-\u001f\u007f]|\u202[89]/;
const MULTI_LINE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const startsWith = (bytes, signature, at = 0) => signature.every((b, i) => bytes[at + i] === b);
const SIGNATURES = {
  png: (bytes) => startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  jpeg: (bytes) => startsWith(bytes, [0xff, 0xd8, 0xff]),
  webp: (bytes) => startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8),
  'x-icon': (bytes) => startsWith(bytes, [0, 0, 1, 0]),
  // The first element: after a byte order mark, blanks, an XML declaration and comments.
  'svg+xml': (bytes) => /^(?:﻿|\s|<\?xml[^>]*\?>|<!--[\s\S]*?-->)*<svg[\s/>]/.test(Buffer.from(bytes).toString('utf8')),
};

// The image type of some bytes, from their signature; null when none of the five.
export function iconTypeOf(bytes) {
  if (!(bytes instanceof Uint8Array)) return null;
  return Object.keys(SIGNATURES).find((type) => SIGNATURES[type](bytes)) ?? null;
}

function checkIcon(icon) {
  if (icon === 'auto' || icon === 'none') return null;
  const found = typeof icon === 'string' && /^data:image\/(png|jpeg|webp|svg\+xml|x-icon);base64,([A-Za-z0-9+/]*={0,2})$/.exec(icon);
  if (!found) return 'icon must be auto, none, or a data:image/png, jpeg, webp, svg+xml or x-icon base64 URI';
  const bytes = Buffer.from(found[2], 'base64');
  if (bytes.toString('base64') !== found[2] || bytes.length === 0) return 'icon is not valid base64';
  if (bytes.length > ICON_BYTES) return 'icon must be at most 64 KiB once decoded';
  if (!SIGNATURES[found[1]](bytes)) return `icon is not a ${found[1]} image`;
  return null;
}

function checkTitle(title) {
  if (typeof title !== 'string' || !title.trim() || SINGLE_LINE.test(title)) return 'title must be one line of text';
  return size(title) > 80 ? 'title must be at most 80 characters' : null;
}

function checkDescription(description) {
  if (typeof description !== 'string' || !description.trim() || MULTI_LINE.test(description)) return 'description must be text';
  return size(description) > 500 ? 'description must be at most 500 characters' : null;
}

function checkHtml(html) {
  if (typeof html !== 'string' || !html.trim()) return 'html must be a page, not blank';
  return Buffer.byteLength(html) > HTML_BYTES ? 'html must be at most 256 KiB' : null;
}

const CHECKS = { icon: checkIcon, title: checkTitle, description: checkDescription, html: checkHtml };

// Every problem of a document, as sentences; [] when it is fine.
export function validatePage(doc) {
  if (!isObject(doc)) return ['the page must be an object'];
  if (!FIELDS[doc.mode]) return ['mode must be template or custom'];
  const problems = [];
  for (const key of Object.keys(doc)) if (key !== 'mode' && !FIELDS[doc.mode].includes(key)) problems.push(`${key} is not a field of a ${doc.mode} page`);
  for (const key of FIELDS[doc.mode]) {
    if (key in doc) { const problem = CHECKS[key](doc[key]); if (problem) problems.push(problem); }
    else if (key === 'html') problems.push('html is required in a custom page');
  }
  return problems;
}

// The valid document, or null: a custom one with no valid html is no document. Never throws, whatever the value.
export function cleanPage(doc) {
  if (!isObject(doc) || !FIELDS[doc.mode]) return null;
  const page = { mode: doc.mode };
  for (const key of FIELDS[doc.mode]) if (key in doc && !CHECKS[key](doc[key])) page[key] = doc[key];
  return doc.mode === 'custom' && !('html' in page) ? null : page;
}

// What a custom page should fix, without being refused.
export function pageWarnings(doc) {
  const page = cleanPage(doc);
  if (page?.mode !== 'custom') return [];
  const warnings = [];
  if (!/data-dormeto\s*=\s*(["']?)status\1[\s>/]/i.test(page.html)) warnings.push('the page has no element data-dormeto="status": the visitor will not read why it waits');
  if (/<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy/i.test(page.html)) warnings.push('a Content-Security-Policy meta tag may block the script Dormeto adds, and the wake with it in browser mode');
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
    const found = documents.find(([, candidate]) => candidate.mode === 'template' && key in candidate);
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
