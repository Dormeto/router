import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { kubeProxyName } from '../src/lib/kube-proxy-name.mjs';

const cases = JSON.parse(readFileSync(new URL('./fixtures/kube-proxy-names.json', import.meta.url), 'utf8'));

// The patterns of the services that carry these names: Lambda functions, IAM roles, EC2 security groups (255, kept at 64).
const LAMBDA = /^[a-zA-Z0-9-_]{1,64}$/;
const IAM_ROLE = /^[\w+=,.@-]{1,64}$/;
const SECURITY_GROUP = /^[\w\s.:/()#,@[\]+=&;{}!$*-]{1,64}$/;

test('every case of the fixture gives its name', () => {
  assert.ok(cases.length >= 10);
  for (const { prefix, cluster, name } of cases) assert.equal(kubeProxyName(prefix, cluster), name, `${prefix}${cluster}`);
});

test('every name is at most 64 characters and valid for a function, a role and a security group', () => {
  for (const { prefix, cluster } of cases) {
    const name = kubeProxyName(prefix, cluster);
    assert.ok(name.length <= 64, name);
    assert.match(name, LAMBDA);
    assert.match(name, IAM_ROLE);
    assert.match(name, SECURITY_GROUP);
  }
});

test('a name that fits is kept, the longest that fits as well', () => {
  assert.equal(kubeProxyName('dmtr-dev-kube-', 'prod'), 'dmtr-dev-kube-prod');
  const fits = 'e'.repeat(64 - 'dmtr-dev-kube-'.length);
  assert.equal(kubeProxyName('dmtr-dev-kube-', fits).length, 64);
  assert.equal(kubeProxyName('dmtr-dev-kube-', fits), `dmtr-dev-kube-${fits}`);
});

test('a name that does not fit is cut to 64 characters ending with a hyphen and 8 hexadecimal characters', () => {
  const name = kubeProxyName('dmtr-dev-kube-', 'a'.repeat(100));
  assert.equal(name.length, 64);
  assert.match(name, /^dmtr-dev-kube-a+-[0-9a-f]{8}$/);
});

test('two long names sharing their first 50 characters give different names', () => {
  const head = 'x'.repeat(50);
  assert.notEqual(kubeProxyName('dmtr-dev-kube-', `${head}-one`.padEnd(90, 'y')), kubeProxyName('dmtr-dev-kube-', `${head}-two`.padEnd(90, 'y')));
});

test('a role prefix with the region leaves less room for the cluster, still 64 characters', () => {
  const name = kubeProxyName('dmtr-dev-eu-west-1-kube-', 'a'.repeat(100));
  assert.equal(name.length, 64);
  assert.ok(name.startsWith('dmtr-dev-eu-west-1-kube-'));
});
