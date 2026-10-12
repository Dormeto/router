// Discovery for the manager: every rule of the application load balancers of the region, with what Dormeto could do
// with it (managed, eligible, ineligible and why) and how idle its target group was over the last 7 days.
const WORKLOAD_TAG = 'dormeto:workload';
const ROLE_TAG = 'dormeto:role';
const HOUR_MS = 3_600_000;
const IDLE_WINDOW_HOURS = 168;

// Pages of an AWS list call: ELBv2 (Marker/NextMarker), Auto Scaling (NextToken), ECS (nextToken).
async function all(call, key, token = { in: 'Marker', out: 'NextMarker' }) {
  const items = [];
  let next;
  do {
    const page = await call(next ? { [token.in]: next } : {});
    items.push(...(page[key] ?? []));
    next = page[token.out];
  } while (next);
  return items;
}

const chunks = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

async function ruleTags(elbv2, arns) {
  const tags = new Map();
  for (const batch of chunks(arns, 20)) {
    const { TagDescriptions = [] } = await elbv2.describeTags({ ResourceArns: batch });
    for (const d of TagDescriptions) tags.set(d.ResourceArn, Object.fromEntries((d.Tags ?? []).map((t) => [t.Key, t.Value])));
  }
  return tags;
}

// Target group → Auto Scaling group name and ECS service ARN (the backends that register targets in it).
async function backendOwners({ autoscaling, ecs }) {
  const groups = new Map();
  const services = new Map();
  if (autoscaling) {
    const asgs = await all((i) => autoscaling.describeAutoScalingGroups(i), 'AutoScalingGroups', { in: 'NextToken', out: 'NextToken' });
    for (const g of asgs) for (const arn of g.TargetGroupARNs ?? []) groups.set(arn, g.AutoScalingGroupName);
  }
  if (ecs) {
    const clusters = await all((i) => ecs.listClusters(i), 'clusterArns', { in: 'nextToken', out: 'nextToken' });
    for (const cluster of clusters) {
      const arns = await all((i) => ecs.listServices({ ...i, cluster }), 'serviceArns', { in: 'nextToken', out: 'nextToken' });
      for (const batch of chunks(arns, 10)) {
        const { services: described = [] } = await ecs.describeServices({ cluster, services: batch });
        for (const s of described) for (const lb of s.loadBalancers ?? []) if (lb.targetGroupArn) services.set(lb.targetGroupArn, s.serviceArn);
      }
    }
  }
  return { groups, services };
}

// Target groups that receive traffic from the rule (weight > 0), and the type of its final action.
function forwardOf(rule) {
  const action = [...(rule.Actions ?? [])].sort((a, b) => (a.Order ?? 0) - (b.Order ?? 0)).at(-1) ?? {};
  if (action.Type !== 'forward') return { type: action.Type, groups: [], all: [] };
  const groups = action.ForwardConfig?.TargetGroups ?? [{ TargetGroupArn: action.TargetGroupArn, Weight: 1 }];
  return { type: 'forward', groups: groups.filter((g) => (g.Weight ?? 1) > 0).map((g) => g.TargetGroupArn), all: groups.map((g) => g.TargetGroupArn) };
}

function conditionsOf(rule) {
  if (rule.IsDefault) return 'default';
  const parts = (rule.Conditions ?? []).map((c) => {
    if (c.Field === 'host-header') return `host ${(c.HostHeaderConfig?.Values ?? c.Values ?? []).join(' | ')}`;
    if (c.Field === 'path-pattern') return `path ${(c.PathPatternConfig?.Values ?? c.Values ?? []).join(' | ')}`;
    return c.Field;
  });
  return parts.join(', ') || 'any';
}

const REASONS = { redirect: 'redirect action', 'fixed-response': 'fixed response', 'authenticate-oidc': 'authentication only', 'authenticate-cognito': 'authentication only' };

const lbDimension = (arn) => arn.split(':loadbalancer/')[1];
const tgDimension = (arn) => arn.split(':').at(-1);

// Hourly request sums of the last 7 days per target group: idle hours = hours without data or with 0 requests.
async function idleHours(cloudwatch, pairs, now) {
  const end = Math.floor(now() / HOUR_MS) * HOUR_MS;
  const start = end - IDLE_WINDOW_HOURS * HOUR_MS;
  const out = new Map();
  for (const batch of chunks(pairs, 500)) {
    const { MetricDataResults = [] } = await cloudwatch.getMetricData({
      StartTime: new Date(start),
      EndTime: new Date(end),
      MetricDataQueries: batch.map((p, i) => ({
        Id: `q${i}`,
        ReturnData: true,
        MetricStat: {
          Metric: {
            Namespace: 'AWS/ApplicationELB',
            MetricName: 'RequestCount',
            Dimensions: [{ Name: 'LoadBalancer', Value: lbDimension(p.lb) }, { Name: 'TargetGroup', Value: tgDimension(p.tg) }],
          },
          Period: 3600,
          Stat: 'Sum',
        },
      })),
    });
    for (const result of MetricDataResults) {
      const pair = batch[Number(result.Id.slice(1))];
      const values = result.Values ?? [];
      out.set(pair.tg, {
        idleHours7d: IDLE_WINDOW_HOURS - values.filter((v) => v > 0).length,
        requests7d: Math.round(values.reduce((sum, v) => sum + v, 0)),
      });
    }
  }
  return out;
}

export async function discoverCandidates({ elbv2, autoscaling, ecs, cloudwatch }, { now = Date.now } = {}) {
  const lbs = (await all((i) => elbv2.describeLoadBalancers(i), 'LoadBalancers')).filter((lb) => lb.Type === 'application');
  const rows = [];
  for (const lb of lbs) {
    const listeners = await all((i) => elbv2.describeListeners({ ...i, LoadBalancerArn: lb.LoadBalancerArn }), 'Listeners');
    for (const listener of listeners.sort((a, b) => a.Port - b.Port)) {
      const rules = await all((i) => elbv2.describeRules({ ...i, ListenerArn: listener.ListenerArn }), 'Rules');
      for (const rule of rules) rows.push({ lb, listener, rule, forward: forwardOf(rule) });
    }
  }
  const tags = await ruleTags(elbv2, rows.map((r) => r.rule.RuleArn));
  const visible = rows.filter((r) => tags.get(r.rule.RuleArn)?.[ROLE_TAG] !== 'admin');

  const groups = new Map((await all((i) => elbv2.describeTargetGroups(i), 'TargetGroups')).map((g) => [g.TargetGroupArn, g]));
  const usage = new Map();
  for (const r of visible) for (const arn of r.forward.groups) usage.set(arn, (usage.get(arn) ?? 0) + 1);
  const owners = await backendOwners({ autoscaling, ecs });

  const candidates = [];
  for (const { lb, listener, rule, forward } of visible) {
    const ruleTagsOf = tags.get(rule.RuleArn) ?? {};
    const group = forward.groups.length === 1 ? groups.get(forward.groups[0]) : null;
    const candidate = {
      loadBalancer: lb.LoadBalancerName,
      loadBalancerArn: lb.LoadBalancerArn,
      listener: `${listener.Protocol}:${listener.Port}`,
      ruleArn: rule.RuleArn,
      priority: rule.Priority,
      conditions: conditionsOf(rule),
      targetGroup: group?.TargetGroupName ?? null,
      targetGroupArn: group?.TargetGroupArn ?? null,
      suggestedId: group?.TargetGroupName ?? null,
      backend: null,
      idleHours7d: null,
      requests7d: null,
    };
    if (ruleTagsOf[WORKLOAD_TAG]) {
      // The application target group of a managed rule, whatever the weights (asleep, the waker has weight 1).
      const app = forward.all.map((arn) => groups.get(arn)).find((g) => g && g.TargetType !== 'lambda');
      candidates.push({
        ...candidate, targetGroup: app?.TargetGroupName ?? null, targetGroupArn: app?.TargetGroupArn ?? null,
        suggestedId: null, status: 'managed', workloadId: ruleTagsOf[WORKLOAD_TAG],
      });
      continue;
    }
    const reason = await ineligibility({ elbv2, forward, group, usage, owners, candidate });
    candidates.push(reason ? { ...candidate, status: 'ineligible', reason } : { ...candidate, status: 'eligible' });
  }

  const measured = candidates.filter((c) => c.status !== 'ineligible' && c.targetGroupArn);
  const pairs = [...new Map(measured.map((c) => [c.targetGroupArn, { lb: c.loadBalancerArn, tg: c.targetGroupArn }])).values()];
  const idle = pairs.length && cloudwatch ? await idleHours(cloudwatch, pairs, now) : new Map();
  for (const c of measured) Object.assign(c, idle.get(c.targetGroupArn) ?? {});
  return { generatedAt: new Date(now()).toISOString(), candidates };
}

// Why Dormeto cannot manage the rule, or null when it can (candidate.backend is then set).
async function ineligibility({ elbv2, forward, group, usage, owners, candidate }) {
  if (forward.type !== 'forward') return REASONS[forward.type] ?? `${forward.type} action`;
  if (forward.groups.length !== 1) return 'weighted forward to several target groups';
  if (!group) return 'target group not found';
  if (group.TargetType === 'lambda') return 'Lambda target group';
  if (group.TargetType === 'alb') return 'load balancer target group';
  const shared = usage.get(group.TargetGroupArn) ?? 0;
  if (shared > 1) return `target group shared by ${shared} rules`;
  if (owners.groups.has(group.TargetGroupArn)) {
    candidate.backend = { kind: 'asg', id: owners.groups.get(group.TargetGroupArn) };
    return null;
  }
  if (owners.services.has(group.TargetGroupArn)) {
    candidate.backend = { kind: 'ecs', id: owners.services.get(group.TargetGroupArn) };
    return null;
  }
  const { TargetHealthDescriptions = [] } = await elbv2.describeTargetHealth({ TargetGroupArn: group.TargetGroupArn });
  const ids = TargetHealthDescriptions.map((d) => d.Target?.Id).filter(Boolean);
  if (!ids.length) return 'no backend: no registered target, Auto Scaling group or ECS service';
  if (group.TargetType === 'ip') return 'IP targets without an ECS service';
  candidate.backend = { kind: 'instance', id: ids[0] };
  return null;
}
