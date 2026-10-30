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
  // The demo's three (global app, stand-in, managed group are one for_each), the regional one, and the optional ones.
  assert.deepEqual(services.map(([name]) => name).sort(), ['classic', 'demo', 'demo', 'gke', 'neg']);
  for (const [name, body] of services) assert.match(body, /^\s*connection_draining_timeout_sec\s*=\s*30\s*$/m, name);
});

test('the URL maps depend on all their backend services, so a destroy deletes a map switched to the stand-in first', async () => {
  const code = uncommented((await terraformFiles()).map(([, text]) => text).join('\n'));
  const global = bodies(code, 'google_compute_url_map').find(([name]) => name === 'dev')[1];
  const regional = bodies(code, 'google_compute_region_url_map').find(([name]) => name === 'dev')[1];
  assert.match(global, /^\s*depends_on\s*=\s*\[google_compute_backend_service\.demo\]\s*$/m);
  assert.match(regional, /^\s*depends_on\s*=\s*\[google_compute_region_backend_service\.demo\]\s*$/m);
});

test('the demo\'s URL map ignores what Dormeto writes, as the scenario page advises', async () => {
  const lb = uncommented(await readFile(join(ROOT, 'lb.tf'), 'utf8'));
  const urlMap = /resource "google_compute_url_map" "dev" \{[\s\S]*?\n\}/.exec(lb)[0];
  const ignored = /ignore_changes = \[([^\]]*)\]/.exec(urlMap)[1].split(',').map((name) => name.trim()).filter(Boolean);
  for (const name of ['host_rule', 'path_matcher', 'default_custom_error_response_policy', 'default_service', 'default_route_action']) {
    assert.ok(ignored.includes(name), `${name} in ${ignored}`);
  }
});

const variableBlock = (variables, name) => new RegExp(`variable\\s+"${name}"\\s*\\{([\\s\\S]*?)\\n\\}`).exec(variables)?.[1];

test('each optional part is behind a variable that is false by default, and the regional map ignores what Dormeto writes', async () => {
  const variables = uncommented(await readFile(join(ROOT, 'variables.tf'), 'utf8'));
  for (const name of ['enable_classic', 'enable_neg', 'enable_sql', 'enable_gke']) {
    const block = variableBlock(variables, name);
    assert.ok(block, `${name} is declared`);
    assert.match(block, /^\s*type\s*=\s*bool\s*$/m, name);
    assert.match(block, /^\s*default\s*=\s*false\s*$/m, name);
  }
  const regional = uncommented(await readFile(join(ROOT, 'regional.tf'), 'utf8'));
  const urlMap = /resource "google_compute_region_url_map" "dev" \{[\s\S]*?\n\}/.exec(regional)[0];
  const ignored = /ignore_changes = \[([^\]]*)\]/.exec(urlMap)[1].split(',').map((name) => name.trim()).filter(Boolean);
  assert.deepEqual(ignored.sort(), ['default_route_action', 'default_service', 'host_rule', 'path_matcher']);
});

test('every resource of an optional file has a count or a for_each on its own variable, so a plan with the defaults shows no change', async () => {
  const optional = { 'classic.tf': 'enable_classic', 'neg.tf': 'enable_neg', 'sql.tf': 'enable_sql', 'gke.tf': 'enable_gke' };
  for (const [file, variable] of Object.entries(optional)) {
    const code = uncommented(await readFile(join(ROOT, file), 'utf8'));
    const resources = [...code.matchAll(/^resource\s+"([^"]+)"\s+"([^"]+)"/gm)];
    assert.ok(resources.length > 0, file);
    for (const [, type, name] of resources) {
      const [[, body]] = bodies(code, type).filter(([n]) => n === name);
      assert.match(body, new RegExp(`^\\s*(?:count\\s*=\\s*var\\.${variable}\\s*\\?\\s*1\\s*:\\s*0|for_each\\s*=\\s*var\\.${variable}\\s*\\?[^\\n]*:\\s*\\{\\}|for_each\\s*=\\s*var\\.${variable}\\s*\\?[^\\n]*:\\s*toset\\(\\[\\]\\))\\s*$`, 'm'), `${type}.${name}`);
    }
  }
});

test('the optional resources are the ones asked for: Cloud SQL smallest and deletable, GKE zonal Standard with one small node', async () => {
  const sql = uncommented(await readFile(join(ROOT, 'sql.tf'), 'utf8'));
  assert.match(sql, /resource\s+"google_sql_database_instance"/);
  assert.match(sql, /tier\s*=\s*"db-f1-micro"/);
  assert.match(sql, /disk_size\s*=\s*10\b/);
  assert.match(sql, /disk_type\s*=\s*"PD_HDD"/);
  assert.match(sql, /^\s*deletion_protection\s*=\s*false\s*$/m);
  assert.match(sql, /ipv4_enabled\s*=\s*true/);
  assert.doesNotMatch(sql, /authorized_networks/);
  const gke = uncommented(await readFile(join(ROOT, 'gke.tf'), 'utf8'));
  assert.match(gke, /resource\s+"google_container_cluster"/);
  assert.match(gke, /remove_default_node_pool\s*=\s*true/);
  assert.match(gke, /^\s*deletion_protection\s*=\s*false\s*$/m);
  assert.match(gke, /machine_type\s*=\s*"e2-small"/);
  assert.match(gke, /node_count\s*=\s*1\b/);
  assert.match(gke, /control_plane_endpoints_config\s*\{\s*dns_endpoint_config\s*\{\s*allow_external_traffic\s*=\s*true/);
  assert.equal([...gke.matchAll(/resource\s+"google_container_node_pool"/g)].length, 1);
  assert.doesNotMatch(gke, /google_container_cluster"\s+"[^"]+"\s*\{[\s\S]*autopilot/);
});

test('the classic load balancer is EXTERNAL over HTTP, the NEG one holds one VM without a service account', async () => {
  const classic = uncommented(await readFile(join(ROOT, 'classic.tf'), 'utf8'));
  assert.match(classic, /load_balancing_scheme\s*=\s*"EXTERNAL"/);
  assert.match(classic, /port_range\s*=\s*"80"/);
  assert.doesNotMatch(classic, /ssl_certificate|https_proxy/);
  const neg = uncommented(await readFile(join(ROOT, 'neg.tf'), 'utf8'));
  assert.match(neg, /name\s*=\s*"\$\{local\.demo\}-neg"/);
  assert.match(neg, /network_endpoint_type\s*=\s*"GCE_VM_IP_PORT"/);
  assert.match(neg, /load_balancing_scheme\s*=\s*"EXTERNAL_MANAGED"/);
  assert.match(neg, /machine_type\s*=\s*var\.machine_type/);
  assert.match(neg, /port_range\s*=\s*"80"/);
});

test('the GKE demo manifest holds the Deployment, the Service with a standalone NEG and the Gateway', async () => {
  const yaml = await readFile(join(ROOT, 'gke-demo.yaml'), 'utf8');
  for (const kind of ['Deployment', 'Service', 'Gateway', 'HTTPRoute']) assert.match(yaml, new RegExp(`^kind: ${kind}$`, 'm'), kind);
  assert.match(yaml, /cloud\.google\.com\/neg/);
  assert.doesNotMatch(yaml, /kind: (?:ClusterRole|Role|RoleBinding|ClusterRoleBinding)\b/);
});
