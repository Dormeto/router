// The router's own Signature Version 4 (sigv4.mjs), which signs its PutEvents to the manager's bus with the session the manager gives
// (vision docs/specs/2026-11-15-router-credentials-design.md, §5). Against AWS's published examples (the Signature Version 4 test suite
// and the IAM guide's request), and against the SDK's signer when the repository has it installed (it has no runtime dependency).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalRequest, signedHeaders } from '../src/sigv4.mjs';

// AWS's example keys (the test suite's and the IAM guide's), at 2015-08-30T12:36:00Z.
const EXAMPLE = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };
const AT = Date.parse('2015-08-30T12:36:00Z');

test('the test suite\'s get-vanilla: GET / on example.amazonaws.com, service "service" in us-east-1', () => {
  const headers = signedHeaders({ method: 'GET', url: 'https://example.amazonaws.com/', credentials: EXAMPLE, region: 'us-east-1', service: 'service', now: AT });
  assert.equal(headers['x-amz-date'], '20150830T123600Z');
  assert.equal(headers.authorization,
    'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
});

test('the test suite\'s post-vanilla: POST / with no body', () => {
  const headers = signedHeaders({ method: 'POST', url: 'https://example.amazonaws.com/', credentials: EXAMPLE, region: 'us-east-1', service: 'service', now: AT });
  assert.equal(headers.authorization,
    'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b');
});

test('the test suite\'s get-vanilla-with-session-token: X-Amz-Security-Token signed', () => {
  const sessionToken = '6e86291e8372ff2a2260956d9b8aae1d763fbf315fa00fa31553b73ebf194267';
  const headers = signedHeaders({ method: 'GET', url: 'https://example.amazonaws.com/', credentials: { ...EXAMPLE, sessionToken }, region: 'us-east-1', service: 'service', now: AT });
  assert.equal(headers['x-amz-security-token'], sessionToken);
  assert.equal(headers.authorization,
    'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date;x-amz-security-token, Signature=07ec1639c89043aa0e3e2de82b96708f198cceab042d4a97044c66dd9f74e7f8');
});

test('the test suite\'s post-x-www-form-urlencoded: a body and its content type signed', () => {
  const headers = signedHeaders({
    method: 'POST', url: 'https://example.amazonaws.com/', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'Param1=value1',
    credentials: EXAMPLE, region: 'us-east-1', service: 'service', now: AT,
  });
  assert.equal(headers.authorization,
    'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=ff11897932ad3f4e8b18135d722051e5ac45fc38421b1da7b9d196a0fe09473a');
});

test('the IAM guide\'s ListUsers: a query string and a content type signed', () => {
  const headers = signedHeaders({
    method: 'GET', url: 'https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08', headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
    credentials: EXAMPLE, region: 'us-east-1', service: 'iam', now: AT,
  });
  assert.equal(headers.authorization,
    'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7');
  assert.equal(headers['content-type'], 'application/x-www-form-urlencoded; charset=utf-8', 'the headers given are sent, named in lower case');
});

test('a session: X-Amz-Security-Token sent and signed; the body\'s hash in the canonical request; no host header returned (fetch sets it)', () => {
  const body = JSON.stringify({ Entries: [] });
  const credentials = { ...EXAMPLE, sessionToken: 'session-token' };
  const input = {
    method: 'POST', url: 'https://events.eu-west-1.amazonaws.com/', headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'AWSEvents.PutEvents' },
    body, credentials, region: 'eu-west-1', service: 'events', now: AT,
  };
  const headers = signedHeaders(input);
  assert.equal(headers['x-amz-security-token'], 'session-token');
  assert.equal(headers.host, undefined);
  assert.match(headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20150830\/eu-west-1\/events\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-amz-target, Signature=[0-9a-f]{64}$/);
  const canonical = canonicalRequest(input, '20150830T123600Z');
  assert.deepEqual(canonical.split('\n'), [
    'POST', '/', '',
    'content-type:application/x-amz-json-1.1', 'host:events.eu-west-1.amazonaws.com', 'x-amz-date:20150830T123600Z', 'x-amz-security-token:session-token', 'x-amz-target:AWSEvents.PutEvents',
    '', 'content-type;host;x-amz-date;x-amz-security-token;x-amz-target', createHash('sha256').update(body).digest('hex'),
  ]);
  const other = signedHeaders({ ...input, body: JSON.stringify({ Entries: [{}] }) });
  assert.notEqual(other.authorization, headers.authorization, 'another body, another signature');
  const unsigned = signedHeaders({ ...input, credentials: EXAMPLE });
  assert.equal(unsigned['x-amz-security-token'], undefined);
});

test('the same signature as the SDK\'s signer, when the repository has it installed', async (t) => {
  let SignatureV4;
  let Sha256;
  try {
    ({ SignatureV4 } = await import('@smithy/signature-v4'));
    ({ Sha256 } = await import('@aws-crypto/sha256-js'));
  } catch {
    t.skip('@smithy/signature-v4 is not installed in this repository');
    return;
  }
  const body = JSON.stringify({ Entries: [{ Source: 'dormeto.router.gcp/p/europe-west1' }] });
  const credentials = { ...EXAMPLE, sessionToken: 'session-token' };
  const sdk = new SignatureV4({ credentials, region: 'eu-west-1', service: 'events', sha256: Sha256, applyChecksum: false });
  const signed = await sdk.sign({
    method: 'POST', protocol: 'https:', hostname: 'events.eu-west-1.amazonaws.com', path: '/', body,
    headers: { host: 'events.eu-west-1.amazonaws.com', 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'AWSEvents.PutEvents' },
  }, { signingDate: new Date(AT) });
  const ours = signedHeaders({
    method: 'POST', url: 'https://events.eu-west-1.amazonaws.com/', headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'AWSEvents.PutEvents' },
    body, credentials, region: 'eu-west-1', service: 'events', now: AT,
  });
  assert.equal(ours.authorization.split('Signature=')[1], signed.headers.authorization.split('Signature=')[1]);
});
