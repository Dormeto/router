// What the router may do in a cluster (vision docs/specs/2026-10-11-kubernetes-design.md, section 4): the rights of the
// published ClusterRole, read from a SelfSubjectRulesReview.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROUTER_RULES, missingRights } from '../src/lib/kube-access.mjs';

// The review of a caller bound to the published ClusterRole.
const fullReview = () => ({ resourceRules: ROUTER_RULES.map((r) => ({ apiGroups: [r.group], resources: r.resources, verbs: r.verbs })), nonResourceRules: [], incomplete: false });

test('the published ClusterRole\'s rights are all there: nothing missing', () => {
  assert.deepEqual(missingRights(fullReview()), []);
  // Wildcards cover them too, as an admin's review shows.
  assert.deepEqual(missingRights({ resourceRules: [{ apiGroups: ['*'], resources: ['*'], verbs: ['*'] }] }), []);
  assert.deepEqual(missingRights({ resourceRules: [
    ...fullReview().resourceRules.filter((r) => !r.resources.includes('deployments/scale')),
    { apiGroups: ['apps'], resources: ['deployments/*', '*/scale'], verbs: ['get', 'patch'] },
  ] }), []);
});

test('each right missing is named: verbs, resource and API group', () => {
  const review = fullReview();
  review.resourceRules = review.resourceRules
    .filter((r) => !r.resources.includes('deployments/scale'))
    .map((r) => (r.resources.includes('ingresses') ? { ...r, verbs: ['get', 'list', 'watch', 'patch'] } : r))
    .filter((r) => !r.resources.includes('nodes'));
  assert.deepEqual(missingRights(review), [
    'create, delete ingresses (networking.k8s.io)',
    'get, patch deployments/scale (apps)',
    'get, patch statefulsets/scale (apps)',
    'get nodes',
  ]);
});
