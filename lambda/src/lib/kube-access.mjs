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

// On GKE (vision docs/specs/2026-10-30-google-cloud-coverage-design.md, section 8): the Role the CLI applies in the workload's
// namespace (cli/internal/gcponboard/rbac.go), nothing a namespace cannot hold.
export const GKE_RULES = [
  { group: 'apps', resources: ['deployments', 'statefulsets'], verbs: ['get'] },
  { group: 'apps', resources: ['replicasets'], verbs: ['list'] },
  { group: 'apps', resources: ['deployments/scale', 'statefulsets/scale'], verbs: ['patch'] },
  { group: '', resources: ['pods', 'events'], verbs: ['list'] },
  { group: 'keda.sh', resources: ['scaledobjects'], verbs: ['list', 'patch'] },
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

// The rights of the rules the review does not list: [{ group, resource, verbs }].
function lacking(review, routerRules) {
  const rules = review?.resourceRules ?? [];
  const allowed = (group, resource, verb) => rules.some((r) => has(r.apiGroups, group) && covers(r.resources, resource) && has(r.verbs, verb));
  return routerRules.flatMap(({ group, resources, verbs }) => resources
    .map((resource) => ({ group, resource, verbs: verbs.filter((verb) => !allowed(group, resource, verb)) }))
    .filter((r) => r.verbs.length));
}

// The rights of the rules the review does not grant, as text: "get, patch deployments/scale (apps)".
export const missingRights = (review, rules = ROUTER_RULES) => lacking(review, rules).map(text);

// Those of the rights the caller is refused, each asked on its own, as text.
async function refused(k8s, namespace, rights) {
  const denied = [];
  for (const { group, resource, verbs } of rights) {
    const [name, subresource] = resource.split('/');
    const no = [];
    for (const verb of verbs) {
      const attributes = { ...(CLUSTER_SCOPED.has(name) ? {} : { namespace }), verb, group, resource: name, ...(subresource ? { subresource } : {}) };
      if (!(await k8s.accessReview(attributes))) no.push(verb);
    }
    if (no.length) denied.push(text({ group, resource, verbs: no }));
  }
  return denied;
}

// The rights the caller lacks in the namespace. A rules review lists RBAC's rules only and says when it is incomplete
// (EKS access policies are another authorizer, checked on dev-eks 2026-10-11): each right it does not list is then
// asked on its own.
export async function checkRights(k8s, namespace, rules = ROUTER_RULES) {
  const review = await k8s.rulesReview(namespace);
  const missing = lacking(review, rules);
  if (!review?.incomplete) return missing.map(text);
  return refused(k8s, namespace, missing);
}

// The rights of the rules the caller lacks in the namespace, a SelfSubjectAccessReview per verb: for a cluster whose authorizers a
// rules review does not all list (on GKE, IAM's).
export const askRights = (k8s, namespace, rules) => refused(k8s, namespace, rules.flatMap(({ group, resources, verbs }) => resources.map((resource) => ({ group, resource, verbs }))));
