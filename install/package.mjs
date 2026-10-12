// npm run package: the router bundle the manager installs (vision docs/specs/2026-10-05-onboarding-design.md, R4b):
// dist/router-<version>.zip (lambda/src), dist/blueprint-<version>.json (its build filled, the other placeholders kept)
// and dist/router-boundary.json (DmtRouterBoundary, placeholders ${account} and ${partition}).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { PLACEHOLDERS, blueprint, routerBoundary } from './blueprint.mjs';

const root = new URL('..', import.meta.url).pathname;
const { version } = JSON.parse(readFileSync(`${root}package.json`, 'utf8'));
const dist = `${root}dist`;
mkdirSync(dist, { recursive: true });
const zip = `${dist}/router-${version}.zip`;
rmSync(zip, { force: true });
// -X: no extra file attributes; -D: no directory entries.
execFileSync('zip', ['-q', '-r', '-X', '-D', zip, '.'], { cwd: `${root}lambda/src` });
const build = createHash('sha256').update(readFileSync(zip)).digest('hex').slice(0, 12);
writeFileSync(`${dist}/blueprint-${version}.json`, `${JSON.stringify(blueprint({ version, p: { ...PLACEHOLDERS, build } }), null, 2)}\n`);
writeFileSync(`${dist}/router-boundary.json`, `${JSON.stringify(routerBoundary(), null, 2)}\n`);
console.log(`router ${version} build ${build}: ${zip}`);
