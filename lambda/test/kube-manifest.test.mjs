// The Kubernetes permissions Dormeto publishes (vision docs/specs/2026-10-11-kubernetes-design.md, section 4): the
// ClusterRole of the dormeto:router group is exactly what the router checks (lib/kube-access.mjs), and the admission
// policy keeps its create and delete to Dormeto's own Ingresses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ROUTER_RULES } from '../src/lib/kube-access.mjs';

const MANIFEST = new URL('../../kubernetes/dormeto-router.yaml', import.meta.url);
const documents = async () => (await readFile(MANIFEST, 'utf8')).split(/^---$/m).map((d) => d.trim()).filter(Boolean);
const field = (doc, name) => new RegExp(`^${name}: (.+)$`, 'm').exec(doc)?.[1];

test('the manifest holds the ClusterRole, its binding to the group dormeto:router, and the Ingress admission policy with its binding', async () => {
  const docs = await documents();
  assert.deepEqual(docs.map((d) => [field(d, 'kind'), /^ {2}name: (.+)$/m.exec(d)?.[1]]), [
    ['ClusterRole', 'dormeto-router'],
    ['ClusterRoleBinding', 'dormeto-router'],
    ['ValidatingAdmissionPolicy', 'dormeto-router-ingresses'],
    ['ValidatingAdmissionPolicyBinding', 'dormeto-router-ingresses'],
  ]);
  const binding = docs[1];
  assert.match(binding, /roleRef:\n {2}apiGroup: rbac\.authorization\.k8s\.io\n {2}kind: ClusterRole\n {2}name: dormeto-router/);
  assert.match(binding, /subjects:\n {2}- apiGroup: rbac\.authorization\.k8s\.io\n {4}kind: Group\n {4}name: dormeto:router/);
});

test('the ClusterRole grants exactly the rights the router checks, nothing more (no Secrets, no change to a workload but its scale)', async () => {
  const [role] = await documents();
  const rules = [...role.matchAll(/- apiGroups: (\[.*\])\n\s+resources: (\[.*\])\n\s+verbs: (\[.*\])/g)].map(([, groups, resources, verbs]) => ({ group: JSON.parse(groups)[0], resources: JSON.parse(resources), verbs: JSON.parse(verbs) }));
  assert.deepEqual(rules, ROUTER_RULES);
  assert.doesNotMatch(role, /secrets|"\*"/);
});

test('the admission policy refuses the group\'s create and delete of an Ingress without the dormeto.com/managed label, and its changes of that label', async () => {
  const [, , policy, binding] = await documents();
  assert.match(policy, /apiVersion: admissionregistration\.k8s\.io\/v1\n/);
  assert.match(policy, /operations: \["CREATE", "UPDATE", "DELETE"\]/);
  assert.match(policy, /expression: "request\.operation != 'UPDATE' \|\| variables\.before == variables\.after"/);
  assert.match(policy, /resources: \["ingresses"\]/);
  assert.match(policy, /expression: "'dormeto:router' in request\.userInfo\.groups"/);
  assert.match(policy, /dormeto\.com\/managed/);
  assert.match(policy, /failurePolicy: Fail/);
  assert.match(binding, /policyName: dormeto-router-ingresses\n {2}validationActions: \["Deny"\]/);
});
