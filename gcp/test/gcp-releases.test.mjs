// terraform/gcp-releases is Dormeto's own release project (vision docs/specs/2026-11-07-google-cloud-fixes-design.md, section 4):
// the router image's three public repositories. Its `allUsers` reader is the one IAM change outside `dormeto gcp install`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = new URL('../../terraform/gcp-releases/', import.meta.url).pathname;
const uncommented = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?:#|\/\/).*$/gm, '');
const code = async () => {
  const names = (await readdir(ROOT)).filter((name) => name.endsWith('.tf')).sort();
  return uncommented((await Promise.all(names.map((name) => readFile(join(ROOT, name), 'utf8')))).join('\n'));
};
const body = (text, type, name) => {
  const start = new RegExp(`^resource\\s+"${type}"\\s+"${name}"\\s*\\{`, 'm').exec(text);
  assert.ok(start, `${type}.${name}`);
  let depth = 1;
  let i = start.index + start[0].length;
  while (depth > 0) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') depth -= 1;
    i += 1;
  }
  return text.slice(start.index + start[0].length, i - 1);
};

test('the release project holds the router repository in europe, us and asia: Docker, immutable tags', async () => {
  const text = await code();
  assert.match(text, /variable\s+"project"\s*\{[^}]*default\s*=\s*"dormeto-releases"/);
  assert.match(text, /locations\s*=\s*toset\(\["europe", "us", "asia"\]\)/);
  const repository = body(text, 'google_artifact_registry_repository', 'router');
  assert.match(repository, /^\s*for_each\s*=\s*local\.locations\s*$/m);
  assert.match(repository, /^\s*repository_id\s*=\s*"router"\s*$/m);
  assert.match(repository, /^\s*format\s*=\s*"DOCKER"\s*$/m);
  assert.match(repository, /docker_config\s*\{\s*immutable_tags\s*=\s*true\s*\}/);
  assert.equal([...text.matchAll(/^resource\s+"google_artifact_registry_repository"/gm)].length, 1, 'one block, one for_each');
});

test('each repository has one allUsers reader binding and nothing else touches IAM', async () => {
  const text = await code();
  const iam = [...text.matchAll(/^\s*(?:resource|data)\s+"(google_[a-z0-9_]*(?:iam|service_account|project_service)[a-z0-9_]*)"/gm)].map((m) => m[1]);
  assert.deepEqual(iam, ['google_artifact_registry_repository_iam_member']);
  const binding = body(text, 'google_artifact_registry_repository_iam_member', 'public_reader');
  assert.match(binding, /^\s*for_each\s*=\s*google_artifact_registry_repository\.router\s*$/m);
  assert.match(binding, /^\s*role\s*=\s*"roles\/artifactregistry\.reader"\s*$/m);
  assert.match(binding, /^\s*member\s*=\s*"allUsers"\s*$/m);
  assert.equal([...text.matchAll(/allUsers|allAuthenticatedUsers/g)].length, 1);
  assert.doesNotMatch(text, /_iam_(?:binding|policy)|roles\/(?:owner|editor|writer|admin)|artifactregistry\.(?:writer|admin|repoAdmin)/);
});

test('its state is in the S3 backend, under router/gcp-releases.tfstate', async () => {
  const versions = await readFile(join(ROOT, 'versions.tf'), 'utf8');
  assert.match(versions, /bucket\s*=\s*"terraform-states-121014831971-eu-west-1-an"/);
  assert.match(versions, /key\s*=\s*"router\/gcp-releases\.tfstate"/);
  assert.match(versions, /region\s*=\s*"eu-west-1"/);
});
