// An in-memory AWS account and region for the onboarding tests, with the errors AWS returns: a customer's load balancer,
// target groups, rules, instances, Auto Scaling groups, ECS services and databases, the router's waker function
// permissions, and a multi-workload router table.
const REGION = 'eu-west-1';
const ACCOUNT = '111122223333';
export const LB = `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:loadbalancer/app/shop/50dc6c495c0c9188`;
export const LISTENER = `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:listener/app/shop/50dc6c495c0c9188/f2f7dc8efc522ab2`;
export const LISTENER_HTTP = `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:listener/app/shop/50dc6c495c0c9188/a1a1a1a1a1a1a1a1`;
export const WAKER_ARN = `arn:aws:lambda:${REGION}:${ACCOUNT}:function:dmt-dev-waker`;
export const tgArn = (name, id = '73e2d6bc24d8a067') => `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:targetgroup/${name}/${id}`;
const ruleArn = (n, listener = 'f2f7dc8efc522ab2') => `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:listener-rule/app/shop/50dc6c495c0c9188/${listener}/${String(n).padStart(16, '0')}`;

const error = (name, message = name) => Object.assign(new Error(message), { name });
const tagList = (tags) => Object.entries(tags).map(([Key, Value]) => ({ Key, Value }));
const plain = (tg) => [{ Type: 'forward', Order: 1, TargetGroupArn: tg, ForwardConfig: { TargetGroups: [{ TargetGroupArn: tg, Weight: 1 }], TargetGroupStickinessConfig: { Enabled: false } } }];

export function fakeAccount() {
  let ids = 0;
  const state = {
    targetGroups: new Map(), // arn → { name, type, lbs, targets: [{ Id, State }], tags, attributes }
    rules: new Map(), // arn → { priority, isDefault, conditions, actions, tags }
    instances: new Map(), // id → { tags, state }
    groups: new Map(), // name → { targetGroups, tags, instances }
    services: new Map(), // arn → { cluster, targetGroups, tags }
    databases: new Map(), // arn → { kind, id, tags }
    permissions: new Map(), // statement id → { SourceArn }
    fail: {}, // method name → error to throw once
    limits: {}, // DescribeAccountLimits overrides (name → max)
    calls: [],
  };
  const call = (name) => {
    state.calls.push(name);
    const failure = state.fail[name];
    if (failure) {
      delete state.fail[name];
      throw failure;
    }
  };

  // --- Customer resources (what the customer's Terraform created) ---
  const customer = {
    targetGroup(name, { type = 'instance', attached = true, targets = [] } = {}) {
      const arn = tgArn(name, (0x1000000000000000 + (ids += 1)).toString(16));
      state.targetGroups.set(arn, { name, type, lbs: attached ? [LB] : [], targets, tags: {}, attributes: {} });
      return arn;
    },
    rule(priority, tg, { host, path, isDefault = false, actions, listener = 'https', transforms } = {}) {
      const arn = ruleArn(priority === 'default' ? 99999 : priority, listener === 'http' ? 'a1a1a1a1a1a1a1a1' : undefined);
      // DescribeRules answers the legacy Values next to the condition's configuration.
      const conditions = [
        ...(host ? [{ Field: 'host-header', Values: [host], HostHeaderConfig: { Values: [host] } }] : []),
        ...(path ? [{ Field: 'path-pattern', Values: [path], PathPatternConfig: { Values: [path] } }] : []),
      ];
      state.rules.set(arn, {
        priority: String(priority), isDefault, conditions,
        actions: actions ?? plain(tg), tags: {}, listener: listener === 'http' ? LISTENER_HTTP : LISTENER, ...(transforms ? { transforms } : {}),
      });
      return arn;
    },
    instance(id, { tags = {}, state: s = 'running' } = {}) { state.instances.set(id, { tags, state: s }); },
    group(name, { targetGroups = [], tags = {}, instances = [] } = {}) { state.groups.set(name, { targetGroups, tags, instances }); },
    service(name, { cluster = 'shop', targetGroups = [], tags = {} } = {}) {
      const arn = `arn:aws:ecs:${REGION}:${ACCOUNT}:service/${cluster}/${name}`;
      state.services.set(arn, { cluster: `arn:aws:ecs:${REGION}:${ACCOUNT}:cluster/${cluster}`, targetGroups, tags });
      return arn;
    },
    database(kind, id, { tags = {} } = {}) {
      const arn = `arn:aws:rds:${REGION}:${ACCOUNT}:${kind === 'rds-cluster' ? 'cluster' : 'db'}:${id}`;
      state.databases.set(arn, { kind, id, tags });
      return arn;
    },
  };

  const toRule = ([RuleArn, r]) => ({
    RuleArn, Priority: r.isDefault ? 'default' : r.priority, IsDefault: r.isDefault, Conditions: structuredClone(r.conditions), Actions: structuredClone(r.actions),
    ...(r.transforms ? { Transforms: structuredClone(r.transforms) } : {}),
  });
  const resourceTags = (arn) => state.targetGroups.get(arn)?.tags ?? state.rules.get(arn)?.tags;
  const referenced = (tg) => [...state.rules.values()].some((r) => r.actions.some((a) => a.TargetGroupArn === tg || a.ForwardConfig?.TargetGroups?.some((g) => g.TargetGroupArn === tg)));

  const elbv2 = {
    async describeTargetGroups({ TargetGroupArns, Names, LoadBalancerArn } = {}) {
      call('describeTargetGroups');
      // By load balancer, or every target group of the region (one page here).
      if (!TargetGroupArns && !Names) {
        const all = [...state.targetGroups].filter(([a, g]) => !LoadBalancerArn || g.lbs.includes(LoadBalancerArn) || referenced(a));
        return { TargetGroups: all.map(([a, g]) => ({ TargetGroupArn: a, TargetGroupName: g.name, TargetType: g.type, LoadBalancerArns: [...g.lbs] })) };
      }
      const wanted = TargetGroupArns ?? [...state.targetGroups].filter(([, g]) => Names.includes(g.name)).map(([a]) => a);
      if (Names && !wanted.length) throw error('TargetGroupNotFoundException', 'One or more target groups not found');
      if (wanted.some((a) => !state.targetGroups.has(a))) throw error('TargetGroupNotFoundException', 'One or more target groups not found');
      return { TargetGroups: wanted.map((a) => { const g = state.targetGroups.get(a); return { TargetGroupArn: a, TargetGroupName: g.name, TargetType: g.type, LoadBalancerArns: [...g.lbs] }; }) };
    },
    async describeAccountLimits() {
      call('describeAccountLimits');
      const limits = { 'rules-per-application-load-balancer': 100, 'target-groups': 3000, 'application-load-balancers': 50, ...state.limits };
      return { Limits: Object.entries(limits).map(([Name, Max]) => ({ Name, Max: String(Max) })) };
    },
    async describeListeners({ LoadBalancerArn }) {
      call('describeListeners');
      return { Listeners: LoadBalancerArn === LB ? [{ ListenerArn: LISTENER, Protocol: 'HTTPS', Port: 443 }, { ListenerArn: LISTENER_HTTP, Protocol: 'HTTP', Port: 80 }] : [] };
    },
    async describeRules({ ListenerArn, RuleArns }) {
      call('describeRules');
      if (RuleArns) return { Rules: RuleArns.map((a) => toRule([a, state.rules.get(a)])) };
      return { Rules: [...state.rules].filter(([, r]) => (r.listener ?? LISTENER) === ListenerArn).map(toRule) };
    },
    async describeTags({ ResourceArns }) {
      call('describeTags');
      return { TagDescriptions: ResourceArns.map((a) => ({ ResourceArn: a, Tags: tagList(resourceTags(a) ?? {}) })) };
    },
    async describeTargetHealth({ TargetGroupArn }) {
      call('describeTargetHealth');
      return { TargetHealthDescriptions: state.targetGroups.get(TargetGroupArn).targets.map((t) => ({ Target: { Id: t.Id }, TargetHealth: { State: t.State ?? 'healthy' } })) };
    },
    async createTargetGroup({ Name, TargetType, Tags = [] }) {
      call('createTargetGroup');
      if ([...state.targetGroups.values()].some((g) => g.name === Name)) throw error('DuplicateTargetGroupNameException');
      const arn = tgArn(Name, (0x2000000000000000 + (ids += 1)).toString(16));
      state.targetGroups.set(arn, { name: Name, type: TargetType, lbs: [], targets: [], tags: Object.fromEntries(Tags.map((t) => [t.Key, t.Value])), attributes: {} });
      return { TargetGroups: [{ TargetGroupArn: arn, TargetGroupName: Name, TargetType }] };
    },
    async modifyTargetGroupAttributes({ TargetGroupArn, Attributes }) {
      call('modifyTargetGroupAttributes');
      for (const a of Attributes) state.targetGroups.get(TargetGroupArn).attributes[a.Key] = a.Value;
      return {};
    },
    async deleteTargetGroup({ TargetGroupArn }) {
      call('deleteTargetGroup');
      if (referenced(TargetGroupArn)) throw error('ResourceInUseException', 'Target group is currently in use by a listener or a rule');
      state.targetGroups.delete(TargetGroupArn);
      return {};
    },
    async registerTargets({ TargetGroupArn, Targets }) {
      call('registerTargets');
      const g = state.targetGroups.get(TargetGroupArn);
      for (const t of Targets) if (!g.targets.some((x) => x.Id === t.Id)) g.targets.push({ Id: t.Id, State: 'healthy' });
      return {};
    },
    async deregisterTargets({ TargetGroupArn, Targets }) {
      call('deregisterTargets');
      const g = state.targetGroups.get(TargetGroupArn);
      g.targets = g.targets.filter((x) => !Targets.some((t) => t.Id === x.Id));
      return {};
    },
    async modifyRule({ RuleArn, Actions, Conditions }) {
      call('modifyRule');
      if (Conditions) state.rules.get(RuleArn).conditions = structuredClone(Conditions);
      if (!Actions) return {};
      for (const a of Actions) {
        if (a.TargetGroupArn && (a.ForwardConfig?.TargetGroups?.length ?? 0) > 1) throw error('ValidationError', 'TargetGroupArn with a multi target group ForwardConfig');
        for (const g of a.ForwardConfig?.TargetGroups ?? []) if (!state.targetGroups.has(g.TargetGroupArn)) throw error('TargetGroupNotFoundException');
      }
      state.rules.get(RuleArn).actions = structuredClone(Actions);
      // A Lambda target group joins the load balancer of the rules that forward to it.
      for (const g of Actions.flatMap((a) => a.ForwardConfig?.TargetGroups ?? [])) {
        const tg = state.targetGroups.get(g.TargetGroupArn);
        if (!tg.lbs.includes(LB)) tg.lbs.push(LB);
      }
      return {};
    },
    async createRule({ ListenerArn, Priority, Conditions, Actions, Tags = [] }) {
      call('createRule');
      if (ListenerArn !== LISTENER && ListenerArn !== LISTENER_HTTP) throw error('ListenerNotFoundException');
      if ([...state.rules.values()].some((r) => (r.listener ?? LISTENER) === ListenerArn && r.priority === String(Priority))) throw error('PriorityInUseException', `Priority '${Priority}' is currently in use`);
      for (const c of Conditions) if (c.Values && c.HostHeaderConfig) throw error('ValidationError', 'You cannot both specify Values and HostHeaderConfig');
      const arn = ruleArn(100000 + (ids += 1));
      state.rules.set(arn, { priority: String(Priority), isDefault: false, conditions: structuredClone(Conditions), actions: structuredClone(Actions), tags: Object.fromEntries(Tags.map((t) => [t.Key, t.Value])), listener: ListenerArn });
      for (const g of Actions.flatMap((a) => a.ForwardConfig?.TargetGroups ?? [])) {
        const tg = state.targetGroups.get(g.TargetGroupArn);
        if (!tg.lbs.includes(LB)) tg.lbs.push(LB);
      }
      return { Rules: [{ RuleArn: arn, Priority: String(Priority) }] };
    },
    async deleteRule({ RuleArn }) {
      call('deleteRule');
      if (!state.rules.delete(RuleArn)) throw error('RuleNotFoundException');
      return {};
    },
    async setRulePriorities({ RulePriorities }) {
      call('setRulePriorities');
      for (const { RuleArn, Priority } of RulePriorities) {
        const listener = state.rules.get(RuleArn).listener ?? LISTENER;
        if ([...state.rules].some(([a, r]) => a !== RuleArn && (r.listener ?? LISTENER) === listener && r.priority === String(Priority))) throw error('PriorityInUseException');
        state.rules.get(RuleArn).priority = String(Priority);
      }
      return {};
    },
    async modifyRuleConditions(arn, conditions) { state.rules.get(arn).conditions = structuredClone(conditions); },
    async addTags({ ResourceArns, Tags }) {
      call('addTags');
      for (const a of ResourceArns) Object.assign(resourceTags(a), Object.fromEntries(Tags.map((t) => [t.Key, t.Value])));
      return {};
    },
    async removeTags({ ResourceArns, TagKeys }) {
      call('removeTags');
      for (const a of ResourceArns) for (const k of TagKeys) delete resourceTags(a)[k];
      return {};
    },
  };

  const ec2 = {
    async describeInstances({ InstanceIds }) {
      call('describeInstances');
      return { Reservations: [{ Instances: InstanceIds.filter((id) => state.instances.has(id)).map((id) => ({ InstanceId: id, State: { Name: state.instances.get(id).state }, Tags: tagList(state.instances.get(id).tags) })) }] };
    },
    async createTags({ Resources, Tags }) {
      call('createTags');
      for (const id of Resources) Object.assign(state.instances.get(id).tags, Object.fromEntries(Tags.map((t) => [t.Key, t.Value])));
      return {};
    },
    async deleteTags({ Resources, Tags }) {
      call('deleteTags');
      for (const id of Resources) for (const t of Tags) delete state.instances.get(id).tags[t.Key];
      return {};
    },
  };

  const autoscaling = {
    // Pages of one group, to exercise the pagination.
    async describeAutoScalingGroups({ NextToken, AutoScalingGroupNames } = {}) {
      call('describeAutoScalingGroups');
      const names = AutoScalingGroupNames ?? [...state.groups.keys()];
      const toGroup = (name) => { const g = state.groups.get(name); return { AutoScalingGroupName: name, TargetGroupARNs: [...g.targetGroups], Tags: tagList(g.tags), Instances: g.instances.map((InstanceId) => ({ InstanceId })) }; };
      if (AutoScalingGroupNames) return { AutoScalingGroups: names.filter((n) => state.groups.has(n)).map(toGroup) };
      const at = Number(NextToken ?? 0);
      return { AutoScalingGroups: names.slice(at, at + 1).map(toGroup), NextToken: at + 1 < names.length ? String(at + 1) : undefined };
    },
    async createOrUpdateTags({ Tags }) {
      call('createOrUpdateTags');
      for (const t of Tags) state.groups.get(t.ResourceId).tags[t.Key] = t.Value;
      return {};
    },
    async deleteTags({ Tags }) {
      call('deleteAsgTags');
      for (const t of Tags) delete state.groups.get(t.ResourceId).tags[t.Key];
      return {};
    },
  };

  const clusters = () => [...new Set([...state.services.values()].map((s) => s.cluster))];
  const ecs = {
    async listClusters() { call('listClusters'); return { clusterArns: clusters() }; },
    // As ECS: 10 per page unless maxResults asks for up to 100.
    async listServices({ cluster, maxResults = 10, nextToken }) {
      call('listServices');
      const all = [...state.services].filter(([, s]) => s.cluster === cluster).map(([a]) => a);
      const start = Number(nextToken ?? 0);
      const end = start + Math.min(maxResults, 100);
      return { serviceArns: all.slice(start, end), ...(end < all.length ? { nextToken: String(end) } : {}) };
    },
    async describeServices({ services, include }) {
      call('describeServices');
      return {
        services: services.map((a) => {
          const s = state.services.get(a);
          return { serviceArn: a, clusterArn: s.cluster, desiredCount: 1, loadBalancers: s.targetGroups.map((targetGroupArn) => ({ targetGroupArn })), ...(include?.includes('TAGS') ? { tags: Object.entries(s.tags).map(([key, value]) => ({ key, value })) } : {}) };
        }),
      };
    },
    async tagResource({ resourceArn, tags }) { call('tagResource'); Object.assign(state.services.get(resourceArn).tags, Object.fromEntries(tags.map((t) => [t.key, t.value]))); return {}; },
    async untagResource({ resourceArn, tagKeys }) { call('untagResource'); for (const k of tagKeys) delete state.services.get(resourceArn).tags[k]; return {}; },
  };

  const byId = (kind, id) => [...state.databases].find(([, d]) => d.kind === kind && d.id === id);
  const rds = {
    async describeDBInstances({ DBInstanceIdentifier }) {
      call('describeDBInstances');
      const found = byId('rds-instance', DBInstanceIdentifier);
      if (!found) throw error('DBInstanceNotFoundFault');
      return { DBInstances: [{ DBInstanceIdentifier, DBInstanceArn: found[0], TagList: tagList(found[1].tags) }] };
    },
    async describeDBClusters({ DBClusterIdentifier }) {
      call('describeDBClusters');
      const found = byId('rds-cluster', DBClusterIdentifier);
      if (!found) throw error('DBClusterNotFoundFault');
      return { DBClusters: [{ DBClusterIdentifier, DBClusterArn: found[0], TagList: tagList(found[1].tags) }] };
    },
    async addTagsToResource({ ResourceName, Tags }) { call('addTagsToResource'); Object.assign(state.databases.get(ResourceName).tags, Object.fromEntries(Tags.map((t) => [t.Key, t.Value]))); return {}; },
    async removeTagsFromResource({ ResourceName, TagKeys }) {
      call('removeTagsFromResource');
      if (!state.databases.has(ResourceName)) throw error('DBInstanceNotFoundFault');
      for (const k of TagKeys) delete state.databases.get(ResourceName).tags[k];
      return {};
    },
  };

  const lambda = {
    async addPermission({ StatementId, SourceArn }) {
      call('addPermission');
      if (state.permissions.has(StatementId)) throw error('ResourceConflictException', 'The statement id provided already exists');
      state.permissions.set(StatementId, { SourceArn });
      return {};
    },
    async removePermission({ StatementId }) {
      call('removePermission');
      if (!state.permissions.delete(StatementId)) throw error('ResourceNotFoundException', 'No policy is found');
      return {};
    },
  };

  // Router table: configurations, runtime states and pauses of several workloads.
  const items = new Map(); // `${workloadId}/${sk}` → value
  const store = {
    async getConfig(id) { return structuredClone(items.get(`${id}/CFG`) ?? null); },
    async listConfigs() { return [...items].filter(([k]) => k.endsWith('/CFG')).map(([, v]) => structuredClone(v)); },
    async getRun(id) { return structuredClone(items.get(`${id}/RUN`) ?? null); },
    async putConfig(id, config, { mustExist = false } = {}) { call('putConfig'); if (mustExist && !items.has(`${id}/CFG`)) return false; items.set(`${id}/CFG`, structuredClone(config)); return true; },
    async initRun(id, at) {
      if (items.has(`${id}/RUN`)) return false;
      items.set(`${id}/RUN`, { state: 'AWAKE', version: 0, awakeSince: at, holders: 0, wakeCount: 0 });
      return true;
    },
    async deleteWorkload(id) { call('deleteWorkload'); for (const k of [...items.keys()]) if (k.startsWith(`${id}/`)) items.delete(k); },
    async putDrift(id, event) { call('putDrift'); items.set(`${id}/DRIFT#${event.at}#${items.size}`, structuredClone(event)); },
    async listDrift(id) { return [...items].filter(([k]) => k.startsWith(`${id}/DRIFT#`)).map(([, v]) => structuredClone(v)).reverse(); },
    async putPause(id, pause) { call('putPause'); items.set(`${id}/PAUSE${pause.exclusionId ? `#${pause.exclusionId}` : ''}`, structuredClone(pause)); },
    async getPauses(id) { return [...items].filter(([k]) => k.startsWith(`${id}/PAUSE`)).map(([, v]) => structuredClone(v)); },
  };

  return { state, items, customer, elbv2, ec2, autoscaling, ecs, rds, lambda, store };
}
