// A Firestore REST server in memory, for the store's tests and for what a request reads through the real store.
import assert from 'node:assert/strict';
import { GoogleError } from '../src/google.mjs';

export const ROOT = 'projects/p/databases/dmtr-europe-west1/documents';
export const BASE = `https://firestore.googleapis.com/v1/${ROOT}`;
// Firestore's limits (its "Usage and limits" and "Storage size calculations" pages): a document of at most 1 MiB, field names
// matching __.*__ reserved, no array directly in an array.
export const DOCUMENT_MAX_BYTES = 1_048_576;
const RESERVED = /^__.*__$/;

const textSize = (text) => Buffer.byteLength(text) + 1;
// A value's size as Firestore counts it, refusing what Firestore refuses; `inArray`: the value is an array's element.
function valueSize(value, inArray = false) {
  if ('stringValue' in value) return textSize(value.stringValue);
  if ('booleanValue' in value || 'nullValue' in value) return 1;
  if ('integerValue' in value || 'doubleValue' in value || 'timestampValue' in value) return 8;
  if ('bytesValue' in value) return Buffer.from(value.bytesValue, 'base64').length;
  if ('referenceValue' in value) return nameSize(value.referenceValue.slice(ROOT.length + 1));
  if ('arrayValue' in value) {
    if (inArray) throw new Error('an array cannot directly contain another array');
    return (value.arrayValue.values ?? []).reduce((n, v) => n + valueSize(v, true), 0);
  }
  if ('mapValue' in value) return fieldsSize(value.mapValue.fields ?? {});
  throw new Error(`unsupported Firestore value: ${Object.keys(value).join(', ')}`);
}
function fieldsSize(fields) {
  return Object.entries(fields).reduce((n, [name, value]) => {
    if (RESERVED.test(name)) throw new Error(`the field name ${name} is reserved`);
    return n + textSize(name) + valueSize(value);
  }, 0);
}
const nameSize = (name) => name.split('/').reduce((n, segment) => n + textSize(segment), 16);

// A Firestore REST server in memory: documents, `updateTime` preconditions, `exists` preconditions, update masks and
// `increment` transforms, and Firestore's limits on what a document holds (a write that breaks one is refused whole, as
// Firestore's 400); every request yields once, so that concurrent callers interleave.
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
        const gone = write.delete.slice(ROOT.length + 1);
        if (write.currentDocument?.exists === true && !current(gone)) throw fail(404, 'NOT_FOUND', `${gone} is missing`);
        staged.set(gone, null);
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
      let size;
      try {
        size = nameSize(name) + fieldsSize(fields) + 32;
      } catch (err) {
        throw fail(400, 'INVALID_ARGUMENT', `${name}: ${err.message}`);
      }
      if (size > DOCUMENT_MAX_BYTES) throw fail(400, 'INVALID_ARGUMENT', `${name} cannot be written because its size (${size} bytes) exceeds the maximum allowed size of ${DOCUMENT_MAX_BYTES} bytes`);
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
    // A collection's documents after a name, by name: the structured query the journal reads with.
    if (method === 'POST' && path === ':runQuery') {
      const { from, where, orderBy, limit } = body.structuredQuery;
      assert.deepEqual(orderBy, [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }]);
      const after = where?.fieldFilter?.value.referenceValue;
      assert.ok(!where || (where.fieldFilter.op === 'GREATER_THAN' && where.fieldFilter.field.fieldPath === '__name__'));
      const names = [...docs.keys()].filter((n) => n.startsWith(`${from[0].collectionId}/`) && (!after || `${ROOT}/${n}` > after)).sort().slice(0, limit);
      return names.length ? names.map((name) => ({ document: wire(name), readTime: 'x' })) : [{ readTime: 'x' }];
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
