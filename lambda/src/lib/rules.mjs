// The rules of a workload, found from its application target group: every listener rule of the target group's load
// balancer that forwards to it. A rule is instrumented when it forwards to the application and the workload's waker
// target groups only and carries dormeto:workload = <workload id>; any other rule forwarding to the target group is an
// issue (the router cannot switch it, so it must not nap the workload).
const WORKLOAD_TAG = 'dormeto:workload';
// A Dormeto rule before a customer rule, with its conditions and the weighted forward (R4c): the customer rule it covers is
// neither switched nor an issue.
const SHADOWS_TAG = 'dormeto:shadows';
const CONFIGS = ['HostHeaderConfig', 'PathPatternConfig', 'HttpHeaderConfig', 'QueryStringConfig', 'HttpRequestMethodConfig', 'SourceIpConfig'];
const NO_RULE = 'no rule forwards to the target group';
const DETACHED = 'target group not attached to a load balancer';

const chunks = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

async function pages(call, key) {
  const items = [];
  let marker;
  do {
    const page = await call(marker ? { Marker: marker } : {});
    items.push(...(page[key] ?? []));
    marker = page.NextMarker;
  } while (marker);
  return items;
}

// Conditions as CreateRule and ModifyRule take them: DescribeRules adds the legacy Values next to the configuration.
export function cleanConditions(conditions = []) {
  return conditions.map((c) => {
    const copy = structuredClone(c);
    if (CONFIGS.some((k) => copy[k])) delete copy.Values;
    return copy;
  });
}

const canonical = (value) => (Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value);
export const sameConditions = (a, b) => JSON.stringify(canonical(cleanConditions(a))) === JSON.stringify(canonical(cleanConditions(b)));

// Target groups of the forward actions of a rule, whatever their weight.
export function forwardTargetGroups(rule) {
  return (rule.Actions ?? []).filter((a) => a.Type === 'forward').flatMap((a) => (a.ForwardConfig?.TargetGroups?.length
    ? a.ForwardConfig.TargetGroups.map((tg) => tg.TargetGroupArn)
    : [a.TargetGroupArn].filter(Boolean)));
}

export const forwardOnly = (rule) => (rule.Actions ?? []).length === 1 && rule.Actions[0].Type === 'forward';

// Host headers a rule requires, lower-cased (ALB matches them without case), or null when it takes any host or a pattern.
function literalHosts(conditions = []) {
  const values = conditions.filter((c) => c.Field === 'host-header').flatMap((c) => c.HostHeaderConfig?.Values ?? c.Values ?? []);
  if (!values.length || values.some((v) => /[*?]/.test(v))) return null;
  return new Set(values.map((v) => v.toLowerCase()));
}
// No request can match both rules: each requires literal host headers, none in common.
export function disjoint(a, b) {
  const [x, y] = [literalHosts(a), literalHosts(b)];
  return Boolean(x && y) && ![...x].some((h) => y.has(h));
}

// Why a customer rule cannot be shadowed (a shadow forwards only), or null: an action before the forward (authentication),
// a rewrite, or other target groups (blue/green, canary: the customer's own split).
export function unshadowable(rule, { appArn, wakerArn }) {
  const groups = forwardTargetGroups(rule);
  if (groups.some((g) => g !== appArn && g !== wakerArn)) return 'forwards to other target groups';
  if (!forwardOnly(rule)) return 'acts before its forward';
  if (rule.Transforms?.length) return 'has transforms';
  return null;
}

// A rule a shadow may pass over (it takes the requests of both): one of the workload's shadows, a plain forward to the
// workload (the same backends, switched together), or a rule no request of the customer rule can match.
export function passable({ rule, tags = {} }, customer, { appArn, wakerArn, workloadId }) {
  if (tags[SHADOWS_TAG] && tags[WORKLOAD_TAG] === workloadId) return true;
  if (forwardTargetGroups(rule).includes(appArn) && !unshadowable(rule, { appArn, wakerArn })) return true;
  return disjoint(rule.Conditions, customer.Conditions);
}

// A shadow covers its customer rule when it sits before it on its listener, nothing it may not pass over lies between
// them, and it has its conditions; else why not (only 'with other conditions' leaves the shadow in a good place).
export function shadowGap(shadow, customer, listenerRows, options) {
  if (shadow.listener.ListenerArn !== customer.listener.ListenerArn) return 'on another listener';
  const [from, to] = [Number(shadow.rule.Priority), Number(customer.rule.Priority)];
  if (from > to) return 'placed after it';
  const between = listenerRows.filter((r) => Number(r.rule.Priority) > from && Number(r.rule.Priority) < to).sort((a, b) => Number(a.rule.Priority) - Number(b.rule.Priority));
  const blocking = between.find((r) => !passable(r, customer.rule, options));
  if (blocking) return `with rule ${blocking.rule.Priority} between them`;
  return sameConditions(shadow.rule.Conditions, customer.rule.Conditions) ? null : 'with other conditions';
}

function issueOf(rule, listener, tags, cfg) {
  const label = `rule ${rule.Priority}`;
  if (rule.IsDefault) return `default rule of ${listener.Protocol}:${listener.Port} forwards to the target group (not supported yet)`;
  const groups = forwardTargetGroups(rule);
  if (groups.some((arn) => arn !== cfg.appTargetGroupArn && arn !== cfg.wakerTargetGroupArn)) return `${label} also forwards to other target groups`;
  if (!groups.includes(cfg.wakerTargetGroupArn)) return `${label} forwards to the target group without the waker (not instrumented)`;
  if (tags[WORKLOAD_TAG] !== cfg.workloadId) return `${label} is not tagged ${WORKLOAD_TAG} = ${cfg.workloadId}`;
  return null;
}

// Every rule of every listener of a load balancer: [{ rule, listener }].
export async function listRules(elbv2, loadBalancerArn) {
  const rows = [];
  for (const listener of await pages((i) => elbv2.describeListeners({ ...i, LoadBalancerArn: loadBalancerArn }), 'Listeners')) {
    for (const rule of await pages((i) => elbv2.describeRules({ ...i, ListenerArn: listener.ListenerArn }), 'Rules')) rows.push({ rule, listener });
  }
  return rows;
}

// Tags of rules (never default rules: their reason never depends on tags, and a default rule may not accept tags).
export async function ruleTags(elbv2, rules) {
  const tags = new Map();
  for (const batch of chunks([...new Set(rules.filter((rule) => !rule.IsDefault).map((rule) => rule.RuleArn))], 20)) {
    const { TagDescriptions = [] } = await elbv2.describeTags({ ResourceArns: batch });
    for (const d of TagDescriptions) tags.set(d.ResourceArn, Object.fromEntries((d.Tags ?? []).map((t) => [t.Key, t.Value])));
  }
  return tags;
}

// Workload id → { rules, instrumented, issues: [{ arn, priority, reason, repairable }], covered: [{ arn, by }], orphans }.
// One listing per load balancer, whatever the number of workloads (the workload list resolves them all at once).
export async function resolveRules(elbv2, cfgs) {
  const balancers = new Map();
  for (const batch of chunks([...new Set(cfgs.map((c) => c.appTargetGroupArn))], 20)) {
    const { TargetGroups = [] } = await elbv2.describeTargetGroups({ TargetGroupArns: batch });
    for (const g of TargetGroups) balancers.set(g.TargetGroupArn, g.LoadBalancerArns ?? []);
  }
  const listed = new Map();
  for (const lb of new Set([...balancers.values()].flat())) listed.set(lb, await listRules(elbv2, lb));
  const matching = new Map(cfgs.map((cfg) => [cfg.workloadId, (balancers.get(cfg.appTargetGroupArn) ?? [])
    .flatMap((lb) => listed.get(lb) ?? [])
    .filter(({ rule }) => forwardTargetGroups(rule).includes(cfg.appTargetGroupArn))]));
  const tags = await ruleTags(elbv2, [...matching.values()].flat().map(({ rule }) => rule));
  return new Map(cfgs.map((cfg) => {
    const rows = matching.get(cfg.workloadId);
    const instrumented = [];
    const issues = [];
    const covered = [];
    // Shadows to remove (their rule is gone or cannot be shadowed): switched with the others until the onboarder removes
    // them, never a reason to stay awake.
    const orphans = [];
    const tagsOf = (rule) => tags.get(rule.RuleArn) ?? {};
    const options = { appArn: cfg.appTargetGroupArn, wakerArn: cfg.wakerTargetGroupArn, workloadId: cfg.workloadId };
    const all = (balancers.get(cfg.appTargetGroupArn) ?? []).flatMap((lb) => listed.get(lb) ?? []).map((r) => ({ ...r, tags: tagsOf(r.rule) }));
    const shadows = rows.filter(({ rule }) => tagsOf(rule)[SHADOWS_TAG] && tagsOf(rule)[WORKLOAD_TAG] === cfg.workloadId);
    for (const { rule, listener } of shadows) {
      const target = rows.find((r) => r.rule.RuleArn === tagsOf(rule)[SHADOWS_TAG] && !r.rule.IsDefault);
      const why = target ? unshadowable(target.rule, options) : null;
      if (!target || why) orphans.push({ arn: rule.RuleArn, priority: rule.Priority, reason: target ? `rule ${rule.Priority} shadows rule ${target.rule.Priority}, which ${why}` : `rule ${rule.Priority} shadows a rule gone` });
    }
    for (const { rule, listener } of rows) {
      const shadow = !rule.IsDefault && !tagsOf(rule)[SHADOWS_TAG] && !unshadowable(rule, options) && shadows.find((x) => tagsOf(x.rule)[SHADOWS_TAG] === rule.RuleArn);
      if (shadow) {
        const gap = shadowGap(shadow, { rule, listener }, all.filter((r) => r.listener.ListenerArn === listener.ListenerArn), options);
        if (!gap) {
          covered.push({ arn: rule.RuleArn, by: shadow.rule.RuleArn });
          continue;
        }
        issues.push({ arn: rule.RuleArn, priority: rule.Priority, reason: `rule ${rule.Priority} is shadowed by rule ${shadow.rule.Priority} ${gap}`, repairable: true });
        continue;
      }
      const reason = issueOf(rule, listener, tagsOf(rule), cfg);
      // The onboarder repairs a rule without the waker (it shadows it) or without the workload tag; not the others.
      if (reason) issues.push({ arn: rule.RuleArn, priority: rule.Priority, reason, repairable: !rule.IsDefault && !reason.includes('other target groups') });
      else instrumented.push(rule);
    }
    if (!(balancers.get(cfg.appTargetGroupArn) ?? []).length) issues.push({ arn: null, priority: null, reason: DETACHED });
    else if (!rows.length) issues.push({ arn: null, priority: null, reason: NO_RULE });
    return [cfg.workloadId, { rules: rows.map(({ rule }) => rule), instrumented, issues, covered, orphans }];
  }));
}
