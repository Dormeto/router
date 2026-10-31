// What the router may do in a cluster (vision docs/specs/2026-10-11-kubernetes-design.md, section 4): the rights of the
// published ClusterRole, read from a SelfSubjectRulesReview.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GKE_RULES, ROUTER_RULES, askRights, checkRights, missingRights } from '../src/lib/kube-access.mjs';

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

// --- A namespace's rules (GKE, the coverage design's section 8): the list of what the CLI applies, verbatim -----------------

test('GKE_RULES: what the CLI\'s Role holds (cli/internal/gcponboard/rbac.go), nothing cluster-wide', () => {
  assert.deepEqual(GKE_RULES, [
    { group: 'apps', resources: ['deployments', 'statefulsets'], verbs: ['get'] },
    { group: 'apps', resources: ['replicasets'], verbs: ['list'] },
    { group: 'apps', resources: ['deployments/scale', 'statefulsets/scale'], verbs: ['patch'] },
    { group: '', resources: ['pods', 'events'], verbs: ['list'] },
    { group: 'keda.sh', resources: ['scaledobjects'], verbs: ['list', 'patch'] },
  ]);
});

test('the rules are a parameter: a review holding GKE_RULES lacks nothing of them, and the default still asks for the rest', () => {
  const review = { resourceRules: GKE_RULES.map((r) => ({ apiGroups: [r.group], resources: r.resources, verbs: r.verbs })), incomplete: false };
  assert.deepEqual(missingRights(review, GKE_RULES), []);
  assert.ok(missingRights(review).includes('get nodes'));
});

test('checkRights with the rules: an incomplete review\'s missing ones are asked in the namespace', async () => {
  const asked = [];
  const k8s = {
    rulesReview: async () => ({ resourceRules: [], incomplete: true }),
    accessReview: async (attributes) => {
      asked.push(attributes);
      return attributes.resource !== 'pods';
    },
  };
  assert.deepEqual(await checkRights(k8s, 'shop', [{ group: '', resources: ['pods'], verbs: ['get'] }, { group: 'apps', resources: ['deployments/scale'], verbs: ['patch'] }]), ['get pods']);
  assert.deepEqual(asked, [
    { namespace: 'shop', verb: 'get', group: '', resource: 'pods' },
    { namespace: 'shop', verb: 'patch', group: 'apps', resource: 'deployments', subresource: 'scale' },
  ]);
});

test('askRights: one review per verb of each rule, whatever a rules review would say, and what is refused named', async () => {
  const asked = [];
  const k8s = {
    rulesReview: async () => { throw new Error('no rules review'); },
    accessReview: async (attributes) => {
      asked.push(attributes);
      return !(attributes.subresource === 'scale' && attributes.verb === 'patch');
    },
  };
  assert.deepEqual(await askRights(k8s, 'shop', GKE_RULES), ['patch deployments/scale (apps)', 'patch statefulsets/scale (apps)']);
  assert.equal(asked.length, 9);
  assert.ok(asked.every((attributes) => attributes.namespace === 'shop'), 'each in the namespace');
});
