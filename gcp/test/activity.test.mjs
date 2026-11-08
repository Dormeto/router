import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityOf, eventOfRequest } from '../src/activity.mjs';
import { clientIp } from '../../lambda/src/lib/http.mjs';

const BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const BOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const request = (path, { method = 'GET', userAgent = BROWSER, remoteIp = '203.0.113.7' } = {}) => ({
  method, url: `https://demo.example.com${path}`, path, userAgent, remoteIp,
});
// A list as the waker's cache holds it (lambda/src/lib/list-cache.mjs).
const listOf = (name, action, ips) => ({ name, action, has: (ip) => ips.includes(ip) });
const LISTS = [listOf('scanners', 'ignore', ['198.51.100.4'])];

test('a scanner path with a browser\'s user agent is no activity', () => {
  assert.equal(activityOf([request('/.env')], { lists: [], rules: [] }), 0);
});

test('a bot\'s user agent on the home page is no activity', () => {
  assert.equal(activityOf([request('/', { userAgent: BOT })], { lists: [], rules: [] }), 0);
});

test('a HEAD is no activity', () => {
  assert.equal(activityOf([request('/', { method: 'HEAD' })], { lists: [], rules: [] }), 0);
});

test('an address of a list the waker ignores is no activity', () => {
  assert.equal(activityOf([request('/', { remoteIp: '198.51.100.4' })], { lists: LISTS, rules: [] }), 0);
});

test('one browser\'s GET of the home page is activity', () => {
  assert.equal(activityOf([request('/')], { lists: LISTS, rules: [] }), 1);
});

test('the requests left are counted, each', () => {
  const requests = [
    request('/.env'), request('/wp-login.php'), request('/', { userAgent: BOT }), request('/', { method: 'HEAD' }),
    request('/', { remoteIp: '198.51.100.4' }), request('/shop'), request('/shop/cart', { method: 'POST' }),
  ];
  assert.equal(activityOf(requests, { lists: LISTS, rules: [] }), 2);
  assert.equal(activityOf([], { lists: LISTS, rules: [] }), 0);
});

// A deferred source is browser mode for it: its visitor's browser wakes the workload through the page's probe.
test('an address of a list the waker defers is activity: the waker does not ignore it', () => {
  assert.equal(activityOf([request('/', { remoteIp: '198.51.100.4' })], { lists: [listOf('vpn', 'defer', ['198.51.100.4'])], rules: [] }), 1);
});

test('a no-wake rule\'s request is no activity (G5 passes the workload\'s)', () => {
  const rules = [{ name: 'health', matches: (event) => event.path === '/healthz' }];
  assert.equal(activityOf([request('/healthz'), request('/')], { lists: [], rules }), 1);
});

test('the event is the waker\'s: the method, the path, the user agent, and the logged address as the client\'s', () => {
  const event = eventOfRequest(request('/shop', { remoteIp: '198.51.100.4' }));
  assert.equal(event.httpMethod, 'GET');
  assert.equal(event.path, '/shop');
  assert.equal(event.headers['user-agent'], BROWSER);
  assert.equal(clientIp(event), '198.51.100.4');
  const bare = eventOfRequest({ method: 'GET', url: 'https://demo.example.com/', path: '/' });
  assert.equal(clientIp(bare), '');
  assert.equal(bare.headers['user-agent'], undefined);
});
