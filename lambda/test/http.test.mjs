import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptsHtml, classify, header, redirectCount, requestTarget, response, workloadIdFromEvent } from '../src/lib/http.mjs';

const event = (over = {}) => ({
  requestContext: { elb: { targetGroupArn: 'arn:aws:elasticloadbalancing:eu-west-1:111122223333:targetgroup/dmt-dev-demo/abc' } },
  httpMethod: 'GET',
  path: '/',
  multiValueQueryStringParameters: {},
  multiValueHeaders: { accept: ['text/html'], 'user-agent': ['Mozilla/5.0'] },
  ...over,
});

test('workloadIdFromEvent strips the prefix from the target group name', () => {
  assert.equal(workloadIdFromEvent(event(), 'dmt-dev-'), 'demo');
  assert.throws(() => workloadIdFromEvent(event(), 'dmt-prd-'), /unexpected target group/);
  assert.throws(() => workloadIdFromEvent(event({ requestContext: {} }), 'dmt-dev-'), /unexpected target group/);
});

test('header lookups are case-insensitive and support single-value events', () => {
  assert.equal(header(event({ multiValueHeaders: { Accept: ['a', 'b'] } }), 'accept'), 'a');
  assert.equal(header({ headers: { 'User-Agent': 'x' } }, 'user-agent'), 'x');
  assert.equal(header(event(), 'missing'), undefined);
});

test('classify detects probes, HEAD, bots and normal requests', () => {
  assert.equal(classify(event()), 'normal');
  assert.equal(classify(event({ multiValueHeaders: { 'x-dormeto-probe': ['1'] } })), 'probe');
  assert.equal(classify(event({ httpMethod: 'HEAD' })), 'no-wake');
  assert.equal(classify(event({ multiValueHeaders: { 'user-agent': ['Googlebot/2.1'] } })), 'no-wake');
  assert.equal(classify(event({ multiValueHeaders: { 'user-agent': ['ELB-HealthChecker/2.0'] } })), 'no-wake');
  assert.equal(classify(event({ multiValueHeaders: { 'user-agent': ['UptimeRobot/2.0'] } })), 'no-wake');
});

test('requestTarget rebuilds path and repeated query parameters', () => {
  assert.equal(requestTarget(event({ path: '/a/b' })), '/a/b');
  assert.equal(requestTarget(event({ path: '/s', multiValueQueryStringParameters: { q: ['x%20y'], tag: ['1', '2'], flag: [''] } })),
    '/s?q=x%20y&tag=1&tag=2&flag');
  assert.equal(requestTarget({ path: '/s', queryStringParameters: { q: 'v' } }), '/s?q=v');
  assert.equal(requestTarget({}), '/');
});

test('requestTarget never produces a protocol-relative redirect', () => {
  assert.equal(requestTarget(event({ path: '//evil.example/x' })), '/evil.example/x');
  assert.equal(requestTarget(event({ path: '/\\evil.example' })), '/evil.example');
});

test('redirectCount reads the dmt_r cookie', () => {
  assert.equal(redirectCount(event()), 0);
  assert.equal(redirectCount(event({ multiValueHeaders: { cookie: ['a=1; dmt_r=2'] } })), 2);
  assert.equal(redirectCount(event({ multiValueHeaders: { cookie: ['a=1', 'dmt_r=1'] } })), 1);
  assert.equal(redirectCount(event({ multiValueHeaders: { cookie: ['dmt_r=abc'] } })), 0);
});

test('acceptsHtml checks the Accept header', () => {
  assert.equal(acceptsHtml(event()), true);
  assert.equal(acceptsHtml(event({ multiValueHeaders: { accept: ['application/json'] } })), false);
});

test('response uses multi-value headers', () => {
  assert.deepEqual(response(503, { 'retry-after': '3' }, 'x'), {
    statusCode: 503, statusDescription: '503 Service Unavailable', isBase64Encoded: false,
    multiValueHeaders: { 'retry-after': ['3'] }, body: 'x',
  });
});
