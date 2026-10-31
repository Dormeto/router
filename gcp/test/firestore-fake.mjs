// A Firestore REST server in memory, for the store's tests and for what a request reads through the real store.
import assert from 'node:assert/strict';
import { GoogleError } from '../src/google.mjs';

export const ROOT = 'projects/p/databases/dmtr-europe-west1/documents';
export const BASE = `https://firestore.googleapis.com/v1/${ROOT}`;

// A Firestore REST server in memory: documents, `updateTime` preconditions, `exists` preconditions, update masks and
// `increment` transforms; every request yields once, so that concurrent callers interleave.
export function fakeFirestore() {
  const docs = new Map();
  const calls = [];
  let clock = 0;
  const fail = (code, status, message) => new GoogleError(`Google: ${code} ${message}`, { code, status });
  const wire = (name) => ({ name: `${ROOT}/${name}`, fields: structuredClone(docs.get(name).fields), updateTime: docs.get(name).updateTime });

  function commit({ writes }) {
    const staged = new Map();
    const current = (name) => staged.get(name) ?? docs.get(name);
    for (const write of writes) {
      if (write.delete) {
        staged.set(write.delete.slice(ROOT.length + 1), null);
        continue;
      }
      const name = write.update.name.slice(ROOT.length + 1);
      const before = current(name);
      const precondition = write.currentDocument;
      if (precondition?.exists === false && before) throw fail(409, 'ALREADY_EXISTS', `${name} exists`);
      if (precondition?.exists === true && !before) throw fail(404, 'NOT_FOUND', `${name} is missing`);
      if (precondition?.updateTime && before?.updateTime !== precondition.updateTime) {
        throw fail(400, 'FAILED_PRECONDITION', 'the stored version does not match the requested one');
      }
      let fields = structuredClone(write.update.fields ?? {});
      if (write.updateMask) {
        fields = structuredClone(before?.fields ?? {});
        for (const path of write.updateMask.fieldPaths) {
          const key = path.replace(/^`(.*)`$/, '$1');
          if (key in (write.update.fields ?? {})) fields[key] = structuredClone(write.update.fields[key]);
          else delete fields[key];
        }
      }
      for (const { fieldPath, increment } of write.updateTransforms ?? []) {
        const key = fieldPath.replace(/^`(.*)`$/, '$1');
        fields[key] = { integerValue: String(Number(fields[key]?.integerValue ?? 0) + Number(increment.integerValue)) };
      }
      staged.set(name, { fields });
    }
    clock += 1;
    for (const [name, doc] of staged) {
      if (doc === null) docs.delete(name);
      else docs.set(name, { fields: doc.fields, updateTime: `2026-01-01T00:00:${String(clock).padStart(2, '0')}.000000Z` });
    }
    return { writeResults: writes.map(() => ({})), commitTime: String(clock) };
  }

  async function request(method, url, body) {
    calls.push({ method, url, body });
    await Promise.resolve();
    assert.ok(url.startsWith(BASE), `unexpected url ${url}`);
    const path = url.slice(BASE.length);
    if (method === 'POST' && path === ':commit') return commit(body);
    if (method === 'POST' && path === ':batchGet') {
      return body.documents.map((full) => {
        const name = full.slice(ROOT.length + 1);
        return docs.has(name) ? { found: wire(name) } : { missing: full };
      });
    }
    if (method === 'GET') {
      const [route, query = ''] = path.slice(1).split('?');
      if (docs.has(route)) return wire(route);
      if (!route.includes('/')) {
        const params = new URLSearchParams(query);
        const names = [...docs.keys()].filter((n) => n.startsWith(`${route}/`)).sort();
        const size = Number(params.get('pageSize') ?? 100);
        const from = Number(params.get('pageToken') ?? 0);
        const page = names.slice(from, from + size).map(wire);
        return from + size < names.length ? { documents: page, nextPageToken: String(from + size) } : (page.length ? { documents: page } : {});
      }
      throw fail(404, 'NOT_FOUND', `${route} not found`);
    }
    throw new Error(`unexpected request ${method} ${url}`);
  }

  return { request, docs, calls };
}
