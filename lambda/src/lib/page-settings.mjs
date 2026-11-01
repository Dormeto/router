// The waiting page's setting (spec 2026-11-01-branded-waiting-page §4 and §5): its rules, its levels' merge, and the
// recent wake times the progress bar is drawn from. Terraform and a hand-edited settings.json bypass the write's check,
// so every read goes through cleanPage.
const LANGUAGES = ['en', 'fr'];
const TOP = ['logo', 'accent', 'background', 'texts'];
const TEXTS = ['title', 'message', 'links'];
const LOGO_BYTES = 64 * 1024;
const LOGO_TYPES = { png: 'png', jpeg: 'jpeg', webp: 'webp', 'svg+xml': 'svg' };
const MAX_LINKS = 3;
const WAKES_KEPT = 10;

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
  // The first element: after a byte order mark, blanks, an XML declaration and comments.
  svg: (bytes) => /^(?:﻿|\s|<\?xml[^>]*\?>|<!--[\s\S]*?-->)*<svg[\s/>]/.test(bytes.toString('utf8')),
};

function checkLogo(logo) {
  const found = typeof logo === 'string' && /^data:image\/(png|jpeg|webp|svg\+xml);base64,([A-Za-z0-9+/]*={0,2})$/.exec(logo);
  if (!found) return 'logo must be a data:image/png, jpeg, webp or svg+xml base64 URI';
  const bytes = Buffer.from(found[2], 'base64');
  if (bytes.toString('base64') !== found[2] || bytes.length === 0) return 'logo is not valid base64';
  if (bytes.length > LOGO_BYTES) return 'logo must be at most 64 KiB once decoded';
  if (!SIGNATURES[LOGO_TYPES[found[1]]](bytes)) return `logo is not a ${found[1]} image`;
  return null;
}

const checkColor = (name) => (value) => (typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? null : `${name} must be a color like #0b5fff`);

function checkTitle(title) {
  if (typeof title !== 'string' || !title.trim() || SINGLE_LINE.test(title)) return 'title must be one line of text';
  return size(title) > 80 ? 'title must be at most 80 characters' : null;
}

function checkMessage(message) {
  if (typeof message !== 'string' || !message.trim() || MULTI_LINE.test(message)) return 'message must be text';
  return size(message) > 500 ? 'message must be at most 500 characters' : null;
}

function checkLink(link) {
  if (!isObject(link)) return 'a link must be { label, url }';
  const unknown = Object.keys(link).filter((key) => !['label', 'url'].includes(key));
  if (unknown.length) return `a link has no ${unknown.join(', ')}`;
  const { label, url } = link;
  if (typeof label !== 'string' || !label.trim() || SINGLE_LINE.test(label)) return 'a link label must be one line of text';
  if (size(label) > 40) return 'a link label must be at most 40 characters';
  if (typeof url !== 'string' || !/^(https:\/\/|mailto:)[^\s\u0000-\u001f\u007f]+$/i.test(url)) return 'a link url must start with https: or mailto:';
  if (url.length > 300) return 'a link url must be at most 300 characters';
  try {
    if (!['https:', 'mailto:'].includes(new URL(url).protocol)) return 'a link url must start with https: or mailto:';
  } catch {
    return 'a link url is not a valid address';
  }
  return null;
}

const FIELDS = { logo: checkLogo, accent: checkColor('accent'), background: checkColor('background') };
const TEXT_FIELDS = { title: checkTitle, message: checkMessage };

function validateTexts(texts, problems) {
  if (!isObject(texts)) return void problems.push('texts must be an object with en and fr');
  for (const [language, text] of Object.entries(texts)) {
    if (!LANGUAGES.includes(language)) { problems.push(`texts has no language ${language}: only en and fr`); continue; }
    if (!isObject(text)) { problems.push(`texts.${language} must be an object`); continue; }
    for (const [key, value] of Object.entries(text)) {
      const at = `texts.${language}.${key}`;
      if (!TEXTS.includes(key)) problems.push(`${at} is not a field of the page`);
      else if (key === 'links') {
        if (!Array.isArray(value)) problems.push(`${at} must be a list`);
        else {
          if (value.length > MAX_LINKS) problems.push(`${at} holds at most 3 links`);
          value.forEach((link, i) => { const problem = checkLink(link); if (problem) problems.push(`${at}[${i}]: ${problem}`); });
        }
      } else { const problem = TEXT_FIELDS[key](value); if (problem) problems.push(`texts.${language}.${problem}`); }
    }
  }
}

// Every problem of a document, as sentences; [] when it is fine.
export function validatePage(doc) {
  if (!isObject(doc)) return ['the page must be an object'];
  const problems = [];
  for (const [key, value] of Object.entries(doc)) {
    if (!TOP.includes(key)) problems.push(`${key} is not a field of the page`);
    else if (key === 'texts') validateTexts(value, problems);
    else { const problem = FIELDS[key](value); if (problem) problems.push(problem); }
  }
  return problems;
}

// The valid fields only; never throws, whatever the value. Links: the first 3 valid ones.
export function cleanPage(doc) {
  const page = {};
  if (!isObject(doc)) return page;
  for (const key of Object.keys(FIELDS)) if (key in doc && !FIELDS[key](doc[key])) page[key] = doc[key];
  if (!isObject(doc.texts)) return page;
  const texts = {};
  for (const language of LANGUAGES) {
    const text = doc.texts[language];
    if (!isObject(text)) continue;
    const kept = {};
    for (const key of Object.keys(TEXT_FIELDS)) if (key in text && !TEXT_FIELDS[key](text[key])) kept[key] = text[key];
    if (Array.isArray(text.links)) kept.links = text.links.filter((link) => !checkLink(link)).slice(0, MAX_LINKS).map(({ label, url }) => ({ label, url }));
    if (Object.keys(kept).length) texts[language] = kept;
  }
  if (Object.keys(texts).length) page.texts = texts;
  return page;
}

const FLAT = (page) => {
  const out = {};
  for (const key of Object.keys(FIELDS)) if (key in page) out[key] = page[key];
  for (const language of LANGUAGES) for (const key of TEXTS) if (key in (page.texts?.[language] ?? {})) out[`${language}.${key}`] = page.texts[language][key];
  return out;
};
const LEVELS = ['manager', 'router', 'workload'];

// The most specific field wins; a language's links are replaced as a whole.
export function mergePage(manager, router, workload) {
  const flat = Object.assign({}, ...[manager, router, workload].map((level) => FLAT(cleanPage(level))));
  const page = {};
  for (const [key, value] of Object.entries(flat)) {
    const [language, field] = key.split('.');
    if (field) ((page.texts ??= {})[language] ??= {})[field] = value;
    else page[key] = value;
  }
  return page;
}

// For each field of the merged page, the level it came from: { logo: 'router', 'en.title': 'workload', … }.
export function fromOf(manager, router, workload) {
  const from = {};
  [manager, router, workload].forEach((level, i) => { for (const key of Object.keys(FLAT(cleanPage(level)))) from[key] = LEVELS[i]; });
  return from;
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
