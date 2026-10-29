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
