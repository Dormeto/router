// Onboarding (R4a): preview, onboard and offboard a workload from its application target group, in the router's account
// and region. Every step finds what exists before changing anything, so an action can run again; offboarding removes only
// what onboarding added (tags carry the dormeto:tagged marker), never what the customer set.
import { createHash } from 'node:crypto';
import { checkName } from './names.mjs';
import { cleanConditions, forwardTargetGroups, listRules, passable, ruleTags, sameConditions, shadowGap, unshadowable } from './rules.mjs';
import { conditionsOf } from './route.mjs';

const WORKLOAD_TAG = 'dormeto:workload';
// Target groups per Application Load Balancer: not adjustable (the waker target group counts once its rule uses it).
const TARGET_GROUPS_PER_ALB = 100;
// A Dormeto rule just before a customer rule, with its conditions and the weighted forward: the customer's rule and its
// infrastructure as code stay untouched (R4c).
const SHADOWS_TAG = 'dormeto:shadows';
const ROUTER_TAG = 'dormeto:router';
const MARKER_TAG = 'dormeto:tagged';
const MARKER = 'onboarder';
const GROUP_TAG = 'aws:autoscaling:groupName';
const ID = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const NAME_MAX = 32;

// The router's invoke permission (design section 7): the load balancers invoke the waker from its target groups. Named
// outside the alb-<workload id> statements of routers before 0.20.0, which offboarding removes.
export const ROUTER_PERMISSION = 'dormeto-alb';

// The workload id of a target group (design section 7): 16 hexadecimal characters of the SHA-256 of its ARN. Unique per
// router, as required, and across accounts in practice (the ARN carries the partition, region, account, name and id).
export const workloadIdOf = (targetGroupArn) => createHash('sha256').update(targetGroupArn).digest('hex').slice(0, 16);
// The workload module's defaults; a workload with databases waits longer for them to start.
const DEFAULTS = { waitSeconds: 60, idleMinutes: 15, drainSeconds: 30, wakeTimeoutSeconds: 600, failedRetrySeconds: 60, maxHolders: 50, pollSeconds: 3, wakeMode: 'any' };
const DATABASE_WAKE_TIMEOUT = 1800;
const SETTINGS = {
  waitSeconds: [5, 120], idleMinutes: [5, 1440], drainSeconds: [0, 300], wakeTimeoutSeconds: [60, 3600], maxHolders: [1, 500],
};
const KIND_TEXT = { instance: 'instance', asg: 'Auto Scaling group', ecs: 'ECS service', 'rds-instance': 'RDS instance', 'rds-cluster': 'RDS cluster' };

const tagsOf = (list = [], key = 'Key', value = 'Value') => Object.fromEntries(list.map((t) => [t[key], t[value]]));
const chunks = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));
const notFound = (err, ...names) => names.includes(err?.name);

async function pages(call, key, token = { in: 'NextToken', out: 'NextToken' }) {
  const items = [];
  let next;
  do {
    const page = await call(next ? { [token.in]: next } : {});
    items.push(...(page[key] ?? []));
    next = page[token.out];
  } while (next);
  return items;
}

// A rule's forward action sent to the application only: plain, or weighted with the waker.
function instrumentedActions(actions, app, waker, weights) {
  return actions.map((action) => {
    const copy = structuredClone(action);
    if (copy.Type === 'forward' && forwardTargetGroups({ Actions: [copy] }).includes(app)) {
      copy.ForwardConfig = {
        TargetGroups: waker ? [{ TargetGroupArn: app, Weight: weights.app }, { TargetGroupArn: waker, Weight: weights.waker }] : [{ TargetGroupArn: app, Weight: 1 }],
        TargetGroupStickinessConfig: copy.ForwardConfig?.TargetGroupStickinessConfig ?? { Enabled: false },
      };
      // ModifyRule rejects TargetGroupArn together with a multi target group ForwardConfig.
      delete copy.TargetGroupArn;
    }
    // DescribeRules never returns the OIDC client secret: keep the stored one.
    if (copy.AuthenticateOidcConfig && !copy.AuthenticateOidcConfig.ClientSecret) copy.AuthenticateOidcConfig.UseExistingClientSecret = true;
    return copy;
  });
}

// For each customer rule forwarding to the target group (default rules aside), per listener: shadowed already, a shadow
// to create, mirror or move, instrumented in place (with why), or refused; and the shadows to remove. A shadow passes over
// only what `passable` allows (rules.mjs): anything else between it and its rule would see its requests taken.
export function planRules(rows, { targetGroupArn, wakerArn, workloadId }) {
  const options = { appArn: targetGroupArn, wakerArn, workloadId };
  const priority = (row) => Number(row.rule.Priority);
  const isShadow = (row) => Boolean(row.tags?.[SHADOWS_TAG]) && row.tags?.[WORKLOAD_TAG] === workloadId;
  const plans = [];
  const planned = new Set();
  const orphan = (shadow, reason) => {
    plans.push({ row: shadow, action: 'orphan', reason });
    planned.add(shadow.rule.RuleArn);
  };
  for (const listenerArn of new Set(rows.map((r) => r.listener.ListenerArn))) {
    const here = rows.filter((r) => r.listener.ListenerArn === listenerArn && !r.rule.IsDefault);
    const taken = new Map(here.map((r) => [priority(r), r]));
    // The first free priority before a rule, passing over only what its shadow may pass over.
    const slotBefore = (row) => {
      for (let q = priority(row) - 1; q >= 1; q -= 1) {
        const occupant = taken.get(q);
        if (!occupant) return q;
        if (occupant !== 'planned' && !passable(occupant, row.rule, options)) return null;
      }
      return null;
    };
    const create = (row) => {
      const slot = slotBefore(row);
      if (slot === null) return plans.push({ row, action: 'in place', reason: 'no free priority before it' });
      taken.set(slot, 'planned');
      return plans.push({ row, action: 'shadow', priority: slot });
    };
    const customers = here.filter((r) => !r.tags?.[SHADOWS_TAG] && forwardTargetGroups(r.rule).includes(targetGroupArn)).sort((a, b) => priority(a) - priority(b));
    for (const row of customers) {
      // Two repairs at once may each create a shadow: the closest one before the rule stays.
      const distance = (r) => (priority(r) < priority(row) ? priority(row) - priority(r) : 100000 + priority(r));
      let [shadow, ...duplicates] = rows.filter((r) => isShadow(r) && r.tags[SHADOWS_TAG] === row.rule.RuleArn).sort((a, b) => distance(a) - distance(b));
      for (const d of duplicates) orphan(d, 'a second shadow of its rule');
      const why = unshadowable(row.rule, options);
      if (why === 'forwards to other target groups') {
        if (shadow) orphan(shadow, `its rule ${why}`);
        plans.push({ row, action: 'refused' });
        continue;
      }
      if (wakerArn && forwardTargetGroups(row.rule).includes(wakerArn)) {
        if (shadow) orphan(shadow, 'its rule is instrumented in place');
        plans.push({ row, action: 'instrumented' });
        continue;
      }
      // Instrumented in place before its shadow goes (while the shadow exists, the rule is never reached).
      if (why) {
        plans.push({ row, action: 'in place', reason: why === 'has transforms' ? 'transforms' : 'actions before the forward' });
        if (shadow) orphan(shadow, `its rule ${why}`);
        continue;
      }
      const gap = shadow ? shadowGap(shadow, row, here, options) : null;
      if (gap === 'on another listener') {
        orphan(shadow, 'on another listener than its rule');
        shadow = null;
      }
      if (!shadow) create(row);
      else if (!gap) plans.push({ row, shadow, action: 'shadowed' });
      else if (gap === 'with other conditions') plans.push({ row, shadow, action: 'mirror' });
      else {
        const slot = slotBefore(row);
        if (slot !== null) {
          taken.set(slot, 'planned');
          plans.push({ row, shadow, action: 'move', priority: slot, mirror: !sameConditions(shadow.rule.Conditions, row.rule.Conditions) });
        } else {
          plans.push({ row, action: 'in place', reason: 'no free priority before it' });
          orphan(shadow, 'no free priority before its rule');
        }
      }
    }
  }
  // Shadows of rules gone (deleted, or no longer forwarding to the target group).
  const customerArns = new Set(rows.filter((r) => !r.rule.IsDefault && !r.tags?.[SHADOWS_TAG] && forwardTargetGroups(r.rule).includes(targetGroupArn)).map((r) => r.rule.RuleArn));
  for (const row of rows.filter((r) => isShadow(r) && !planned.has(r.rule.RuleArn) && !customerArns.has(r.tags[SHADOWS_TAG]))) orphan(row, 'its rule is gone');
  return plans;
}

const planText = (p) => ({
  shadowed: 'shadowed', instrumented: 'instrumented', mirror: 'shadowed (conditions to mirror)', move: 'shadowed (shadow to move before it)', shadow: `shadow at ${p.priority}`,
  refused: 'refused (forwards to other target groups)',
})[p.action] ?? `instrument in place (${p.reason})`;

export function createOnboarding({ elbv2, ec2, autoscaling, ecs, rds, lambda, store, router, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log }) {
  const wakerName = (workloadId) => `${router.name}-${workloadId}`;

  async function targetGroup(arn) {
    try {
      return (await elbv2.describeTargetGroups({ TargetGroupArns: [arn] })).TargetGroups?.[0] ?? null;
    } catch (err) {
      if (notFound(err, 'TargetGroupNotFoundException')) return null;
      throw err;
    }
  }

  // The waker target group of the workload, with whether it is tagged as such (a group of the same name that is not is
  // never touched).
  async function wakerGroup(workloadId) {
    let group;
    try {
      group = (await elbv2.describeTargetGroups({ Names: [wakerName(workloadId)] })).TargetGroups?.[0] ?? null;
    } catch (err) {
      if (notFound(err, 'TargetGroupNotFoundException')) return null;
      throw err;
    }
    if (!group) return null;
    const { TagDescriptions: [d] = [] } = await elbv2.describeTags({ ResourceArns: [group.TargetGroupArn] });
    return { ...group, ours: tagsOf(d?.Tags)[WORKLOAD_TAG] === workloadId };
  }

  // Every rule of the target group's load balancers, with the tags of those forwarding to it (shadows included).
  async function listenerRows(group) {
    const rows = [];
    for (const lb of group.LoadBalancerArns ?? []) rows.push(...(await listRules(elbv2, lb)));
    const tags = await ruleTags(elbv2, rows.filter(({ rule }) => forwardTargetGroups(rule).includes(group.TargetGroupArn)).map(({ rule }) => rule));
    return rows.map((row) => ({ ...row, tags: tags.get(row.rule.RuleArn) ?? {} }));
  }

  // Rules forwarding to the target group, on its load balancers, with their tags.
  async function rulesTo(group) {
    return (await listenerRows(group)).filter(({ rule }) => forwardTargetGroups(rule).includes(group.TargetGroupArn));
  }

  // Backends feeding the target group, whatever their tags: Auto Scaling groups attached to it, ECS services registered with
  // it, instances among its targets that no group owns.
  async function backendsOf(group) {
    const backends = [];
    for (const g of await pages((i) => autoscaling.describeAutoScalingGroups(i), 'AutoScalingGroups')) {
      if ((g.TargetGroupARNs ?? []).includes(group.TargetGroupArn)) backends.push({ kind: 'asg', id: g.AutoScalingGroupName, tags: tagsOf(g.Tags) });
    }
    for (const cluster of await pages((i) => ecs.listClusters(i), 'clusterArns', { in: 'nextToken', out: 'nextToken' })) {
      // 100 per page (ECS gives 10 by default): a cluster may run hundreds of services.
      const arns = await pages((i) => ecs.listServices({ ...i, cluster, maxResults: 100 }), 'serviceArns', { in: 'nextToken', out: 'nextToken' });
      for (const batch of chunks(arns, 10)) {
        const { services = [] } = await ecs.describeServices({ cluster, services: batch, include: ['TAGS'] });
        for (const service of services) {
          if ((service.loadBalancers ?? []).some((l) => l.targetGroupArn === group.TargetGroupArn)) backends.push({ kind: 'ecs', id: service.serviceArn, tags: tagsOf(service.tags, 'key', 'value') });
        }
      }
    }
    if (group.TargetType === 'instance') {
      const { TargetHealthDescriptions = [] } = await elbv2.describeTargetHealth({ TargetGroupArn: group.TargetGroupArn });
      const ids = TargetHealthDescriptions.map((d) => d.Target?.Id).filter((id) => id?.startsWith('i-'));
      if (ids.length) {
        const { Reservations = [] } = await ec2.describeInstances({ InstanceIds: ids });
        for (const instance of Reservations.flatMap((r) => r.Instances ?? [])) {
          const tags = tagsOf(instance.Tags);
          if (!tags[GROUP_TAG]) backends.push({ kind: 'instance', id: instance.InstanceId, tags });
        }
      }
    }
    return backends;
  }

  // Companion databases; with `skipMissing`, a database deleted since is left out (offboarding).
  async function databasesOf(list = [], { skipMissing = false } = {}) {
    const found = [];
    for (const { kind, id } of list) {
      try {
        if (kind === 'rds-cluster') {
          const { DBClusters: [db] = [] } = await rds.describeDBClusters({ DBClusterIdentifier: id });
          found.push({ kind, id, arn: db.DBClusterArn, tags: tagsOf(db.TagList) });
        } else {
          const { DBInstances: [db] = [] } = await rds.describeDBInstances({ DBInstanceIdentifier: id });
          found.push({ kind: 'rds-instance', id, arn: db.DBInstanceArn, tags: tagsOf(db.TagList) });
        }
      } catch (err) {
        if (!(skipMissing && notFound(err, 'DBInstanceNotFoundFault', 'DBClusterNotFoundFault'))) throw err;
      }
    }
    return found;
  }

  function settingsProblems(settings = {}) {
    const problems = [];
    for (const [key, value] of Object.entries(settings)) {
      if (key === 'wakeMode') {
        if (!['any', 'browser'].includes(value)) problems.push('settings: wakeMode must be any or browser');
      } else if (SETTINGS[key]) {
        const [min, max] = SETTINGS[key];
        if (!Number.isInteger(value) || value < min || value > max) problems.push(`settings: ${key} must be an integer from ${min} to ${max}`);
      } else problems.push(`settings: unknown setting ${key}`);
    }
    return problems;
  }

  // Quotas (scale design §6): room on the load balancer for the waker target group (100 target groups, not adjustable) and
  // the shadow rules (its rules quota), and in the region for the waker target group.
  async function quotaProblems(loadBalancerArn, { wakerExists, shadows, rules }) {
    const problems = [];
    const limits = Object.fromEntries(((await elbv2.describeAccountLimits({})).Limits ?? []).map((l) => [l.Name, Number(l.Max)]));
    const elb = { in: 'Marker', out: 'NextMarker' };
    if (!wakerExists) {
      const onBalancer = await pages((i) => elbv2.describeTargetGroups({ ...i, LoadBalancerArn: loadBalancerArn }), 'TargetGroups', elb);
      if (onBalancer.length >= TARGET_GROUPS_PER_ALB) problems.push(`the load balancer has ${onBalancer.length} target groups, its maximum (not adjustable): no room for the waker target group`);
    }
    const ruleMax = limits['rules-per-application-load-balancer'];
    if (ruleMax && shadows && rules + shadows > ruleMax) {
      problems.push(`the load balancer has ${rules} rules of the ${ruleMax} it may have: no room for ${shadows} shadow rule${shadows === 1 ? '' : 's'} (rules per Application Load Balancer, adjustable in Service Quotas)`);
    }
    const groupMax = limits['target-groups'];
    if (!wakerExists && groupMax) {
      const inRegion = await pages((i) => elbv2.describeTargetGroups(i), 'TargetGroups', elb);
      if (inRegion.length >= groupMax) problems.push(`the region has ${inRegion.length} target groups of the ${groupMax} it may have: no room for the waker target group (target groups per region, adjustable in Service Quotas)`);
    }
    return problems;
  }

  // What onboarding would do, and why it cannot. `found` (onboard) receives the backends and databases it listed.
  // Without an id, the one of the target group (an explicit id: workloads named before 0.20.0, direct use).
  async function preview({ targetGroupArn, workloadId = targetGroupArn ? workloadIdOf(targetGroupArn) : undefined, name: wanted, settings, databases }, found = {}) {
    const problems = [];
    const name = wakerName(workloadId ?? '');
    const named = checkName(wanted);
    if (named.problem) problems.push(named.problem);
    if (!ID.test(workloadId ?? '')) problems.push('workload id: lowercase letters, digits and hyphens, not starting or ending with a hyphen');
    else if (name.length > NAME_MAX) problems.push(`workload id too long: ${name} exceeds the ${NAME_MAX} characters of a target group name`);
    problems.push(...settingsProblems(settings));
    const configs = await store.listConfigs();
    const existing = configs.find((c) => c.workloadId === workloadId);
    if (existing && existing.appTargetGroupArn !== targetGroupArn) problems.push(`workload ${workloadId} already exists with another target group`);
    const owner = configs.find((c) => c.appTargetGroupArn === targetGroupArn && c.workloadId !== workloadId);
    if (owner) problems.push(`the target group is already workload ${owner.workloadId}`);

    const group = await targetGroup(targetGroupArn);
    // The name people see: the one asked for, else the target group's.
    const result = { workloadId, name: named.name || (group?.TargetGroupName ?? ''), targetGroupArn, wakerTargetGroupName: name, loadBalancerArn: null, rules: [], backends: [], databases: [] };
    if (!group) return { ...result, ok: false, problems: [...problems, 'target group not found'] };
    if (!['instance', 'ip'].includes(group.TargetType)) problems.push(`target type ${group.TargetType} is not supported`);
    const lbs = group.LoadBalancerArns ?? [];
    if (!lbs.length) problems.push('the target group is not attached to a load balancer');
    if (lbs.length > 1) problems.push('the target group is attached to several load balancers');
    result.loadBalancerArn = lbs[0] ?? null;

    const waker = await wakerGroup(workloadId);
    if (waker && !waker.ours) problems.push(`target group ${waker.TargetGroupName} exists and is not the waker of ${workloadId}`);
    const rows = await listenerRows(group);
    const plans = planRules(rows, { targetGroupArn, wakerArn: waker?.ours ? waker.TargetGroupArn : null, workloadId });
    for (const { rule, listener, tags } of rows.filter((r) => forwardTargetGroups(r.rule).includes(targetGroupArn) && !r.tags[SHADOWS_TAG])) {
      const groups = forwardTargetGroups(rule);
      const entry = { arn: rule.RuleArn, priority: rule.Priority, conditions: conditionsOf(rule) };
      if (rule.IsDefault) problems.push(`the listener default action of ${listener.Protocol}:${listener.Port} forwards to the target group (not supported yet)`);
      else if (groups.some((g) => g !== targetGroupArn && g !== waker?.TargetGroupArn)) problems.push(`rule ${rule.Priority} also forwards to other target groups`);
      else entry.action = planText(plans.find((p) => p.row.rule.RuleArn === rule.RuleArn && p.action !== 'orphan'));
      result.rules.push(entry);
    }
    // By priority, listener default rules last (DescribeRules gives no order across listeners).
    const rank = (r) => (r.priority === 'default' ? Infinity : Number(r.priority));
    result.rules.sort((a, b) => rank(a) - rank(b));
    if (lbs.length && !result.rules.length) problems.push('no rule forwards to the target group');
    if (result.loadBalancerArn) {
      problems.push(...await quotaProblems(result.loadBalancerArn, {
        wakerExists: Boolean(waker?.ours), shadows: plans.filter((p) => p.action === 'shadow').length, rules: rows.filter((r) => !r.rule.IsDefault).length,
      }));
    }

    const backends = await backendsOf(group);
    found.backends = backends;
    if (!backends.length) problems.push('no backend: no instance, Auto Scaling group or ECS service feeds the target group');
    for (const b of backends) {
      const tagged = b.tags[WORKLOAD_TAG] ?? null;
      if (tagged && tagged !== workloadId) problems.push(`${KIND_TEXT[b.kind]} ${b.id} belongs to workload ${tagged}`);
      result.backends.push({ kind: b.kind, id: b.id, tagged });
    }
    found.databases = await databasesOf(databases);
    for (const db of found.databases) {
      const tagged = db.tags[WORKLOAD_TAG] ?? null;
      if (tagged && tagged !== workloadId) problems.push(`${KIND_TEXT[db.kind]} ${db.id} belongs to workload ${tagged}`);
      result.databases.push({ kind: db.kind, id: db.id, tagged });
    }
    return { ...result, ok: problems.length === 0, problems };
  }

  // Tag a backend with the workload and the marker (only if it has no dormeto:workload tag yet).
  async function tag(b, workloadId) {
    const tags = { [WORKLOAD_TAG]: workloadId, [MARKER_TAG]: MARKER };
    if (b.kind === 'instance') await ec2.createTags({ Resources: [b.id], Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })) });
    else if (b.kind === 'asg') await autoscaling.createOrUpdateTags({ Tags: Object.entries(tags).map(([Key, Value]) => ({ ResourceId: b.id, ResourceType: 'auto-scaling-group', Key, Value, PropagateAtLaunch: false })) });
    else if (b.kind === 'ecs') await ecs.tagResource({ resourceArn: b.id, tags: Object.entries(tags).map(([key, value]) => ({ key, value })) });
    else await rds.addTagsToResource({ ResourceName: b.arn, Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })) });
  }

  async function untag(b) {
    const keys = [WORKLOAD_TAG, MARKER_TAG];
    if (b.kind === 'instance') await ec2.deleteTags({ Resources: [b.id], Tags: keys.map((Key) => ({ Key })) });
    else if (b.kind === 'asg') await autoscaling.deleteTags({ Tags: keys.map((Key) => ({ ResourceId: b.id, ResourceType: 'auto-scaling-group', Key })) });
    else if (b.kind === 'ecs') await ecs.untagResource({ resourceArn: b.id, tagKeys: keys });
    else await rds.removeTagsFromResource({ ResourceName: b.arn, TagKeys: keys });
  }

  async function onboard({ targetGroupArn, workloadId = targetGroupArn ? workloadIdOf(targetGroupArn) : undefined, name, settings = {}, databases = [], by }) {
    // The backends and databases its preview listed: listed once per onboarding.
    const found = {};
    const checked = await preview({ workloadId, targetGroupArn, name, settings, databases }, found);
    if (!checked.ok) throw new Error(`cannot onboard ${workloadId}: ${checked.problems.join('; ')}`);
    const steps = [];
    const step = (name, done, detail) => steps.push({ name, status: done ? 'done' : 'skipped', ...(detail ? { detail } : {}) });
    // Only a new workload is undone on a failure, and only once something changed: a failing run on an existing workload
    // leaves it as it was (run it again).
    const fresh = !(await store.getConfig(workloadId));
    let changed = false;
    // What this onboarding tagged: recorded in the configuration, removed by offboarding (and by an undo).
    const tagged = [];
    try {
      const group = await targetGroup(targetGroupArn);
      const untagged = [...found.backends, ...found.databases].filter((b) => !b.tags[WORKLOAD_TAG]);
      for (const b of untagged) {
        changed = true;
        await tag(b, workloadId);
        tagged.push({ kind: b.kind, id: b.id, ...(b.arn ? { arn: b.arn } : {}) });
      }
      step('tag backends', untagged.length > 0, untagged.map((b) => `${KIND_TEXT[b.kind]} ${b.id}`).join(', '));

      let waker = await wakerGroup(workloadId);
      if (!waker) {
        changed = true;
        waker = (await elbv2.createTargetGroup({
          Name: wakerName(workloadId), TargetType: 'lambda', Tags: [{ Key: WORKLOAD_TAG, Value: workloadId }, { Key: ROUTER_TAG, Value: router.name }],
        })).TargetGroups[0];
        await elbv2.modifyTargetGroupAttributes({ TargetGroupArn: waker.TargetGroupArn, Attributes: [{ Key: 'lambda.multi_value_headers.enabled', Value: 'true' }] });
        step('waker target group', true, waker.TargetGroupName);
      } else step('waker target group', false, waker.TargetGroupName);

      // The router's own permission (dormeto-alb) lets the load balancers invoke the waker from its target groups.
      const { TargetHealthDescriptions = [] } = await elbv2.describeTargetHealth({ TargetGroupArn: waker.TargetGroupArn });
      const registered = TargetHealthDescriptions.some((d) => d.Target?.Id === router.wakerFunctionArn);
      // A permission just created (a router just installed) takes seconds to be seen by the load balancer: retry meanwhile.
      for (let attempt = 1; !registered; attempt += 1) {
        try {
          await elbv2.registerTargets({ TargetGroupArn: waker.TargetGroupArn, Targets: [{ Id: router.wakerFunctionArn }] });
          break;
        } catch (err) {
          if (attempt >= 10 || !/does not have permission to invoke/.test(err.message ?? '')) throw err;
          await sleep(3000);
        }
      }
      step('register waker', !registered);

      if (!(await store.getConfig(workloadId))) {
        const lb = checked.loadBalancerArn;
        await store.putConfig(workloadId, {
          workloadId, name: checked.name, appTargetGroupArn: targetGroupArn, wakerTargetGroupArn: waker.TargetGroupArn,
          loadBalancerDimension: lb.slice(lb.indexOf('loadbalancer/') + 'loadbalancer/'.length), appTargetGroupDimension: targetGroupArn.split(':').at(-1),
          instanceIds: [], ...DEFAULTS, ...(databases.length ? { wakeTimeoutSeconds: DATABASE_WAKE_TIMEOUT } : {}), ...settings,
          noWakeRules: [], wakeRules: [], admin: { enabled: false, secretHash: '', secretParameter: '' },
          source: 'manager', onboardedBy: by ?? 'unknown', onboardedAt: new Date(now()).toISOString(), databases, tagged,
        });
        await store.initRun(workloadId, now());
        step('workload configuration', true);
      } else step('workload configuration', false);

      const applied = await applyRules({ ...group, LoadBalancerArns: [checked.loadBalancerArn] }, workloadId, waker.TargetGroupArn, { app: 1, waker: 0 });
      step('instrument rules', applied.length > 0, applied.map((a) => a.detail).join(', '));
      log.info('Onboarded', { workloadId, targetGroupArn, by, steps: steps.filter((s) => s.status === 'done').map((s) => s.name) });
      return { steps, workload: { workloadId, name: checked.name, wakerTargetGroupArn: waker.TargetGroupArn } };
    } catch (err) {
      if (!fresh || !changed) throw err;
      // Undo: whatever was done is removed, step by step, going on after a failed step.
      const undo = await clean(workloadId, targetGroupArn, databases, tagged);
      const failed = undo.filter((s) => s.status === 'failed');
      log.warn('OnboardUndone', { workloadId, error: err.message, failed: failed.map((s) => s.name) });
      throw new Error(`cannot onboard ${workloadId}: ${err.message} (${failed.length ? `undo incomplete: ${failed.map((s) => `${s.name}: ${s.detail}`).join('; ')}` : 'undone'})`);
    }
  }

  // Shadows to create, mirror, move or remove, rules to instrument in place: what changed, as { kind, detail }. `weights`
  // follow the workload's state (a shadow created while it sleeps sends to the waker).
  async function applyRules(group, workloadId, wakerArn, weights) {
    const changed = [];
    const change = (kind, detail) => changed.push({ kind, detail });
    const rows = await listenerRows(group);
    for (const plan of planRules(rows, { targetGroupArn: group.TargetGroupArn, wakerArn, workloadId })) {
      const { rule } = plan.row;
      if (plan.action === 'shadow') {
        change('shadow created', `shadow of rule ${rule.Priority} at ${plan.priority}`);
        await elbv2.createRule({
          ListenerArn: plan.row.listener.ListenerArn, Priority: plan.priority, Conditions: cleanConditions(rule.Conditions),
          Actions: [{ Type: 'forward', ForwardConfig: {
            TargetGroups: [{ TargetGroupArn: group.TargetGroupArn, Weight: weights.app }, { TargetGroupArn: wakerArn, Weight: weights.waker }],
            TargetGroupStickinessConfig: rule.Actions[0].ForwardConfig?.TargetGroupStickinessConfig ?? { Enabled: false },
          } }],
          Tags: [{ Key: WORKLOAD_TAG, Value: workloadId }, { Key: SHADOWS_TAG, Value: rule.RuleArn }],
        });
      } else if (plan.action === 'mirror' || (plan.action === 'move' && plan.mirror)) {
        change('shadow conditions mirrored', `shadow of rule ${rule.Priority}: ${conditionsOf(rule)}`);
        await elbv2.modifyRule({ RuleArn: plan.shadow.rule.RuleArn, Conditions: cleanConditions(rule.Conditions) });
      }
      if (plan.action === 'move') {
        change('shadow moved', `shadow of rule ${rule.Priority} from ${plan.shadow.rule.Priority} to ${plan.priority}`);
        await elbv2.setRulePriorities({ RulePriorities: [{ RuleArn: plan.shadow.rule.RuleArn, Priority: plan.priority }] });
      } else if (plan.action === 'orphan') {
        change('shadow removed', `shadow at ${rule.Priority}: ${plan.reason}`);
        await elbv2.deleteRule({ RuleArn: rule.RuleArn });
      } else if (plan.action === 'in place') {
        change('rule instrumented in place', `rule ${rule.Priority} (${plan.reason})`);
        await elbv2.modifyRule({ RuleArn: rule.RuleArn, Actions: instrumentedActions(rule.Actions, group.TargetGroupArn, wakerArn, weights) });
        await elbv2.addTags({ ResourceArns: [rule.RuleArn], Tags: [{ Key: WORKLOAD_TAG, Value: workloadId }] });
      } else if (plan.action === 'instrumented' && plan.row.tags[WORKLOAD_TAG] !== workloadId) {
        change('rule tag restored', `rule ${rule.Priority}`);
        await elbv2.addTags({ ResourceArns: [rule.RuleArn], Tags: [{ Key: WORKLOAD_TAG, Value: workloadId }] });
      }
    }
    return changed;
  }

  // Current tags of a backend recorded at onboarding, null when it is gone.
  async function currentTags(b) {
    try {
      if (b.kind === 'instance') {
        const { Reservations = [] } = await ec2.describeInstances({ InstanceIds: [b.id] });
        const instance = Reservations.flatMap((r) => r.Instances ?? [])[0];
        return instance ? tagsOf(instance.Tags) : null;
      }
      if (b.kind === 'asg') {
        const { AutoScalingGroups: [g] = [] } = await autoscaling.describeAutoScalingGroups({ AutoScalingGroupNames: [b.id] });
        return g ? tagsOf(g.Tags) : null;
      }
      if (b.kind === 'ecs') {
        const cluster = b.id.split(':service/')[1]?.split('/')[0];
        const { services: [svc] = [] } = await ecs.describeServices({ cluster, services: [b.id], include: ['TAGS'] });
        return svc ? tagsOf(svc.tags, 'key', 'value') : null;
      }
      const [db] = await databasesOf([{ kind: b.kind, id: b.id }], { skipMissing: true });
      return db ? db.tags : null;
    } catch (err) {
      if (notFound(err, 'InvalidInstanceID.NotFound', 'ServiceNotFoundException', 'ClusterNotFoundException')) return null;
      throw err;
    }
  }

  // Re-apply what drifted (R4c): rules and shadows, backend tags, the waker target group; each repair is a drift event.
  async function repair({ workloadId, by = 'check' }) {
    const cfg = await store.getConfig(workloadId);
    if (!cfg?.source) return { repaired: [], skipped: 'not onboarded by the manager' };
    if ((await store.getPauses(workloadId)).some((p) => p.reason === 'offboarding')) return { repaired: [], skipped: 'being offboarded' };
    const run = await store.getRun(workloadId);
    const repairs = [];
    for (const b of cfg.tagged ?? []) {
      const tags = await currentTags(b);
      if (tags && tags[WORKLOAD_TAG] !== workloadId) {
        await tag(b, workloadId);
        repairs.push({ kind: 'backend tag restored', detail: `${KIND_TEXT[b.kind]} ${b.id}` });
      }
    }
    const waker = await wakerGroup(workloadId);
    const group = await targetGroup(cfg.appTargetGroupArn);
    if (waker?.ours && group) {
      // Asleep, failed or between: the instrumentation sends to the waker; awake, to the application.
      const weights = run?.state === 'AWAKE' ? { app: 1, waker: 0 } : { app: 0, waker: 1 };
      repairs.push(...await applyRules(group, workloadId, waker.TargetGroupArn, weights));
    }
    const at = new Date(now()).toISOString();
    for (const e of repairs) await store.putDrift(workloadId, { at, by, ...e });
    if (repairs.length) log.warn('DriftRepaired', { workloadId, by, repaired: repairs.map((e) => `${e.kind}: ${e.detail}`) });
    return { repaired: repairs };
  }

  // Remove the instrumentation, step by step, each step going on whatever the others did: rules first (traffic stays on
  // the application), then the waker target group (in use by rules until then), the permission, the tags, the workload.
  async function clean(workloadId, targetGroupArn, databases = [], tagged = []) {
    const steps = [];
    const run = async (name, work) => {
      try {
        const detail = await work();
        steps.push({ name, status: detail === false ? 'skipped' : 'done', ...(typeof detail === 'string' && detail ? { detail } : {}) });
      } catch (err) {
        steps.push({ name, status: 'failed', detail: err.message });
      }
    };
    const group = targetGroupArn ? await targetGroup(targetGroupArn) : null;
    const found = await wakerGroup(workloadId);
    const waker = found?.ours ? found : null;
    await run('restore rules', async () => {
      if (!group) return false;
      let restored = 0;
      for (const { rule, tags } of await rulesTo(group)) {
        // Shadows go first: traffic falls back to the customer's rules, which forward to the application.
        if (tags[SHADOWS_TAG] && tags[WORKLOAD_TAG] === workloadId) {
          await elbv2.deleteRule({ RuleArn: rule.RuleArn });
          restored += 1;
          continue;
        }
        if (waker && forwardTargetGroups(rule).includes(waker.TargetGroupArn)) {
          await elbv2.modifyRule({ RuleArn: rule.RuleArn, Actions: instrumentedActions(rule.Actions, targetGroupArn, null) });
          restored += 1;
        }
        if (tags[WORKLOAD_TAG] === workloadId) {
          await elbv2.removeTags({ ResourceArns: [rule.RuleArn], TagKeys: [WORKLOAD_TAG] });
          restored += 1;
        }
      }
      return restored > 0;
    });
    await run('waker target group', async () => {
      if (!waker) return false;
      await elbv2.deregisterTargets({ TargetGroupArn: waker.TargetGroupArn, Targets: [{ Id: router.wakerFunctionArn }] });
      await elbv2.deleteTargetGroup({ TargetGroupArn: waker.TargetGroupArn });
      return waker.TargetGroupName;
    });
    await run('invoke permission', async () => {
      try {
        await lambda.removePermission({ FunctionName: router.wakerFunctionName, StatementId: `alb-${workloadId}` });
        return true;
      } catch (err) {
        if (notFound(err, 'ResourceNotFoundException')) return false;
        throw err;
      }
    });
    await run('untag backends', async () => {
      // What onboarding recorded, and what still carries its marker among the backends of the target group.
      const marked = [...(group ? await backendsOf(group) : []), ...(await databasesOf(databases, { skipMissing: true }))]
        .filter((b) => b.tags[WORKLOAD_TAG] === workloadId && b.tags[MARKER_TAG] === MARKER);
      const found = [...tagged, ...marked.filter((b) => !tagged.some((t) => t.kind === b.kind && t.id === b.id))];
      const done = [];
      for (const b of found) {
        try {
          await untag(b);
          done.push(`${KIND_TEXT[b.kind]} ${b.id}`);
        } catch (err) {
          // Deleted since onboarding: nothing to untag.
          if (!notFound(err, 'InvalidInstanceID.NotFound', 'ValidationError', 'ResourceNotFoundException', 'ServiceNotFoundException', 'DBInstanceNotFoundFault', 'DBClusterNotFoundFault')) throw err;
        }
      }
      return done.length ? done.join(', ') : false;
    });
    await run('workload configuration', async () => {
      // An incomplete offboarding keeps what it needs to finish when run again.
      if (steps.some((x) => x.status === 'failed')) return false;
      if (!(await store.getConfig(workloadId)) && !(await store.getRun(workloadId))) return false;
      await store.deleteWorkload(workloadId);
      return true;
    });
    return steps;
  }

  async function offboard({ workloadId, by }) {
    const cfg = await store.getConfig(workloadId);
    if (cfg && !cfg.source) throw new Error(`cannot offboard ${workloadId}: written by Terraform, remove its workload module instead`);
    const run = await store.getRun(workloadId);
    // Paused first: no nap starts, and a nap already draining aborts at its commit point, while the instrumentation goes.
    if (cfg || run) await store.putPause(workloadId, { by: by ?? 'unknown', at: now(), reason: 'offboarding', keepAsleep: true });
    if (run && run.state !== 'AWAKE') throw new Error(`cannot offboard ${workloadId}: it is ${run.state}, wake it first`);
    const steps = await clean(workloadId, cfg?.appTargetGroupArn, cfg?.databases, cfg?.tagged);
    const failed = steps.filter((s) => s.status === 'failed');
    log.info('Offboarded', { workloadId, by, steps: steps.map((s) => `${s.name} ${s.status}`) });
    if (failed.length) throw new Error(`offboard of ${workloadId} incomplete: ${failed.map((s) => `${s.name}: ${s.detail}`).join('; ')}`);
    return { steps };
  }

  // A CloudTrail event (EventBridge) on rules, target groups or tags: repair every workload the manager onboarded.
  // Whether a CloudTrail event may concern a workload: its parameters name the workload's load balancer (rule and listener
  // ARNs), its target group, its waker's, or a backend it tagged. Without an event (a manual run), every workload.
  function concerns(cfg, detail) {
    if (!detail) return true;
    const text = JSON.stringify([detail.requestParameters, detail.responseElements]);
    const marks = [cfg.loadBalancerDimension, cfg.appTargetGroupDimension ?? cfg.appTargetGroupArn, `targetgroup/${router.name}-${cfg.workloadId}/`, ...(cfg.tagged ?? []).map((b) => b.id)];
    return marks.filter(Boolean).some((mark) => text.includes(mark));
  }

  // Repair the workloads an event concerns, each on its own: one failing never stops the others.
  async function repairAll({ by, detail = null }) {
    const workloads = [];
    for (const cfg of (await store.listConfigs()).filter((c) => c.source && concerns(c, detail))) {
      try {
        const { repaired } = await repair({ workloadId: cfg.workloadId, by });
        workloads.push({ workloadId: cfg.workloadId, repaired: repaired.map((e) => e.kind) });
      } catch (err) {
        log.error('RepairFailed', { workloadId: cfg.workloadId, by, error: err.message });
        workloads.push({ workloadId: cfg.workloadId, error: err.message });
      }
    }
    return { workloads };
  }

  // Drift events read from the router's queue in a batch (scale design §6): each workload they concern repaired once,
  // however many events name it; a workload offboarded since has no configuration left, so nothing is repaired.
  // requested: the workloads the idle check asked to repair (by: check), each repaired once with those the events concern.
  async function repairEvents(details, requested = []) {
    const names = [...new Set(details.map((d) => d?.eventName ?? 'unknown'))].join(',');
    const workloads = [];
    for (const cfg of (await store.listConfigs()).filter((c) => c.source && (requested.includes(c.workloadId) || details.some((d) => concerns(c, d))))) {
      const by = details.some((d) => concerns(cfg, d)) ? `event:${names}` : 'check';
      try {
        const { repaired } = await repair({ workloadId: cfg.workloadId, by });
        workloads.push({ workloadId: cfg.workloadId, repaired: repaired.map((e) => e.kind) });
      } catch (err) {
        log.error('RepairFailed', { workloadId: cfg.workloadId, by, error: err.message });
        workloads.push({ workloadId: cfg.workloadId, error: err.message });
      }
    }
    return { workloads };
  }

  // A batch of the drift queue: CloudTrail events of the router's drift rule and the idle check's repair requests, each
  // workload repaired once; a failing repair is retried by the next check, never by the queue (no message comes back).
  async function repairBatch(records) {
    const bodies = records.map((r) => { try { return JSON.parse(r.body); } catch { return null; } }).filter(Boolean);
    const details = bodies.filter((b) => b.action !== 'repair' && b.detail).map((b) => b.detail);
    const requested = [...new Set(bodies.filter((b) => b.action === 'repair' && b.workloadId).map((b) => b.workloadId))];
    const { workloads } = details.length || requested.length ? await repairEvents(details, requested) : { workloads: [] };
    return { batchItemFailures: [], workloads };
  }

  return { preview, onboard, offboard, repair, repairAll, repairEvents, repairBatch };
}
