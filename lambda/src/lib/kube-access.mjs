// What the router needs in a cluster (vision docs/specs/2026-10-11-kubernetes-design.md, section 4): the rights of the
// ClusterRole published for the dormeto:router group (kubernetes/dormeto-router.yaml), checked from a
// SelfSubjectRulesReview of the router's role.
export const ROUTER_RULES = [
  { group: 'apps', resources: ['deployments', 'statefulsets', 'replicasets'], verbs: ['get', 'list', 'watch'] },
  { group: '', resources: ['pods', 'services', 'events'], verbs: ['get', 'list', 'watch'] },
  { group: 'networking.k8s.io', resources: ['ingresses'], verbs: ['get', 'list', 'watch', 'create', 'patch', 'delete'] },
  { group: 'autoscaling', resources: ['horizontalpodautoscalers'], verbs: ['get', 'list', 'watch'] },
  { group: 'keda.sh', resources: ['scaledobjects'], verbs: ['get', 'list', 'watch', 'patch'] },
  { group: 'apps', resources: ['deployments/scale', 'statefulsets/scale'], verbs: ['get', 'patch'] },
  { group: '', resources: ['nodes'], verbs: ['get'] },
];

const has = (list = [], value) => list.includes('*') || list.includes(value);
// A resource matches as itself, its wildcard, or a subresource's (deployments/* and */scale).
const covers = (resources = [], resource) => {
  if (has(resources, resource)) return true;
  const [base, sub] = resource.split('/');
  return Boolean(sub) && (resources.includes(`${base}/*`) || resources.includes(`*/${sub}`));
};

const CLUSTER_SCOPED = new Set(['nodes']);
const text = ({ group, resource, verbs }) => `${verbs.join(', ')} ${resource}${group ? ` (${group})` : ''}`;

// The rights of ROUTER_RULES the review does not list: [{ group, resource, verbs }].
function lacking(review) {
  const rules = review?.resourceRules ?? [];
  const allowed = (group, resource, verb) => rules.some((r) => has(r.apiGroups, group) && covers(r.resources, resource) && has(r.verbs, verb));
  return ROUTER_RULES.flatMap(({ group, resources, verbs }) => resources
    .map((resource) => ({ group, resource, verbs: verbs.filter((verb) => !allowed(group, resource, verb)) }))
    .filter((r) => r.verbs.length));
}

// The rights of ROUTER_RULES the review does not grant, as text: "get, patch deployments/scale (apps)".
export const missingRights = (review) => lacking(review).map(text);

// The rights the caller lacks in the namespace. A rules review lists RBAC's rules only and says when it is incomplete
// (EKS access policies are another authorizer, checked on dev-eks 2026-10-11): each right it does not list is then
// asked on its own.
export async function checkRights(k8s, namespace) {
  const review = await k8s.rulesReview(namespace);
  const missing = lacking(review);
  if (!review?.incomplete) return missing.map(text);
  const denied = [];
  for (const { group, resource, verbs } of missing) {
    const [name, subresource] = resource.split('/');
    const refused = [];
    for (const verb of verbs) {
      const attributes = { ...(CLUSTER_SCOPED.has(name) ? {} : { namespace }), verb, group, resource: name, ...(subresource ? { subresource } : {}) };
      if (!(await k8s.accessReview(attributes))) refused.push(verb);
    }
    if (refused.length) denied.push(text({ group, resource, verbs: refused }));
  }
  return denied;
}
