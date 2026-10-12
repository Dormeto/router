import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileRules, describeRules, parseRules } from '../src/lib/no-wake.mjs';
import { classify, clientIp } from '../src/lib/http.mjs';
import { albEvent } from './fakes.mjs';

const fromIp = (ip, extra = {}) => albEvent({ headers: { 'x-forwarded-for': ip, ...extra } });
const match = (rule, event) => compileRules([rule]).some((r) => r.matches(event));

test('clientIp is the last X-Forwarded-For entry (appended by the ALB, not forgeable)', () => {
  assert.equal(clientIp(fromIp('203.0.113.9, 198.51.100.7')), '198.51.100.7');
  assert.equal(clientIp(fromIp('2001:db8::1')), '2001:db8::1');
  assert.equal(clientIp(albEvent()), '');
});

test('sourceIps match addresses and IPv4/IPv6 CIDR ranges', () => {
  const rule = { name: 'office', sourceIps: ['198.51.100.0/24', '203.0.113.7', '2001:db8::/32'] };
  assert.ok(match(rule, fromIp('198.51.100.42')));
  assert.ok(match(rule, fromIp('203.0.113.7')));
  assert.ok(match(rule, fromIp('2001:db8:1::5')));
  assert.ok(!match(rule, fromIp('203.0.113.8')));
  assert.ok(!match(rule, fromIp('198.51.100.42, 192.0.2.1')), 'a forged first entry does not count');
  assert.ok(!match(rule, albEvent()));
});

test('paths match by prefix (case-sensitive) or regular expression', () => {
  assert.ok(match({ name: 'p', pathPrefixes: ['/health', '/status'] }, albEvent({ path: '/healthz' })));
  assert.ok(!match({ name: 'p', pathPrefixes: ['/health'] }, albEvent({ path: '/Health' })));
  assert.ok(match({ name: 'r', pathPattern: '^/api/v[0-9]+/ping$' }, albEvent({ path: '/api/v2/ping' })));
  assert.ok(!match({ name: 'r', pathPattern: '^/api/v[0-9]+/ping$' }, albEvent({ path: '/api/v2/ping/x' })));
});

test('userAgentPattern is case-insensitive', () => {
  const rule = { name: 'monitor', userAgentPattern: '^dormeto-uptime/' };
  assert.ok(match(rule, albEvent({ headers: { 'user-agent': 'Dormeto-Uptime/1.0' } })));
  assert.ok(!match(rule, albEvent({ headers: { 'user-agent': 'curl/8.4 dormeto-uptime/1.0' } })));
});

test('headers match by exact value or pattern, names case-insensitive, all listed headers required', () => {
  const rule = { name: 'h', headers: [{ name: 'X-Monitor', value: 'yes' }, { name: 'x-region', pattern: '^eu-' }] };
  assert.ok(match(rule, albEvent({ headers: { 'x-monitor': 'yes', 'X-Region': 'eu-west-1' } })));
  assert.ok(!match(rule, albEvent({ headers: { 'x-monitor': 'yes' } })));
  assert.ok(!match(rule, albEvent({ headers: { 'x-monitor': 'YES', 'x-region': 'eu-west-1' } })));
});

test('a rule matches only when all its conditions match', () => {
  const rule = { name: 'all', sourceIps: ['198.51.100.0/24'], pathPrefixes: ['/health'] };
  assert.ok(match(rule, albEvent({ path: '/health', headers: { 'x-forwarded-for': '198.51.100.1' } })));
  assert.ok(!match(rule, albEvent({ path: '/', headers: { 'x-forwarded-for': '198.51.100.1' } })));
  assert.ok(!match(rule, albEvent({ path: '/health', headers: { 'x-forwarded-for': '192.0.2.1' } })));
});

test('invalid rules are skipped and reported; null and empty conditions are absent', () => {
  const reported = [];
  const rules = compileRules([
    { name: 'empty', sourceIps: [], pathPattern: null, headers: [] },
    { name: 'bad-cidr', sourceIps: ['300.1.1.1/8'] },
    { name: 'bad-regex', userAgentPattern: '(' },
    { name: 'bad-header', headers: [{ name: 'x-a' }] },
    { name: 'ok', pathPrefixes: ['/health'], pathPattern: null, sourceIps: [] },
  ], { level: 'workload', onInvalid: (rule, reason) => reported.push([rule.name, reason]) });
  assert.deepEqual(rules.map((r) => r.name), ['ok']);
  assert.deepEqual(reported.map(([name]) => name), ['empty', 'bad-cidr', 'bad-regex', 'bad-header']);
  assert.match(reported[0][1], /no condition/);
  assert.ok(rules[0].matches(albEvent({ path: '/health' })));
});

test('classify: rules first (probes included), then the built-ins, with a reason', () => {
  const rules = compileRules([{ name: 'e2e', headers: [{ name: 'x-dormeto-e2e', value: 'no-wake' }] }]);
  const tagged = { 'x-dormeto-e2e': 'no-wake' };
  assert.deepEqual(classify(albEvent({ headers: tagged }), rules), { kind: 'no-wake', reason: 'rule e2e' });
  assert.deepEqual(classify(albEvent({ headers: { ...tagged, 'x-dormeto-probe': '1' } }), rules), { kind: 'no-wake', reason: 'rule e2e' });
  assert.deepEqual(classify(albEvent({ headers: { 'x-dormeto-probe': '1' } }), rules), { kind: 'probe' });
  assert.deepEqual(classify(albEvent({ method: 'HEAD' })), { kind: 'no-wake', reason: 'HEAD' });
  assert.deepEqual(classify(albEvent({ headers: { 'user-agent': 'Googlebot/2.1' } })), { kind: 'no-wake', reason: 'bot user agent' });
  assert.deepEqual(classify(albEvent({ path: '/.env' })), { kind: 'no-wake', reason: 'scanner path' });
  assert.deepEqual(classify(albEvent(), rules), { kind: 'normal' });
});

test('describeRules lists the configured rules with their level and invalid reason', () => {
  const described = describeRules([
    { level: 'router', rules: [{ name: 'e2e', headers: [{ name: 'x-dormeto-e2e', value: 'no-wake', pattern: null }], sourceIps: [], pathPattern: null }] },
    { level: 'workload', rules: [{ name: 'bad', userAgentPattern: '(' }] },
  ]);
  assert.deepEqual(described[0], { name: 'e2e', level: 'router', conditions: { headers: [{ name: 'x-dormeto-e2e', value: 'no-wake' }] } });
  assert.equal(described[1].level, 'workload');
  assert.match(described[1].invalid, /userAgentPattern/);
});

test('parseRules reads the router defaults from JSON and ignores unreadable values', () => {
  const errors = [];
  assert.deepEqual(parseRules('[{"name":"e2e","pathPrefixes":["/x"]}]'), [{ name: 'e2e', pathPrefixes: ['/x'] }]);
  assert.deepEqual(parseRules(undefined), []);
  assert.deepEqual(parseRules('{oops', (e) => errors.push(e)), []);
  assert.deepEqual(parseRules('{"name":"x"}', (e) => errors.push(e)), []);
  assert.equal(errors.length, 2);
});
