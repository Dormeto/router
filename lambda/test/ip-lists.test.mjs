import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeParts, dropReserved, encodeParts, parseList, rangeSet } from '../src/lib/ip-lists.mjs';

test('parseList reads the first column of text lists, with comments and separators', () => {
  const text = [
    '# ipsum-like list',
    '45.130.203.183\t3',
    '142.93.0.0/16 ; DigitalOcean',
    '8.229.112.0/20,US,US-CA,,',
    '; Spamhaus comment',
    'not-an-address 2',
    '2a03:b0c0::/32',
    '',
  ].join('\n');
  assert.deepEqual(parseList(text), { entries: ['45.130.203.183/32', '142.93.0.0/16', '8.229.112.0/20', '2a03:b0c0::/32'], invalid: 1 });
});

test('parseList reads every address or range string of a JSON document (AWS, Google Cloud)', () => {
  const aws = JSON.stringify({
    syncToken: '1791100000', createDate: '2026-10-04-08-00-00',
    prefixes: [{ ip_prefix: '54.94.0.0/16', region: 'sa-east-1', service: 'AMAZON' }],
    ipv6_prefixes: [{ ipv6_prefix: '2600:1f1e::/36', service: 'AMAZON' }],
  });
  assert.deepEqual(parseList(aws).entries, ['54.94.0.0/16', '2600:1f1e::/36']);
  const gcp = JSON.stringify({ prefixes: [{ ipv4Prefix: '34.182.0.0/16' }, { ipv6Prefix: '2600:1900::/35' }] });
  assert.deepEqual(parseList(gcp).entries, ['34.182.0.0/16', '2600:1900::/35']);
});

test('parseList normalizes host bits and rejects invalid prefixes', () => {
  assert.deepEqual(parseList('142.93.12.34/16\n1.2.3.4/33\n2a03:b0c0::1/129').entries, ['142.93.0.0/16']);
});

test('dropReserved removes entries overlapping private, loopback, link-local, CGNAT, multicast or reserved ranges', () => {
  const { kept, dropped } = dropReserved(['10.0.0.0/8', '0.0.0.0/0', '172.20.1.0/24', '100.64.0.0/10', '127.0.0.1/32',
    '169.254.0.0/16', '192.168.0.0/16', '224.0.0.0/4', '240.0.0.0/4', '45.130.203.183/32', '8.0.0.0/7', 'fc00::/7',
    'fe80::/10', '::1/128', '::ffff:0:0/96', '2a03:b0c0::/32']);
  assert.deepEqual(kept, ['45.130.203.183/32', '8.0.0.0/7', '2a03:b0c0::/32']);
  assert.equal(dropped, 13);
  assert.deepEqual(dropReserved(['8.0.0.0/4']).kept, [], 'a range covering 10.0.0.0/8 is dropped');
});

test('rangeSet finds IPv4 and IPv6 addresses in merged ranges', () => {
  const set = rangeSet(['142.93.0.0/16', '142.94.0.0/16', '45.130.203.183/32', '2a03:b0c0::/32', '142.93.5.0/24']);
  assert.equal(set.size, 3, 'adjacent and nested ranges are merged');
  for (const ip of ['142.93.0.66', '142.94.255.255', '45.130.203.183', '2a03:b0c0:3:d0::1']) assert.ok(set.has(ip), ip);
  for (const ip of ['142.92.255.255', '142.95.0.0', '45.130.203.184', '2a03:b0c1::1', 'garbage', '']) assert.ok(!set.has(ip), ip);
});

test('rangeSet handles an empty list and IPv4-only or IPv6-only lists', () => {
  assert.equal(rangeSet([]).has('45.130.203.183'), false);
  assert.equal(rangeSet(['2a03:b0c0::/32']).has('45.130.203.183'), false);
  assert.equal(rangeSet(['45.130.203.0/24']).has('2a03:b0c0::1'), false);
});

test('encodeParts and decodeParts round-trip a large list in chunks', () => {
  const entries = Array.from({ length: 50_000 }, (_, i) => `${45 + (i >> 16)}.${(i >> 8) & 255}.${i & 255}.${(i * 7) & 255}/32`);
  const parts = encodeParts(entries, 20_000);
  assert.ok(parts.length > 1, 'split into several parts');
  assert.ok(parts.every((p) => p.length <= 20_000));
  assert.deepEqual(decodeParts(parts), entries);
});
