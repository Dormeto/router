// What each build of the router ships holds every module its entry points reach (vision docs/specs/2026-11-12-cloud-duplication-design.md,
// §3): the tests import from the checkout, where every file exists, so only following the imports from the entry points shows a module
// a build lacks. The Lambda zip is all of lambda/src (install/package.mjs, Terraform's archive of the same directory), its entry points
// the handlers; the Cloud Run image is what gcp/Containerfile copies, its entry points its CMD, the roles server.mjs loads by DMT_ROLE
// and the tool it copies. The image has no node_modules: what it reaches imports only node built-ins and its own files, and the shared
// lib it reaches imports nothing from lambda/src/aws or gcp/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const read = (path) => readFileSync(join(ROOT, path), 'utf8');

// A module's import specifiers: static imports and re-exports, side-effect imports and dynamic imports of a literal. A dynamic import
// of anything else is answered apart (`dynamic`), for its caller to say what it loads. Comment lines are not read.
export function importsOf(code) {
  const text = code.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
  const specs = [
    ...[...text.matchAll(/(?:^|[\s;])(?:import|export)\s[^'"`;]*?\sfrom\s*['"]([^'"]+)['"]/g)].map((m) => m[1]),
    ...[...text.matchAll(/(?:^|[\s;])import\s*['"]([^'"]+)['"]/g)].map((m) => m[1]),
    ...[...text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]),
  ];
  return { specs, dynamic: [...text.matchAll(/\bimport\(\s*([^'"\s)][^)]*)\)/g)].map((m) => m[1]) };
}

// Every module reached from `entries` (paths from the root): `{ files, bare }`, the files as paths from the root and the bare specifiers
// each file imports. `dynamic(file, expression)` answers what a dynamic import of an expression loads, relative to that file.
export function closure(root, entries, { dynamic = () => { throw new Error('a dynamic import of an expression'); } } = {}) {
  const files = new Map();
  const queue = entries.map((entry) => resolve(root, entry));
  while (queue.length) {
    const file = queue.pop();
    const path = relative(root, file);
    if (files.has(path)) continue;
    const imported = { bare: [], relative: [] };
    files.set(path, imported);
    if (!file.endsWith('.mjs')) continue;
    const { specs, dynamic: expressions } = importsOf(readFileSync(file, 'utf8'));
    const loads = [...specs, ...expressions.flatMap((expression) => dynamic(path, expression))];
    for (const spec of loads) {
      if (spec.startsWith('.')) {
        const target = resolve(dirname(file), spec);
        imported.relative.push(relative(root, target));
        queue.push(target);
      } else {
        imported.bare.push(spec);
      }
    }
  }
  return files;
}

// The Lambda zip: the handlers are lambda/src's top-level modules, Terraform's among them.
function lambdaZip() {
  assert.match(read('install/package.mjs'), /execFileSync\('zip', \[[^\]]*\], \{ cwd: `\$\{root\}lambda\/src` \}\)/);
  const entries = readdirSync(join(ROOT, 'lambda/src')).filter((name) => name.endsWith('.mjs')).map((name) => `lambda/src/${name}`);
  const handlers = ['terraform/modules/router/main.tf', 'terraform/modules/kubernetes-proxy/main.tf']
    .flatMap((tf) => [...read(tf).matchAll(/handler\s*=\s*"([a-z-]+)\.handler"/g)].map((m) => `lambda/src/${m[1]}.mjs`));
  assert.ok(handlers.length >= 4, handlers.join(', '));
  for (const handler of handlers) assert.ok(entries.includes(handler), `${handler} is a Terraform handler`);
  return { entries, ships: (path) => path.startsWith('lambda/src/') };
}

// The Cloud Run image: what the Containerfile copies, each to its own path, its CMD, the roles server.mjs loads and the tools it copies.
function cloudRunImage() {
  const containerfile = read('gcp/Containerfile');
  const copies = [...containerfile.matchAll(/^COPY\s+(\S+)\s+(\S+)$/gm)].map(([, from, to]) => {
    assert.equal(to.replace(/^\.\//, ''), from, `${from} is copied to its own path`);
    return from;
  });
  const [, cmd] = /^CMD \["([^"]+)"\]$/m.exec(containerfile);
  const roles = [.../ROLES = \{([^}]*)\}/.exec(read('gcp/src/server.mjs'))[1].matchAll(/'(\.\/[a-z-]+\.mjs)'/g)].map((m) => m[1]);
  assert.deepEqual(roles, ['./waker.mjs', './controller.mjs']);
  const tools = copies.filter((path) => path.startsWith('gcp/tools/') && path.endsWith('.mjs'));
  return {
    entries: [cmd, ...roles.map((role) => join('gcp/src', role)), ...tools],
    ships: (path) => copies.some((copied) => path === copied || path.startsWith(`${copied}/`)),
    // server.mjs's `import(ROLES[role])`: one of its roles.
    dynamic: (file, expression) => {
      assert.equal(`${file} ${expression}`, 'gcp/src/server.mjs ROLES[role]');
      return roles;
    },
  };
}

test('the Lambda zip holds every module its handlers reach, which import only node built-ins and the runtime\'s AWS SDK clients', () => {
  const { entries, ships } = lambdaZip();
  const files = closure(ROOT, entries);
  assert.ok(files.size > 50, `${files.size} modules`);
  assert.deepEqual([...files.keys()].filter((path) => !ships(path)), [], 'reached, not in the zip');
  for (const [path, { bare }] of files) {
    for (const spec of bare) assert.match(spec, /^(node:[a-z_/]+|@aws-sdk\/client-[a-z0-9-]+)$/, `${path} imports ${spec}`);
  }
});

test('the Cloud Run image holds every module its entry points reach, with no package, and the shared lib it reaches knows no cloud', () => {
  const { entries, ships, dynamic } = cloudRunImage();
  const files = closure(ROOT, entries, { dynamic });
  assert.ok(files.size > 50, `${files.size} modules`);
  assert.deepEqual([...files.keys()].filter((path) => !ships(path)), [], 'reached, not in the image');
  for (const [path, { bare, relative: imported }] of files) {
    for (const spec of bare) assert.match(spec, /^node:[a-z_/]+$/, `${path} imports ${spec}: the image has no node_modules`);
    if (!path.startsWith('lambda/src/lib/')) continue;
    for (const target of imported) assert.ok(target.startsWith('lambda/src/lib/'), `${path} imports ${target}: the shared lib imports nothing outside it`);
  }
});

test('the import reader finds static, re-exported, side-effect and dynamic imports, and skips comment lines', () => {
  const code = [
    "import { a } from './a.mjs';", "import {\n  b,\n  c,\n} from './b.mjs';", "export { d } from './d.mjs';", "export * from './e.mjs';", "import './f.mjs';",
    "import PACKAGE from '../package.json' with { type: 'json' };", "const g = await import('./g.mjs');", "const h = await import(NAMES[name]);",
    "// import { x } from './commented.mjs';", " * import y from './doc.mjs'", "const url = 'https://example.com/import';",
  ].join('\n');
  assert.deepEqual(importsOf(code), { specs: ['./a.mjs', './b.mjs', './d.mjs', './e.mjs', '../package.json', './f.mjs', './g.mjs'], dynamic: ['NAMES[name]'] });
});
