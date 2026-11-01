import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWaitingPages } from '../src/lib/waiting-pages.mjs';
import { fakeClock } from './fakes.mjs';

const PNG = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]).toString('base64')}`;
const UPLOAD = `data:image/x-icon;base64,${Buffer.from([0, 0, 1, 0, 1]).toString('base64')}`;

// A store holding pages by level ('router', workload id; 'organization' is the reader's) and favicons by workload id; every read is recorded.
function setup({ pages = {}, favicons = {}, ...options } = {}) {
  const clock = fakeClock();
  const reads = [];
  const warned = [];
  const store = {
    async getWaitingPage(level, { eventual } = {}) {
      const key = typeof level === 'string' ? level : level.workloadId;
      reads.push(['page', key, eventual]);
      if (store.broken) throw new Error('ProvisionedThroughputExceeded');
      return pages[key] ? { page: structuredClone(pages[key]), by: 'ana', at: 1 } : null;
    },
    async getFavicon(id, { eventual } = {}) {
      reads.push(['favicon', id, eventual]);
      if (store.broken) throw new Error('ProvisionedThroughputExceeded');
      return favicons[id] ? structuredClone(favicons[id]) : null;
    },
  };
  const log = { info() {}, warn: (event, fields) => warned.push([event, fields]), error() {} };
  // The organization's level is read from S3 (lib/organization-page.mjs): a reader of its own, not the store.
  const organization = {
    async read() {
      reads.push(['page', 'organization', undefined]);
      if (store.broken || organization.broken) throw new Error('ProvisionedThroughputExceeded');
      return pages.organization ? structuredClone(pages.organization) : null;
    },
  };
  const waiting = createWaitingPages({ store, organizationPage: organization, now: clock.now, log, ...options });
  return { waiting, store, organization, clock, reads, warned, pages, favicons };
}

test('merges the three levels by field and shows the cached favicon for icon auto', async () => {
  const s = setup({
    pages: { organization: { mode: 'template', title: 'Org', description: 'From the org.' }, router: { mode: 'template', title: 'Router' }, shop: { mode: 'template', description: 'Shop only.' } },
    favicons: { shop: { icon: PNG, fetchedAt: 1, error: null } },
  });
  assert.deepEqual(await s.waiting.pageOf('shop'), { page: { mode: 'template', title: 'Router', description: 'Shop only.' }, icon: PNG });
});

test('the icon: an upload is shown as it is, none shows none, and the favicon item is read only for auto', async () => {
  const s = setup({ pages: { organization: { mode: 'template', icon: 'none' }, a: { mode: 'template', icon: UPLOAD } }, favicons: { a: { icon: PNG }, b: { icon: PNG } } });
  assert.equal((await s.waiting.pageOf('a')).icon, UPLOAD);
  assert.equal((await s.waiting.pageOf('b')).icon, null);
  assert.deepEqual(s.reads.filter(([kind]) => kind === 'favicon'), [], 'no favicon item read for an upload or none');
  const auto = setup({ favicons: { b: { icon: PNG }, c: { icon: null, error: 'no host name' }, d: { icon: 42 } } });
  assert.equal((await auto.waiting.pageOf('b')).icon, PNG);
  assert.equal((await auto.waiting.pageOf('c')).icon, null);
  assert.equal((await auto.waiting.pageOf('d')).icon, null);
  assert.equal((await auto.waiting.pageOf('none-yet')).icon, null);
});

test('a custom page decides, whole; nothing set is the built-in template', async () => {
  const html = '<!doctype html><p data-dormeto="status"></p>';
  const s = setup({ pages: { router: { mode: 'custom', html }, other: { mode: 'template', title: 'T' } }, favicons: { x: { icon: PNG } } });
  assert.deepEqual(await s.waiting.pageOf('x'), { page: { mode: 'custom', html }, icon: null });
  const bare = setup();
  assert.deepEqual(await bare.waiting.pageOf('x'), { page: { mode: 'template' }, icon: null });
});

test('what is read is cached for 60 seconds, then read again; reads are eventually consistent', async () => {
  const s = setup({ pages: { router: { mode: 'template', title: 'One' } } });
  await s.waiting.pageOf('shop');
  assert.deepEqual(s.reads.map(([kind, key]) => `${kind}:${key}`).sort(), ['favicon:shop', 'page:organization', 'page:router', 'page:shop']);
  assert.ok(s.reads.filter(([, key]) => key !== 'organization').every(([, , eventual]) => eventual === true));
  s.clock.advance(59_000);
  await s.waiting.pageOf('shop');
  assert.equal(s.reads.length, 4);
  s.pages.router = { mode: 'template', title: 'Two' };
  s.clock.advance(1000);
  assert.equal((await s.waiting.pageOf('shop')).page.title, 'Two');
  assert.equal(s.reads.length, 8);
});

test('concurrent requests share one read', async () => {
  const s = setup();
  await Promise.all(Array.from({ length: 30 }, () => s.waiting.pageOf('shop')));
  assert.equal(s.reads.length, 4);
});

test('a read that fails keeps the last value for 60 seconds, logs WaitingPageUnread, and answers the built-in page when there is none', async () => {
  const s = setup({ pages: { router: { mode: 'template', title: 'Kept' } } });
  s.store.broken = true;
  assert.deepEqual(await s.waiting.pageOf('shop'), { page: { mode: 'template' }, icon: null });
  assert.ok(s.warned.length >= 1 && s.warned.every(([event]) => event === 'WaitingPageUnread'));
  assert.match(s.warned[0][1].error, /ProvisionedThroughputExceeded/);
  const reads = s.reads.length;
  await s.waiting.pageOf('shop');
  assert.equal(s.reads.length, reads, 'not read again for 60 seconds');

  s.store.broken = false;
  s.clock.advance(60_000);
  assert.equal((await s.waiting.pageOf('shop')).page.title, 'Kept');
  s.store.broken = true;
  s.clock.advance(60_000);
  const warned = s.warned.length;
  assert.equal((await s.waiting.pageOf('shop')).page.title, 'Kept', 'the last value');
  assert.ok(s.warned.length > warned);
  const again = s.warned.length;
  await s.waiting.pageOf('shop');
  assert.equal(s.warned.length, again, 'logged once per failed attempt');
});

test('never throws, whatever the store does', async () => {
  const hostile = createWaitingPages({ store: { getWaitingPage() { throw new Error('sync'); }, getFavicon: () => { throw new Error('sync'); } }, now: Date.now, log: { warn() {} } });
  assert.deepEqual(await hostile.pageOf('shop'), { page: { mode: 'template' }, icon: null });
  const odd = createWaitingPages({ store: { getWaitingPage: async () => ({ page: 'text' }), getFavicon: async () => 7 }, now: Date.now, log: { warn() {} } });
  assert.deepEqual(await odd.pageOf('shop'), { page: { mode: 'template' }, icon: null });
});

test('keeps at most maxEntries workloads, the oldest out first; the router\'s and the organization\'s stay', async () => {
  const s = setup({ maxEntries: 3 });
  for (const id of ['a', 'b', 'c', 'd']) await s.waiting.pageOf(id);
  s.reads.length = 0;
  await s.waiting.pageOf('d');
  await s.waiting.pageOf('c');
  await s.waiting.pageOf('b');
  assert.deepEqual(s.reads, [], 'b, c and d are kept');
  await s.waiting.pageOf('a');
  assert.deepEqual(s.reads.map(([kind, key]) => `${kind}:${key}`), ['page:a', 'favicon:a'], 'a was evicted; the upper levels were not read again');
  s.reads.length = 0;
  await s.waiting.pageOf('b');
  assert.ok(s.reads.some(([, key]) => key === 'b'), 'b went out when a came back');
});

test('without a workload (WorkloadNotConfigured) only the two upper levels are read', async () => {
  const s = setup({ pages: { organization: { mode: 'template', title: 'Org' } }, favicons: { x: { icon: PNG } } });
  assert.deepEqual(await s.waiting.pageOf(null), { page: { mode: 'template', title: 'Org' }, icon: null });
  assert.deepEqual(s.reads.map(([kind, key]) => `${kind}:${key}`).sort(), ['page:organization', 'page:router']);
});

// --- Fix round 1 --------------------------------------------------------------------------------------------------------

test('a store that never answers holds the page for readMs at most, then the last value or none; the read fills the cache when it comes', async () => {
  let release;
  const s = setup({ pages: { router: { mode: 'template', title: 'Late' } }, readMs: 40 });
  const getPage = s.store.getWaitingPage;
  s.store.getWaitingPage = (...args) => new Promise((resolve) => { release = () => resolve(getPage(...args)); });
  const started = Date.now();
  assert.deepEqual(await s.waiting.pageOf('shop'), { page: { mode: 'template' }, icon: null });
  assert.ok(Date.now() - started < 500, `${Date.now() - started} ms`);
  assert.ok(s.warned.some(([event, fields]) => event === 'WaitingPageUnread' && /no answer/.test(fields.error)));
  // Not asked again for the same time: no new wait.
  const again = Date.now();
  await s.waiting.pageOf('shop');
  assert.ok(Date.now() - again < 30);
});

test('a read that stays pending for ever is replaced by a new one after a while', async () => {
  const s = setup({ readMs: 20 });
  let calls = 0;
  s.store.getWaitingPage = () => { calls += 1; return new Promise(() => {}); };
  await s.waiting.pageOf('shop');
  const first = calls;
  s.clock.advance(61_000);
  await s.waiting.pageOf('shop');
  assert.ok(calls > first, 'asked again');
});

test('the default keeps 200 workloads', async () => {
  const s = setup();
  for (let i = 0; i < 201; i += 1) await s.waiting.pageOf(`w${i}`);
  s.reads.length = 0;
  await s.waiting.pageOf('w1');
  assert.deepEqual(s.reads, [], 'w1 is kept');
  await s.waiting.pageOf('w0');
  assert.ok(s.reads.length > 0, 'w0 went out');
});
