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

// Workload id → { rules, instrumented, issues: [{ arn, priority, reason }] }. One listing per load balancer, whatever the
// number of workloads (the workload list resolves them all at once).
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
    const tagsOf = (rule) => tags.get(rule.RuleArn) ?? {};
    const shadows = rows.filter(({ rule }) => tagsOf(rule)[SHADOWS_TAG] && tagsOf(rule)[WORKLOAD_TAG] === cfg.workloadId);
    for (const { rule, listener } of rows) {
      const shadow = !rule.IsDefault && !tagsOf(rule)[SHADOWS_TAG] && shadows.find((x) => tagsOf(x.rule)[SHADOWS_TAG] === rule.RuleArn);
      if (shadow) {
        const before = Number(shadow.rule.Priority) < Number(rule.Priority);
        if (before && sameConditions(shadow.rule.Conditions, rule.Conditions)) {
          covered.push({ arn: rule.RuleArn, by: shadow.rule.RuleArn });
          continue;
        }
        const why = before ? 'with other conditions' : 'placed after it';
        issues.push({ arn: rule.RuleArn, priority: rule.Priority, reason: `rule ${rule.Priority} is shadowed by rule ${shadow.rule.Priority} ${why}`, repairable: true });
        continue;
      }
      const reason = issueOf(rule, listener, tagsOf(rule), cfg);
      // The onboarder repairs a rule without the waker (it shadows it) or without the workload tag; not the others.
      if (reason) issues.push({ arn: rule.RuleArn, priority: rule.Priority, reason, repairable: !rule.IsDefault && !reason.includes('other target groups') });
      else instrumented.push(rule);
    }
    if (!(balancers.get(cfg.appTargetGroupArn) ?? []).length) issues.push({ arn: null, priority: null, reason: DETACHED });
    else if (!rows.length) issues.push({ arn: null, priority: null, reason: NO_RULE });
    return [cfg.workloadId, { rules: rows.map(({ rule }) => rule), instrumented, issues, covered }];
  }));
}
