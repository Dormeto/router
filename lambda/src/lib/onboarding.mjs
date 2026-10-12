// Onboarding (R4a): preview, onboard and offboard a workload from its application target group, in the router's account
// and region. Every step finds what exists before changing anything, so an action can run again; offboarding removes only
// what onboarding added (tags carry the dormeto:tagged marker), never what the customer set.
import { forwardTargetGroups, listRules, ruleTags } from './rules.mjs';
import { conditionsOf } from './route.mjs';

const WORKLOAD_TAG = 'dormeto:workload';
const ROUTER_TAG = 'dormeto:router';
const MARKER_TAG = 'dormeto:tagged';
const MARKER = 'onboarder';
const GROUP_TAG = 'aws:autoscaling:groupName';
const ID = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const NAME_MAX = 32;
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

export function createOnboarding({ elbv2, ec2, autoscaling, ecs, rds, lambda, store, router, now = Date.now, log }) {
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

  // Rules forwarding to the target group, on its load balancers, with their tags.
  async function rulesTo(group) {
    const rows = [];
    for (const lb of group.LoadBalancerArns ?? []) rows.push(...(await listRules(elbv2, lb)).filter(({ rule }) => forwardTargetGroups(rule).includes(group.TargetGroupArn)));
    const tags = await ruleTags(elbv2, rows.map(({ rule }) => rule));
    return rows.map((row) => ({ ...row, tags: tags.get(row.rule.RuleArn) ?? {} }));
  }

  // Backends feeding the target group, whatever their tags: Auto Scaling groups attached to it, ECS services registered with
  // it, instances among its targets that no group owns.
  async function backendsOf(group) {
    const backends = [];
    for (const g of await pages((i) => autoscaling.describeAutoScalingGroups(i), 'AutoScalingGroups')) {
      if ((g.TargetGroupARNs ?? []).includes(group.TargetGroupArn)) backends.push({ kind: 'asg', id: g.AutoScalingGroupName, tags: tagsOf(g.Tags) });
    }
    for (const cluster of await pages((i) => ecs.listClusters(i), 'clusterArns', { in: 'nextToken', out: 'nextToken' })) {
      const arns = await pages((i) => ecs.listServices({ ...i, cluster }), 'serviceArns', { in: 'nextToken', out: 'nextToken' });
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

  // What onboarding would do, and why it cannot.
  async function preview({ workloadId, targetGroupArn, settings, databases }) {
    const problems = [];
    const name = wakerName(workloadId ?? '');
    if (!ID.test(workloadId ?? '')) problems.push('workload id: lowercase letters, digits and hyphens, not starting or ending with a hyphen');
    else if (name.length > NAME_MAX) problems.push(`workload id too long: ${name} exceeds the ${NAME_MAX} characters of a target group name`);
    problems.push(...settingsProblems(settings));
    const configs = await store.listConfigs();
    const existing = configs.find((c) => c.workloadId === workloadId);
    if (existing && existing.appTargetGroupArn !== targetGroupArn) problems.push(`workload ${workloadId} already exists with another target group`);
    const owner = configs.find((c) => c.appTargetGroupArn === targetGroupArn && c.workloadId !== workloadId);
    if (owner) problems.push(`the target group is already workload ${owner.workloadId}`);

    const group = await targetGroup(targetGroupArn);
    const result = { workloadId, targetGroupArn, wakerTargetGroupName: name, loadBalancerArn: null, rules: [], backends: [], databases: [] };
    if (!group) return { ...result, ok: false, problems: [...problems, 'target group not found'] };
    if (!['instance', 'ip'].includes(group.TargetType)) problems.push(`target type ${group.TargetType} is not supported`);
    const lbs = group.LoadBalancerArns ?? [];
    if (!lbs.length) problems.push('the target group is not attached to a load balancer');
    if (lbs.length > 1) problems.push('the target group is attached to several load balancers');
    result.loadBalancerArn = lbs[0] ?? null;

    const waker = await wakerGroup(workloadId);
    if (waker && !waker.ours) problems.push(`target group ${waker.TargetGroupName} exists and is not the waker of ${workloadId}`);
    for (const { rule, listener, tags } of await rulesTo(group)) {
      const groups = forwardTargetGroups(rule);
      const entry = { arn: rule.RuleArn, priority: rule.Priority, conditions: conditionsOf(rule) };
      if (rule.IsDefault) problems.push(`the listener default action of ${listener.Protocol}:${listener.Port} forwards to the target group (not supported yet)`);
      else if (groups.some((g) => g !== targetGroupArn && g !== waker?.TargetGroupArn)) problems.push(`rule ${rule.Priority} also forwards to other target groups`);
      else entry.action = waker && groups.includes(waker.TargetGroupArn) && tags[WORKLOAD_TAG] === workloadId ? 'instrumented' : 'instrument';
      result.rules.push(entry);
    }
    if (lbs.length && !result.rules.length) problems.push('no rule forwards to the target group');

    const backends = await backendsOf(group);
    if (!backends.length) problems.push('no backend: no instance, Auto Scaling group or ECS service feeds the target group');
    for (const b of backends) {
      const tagged = b.tags[WORKLOAD_TAG] ?? null;
      if (tagged && tagged !== workloadId) problems.push(`${KIND_TEXT[b.kind]} ${b.id} belongs to workload ${tagged}`);
      result.backends.push({ kind: b.kind, id: b.id, tagged });
    }
    for (const db of await databasesOf(databases)) {
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

  async function onboard({ workloadId, targetGroupArn, settings = {}, databases = [], by }) {
    const checked = await preview({ workloadId, targetGroupArn, settings, databases });
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
      const untagged = [...(await backendsOf(group)), ...(await databasesOf(databases))].filter((b) => !b.tags[WORKLOAD_TAG]);
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

      try {
        changed = true;
        await lambda.addPermission({
          FunctionName: router.wakerFunctionName, StatementId: `alb-${workloadId}`, Action: 'lambda:InvokeFunction',
          Principal: 'elasticloadbalancing.amazonaws.com', SourceArn: waker.TargetGroupArn,
        });
        step('invoke permission', true);
      } catch (err) {
        if (!notFound(err, 'ResourceConflictException')) throw err;
        step('invoke permission', false);
      }

      const { TargetHealthDescriptions = [] } = await elbv2.describeTargetHealth({ TargetGroupArn: waker.TargetGroupArn });
      const registered = TargetHealthDescriptions.some((d) => d.Target?.Id === router.wakerFunctionArn);
      if (!registered) await elbv2.registerTargets({ TargetGroupArn: waker.TargetGroupArn, Targets: [{ Id: router.wakerFunctionArn }] });
      step('register waker', !registered);

      if (!(await store.getConfig(workloadId))) {
        const lb = checked.loadBalancerArn;
        await store.putConfig(workloadId, {
          workloadId, appTargetGroupArn: targetGroupArn, wakerTargetGroupArn: waker.TargetGroupArn,
          loadBalancerDimension: lb.slice(lb.indexOf('loadbalancer/') + 'loadbalancer/'.length), appTargetGroupDimension: targetGroupArn.split(':').at(-1),
          instanceIds: [], ...DEFAULTS, ...(databases.length ? { wakeTimeoutSeconds: DATABASE_WAKE_TIMEOUT } : {}), ...settings,
          noWakeRules: [], wakeRules: [], admin: { enabled: false, secretHash: '', secretParameter: '' },
          source: 'manager', onboardedBy: by ?? 'unknown', onboardedAt: new Date(now()).toISOString(), databases, tagged,
        });
        await store.initRun(workloadId, now());
        step('workload configuration', true);
      } else step('workload configuration', false);

      let instrumented = 0;
      for (const { rule, tags } of await rulesTo({ ...group, LoadBalancerArns: [checked.loadBalancerArn] })) {
        if (!forwardTargetGroups(rule).includes(waker.TargetGroupArn)) {
          await elbv2.modifyRule({ RuleArn: rule.RuleArn, Actions: instrumentedActions(rule.Actions, targetGroupArn, waker.TargetGroupArn, { app: 1, waker: 0 }) });
          instrumented += 1;
        }
        if (tags[WORKLOAD_TAG] !== workloadId) {
          await elbv2.addTags({ ResourceArns: [rule.RuleArn], Tags: [{ Key: WORKLOAD_TAG, Value: workloadId }] });
          instrumented += 1;
        }
      }
      step('instrument rules', instrumented > 0);
      log.info('Onboarded', { workloadId, targetGroupArn, by, steps: steps.filter((s) => s.status === 'done').map((s) => s.name) });
      return { steps, workload: { workloadId, wakerTargetGroupArn: waker.TargetGroupArn } };
    } catch (err) {
      if (!fresh || !changed) throw err;
      // Undo: whatever was done is removed, step by step, going on after a failed step.
      const undo = await clean(workloadId, targetGroupArn, databases, tagged);
      const failed = undo.filter((s) => s.status === 'failed');
      log.warn('OnboardUndone', { workloadId, error: err.message, failed: failed.map((s) => s.name) });
      throw new Error(`cannot onboard ${workloadId}: ${err.message} (${failed.length ? `undo incomplete: ${failed.map((s) => `${s.name}: ${s.detail}`).join('; ')}` : 'undone'})`);
    }
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

  return { preview, onboard, offboard };
}
