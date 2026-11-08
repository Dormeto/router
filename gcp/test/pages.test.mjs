import { test } from 'node:test';
import assert from 'node:assert/strict';
import { customPagesOf, faviconReachable, notServed, servedPage, servedStore } from '../src/pages.mjs';

const CUSTOM = { mode: 'custom', html: '<p>x</p>' };
const TEMPLATE = { mode: 'template', title: 'Acme' };

test('the switch is DMT_CUSTOM_PAGES=1 alone', () => {
  assert.equal(customPagesOf({ DMT_CUSTOM_PAGES: '1' }), true);
  for (const value of [undefined, '', '0', 'true', 'yes']) assert.equal(customPagesOf({ DMT_CUSTOM_PAGES: value }), false, String(value));
});

test('off, a custom page is none to visitors and its level says it is not served; a template is as it is; on, both are', () => {
  assert.equal(servedPage(false)(CUSTOM), null);
  assert.deepEqual(servedPage(false)(TEMPLATE), TEMPLATE);
  assert.deepEqual(servedPage(true)(CUSTOM), CUSTOM);
  assert.equal(servedPage(false)(undefined), null);
  assert.deepEqual([notServed(false, CUSTOM), notServed(false, TEMPLATE), notServed(true, CUSTOM), notServed(false, null)], [true, false, false, false]);
});

test('the store as the waiting page reads it: a custom page off is page null, by and at kept; the favicon as stored', async () => {
  const store = {
    getWaitingPage: async (level, options) => (level === 'router' ? { page: CUSTOM, by: 'adm', at: 1, options } : null),
    getFavicon: async (id, options) => ({ icon: null, id, options }),
  };
  assert.deepEqual(await servedStore(store, false).getWaitingPage('router', { eventual: true }), { page: null, by: 'adm', at: 1, options: { eventual: true } });
  assert.equal(await servedStore(store, false).getWaitingPage({ workloadId: 'demo' }), null);
  assert.deepEqual((await servedStore(store, true).getWaitingPage('router')).page, CUSTOM);
  assert.deepEqual(await servedStore(store, false).getFavicon('demo', { eventual: true }), { icon: null, id: 'demo', options: { eventual: true } });
});

test('the favicon is read behind the load balancers visitors reach from the internet; an internal one, or a kind not known, gets none', () => {
  for (const lb of [undefined, { kind: 'global' }, { kind: 'regional', region: 'europe-west1' }, { kind: 'classic' }]) assert.equal(faviconReachable(lb), true, JSON.stringify(lb));
  for (const kind of ['internal', 'cross-region-internal', 'other']) assert.equal(faviconReachable({ kind }), false, kind);
});
