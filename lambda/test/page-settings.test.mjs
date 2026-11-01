import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanPage, iconTypeOf, medianOf, pageWarnings, resolvePage, validatePage, withWake } from '../src/lib/page-settings.mjs';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(32)]);
const ICO = Buffer.concat([Buffer.from([0, 0, 1, 0, 1, 0]), Buffer.alloc(32)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>');
const uri = (type, bytes) => `data:image/${type};base64,${bytes.toString('base64')}`;
const padded = (head, size) => Buffer.concat([head, Buffer.alloc(size - head.length)]);
const template = (fields) => ({ mode: 'template', ...fields });
const custom = (html = '<!doctype html><p>hi</p>') => ({ mode: 'custom', html });

test('both shapes and every valid field are fine', () => {
  const full = { mode: 'template', icon: uri('png', PNG), title: 'Acme portal', description: 'a\nb' };
  assert.deepEqual(validatePage(full), []);
  assert.deepEqual(cleanPage(full), full);
  for (const icon of ['auto', 'none']) assert.deepEqual(validatePage(template({ icon })), []);
  assert.deepEqual(validatePage({ mode: 'template' }), []);
  assert.deepEqual(validatePage(custom()), []);
  assert.deepEqual(cleanPage(custom()), custom());
});

test('anything but a plain object is refused, and cleans to null', () => {
  for (const bad of [null, undefined, 'x', 3, true, [], [{}]]) {
    assert.equal(validatePage(bad).length, 1, String(bad));
    assert.equal(cleanPage(bad), null);
  }
});

test('the mode is required and is template or custom', () => {
  for (const bad of [{}, { mode: 'html' }, { mode: 5 }, { mode: null }, { title: 'x' }]) {
    assert.equal(validatePage(bad).length, 1, JSON.stringify(bad));
    assert.equal(cleanPage(bad), null);
  }
});

test('unknown keys and a field of the other mode are refused', () => {
  assert.match(validatePage(template({ colour: '#000000' })).join(), /colour/);
  assert.match(validatePage(template({ html: '<p>x</p>' })).join(), /html/);
  assert.match(validatePage({ ...custom(), title: 'x' }).join(), /title/);
  assert.match(validatePage({ ...custom(), icon: 'auto' }).join(), /icon/);
  assert.match(validatePage({ ...custom(), description: 'x' }).join(), /description/);
  assert.match(validatePage(template({ accent: '#000000' })).join(), /accent/);
  assert.match(validatePage(template({ texts: {} })).join(), /texts/);
});

test('cleanPage keeps what is valid and drops the rest', () => {
  assert.deepEqual(cleanPage(template({ colour: 'x', html: '<p>', title: 'ok', description: '', icon: 'blue' })), { mode: 'template', title: 'ok' });
  assert.deepEqual(cleanPage({ ...custom(), title: 'x', icon: 'auto' }), custom());
  assert.deepEqual(cleanPage({ mode: 'template' }), { mode: 'template' });
});

test('title: 80 characters, one line, not blank', () => {
  assert.deepEqual(validatePage(template({ title: 'a'.repeat(80) })), []);
  assert.equal(validatePage(template({ title: 'a'.repeat(81) })).length, 1);
  for (const bad of ['a\nb', 'a\rb', '', '   ', 4, null, ['x'], 'a\u0000b']) assert.equal(validatePage(template({ title: bad })).length, 1, String(bad));
  assert.deepEqual(validatePage(template({ title: '\u{1F600}'.repeat(80) })), [], 'characters, not UTF-16 units');
  assert.equal(validatePage(template({ title: '\u{1F600}'.repeat(81) })).length, 1);
});

test('description: 500 characters, line breaks kept, not blank', () => {
  assert.deepEqual(validatePage(template({ description: 'a'.repeat(500) })), []);
  assert.equal(validatePage(template({ description: 'a'.repeat(501) })).length, 1);
  assert.deepEqual(cleanPage(template({ description: 'a\nb\r\nc' })), template({ description: 'a\nb\r\nc' }));
  for (const bad of ['', '  \n ', 'a\u0000b', ['x'], 5, null]) assert.equal(validatePage(template({ description: bad })).length, 1, String(bad));
});

test('icon: png, jpeg, webp, svg and ico by their content', () => {
  for (const [type, bytes] of [['png', PNG], ['jpeg', JPEG], ['webp', WEBP], ['svg+xml', SVG], ['x-icon', ICO]]) {
    assert.deepEqual(validatePage(template({ icon: uri(type, bytes) })), [], type);
  }
  assert.deepEqual(validatePage(template({ icon: uri('svg+xml', Buffer.from('\ufeff <?xml version="1.0"?>\n<!-- c -->\n<svg></svg>')) })), []);
});

test('icon: a type that does not match its content is refused', () => {
  assert.equal(validatePage(template({ icon: uri('png', SVG) })).length, 1, 'svg as png');
  assert.equal(validatePage(template({ icon: uri('svg+xml', PNG) })).length, 1, 'png as svg');
  assert.equal(validatePage(template({ icon: uri('x-icon', PNG) })).length, 1, 'png as ico');
  assert.equal(validatePage(template({ icon: uri('png', ICO) })).length, 1, 'ico as png');
  assert.equal(validatePage(template({ icon: uri('jpeg', PNG) })).length, 1);
  assert.equal(validatePage(template({ icon: uri('webp', JPEG) })).length, 1);
  assert.equal(validatePage(template({ icon: uri('png', Buffer.from('RIFF')) })).length, 1);
  assert.equal(validatePage(template({ icon: uri('svg+xml', Buffer.from('<html><svg></svg></html>')) })).length, 1);
  assert.equal(validatePage(template({ icon: uri('svg+xml', Buffer.from('<script>1</script><svg></svg>')) })).length, 1);
  assert.equal(validatePage(template({ icon: uri('svg+xml', Buffer.from('<svgx></svgx>')) })).length, 1);
  assert.equal(validatePage(template({ icon: uri('png', Buffer.alloc(0)) })).length, 1);
});

test('icon: 64 KiB decoded, not one byte more', () => {
  assert.deepEqual(validatePage(template({ icon: uri('png', padded(PNG, 65536)) })), []);
  assert.equal(validatePage(template({ icon: uri('png', padded(PNG, 65537)) })).length, 1);
  assert.deepEqual(validatePage(template({ icon: uri('x-icon', padded(ICO, 65536)) })), []);
  assert.equal(validatePage(template({ icon: uri('x-icon', padded(ICO, 65537)) })).length, 1);
});

test('icon: other values, other encodings and bad base64 are refused', () => {
  const b64 = PNG.toString('base64');
  for (const bad of [
    'AUTO', 'Auto', 'default', 'data:image/gif;base64,' + b64, 'data:text/html;base64,' + b64, 'data:image/png,' + b64,
    'data:image/png;charset=utf-8;base64,' + b64, 'https://a.io/logo.png', 'data:image/png;base64,' + b64 + '!', 'data:image/png;base64,' + b64.slice(1),
    'data:image/png;base64,' + b64 + '=', 'data:image/png;base64,', ' data:image/png;base64,' + b64, 'data:image/png;base64,' + b64 + '\n',
    'data:image/PNG;base64,' + b64, 'data:image/vnd.microsoft.icon;base64,' + ICO.toString('base64'), 5, null, '',
  ]) assert.equal(validatePage(template({ icon: bad })).length, 1, String(bad).slice(0, 40));
  assert.deepEqual(cleanPage(template({ icon: 'data:image/gif;base64,' + b64, title: 'x' })), template({ title: 'x' }));
});

test('html: 256 KiB in bytes, not blank, text', () => {
  const html = (bytes) => `<p>${'a'.repeat(bytes - 7)}</p>`;
  assert.deepEqual(validatePage(custom(html(256 * 1024))), []);
  assert.equal(validatePage(custom(html(256 * 1024 + 1))).length, 1);
  const wide = '\u00e9'.repeat(128 * 1024);
  assert.equal(wide.length, 128 * 1024);
  assert.deepEqual(validatePage(custom(wide)), [], '128 Ki characters of 2 bytes are exactly 256 KiB');
  assert.equal(validatePage(custom(`${wide}\u00e9`)).length, 1, 'bytes, not characters');
  assert.equal(validatePage(custom('\u20ac'.repeat(90_000))).length, 1, '270000 bytes in 90000 characters');
  for (const bad of ['', '   ', '\n\t ', 5, null, ['<p>'], {}, undefined]) assert.equal(validatePage({ mode: 'custom', html: bad }).length, 1, String(bad));
  assert.equal(validatePage({ mode: 'custom' }).length, 1, 'html is required');
  assert.equal(cleanPage({ mode: 'custom', html: '  ' }), null, 'a custom document with no valid html reads as no document');
  assert.equal(cleanPage({ mode: 'custom' }), null);
  assert.equal(cleanPage(custom('x'.repeat(256 * 1024 + 1))), null);
});

test('a problem is a sentence naming the field, and every problem is returned', () => {
  const problems = validatePage(template({ icon: 'red', title: '', description: '', html: 'x', colour: 1 }));
  assert.equal(problems.length, 5);
  assert.ok(problems.every((p) => typeof p === 'string' && p.length > 10));
  assert.match(problems.join('\n'), /icon[\s\S]*title|title[\s\S]*icon/);
});

test('cleanPage never throws on any JSON value, and what it returns validates', () => {
  const odd = [0, 1.5, '', 'x', true, false, null, [], [1, [2]], {}, { mode: [] }, { mode: 'template', title: {} }, { mode: 'template', icon: [] }, { mode: 'custom', html: {} },
    JSON.parse('{"__proto__": {"a": 1}, "mode": "template"}'), { mode: 'template', description: 'x'.repeat(1e6) }, { mode: 'custom', html: 'x'.repeat(1e6) }];
  for (const value of odd) {
    assert.doesNotThrow(() => validatePage(value));
    const cleaned = cleanPage(value);
    if (cleaned !== null) assert.deepEqual(validatePage(cleaned), []);
  }
  assert.equal(({}).a, undefined, 'no prototype pollution');
});

test('pageWarnings: what a custom page should fix, without refusing it', () => {
  assert.deepEqual(pageWarnings(custom('<p data-dormeto="status"></p>')), []);
  assert.deepEqual(pageWarnings(custom("<DIV DATA-DORMETO='status'>")), []);
  assert.deepEqual(pageWarnings(custom('<p data-dormeto=status>')), []);
  assert.equal(pageWarnings(custom('<p>no place</p>')).length, 1);
  assert.match(pageWarnings(custom('<p>no place</p>'))[0], /data-dormeto="status"/);
  assert.equal(pageWarnings(custom('<p data-dormeto="elapsed">')).length, 1, 'another hook is not the status');
  const csp = pageWarnings(custom('<meta http-equiv="Content-Security-Policy" content="default-src \'self\'"><p data-dormeto="status">'));
  assert.equal(csp.length, 1);
  assert.match(csp[0], /Content-Security-Policy/);
  assert.equal(pageWarnings(custom("<META content='x' HTTP-EQUIV=content-security-policy><p>")).length, 2);
  assert.deepEqual(pageWarnings(template({ title: 'x' })), []);
  for (const odd of [null, 'x', 5, [], {}, { mode: 'custom' }]) assert.deepEqual(pageWarnings(odd), []);
});

test('iconTypeOf reads the type from the bytes', () => {
  assert.equal(iconTypeOf(PNG), 'png');
  assert.equal(iconTypeOf(JPEG), 'jpeg');
  assert.equal(iconTypeOf(WEBP), 'webp');
  assert.equal(iconTypeOf(SVG), 'svg+xml');
  assert.equal(iconTypeOf(ICO), 'x-icon');
  assert.equal(iconTypeOf(new Uint8Array(PNG)), 'png');
  for (const bad of [Buffer.alloc(0), Buffer.from('GIF89a'), Buffer.from('<html>'), Buffer.from('<script></script><svg>'), 'x', null, undefined, 5, {}]) assert.equal(iconTypeOf(bad), null, String(bad));
});

const T = (fields) => ({ mode: 'template', ...fields });

test('resolvePage: nothing anywhere is a template with the favicon', () => {
  assert.deepEqual(resolvePage(), { mode: 'template', icon: 'auto', from: { mode: 'default', icon: 'default' } });
  assert.deepEqual(resolvePage(null, 'x', []).mode, 'template');
});

test('resolvePage: the most specific level with a document decides the mode', () => {
  const org = T({ title: 'Org' });
  const html = '<p>mine</p>';
  assert.equal(resolvePage(org, null, custom(html)).mode, 'custom');
  assert.equal(resolvePage(custom(html), null, T({ title: 'W' })).mode, 'template');
  assert.equal(resolvePage(custom(html), T({ title: 'R' }), null).mode, 'template');
  assert.deepEqual(resolvePage(org, custom(html), null), { mode: 'custom', html, from: { mode: 'router', html: 'router' } });
  assert.deepEqual(resolvePage(custom('<p>org</p>'), null, null), { mode: 'custom', html: '<p>org</p>', from: { mode: 'organization', html: 'organization' } });
  assert.equal(resolvePage(custom('<p>org</p>'), custom('<p>router</p>'), custom('<p>wl</p>')).html, '<p>wl</p>', 'whole, never merged');
});

test('resolvePage: a template takes each field from the most specific template document that has it', () => {
  const org = T({ icon: uri('png', PNG), title: 'Org', description: 'org text' });
  const router = T({ title: 'Router' });
  const workload = T({ description: 'wl text' });
  assert.deepEqual(resolvePage(org, router, workload), {
    mode: 'template', icon: uri('png', PNG), title: 'Router', description: 'wl text',
    from: { mode: 'workload', icon: 'organization', title: 'router', description: 'workload' },
  });
  assert.deepEqual(resolvePage(null, router, null), { mode: 'template', icon: 'auto', title: 'Router', from: { mode: 'router', icon: 'default', title: 'router' } });
});

test('resolvePage: a custom page above a template is skipped for the fields; icon none is kept', () => {
  const result = resolvePage(T({ icon: 'none', title: 'Org' }), custom(), T({ description: 'wl' }));
  assert.equal(result.mode, 'template');
  assert.equal(result.icon, 'none');
  assert.equal(result.title, 'Org');
  assert.equal(result.description, 'wl');
  assert.deepEqual(result.from, { mode: 'workload', icon: 'organization', title: 'organization', description: 'workload' });
  assert.equal(resolvePage(T({ icon: 'none' }), T({ title: 'x' }), null).icon, 'none');
});

test('resolvePage: bad stored values never get through', () => {
  const result = resolvePage(T({ title: 'ok', icon: 'javascript:1' }), { mode: 'custom', html: ' ' }, { mode: 'template', title: 5, description: 'd' });
  assert.deepEqual(result, { mode: 'template', icon: 'auto', title: 'ok', description: 'd', from: { mode: 'workload', icon: 'default', title: 'organization', description: 'workload' } });
  assert.equal(resolvePage('x', 5, [{}]).mode, 'template');
});

test('medianOf: odd, even, one outlier ignored, nothing', () => {
  assert.equal(medianOf([3, 1, 2]), 2);
  assert.equal(medianOf([4, 1, 3, 2]), 2.5);
  assert.equal(medianOf([100, 110, 90, 105, 95, 600_000]), 102.5);
  assert.equal(medianOf([7]), 7);
  assert.equal(medianOf([]), null);
  assert.equal(medianOf(undefined), null);
  assert.equal(medianOf('x'), null);
  assert.equal(medianOf([1, 'x', null, NaN, Infinity, -5, 3]), 2, 'only usable durations count');
});

test('withWake appends, keeps the last 10, and starts afresh from a bad value', () => {
  assert.equal(withWake(undefined, 1000), '[1000]');
  assert.equal(withWake('[1,2]', 3), '[1,2,3]');
  const ten = JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(withWake(ten, 11), '[2,3,4,5,6,7,8,9,10,11]');
  assert.equal(withWake(JSON.stringify(Array.from({ length: 50 }, (_, i) => i + 1)), 51), JSON.stringify([42, 43, 44, 45, 46, 47, 48, 49, 50, 51]));
  for (const bad of ['{not json', '', 'null', '{"a":1}', '"x"', '12', 7, null]) assert.equal(withWake(bad, 5), '[5]', String(bad));
  assert.equal(withWake('[1,"x",null,2,-3]', 4), '[1,2,4]', 'unusable entries dropped');
  assert.equal(withWake('[1]', NaN), '[1]', 'an unusable duration changes nothing');
  assert.equal(withWake('[1]', undefined), '[1]');
});
