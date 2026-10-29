// terraform/gcp-dev changes nothing in IAM and turns on no API (vision docs/plans/2026-10-29-google-cloud.md, global
// constraints): every IAM change and every API in the dev project go through `dormeto gcp install` or `uninstall`. So
// no IAM resource of the Google provider, no service account, no API, and VMs and templates without a service account
// (a VM's service account is an IAM grant: its users act as it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = new URL('../../terraform/gcp-dev/', import.meta.url).pathname;

// Every `resource` or `data` type that changes or names IAM, a service account or a project's APIs.
const FORBIDDEN_TYPE = /^google_(?:[a-z0-9_]*_)?iam_|^google_service_account|^google_project_service/;

// HCL comments out: a comment may name what the code must not hold.
const uncommented = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?:#|\/\/).*$/gm, '');

function violations(text) {
  const code = uncommented(text);
  const found = [];
  for (const [, kind, type] of code.matchAll(/^\s*(resource|data)\s+"([^"]+)"/gm)) {
    if (FORBIDDEN_TYPE.test(type)) found.push(`${kind} ${type}`);
  }
  for (const [block] of code.matchAll(/^\s*service_account\s*(?:\{|=)/gm)) found.push(block.trim());
  return found;
}

async function terraformFiles() {
  const names = (await readdir(ROOT)).filter((name) => name.endsWith('.tf')).sort();
  return Promise.all(names.map(async (name) => [name, await readFile(join(ROOT, name), 'utf8')]));
}

test('the guard finds IAM resources, service accounts, APIs and service_account blocks', () => {
  const sample = [
    'resource "google_project_iam_member" "x" {}',
    'resource "google_service_account_iam_binding" "y" {}',
    'resource "google_compute_instance_iam_policy" "z" {}',
    'resource "google_iam_workload_identity_pool" "p" {}',
    'resource "google_service_account" "sa" {}',
    'resource "google_project_service" "compute" {}',
    'data "google_iam_policy" "p" {}',
    'resource "google_compute_instance" "vm" {',
    '  service_account {',
    '    scopes = ["cloud-platform"]',
    '  }',
    '}',
    '# resource "google_project_iam_member" "commented" {}',
    '/* service_account { } */',
    'resource "google_compute_instance" "ok" {} // service_account {',
  ].join('\n');
  assert.deepEqual(violations(sample), [
    'resource google_project_iam_member',
    'resource google_service_account_iam_binding',
    'resource google_compute_instance_iam_policy',
    'resource google_iam_workload_identity_pool',
    'resource google_service_account',
    'resource google_project_service',
    'data google_iam_policy',
    'service_account {',
  ]);
  assert.deepEqual(violations('resource "google_compute_instance_group" "g" {}\nresource "google_compute_backend_service" "b" {}'), []);
});

test('terraform/gcp-dev has no IAM resource, no service account, no API and no service_account block', async () => {
  const files = await terraformFiles();
  assert.ok(files.some(([name]) => name === 'versions.tf'), 'terraform/gcp-dev has its root files');
  assert.ok(files.length >= 3);
  for (const [name, text] of files) assert.deepEqual(violations(text), [], name);
});

test('terraform/gcp-dev creates its VM and template, which run without a service account', async () => {
  const code = uncommented((await terraformFiles()).map(([, text]) => text).join('\n'));
  assert.match(code, /resource\s+"google_compute_instance"\s+"demo"/);
  assert.match(code, /resource\s+"google_compute_instance_template"\s+"demo_mig"/);
});

// A resource's body: from its opening brace to the matching closing one (the root's HCL has no brace in a string).
function bodies(code, type) {
  const found = [];
  for (const match of code.matchAll(new RegExp(`^resource\\s+"${type}"\\s+"([^"]+)"\\s*\\{`, 'gm'))) {
    let depth = 1;
    let i = match.index + match[0].length;
    while (depth > 0 && i < code.length) {
      if (code[i] === '{') depth += 1;
      else if (code[i] === '}') depth -= 1;
      i += 1;
    }
    found.push([match[1], code.slice(match.index + match[0].length, i - 1)]);
  }
  return found;
}

test('the demo backend services drain connections for 30 s, as the router does, not Google\'s 300', async () => {
  const code = uncommented((await terraformFiles()).map(([, text]) => text).join('\n'));
  const services = [...bodies(code, 'google_compute_backend_service'), ...bodies(code, 'google_compute_region_backend_service')];
  assert.equal(services.length, 2);
  for (const [name, body] of services) assert.match(body, /^\s*connection_draining_timeout_sec\s*=\s*30\s*$/m, name);
});

test('the URL maps depend on all their backend services, so a destroy deletes a map switched to the stand-in first', async () => {
  const code = uncommented((await terraformFiles()).map(([, text]) => text).join('\n'));
  const [[, global]] = bodies(code, 'google_compute_url_map');
  const [[, regional]] = bodies(code, 'google_compute_region_url_map');
  assert.match(global, /^\s*depends_on\s*=\s*\[google_compute_backend_service\.demo\]\s*$/m);
  assert.match(regional, /^\s*depends_on\s*=\s*\[google_compute_region_backend_service\.demo\]\s*$/m);
});
