import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanPage, fromOf, medianOf, mergePage, validatePage, withWake } from '../src/lib/page-settings.mjs';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(32)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>');
const uri = (type, bytes) => `data:image/${type};base64,${bytes.toString('base64')}`;
const padded = (head, size) => Buffer.concat([head, Buffer.alloc(size - head.length)]);

test('an empty document and every valid field are fine', () => {
  assert.deepEqual(validatePage({}), []);
  const doc = {
    logo: uri('png', PNG), accent: '#0b5fff', background: '#FFFFFF',
    texts: { en: { title: 'Acme', message: 'a\nb', links: [{ label: 'Status', url: 'https://status.acme.com' }, { label: 'Mail', url: 'mailto:ops@acme.com' }] }, fr: { title: 'Portail' } },
  };
  assert.deepEqual(validatePage(doc), []);
  assert.deepEqual(cleanPage(doc), doc);
});

test('anything but a plain object is refused, and cleans to {}', () => {
  for (const bad of [null, undefined, 'x', 3, true, [], [{}]]) {
    assert.equal(validatePage(bad).length, 1, String(bad));
    assert.deepEqual(cleanPage(bad), {});
  }
});

test('unknown keys are refused, at the top, in texts, in a language and in a link', () => {
  assert.match(validatePage({ colour: '#000000' }).join(), /colour/);
  assert.match(validatePage({ texts: { de: { title: 'x' } } }).join(), /de/);
  assert.match(validatePage({ texts: { en: { subtitle: 'x' } } }).join(), /subtitle/);
  assert.match(validatePage({ texts: { en: { links: [{ label: 'a', url: 'https://a.io', rel: 'x' }] } } }).join(), /rel/);
  assert.deepEqual(cleanPage({ colour: '#000000', accent: '#000000', texts: { de: { title: 'x' }, en: { subtitle: 'x', title: 'y' } } }), { accent: '#000000', texts: { en: { title: 'y' } } });
});

test('colors are #rrggbb only', () => {
  for (const ok of ['#000000', '#abcdef', '#ABCDEF']) assert.deepEqual(validatePage({ accent: ok, background: ok }), []);
  for (const bad of ['#fff', '#12345g', '000000', '#0000000', 'red', 'rgb(0,0,0)', '#000000;x', 5, null]) {
    assert.equal(validatePage({ accent: bad }).length, 1, String(bad));
    assert.equal(validatePage({ background: bad }).length, 1, String(bad));
    assert.deepEqual(cleanPage({ accent: bad, background: bad }), {});
  }
});

test('title: 80 characters, one line', () => {
  assert.deepEqual(validatePage({ texts: { en: { title: 'a'.repeat(80) } } }), []);
  assert.equal(validatePage({ texts: { en: { title: 'a'.repeat(81) } } }).length, 1);
  assert.equal(validatePage({ texts: { en: { title: 'a\nb' } } }).length, 1);
  assert.equal(validatePage({ texts: { en: { title: 'a\rb' } } }).length, 1);
  assert.equal(validatePage({ texts: { en: { title: '' } } }).length, 1);
  assert.equal(validatePage({ texts: { en: { title: '   ' } } }).length, 1);
  assert.equal(validatePage({ texts: { en: { title: 4 } } }).length, 1);
  assert.deepEqual(validatePage({ texts: { en: { title: '😀'.repeat(80) } } }), [], 'characters, not UTF-16 units');
});

test('message: 500 characters, line breaks kept', () => {
  assert.deepEqual(validatePage({ texts: { fr: { message: 'a'.repeat(500) } } }), []);
  assert.equal(validatePage({ texts: { fr: { message: 'a'.repeat(501) } } }).length, 1);
  assert.deepEqual(cleanPage({ texts: { fr: { message: 'a\nb\r\nc' } } }), { texts: { fr: { message: 'a\nb\r\nc' } } });
  assert.equal(validatePage({ texts: { fr: { message: 'a\u0000b' } } }).length, 1);
  assert.equal(validatePage({ texts: { fr: { message: ['x'] } } }).length, 1);
});

test('links: 3 at most, label 40, url 300, https or mailto only', () => {
  const link = (url, label = 'x') => ({ label, url });
  const links = (...l) => ({ texts: { en: { links: l } } });
  assert.deepEqual(validatePage(links()), []);
  assert.deepEqual(validatePage(links(link('https://a.io'), link('https://b.io'), link('https://c.io'))), []);
  assert.equal(validatePage(links(link('https://a.io'), link('https://b.io'), link('https://c.io'), link('https://d.io'))).length, 1);
  assert.deepEqual(validatePage(links(link('https://a.io', 'a'.repeat(40)))), []);
  assert.equal(validatePage(links(link('https://a.io', 'a'.repeat(41)))).length, 1);
  assert.equal(validatePage(links(link('https://a.io', ''))).length, 1);
  const long = `https://a.io/${'a'.repeat(287)}`;
  assert.equal(long.length, 300);
  assert.deepEqual(validatePage(links(link(long))), []);
  assert.equal(validatePage(links(link(`${long}a`))).length, 1);
  for (const bad of ['javascript:alert(1)', 'JavaScript:alert(1)', ' javascript:alert(1)', 'data:text/html,x', 'http://a.io', 'ftp://a.io', '//a.io', '/a', 'a.io', 'https://', 'https://a.io/ b', 'https://a.io/\nb', 'https:\\\\a.io', 5, null]) {
    assert.equal(validatePage(links(link(bad))).length, 1, String(bad));
  }
  assert.deepEqual(validatePage(links(link('HTTPS://A.io'))), []);
  assert.equal(validatePage({ texts: { en: { links: 'x' } } }).length, 1);
  assert.equal(validatePage({ texts: { en: { links: ['x'] } } }).length, 1);
});

test('cleanPage keeps the good links, the first 3, and an empty list', () => {
  const good = (n) => ({ label: `l${n}`, url: `https://a.io/${n}` });
  const out = cleanPage({ texts: { en: { links: [good(1), { label: 'bad', url: 'javascript:1' }, good(2), good(3), good(4)] }, fr: { links: [] } } });
  assert.deepEqual(out.texts.en.links, [good(1), good(2), good(3)]);
  assert.deepEqual(out.texts.fr.links, []);
});

test('logo: png, jpeg, webp and svg by their content', () => {
  for (const [type, bytes] of [['png', PNG], ['jpeg', JPEG], ['webp', WEBP], ['svg+xml', SVG]]) {
    assert.deepEqual(validatePage({ logo: uri(type, bytes) }), [], type);
  }
  assert.deepEqual(validatePage({ logo: uri('svg+xml', Buffer.from('﻿ <?xml version="1.0"?>\n<!-- c -->\n<svg></svg>')) }), []);
});

test('logo: a type that does not match its content is refused', () => {
  assert.equal(validatePage({ logo: uri('png', SVG) }).length, 1, 'svg as png');
  assert.equal(validatePage({ logo: uri('svg+xml', PNG) }).length, 1, 'png as svg');
  assert.equal(validatePage({ logo: uri('jpeg', PNG) }).length, 1);
  assert.equal(validatePage({ logo: uri('webp', JPEG) }).length, 1);
  assert.equal(validatePage({ logo: uri('png', Buffer.from('RIFF')) }).length, 1);
  assert.equal(validatePage({ logo: uri('svg+xml', Buffer.from('<html><svg></svg></html>')) }).length, 1);
  assert.equal(validatePage({ logo: uri('svg+xml', Buffer.from('<script>1</script><svg></svg>')) }).length, 1);
  assert.equal(validatePage({ logo: uri('svg+xml', Buffer.from('<svgx></svgx>')) }).length, 1);
  assert.equal(validatePage({ logo: uri('png', Buffer.alloc(0)) }).length, 1);
});

test('logo: 64 KiB decoded, not one byte more', () => {
  assert.deepEqual(validatePage({ logo: uri('png', padded(PNG, 65536)) }), []);
  assert.equal(validatePage({ logo: uri('png', padded(PNG, 65537)) }).length, 1);
  assert.deepEqual(validatePage({ logo: uri('png', padded(PNG, 65535)) }), []);
});

test('logo: other types, other encodings and bad base64 are refused', () => {
  const b64 = PNG.toString('base64');
  for (const bad of [
    `data:image/gif;base64,${b64}`, `data:text/html;base64,${b64}`, `data:image/png,${b64}`, `data:image/png;charset=utf-8;base64,${b64}`,
    `https://a.io/logo.png`, `data:image/png;base64,${b64}!`, `data:image/png;base64,${b64.slice(1)}`, `data:image/png;base64,${b64}=`,
    `data:image/png;base64,`, ` data:image/png;base64,${b64}`, `data:image/png;base64,${b64}\n`, `data:image/PNG;base64,${b64}`, 5, null, '',
  ]) assert.equal(validatePage({ logo: bad }).length, 1, String(bad).slice(0, 40));
  assert.deepEqual(cleanPage({ logo: `data:image/gif;base64,${b64}`, accent: '#000000' }), { accent: '#000000' });
});

test('a problem is a sentence naming the field, and every problem is returned', () => {
  const problems = validatePage({ accent: 'red', background: 'blue', logo: 'x', texts: { en: { title: '' } } });
  assert.equal(problems.length, 4);
  assert.ok(problems.every((p) => typeof p === 'string' && p.length > 10));
  assert.match(problems[0], /accent/);
});

test('cleanPage keeps the good fields beside the bad ones, and never throws on any JSON value', () => {
  const out = cleanPage({ accent: '#112233', background: 'nope', logo: 7, texts: { en: { title: 'ok', message: 'x'.repeat(501), links: 'nope' }, fr: 'nope', de: {} } });
  assert.deepEqual(out, { accent: '#112233', texts: { en: { title: 'ok' } } });
  const odd = [0, 1.5, '', 'x', true, false, null, [], [1, [2]], {}, { texts: null }, { texts: [] }, { texts: { en: null } }, { texts: { en: [] } },
    { texts: { en: { links: [null, 1, 'x', [], { label: {}, url: {} }] } } }, JSON.parse('{"__proto__": {"a": 1}, "texts": {"__proto__": {}}}'), { logo: {} }, { accent: [] }];
  for (const value of odd) {
    assert.doesNotThrow(() => validatePage(value));
    const cleaned = cleanPage(value);
    assert.deepEqual(validatePage(cleaned), []);
  }
  assert.equal(({}).a, undefined, 'no prototype pollution');
  assert.deepEqual(cleanPage({ texts: { en: {}, fr: { title: 'x' } } }), { texts: { fr: { title: 'x' } } }, 'empty language dropped');
  assert.deepEqual(cleanPage({ texts: {} }), {});
});

test('mergePage: the most specific field wins, the others stay', () => {
  const manager = { logo: uri('png', PNG), accent: '#111111', background: '#222222', texts: { en: { title: 'M', message: 'mm' }, fr: { title: 'Mf' } } };
  const router = { accent: '#333333', texts: { en: { title: 'R' } } };
  const workload = { background: '#444444', texts: { fr: { message: 'Wm' } } };
  assert.deepEqual(mergePage(manager, router, workload), {
    logo: manager.logo, accent: '#333333', background: '#444444',
    texts: { en: { title: 'R', message: 'mm' }, fr: { title: 'Mf', message: 'Wm' } },
  });
});

test('mergePage: links are replaced as a whole, and [] removes the inherited ones', () => {
  const a = [{ label: 'a', url: 'https://a.io' }, { label: 'b', url: 'https://b.io' }];
  const c = [{ label: 'c', url: 'https://c.io' }];
  assert.deepEqual(mergePage({ texts: { en: { links: a } } }, { texts: { en: { links: c } } }, null).texts.en.links, c);
  assert.deepEqual(mergePage({ texts: { en: { links: a } } }, null, { texts: { en: { links: [] } } }).texts.en.links, []);
  assert.deepEqual(mergePage({ texts: { en: { links: a } } }, { texts: { fr: { links: c } } }, null).texts, { en: { links: a }, fr: { links: c } });
});

test('mergePage: nothing, undefined and junk give {}; bad stored fields never get through', () => {
  assert.deepEqual(mergePage(), {});
  assert.deepEqual(mergePage(null, 'x', []), {});
  assert.deepEqual(mergePage({ accent: 'red', texts: { en: { title: 'ok' } } }, { accent: '#123456' }, { logo: 'javascript:1' }), { accent: '#123456', texts: { en: { title: 'ok' } } });
});

test('fromOf names the level of each merged field', () => {
  const manager = { logo: uri('png', PNG), accent: '#111111', texts: { en: { title: 'M', message: 'mm' } } };
  const router = { accent: '#333333', texts: { en: { title: 'R', links: [] } } };
  const workload = { texts: { fr: { message: 'Wm' }, en: { title: 'W' } } };
  assert.deepEqual(fromOf(manager, router, workload), {
    logo: 'manager', accent: 'router', 'en.title': 'workload', 'en.message': 'manager', 'en.links': 'router', 'fr.message': 'workload',
  });
  assert.deepEqual(fromOf(), {});
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
