#!/usr/bin/env node
// One call as the router's service account (spec 2026-10-30, section 10: M7, M11, where the owner would bypass a
// condition or an RBAC rule): `node gcp/tools/probe.mjs <METHOD> <https url> [json body]`, run as a Cloud Run job under
// the account dmtr-<region>. The access token comes from the metadata server (gcp/src/google.mjs); the status and the
// body are printed, as they came. Exit 0 for a 2xx, 1 otherwise, 2 for a bad argument. No dependency.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createGoogle } from '../src/google.mjs';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const USAGE = `Usage: node gcp/tools/probe.mjs <${METHODS.join('|')}> <https url> [json body]`;
const TIMEOUT_MS = 60_000;

export async function main(argv, { google = createGoogle(), fetch = globalThis.fetch, out = console.log, err = console.error } = {}) {
  const [method, url, body, ...extra] = argv;
  const bad = (why) => {
    err(`${why}\n${USAGE}`);
    return 2;
  };
  if (!METHODS.includes(method)) return bad(`a method: ${METHODS.join(', ')}`);
  let target;
  try {
    target = new URL(url);
  } catch {
    return bad(`a URL, not ${JSON.stringify(url)}`);
  }
  if (target.protocol !== 'https:') return bad('an https URL');
  if (extra.length > 0) return bad('too many arguments');
  if (body !== undefined) {
    try {
      JSON.parse(body);
    } catch {
      return bad('the body must be JSON');
    }
  }
  try {
    const token = await google.token();
    const res = await fetch(target.href, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    out(`${res.status} ${res.statusText}`);
    out(await res.text());
    return res.ok ? 0 : 1;
  } catch (e) {
    err(e.message ?? String(e));
    return 1;
  }
}

const invoked = process.argv[1] && (() => {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (invoked) process.exit(await main(process.argv.slice(2)));
