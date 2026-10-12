// Switching the waker in for a Kubernetes workload (vision docs/specs/2026-10-11-kubernetes-design.md, section 6): never a
// change to the rules the AWS Load Balancer Controller owns (decision 4). The switch lives in the objects it reads —
// Dormeto's Ingress in the customer's IngressGroup, or the customer's lone Ingress patched — and holds once DescribeRules
// shows the weights (the controller takes about 2 seconds, the ALB 11 more: docs/research/2026-10-11-eks-spike.md).
import { failureError } from './failures.mjs';
import { currentTarget } from './route.mjs';
import { resolveRules } from './rules.mjs';

const ALB = 'alb.ingress.kubernetes.io/';
const ACTION = `${ALB}actions.dormeto`;
const CLASS = 'kubernetes.io/ingress.class';
export const MANAGED_LABEL = 'dormeto.com/managed';
export const WORKLOAD_LABEL = 'dormeto.com/workload';
const DORMETO_BACKEND = { service: { name: 'dormeto', port: { name: 'use-annotation' } } };
// The customer Ingress's target group annotations: Dormeto's Ingress gets its own target group for the same Service and
// port, which must judge the pods alike (spike ruling 2). Never one the controller applies to the whole group (rulings 1, 4).
const TARGET_GROUP = ['success-codes', 'healthy-threshold-count', 'unhealthy-threshold-count', 'backend-protocol', 'backend-protocol-version', 'target-type', 'target-group-attributes']
  .map((name) => `${ALB}${name}`);
const copied = (key) => key.startsWith(`${ALB}healthcheck-`) || TARGET_GROUP.includes(key);
const ROUTE_TIMEOUT_MS = 120_000;
const ROUTE_POLL_MS = 2000;
const EVENTS_MAX = 3;

export const ingressPath = (namespace, name) => `/apis/networking.k8s.io/v1/namespaces/${namespace}/ingresses${name ? `/${name}` : ''}`;
export const dormetoIngressName = (cfg) => `dormeto-${cfg.workloadId}`;
export const weightsOf = (target) => (target === 'app' ? { app: 1, waker: 0 } : { app: 0, waker: 1 });
const portText = (port) => String(port?.number ?? port?.name);
const leadsTo = (backend, service) => backend?.service?.name === service.name && portText(backend.service.port) === portText(service.port);
const isDormeto = (backend) => backend?.service?.name === 'dormeto' && backend.service.port?.name === 'use-annotation';
const where = ({ namespace, name }) => `Ingress ${namespace}/${name}`;
const pointer = (key) => key.replace(/~/g, '~0').replace(/\//g, '~1');
const sorted = (value) => (Array.isArray(value) ? value.map(sorted)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])])) : value);
const same = (a, b) => JSON.stringify(sorted(a ?? null)) === JSON.stringify(sorted(b ?? null));

async function getOrNull(k8s, path) {
  try {
    return await k8s.get(path);
  } catch (err) {
    if (err?.status === 404) return null;
    throw err;
  }
}

// The weighted forward: the application's Service and port, and the waker target group by its ARN.
const actionOf = (cfg, weights) => JSON.stringify({
  type: 'forward',
  forwardConfig: {
    targetGroups: [
      { serviceName: cfg.kubernetes.ingress.service.name, servicePort: portText(cfg.kubernetes.ingress.service.port), weight: weights.app },
      { targetGroupARN: cfg.wakerTargetGroupArn, weight: weights.waker },
    ],
  },
});

// Dormeto's Ingress for the customer's Ingress `customer`: in its group, ranked before it, the paths of its rule that lead
// to the workload's Service (their conditions too), the weighted forward, its target group annotations.
export function dormetoIngress(cfg, weights, customer) {
  const { namespace, ingress } = cfg.kubernetes;
  const ref = { namespace, name: ingress.name };
  const annotations = customer.metadata?.annotations ?? {};
  const group = annotations[`${ALB}group.name`];
  if (!group) throw failureError('configuration', `${where(ref)} is not in an IngressGroup`);
  const rule = customer.spec?.rules?.[ingress.ruleIndex];
  const paths = (rule?.http?.paths ?? []).filter((p) => leadsTo(p.backend, ingress.service));
  if (!paths.length) throw failureError('configuration', `rule ${ingress.ruleIndex} of ${where(ref)} no longer leads to Service ${ingress.service.name}`);
  const order = ingress.groupOrder ?? Math.max(-1000, Number(annotations[`${ALB}group.order`] ?? 0) - 1);
  const conditions = annotations[`${ALB}conditions.${ingress.service.name}`];
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'Ingress',
    metadata: {
      name: dormetoIngressName(cfg),
      namespace,
      labels: { [MANAGED_LABEL]: 'true', [WORKLOAD_LABEL]: cfg.workloadId },
      annotations: {
        [`${ALB}group.name`]: group,
        [`${ALB}group.order`]: String(order),
        ...(annotations[`${ALB}listen-ports`] ? { [`${ALB}listen-ports`]: annotations[`${ALB}listen-ports`] } : {}),
        ...Object.fromEntries(Object.entries(annotations).filter(([key]) => copied(key))),
        ...(annotations[CLASS] ? { [CLASS]: annotations[CLASS] } : {}),
        ...(conditions ? { [`${ALB}conditions.dormeto`]: conditions } : {}),
        [ACTION]: actionOf(cfg, weights),
      },
    },
    spec: {
      ...(customer.spec.ingressClassName ? { ingressClassName: customer.spec.ingressClassName } : {}),
      rules: [{
        ...(rule.host ? { host: rule.host } : {}),
        http: { paths: paths.map((p) => ({ ...(p.path ? { path: p.path } : {}), pathType: p.pathType, backend: DORMETO_BACKEND })) },
      }],
    },
  };
}

// What Dormeto sets differs from the Ingress as it is: its labels, its ALB annotations, its rules and class (the API server
// and the customer's tools may add others).
function differs(existing, desired) {
  const labels = existing.metadata?.labels ?? {};
  const annotations = Object.fromEntries(Object.entries(existing.metadata?.annotations ?? {}).filter(([key]) => key.startsWith(ALB) || key === CLASS));
  return Object.entries(desired.metadata.labels).some(([key, value]) => labels[key] !== value)
    || !same(annotations, desired.metadata.annotations)
    || !same(existing.spec?.rules, desired.spec.rules)
    || (desired.spec.ingressClassName !== undefined && desired.spec.ingressClassName !== existing.spec?.ingressClassName);
}

// The controller's latest warnings on the Ingress, the reason of a switch it did not apply.
async function latestEvents(ports, cfg, ref) {
  try {
    const k8s = await ports.kubernetesOf(cfg.kubernetes.cluster);
    const listed = await k8s.list(`/api/v1/namespaces/${ref.namespace}/events`, { fieldSelector: `involvedObject.kind=Ingress,involvedObject.name=${ref.name}` });
    const time = (e) => Date.parse(e.lastTimestamp ?? e.eventTime ?? e.metadata?.creationTimestamp ?? 0) || 0;
    const warnings = listed.filter((e) => e.type === 'Warning').sort((a, b) => time(b) - time(a)).slice(0, EVENTS_MAX);
    return warnings.length ? warnings.map((e) => `${e.reason}: ${e.message}`).join('; ') : 'no warning from the controller';
  } catch (err) {
    return `its events unreadable (${err.message})`;
  }
}

// Until DescribeRules shows every instrumented rule on the target, at most 120 s; then a configuration failure with the
// controller's warnings. found: the rules as read before (only when nothing was written since).
export async function waitRoute(ports, cfg, target, { ingress, sleep, now, found }) {
  const deadline = now() + ROUTE_TIMEOUT_MS;
  let rules = found;
  for (;;) {
    rules ??= (await resolveRules(ports.elbv2, [cfg])).get(cfg.workloadId);
    if (rules.instrumented.length && rules.instrumented.every((rule) => currentTarget(rule.Actions, cfg) === target)) return;
    if (now() >= deadline) {
      throw failureError('configuration', `the load balancer did not apply the switch to the ${target} within ${ROUTE_TIMEOUT_MS / 1000} s; ${where(ingress)}: ${await latestEvents(ports, cfg, ingress)}`);
    }
    await sleep(ROUTE_POLL_MS);
    rules = null;
  }
}

// Dormeto's Ingress created, or changed when it differs, for the target; then the load balancer waited for (wait: false,
// the caller checks later). Returns the Ingress written, if any.
export async function applyIngressRoute(ports, cfg, target, { sleep, now, found, wait = true } = {}) {
  const { cluster, namespace, ingress } = cfg.kubernetes;
  const k8s = await ports.kubernetesOf(cluster);
  const desired = dormetoIngress(cfg, weightsOf(target), await k8s.get(ingressPath(namespace, ingress.name)));
  const { name } = desired.metadata;
  const existing = await getOrNull(k8s, ingressPath(namespace, name));
  let written = [];
  if (!existing) {
    await k8s.create(ingressPath(namespace), desired);
    written = [name];
  } else if (differs(existing, desired)) {
    const others = Object.fromEntries(Object.entries(existing.metadata.annotations ?? {}).filter(([key]) => !key.startsWith(ALB) && key !== CLASS));
    await k8s.patch(ingressPath(namespace, name), [
      { op: 'test', path: '/metadata/resourceVersion', value: existing.metadata.resourceVersion },
      { op: 'add', path: '/metadata/labels', value: { ...existing.metadata.labels, ...desired.metadata.labels } },
      { op: 'add', path: '/metadata/annotations', value: { ...others, ...desired.metadata.annotations } },
      { op: 'add', path: '/spec', value: { ...existing.spec, ...desired.spec } },
    ], 'json');
    written = [name];
  }
  if (wait) await waitRoute(ports, cfg, target, { ingress: { namespace, name }, sleep, now, found: written.length ? undefined : found });
  return written;
}

// The paths of the customer's rule that lead to the workload's Service, or already to Dormeto's forward.
function patchedPaths(cfg, current) {
  const { namespace, ingress } = cfg.kubernetes;
  const paths = (current.spec?.rules?.[ingress.ruleIndex]?.http?.paths ?? []).map((p, index) => ({ p, index }))
    .filter(({ p }) => leadsTo(p.backend, ingress.service) || isDormeto(p.backend));
  if (!paths.length) throw failureError('configuration', `rule ${ingress.ruleIndex} of ${where({ namespace, name: ingress.name })} no longer leads to Service ${ingress.service.name}`);
  return paths;
}

// The customer's lone Ingress (it owns its ALB: no other Ingress can add a rule to it, joining a group would replace the
// ALB): its paths to the Service become the weighted forward of the actions annotation. Only what differs is written,
// never over a change made since it was read. original: the backends to give back.
export async function patchCustomerIngress({ kubernetesOf }, cfg, weights) {
  const { cluster, namespace, ingress } = cfg.kubernetes;
  const k8s = await kubernetesOf(cluster);
  const path = ingressPath(namespace, ingress.name);
  const current = await k8s.get(path);
  const paths = patchedPaths(cfg, current);
  const original = paths.map(({ index }) => ({ rule: ingress.ruleIndex, path: index, backend: { service: { name: ingress.service.name, port: ingress.service.port } } }));
  const action = actionOf(cfg, weights);
  const ops = [
    ...(current.metadata.annotations ? [] : [{ op: 'add', path: '/metadata/annotations', value: {} }]),
    ...(current.metadata.annotations?.[ACTION] === action ? [] : [{ op: 'add', path: `/metadata/annotations/${pointer(ACTION)}`, value: action }]),
    ...paths.filter(({ p }) => !isDormeto(p.backend)).map(({ index }) => ({ op: 'replace', path: `/spec/rules/${ingress.ruleIndex}/http/paths/${index}/backend`, value: DORMETO_BACKEND })),
  ];
  if (!ops.length) return { changed: false, original };
  await k8s.patch(path, [{ op: 'test', path: '/metadata/resourceVersion', value: current.metadata.resourceVersion }, ...ops], 'json');
  return { changed: true, original };
}

// The customer's lone Ingress as it was: the annotation removed, the backends given back (original, else the Service of
// the configuration on every patched path).
export async function restoreCustomerIngress({ kubernetesOf }, cfg, original) {
  const { cluster, namespace, ingress } = cfg.kubernetes;
  const k8s = await kubernetesOf(cluster);
  const path = ingressPath(namespace, ingress.name);
  const current = await getOrNull(k8s, path);
  if (!current) return { changed: false };
  const backends = original ?? patchedPaths(cfg, current).map(({ index }) => ({ rule: ingress.ruleIndex, path: index, backend: { service: { name: ingress.service.name, port: ingress.service.port } } }));
  const ops = [
    ...(current.metadata.annotations?.[ACTION] === undefined ? [] : [{ op: 'remove', path: `/metadata/annotations/${pointer(ACTION)}` }]),
    ...backends.filter((b) => isDormeto(current.spec?.rules?.[b.rule]?.http?.paths?.[b.path]?.backend))
      .map((b) => ({ op: 'replace', path: `/spec/rules/${b.rule}/http/paths/${b.path}/backend`, value: b.backend })),
  ];
  if (!ops.length) return { changed: false };
  await k8s.patch(path, [{ op: 'test', path: '/metadata/resourceVersion', value: current.metadata.resourceVersion }, ...ops], 'json');
  return { changed: true };
}

// Dormeto's own target group: the other one of its rule, the rule forwarding to the waker target group (one per load
// balancer); null until the controller made it.
export async function dormetoTargetGroup(elbv2, cfg, found) {
  return (found ?? (await resolveRules(elbv2, [cfg])).get(cfg.workloadId)).switchTargetGroup ?? null;
}

// routeTo for a workload switched by an Ingress: setRoute's guard (towards the waker, a rule the switch does not reach
// fails it before any change), then the Ingress written and the load balancer waited for.
export async function routeIngress(ports, cfg, target, { found, allowIssues = false, onIssues = () => {}, sleep, now, wait = true } = {}) {
  const rules = found ?? (await resolveRules(ports.elbv2, [cfg])).get(cfg.workloadId);
  if (rules.issues.length) {
    if (target === 'waker' && !allowIssues) throw new Error(`cannot switch to the waker: ${rules.issues.map((i) => i.reason).join('; ')}`);
    onIssues(rules.issues);
  }
  if (cfg.kubernetes.switch === 'ingress') return applyIngressRoute(ports, cfg, target, { sleep, now, found: rules, wait });
  const { changed } = await patchCustomerIngress(ports, cfg, weightsOf(target));
  const ingress = { namespace: cfg.kubernetes.namespace, name: cfg.kubernetes.ingress.name };
  if (wait) await waitRoute(ports, cfg, target, { ingress, sleep, now, found: changed ? undefined : rules });
  return changed ? [ingress.name] : [];
}
