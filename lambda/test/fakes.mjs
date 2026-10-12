import { matches, STATES } from '../src/lib/state.mjs';
import { currentTarget, routeOf as aggregateRoute } from '../src/lib/route.mjs';

export const silentLog = { info() {}, warn() {}, error() {} };

export function testConfig(overrides = {}) {
  return {
    workloadId: 'demo',
    ruleArn: 'arn:aws:elasticloadbalancing:eu-west-1:111122223333:listener-rule/app/dmt-dev-demo/aaa/bbb/ccc',
    appTargetGroupArn: 'arn:aws:elasticloadbalancing:eu-west-1:111122223333:targetgroup/dmt-dev-demo-app/111',
    wakerTargetGroupArn: 'arn:aws:elasticloadbalancing:eu-west-1:111122223333:targetgroup/dmt-dev-demo/222',
    loadBalancerDimension: 'app/dmt-dev-demo/aaa',
    appTargetGroupDimension: 'targetgroup/dmt-dev-demo-app/111',
    instanceIds: ['i-0123456789abcdef0'],
    waitSeconds: 20,
    idleMinutes: 15,
    drainSeconds: 10,
    wakeTimeoutSeconds: 600,
    failedRetrySeconds: 60,
    maxHolders: 5,
    pollSeconds: 3,
    ...overrides,
  };
}

export function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  const hooks = [];
  return {
    now: () => t,
    advance: (ms) => { t += ms; },
    onSleep: (fn) => hooks.push(fn),
    async sleep(ms) {
      t += ms;
      for (const hook of hooks) await hook(t);
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

export function fakeStore({ config, run, clock }) {
  const state = { run: structuredClone(run), stats: {}, lists: {}, pauses: [] };
  const samePause = (workloadId, exclusionId) => (p) => p.workloadId === workloadId && (p.exclusionId ?? null) === (exclusionId ?? null);
  const list = (name) => (state.lists[name] ??= { meta: null, parts: {} });
  const copy = () => structuredClone(state.run);
  return {
    state,
    async getConfig(id) { return id === config.workloadId ? structuredClone(config) : null; },
    async putConfig(id, next) {
      if (id !== config.workloadId) return false;
      for (const key of Object.keys(config)) delete config[key];
      Object.assign(config, structuredClone(next));
      return true;
    },
    async listConfigs() { return [structuredClone(config)]; },
    async getRun(id) { return id === config.workloadId ? copy() : null; },
    async transition(id, { cond, set = {}, remove = [], increment = [] }) {
      if (id !== config.workloadId || !matches(state.run, cond)) return null;
      Object.assign(state.run, set);
      for (const name of remove) delete state.run[name];
      for (const name of increment) state.run[name] = (state.run[name] ?? 0) + 1;
      state.run.version = (state.run.version ?? 0) + 1;
      state.run.updatedAt = clock.now();
      return copy();
    },
    async setBackendKinds(id, kinds) {
      if (id !== config.workloadId || !state.run) return false;
      state.backendKindWrites = (state.backendKindWrites ?? 0) + 1;
      state.run.backendKinds = kinds;
      return true;
    },
    async setPendingWake() {
      if (state.run.state !== STATES.NAPPING || state.run.pendingWake === true) return false;
      state.run.pendingWake = true;
      return true;
    },
    async count(id, counter) { state.stats[counter] = (state.stats[counter] ?? 0) + 1; },
    async recordScheduledCheck(at) { state.check = { ...(state.check ?? {}), lastScheduledCheckAt: at }; },
    async getCheck() { return structuredClone(state.check ?? null); },
    async getHealth() { return structuredClone(state.health ?? null); },
    async putHealth(health) { state.health = structuredClone(health); },
    // Pauses: { workloadId (null for the router), by, at, reason, until?, keepAsleep, exclusionId? }.
    async putPause(workloadId, pause) {
      state.pauses = [...state.pauses.filter((p) => !samePause(workloadId, pause.exclusionId)(p)), { workloadId, ...structuredClone(pause) }];
    },
    async getPauses(workloadId) { return structuredClone(state.pauses.filter((p) => p.workloadId === workloadId)); },
    async listDrift(id, limit = 10) { return structuredClone((state.drift ?? []).filter((e) => e.workloadId === id).slice(-limit).reverse()); },
    async putDrift(id, event) { (state.drift ??= []).push({ workloadId: id, ...structuredClone(event) }); },
    async listPauses() { return structuredClone(state.pauses); },
    async deletePause(workloadId, { exclusionId, at } = {}) {
      const found = state.pauses.find(samePause(workloadId, exclusionId));
      if (!found || (at !== undefined && found.at !== at)) return at === undefined;
      state.pauses = state.pauses.filter((p) => p !== found);
      return true;
    },
    async getListMeta(name) { return structuredClone(state.lists[name]?.meta ?? null); },
    async setListMeta(name, set, remove = []) {
      const l = list(name);
      l.meta = { ...(l.meta ?? {}), ...set };
      for (const field of remove) delete l.meta[field];
    },
    async putListPart(name, version, index, data) { (list(name).parts[version] ??= [])[index] = Buffer.from(data); },
    async getListParts(name, version) { return [...(state.lists[name]?.parts[version] ?? [])]; },
    async getStats(id, days) {
      const stats = { ignored: {}, deferred: {}, wakes: {} };
      for (const [name, n] of Object.entries(state.stats)) {
        if (name.startsWith('deferred:')) stats.deferred[name.slice(9)] = n;
        else if (name.startsWith('ignored:')) stats.ignored[name.slice(8)] = n;
        else if (name.startsWith('wake:')) stats.wakes[name.slice(5)] = n;
      }
      return { days, since: 'fake', today: structuredClone(stats), total: stats };
    },
    async tryAcquireHolder(id, max) {
      if ((state.run.holders ?? 0) >= max) return false;
      state.run.holders = (state.run.holders ?? 0) + 1;
      return true;
    },
    async releaseHolder() {
      if ((state.run.holders ?? 0) > 0) state.run.holders -= 1;
    },
  };
}

// A load balancer with one HTTPS listener, like ELBv2: the workload's rules (cfg.ruleArns, or cfg.ruleArn) are
// instrumented and tagged; tests add or change rules in state.rules (arn → { actions, conditions, priority, tags,
// isDefault }). An unknown ARN fails DescribeRules({ RuleArns }); state.failOn makes ModifyRule fail for that rule.
export const FAKE_LB = 'arn:aws:elasticloadbalancing:eu-west-1:111122223333:loadbalancer/app/dmt-dev-demo/aaa';
export function fakeElbv2(cfg, { target = 'app', healthy = 1 } = {}) {
  const forward = (app, waker) => [{
    Type: 'forward',
    Order: 1,
    ForwardConfig: {
      TargetGroups: [{ TargetGroupArn: cfg.appTargetGroupArn, Weight: app }, { TargetGroupArn: cfg.wakerTargetGroupArn, Weight: waker }],
      TargetGroupStickinessConfig: { Enabled: false },
    },
  }];
  const [app, waker] = target === 'app' ? [1, 0] : [0, 1];
  const arns = cfg.ruleArns?.length ? cfg.ruleArns : [cfg.ruleArn];
  const state = {
    healthy,
    modifyCount: 0,
    failOn: null,
    calls: { targetGroups: 0, listeners: 0, rules: 0, tags: 0 },
    rules: new Map(arns.map((arn, i) => [arn, { actions: forward(app, waker), conditions: [], priority: String(10 + i), tags: { 'dormeto:workload': cfg.workloadId } }])),
    forward,
    get actions() { return this.rules.get(arns[0])?.actions; },
    set actions(value) { this.rules.get(arns[0]).actions = value; },
  };
  const toRule = ([RuleArn, r]) => ({
    RuleArn, Priority: r.isDefault ? 'default' : r.priority, IsDefault: Boolean(r.isDefault), Conditions: r.conditions ?? [], Actions: structuredClone(r.actions),
    ...(r.transforms ? { Transforms: r.transforms } : {}),
  });
  return {
    state,
    async describeTargetGroups({ TargetGroupArns }) {
      state.calls.targetGroups += 1;
      return { TargetGroups: TargetGroupArns.map((a) => ({ TargetGroupArn: a, LoadBalancerArns: state.detached ? [] : [FAKE_LB] })) };
    },
    async describeListeners({ LoadBalancerArn }) {
      state.calls.listeners += 1;
      // An HTTP listener too when a rule sits on it (`listener: 'http'`).
      const http = [...state.rules.values()].some((r) => r.listener === 'http') ? [{ ListenerArn: `${FAKE_LB}/listener-80`, Protocol: 'HTTP', Port: 80 }] : [];
      return { Listeners: LoadBalancerArn === FAKE_LB ? [{ ListenerArn: `${FAKE_LB}/listener-443`, Protocol: 'HTTPS', Port: 443 }, ...http] : [] };
    },
    async describeRules({ ListenerArn, RuleArns, Marker }) {
      state.calls.rules += 1;
      if (RuleArns) {
        if (RuleArns.some((a) => !state.rules.has(a))) throw Object.assign(new Error('One or more rules not found'), { name: 'RuleNotFoundException' });
        return { Rules: RuleArns.map((a) => toRule([a, state.rules.get(a)])) };
      }
      // Pages of two rules, to exercise the pagination.
      const all = [...state.rules].filter(([, r]) => ListenerArn.endsWith(r.listener === 'http' ? '/listener-80' : '/listener-443')).map(toRule);
      const start = Number(Marker ?? 0);
      return { Rules: ListenerArn.startsWith(FAKE_LB) ? all.slice(start, start + 2) : [], NextMarker: start + 2 < all.length ? String(start + 2) : undefined };
    },
    async describeTags({ ResourceArns }) {
      state.calls.tags += 1;
      return { TagDescriptions: ResourceArns.map((a) => ({ ResourceArn: a, Tags: Object.entries(state.rules.get(a)?.tags ?? {}).map(([Key, Value]) => ({ Key, Value })) })) };
    },
    async modifyRule({ RuleArn, Actions }) {
      if (state.failOn === RuleArn) throw new Error(`ModifyRule failed for ${RuleArn}`);
      state.modifyCount += 1;
      state.rules.get(RuleArn).actions = structuredClone(Actions);
      return {};
    },
    async describeTargetHealth({ TargetGroupArn } = {}) {
      // A target group's own targets (state.targetsOf[arn]), else explicit targets ([{ Id, State }]) when a test sets
      // them, else `healthy` anonymous healthy targets.
      const own = state.targetsOf?.[TargetGroupArn];
      if (own) return { TargetHealthDescriptions: own.map((t) => ({ Target: { Id: t.Id }, TargetHealth: { State: t.State } })) };
      if (state.targets) {
        return { TargetHealthDescriptions: state.targets.map((t) => ({ Target: { Id: t.Id }, TargetHealth: { State: t.State } })) };
      }
      return { TargetHealthDescriptions: Array.from({ length: state.healthy }, (_, i) => ({ Target: { Id: `i-${i}` }, TargetHealth: { State: 'healthy' } })) };
    },
  };
}

// Route over every rule of the workload (app, waker, mixed, unknown).
// Route over the workload's rules: those that forward to its application target group (app, waker, mixed, unknown).
export const routeOf = (elbv2, cfg) => aggregateRoute([...elbv2.state.rules]
  .filter(([, r]) => r.actions.some((a) => a.ForwardConfig?.TargetGroups?.some((tg) => tg.TargetGroupArn === cfg.appTargetGroupArn)))
  .map(([RuleArn, r]) => ({ RuleArn, Actions: r.actions })), cfg);

export function fakeEc2(ids, { state = 'running', type = 't3.medium' } = {}) {
  const s = { instances: Object.fromEntries(ids.map((id) => [id, state])), types: Object.fromEntries(ids.map((id) => [id, type])), tags: {}, started: 0, stopped: 0, onStart: [], onStop: [], modified: [] };
  return {
    state: s,
    async describeInstances({ InstanceIds }) {
      return {
        Reservations: [{
          Instances: InstanceIds.map((id) => ({
            InstanceId: id,
            InstanceType: s.types[id],
            State: { Name: s.instances[id] },
            Tags: Object.entries(s.tags[id] ?? {}).map(([Key, Value]) => ({ Key, Value })),
          })),
        }],
      };
    },
    async startInstances({ InstanceIds }) {
      s.started += 1;
      for (const id of InstanceIds) s.instances[id] = 'running';
      for (const hook of s.onStart) await hook();
      return {};
    },
    async stopInstances({ InstanceIds }) {
      s.stopped += 1;
      for (const id of InstanceIds) s.instances[id] = 'stopped';
      for (const hook of s.onStop) await hook();
      return {};
    },
    // A stopped instance only, as EC2 allows (R7a: fallback instance types).
    async modifyInstanceAttribute({ InstanceId, InstanceType }) {
      if (s.instances[InstanceId] !== 'stopped') throw Object.assign(new Error(`The instance '${InstanceId}' is not in the 'stopped' state.`), { name: 'IncorrectInstanceState' });
      s.modified.push([InstanceId, InstanceType.Value]);
      s.types[InstanceId] = InstanceType.Value;
      return {};
    },
    async createTags({ Resources, Tags }) {
      for (const id of Resources) s.tags[id] = { ...(s.tags[id] ?? {}), ...Object.fromEntries(Tags.map((t) => [t.Key, t.Value])) };
      return {};
    },
    async deleteTags({ Resources, Tags }) {
      for (const id of Resources) for (const t of Tags) delete s.tags[id]?.[t.Key];
      return {};
    },
  };
}

export function fakeCloudWatch(values = [], timestamps = []) {
  const calls = [];
  return {
    calls,
    async getMetricData(input) {
      calls.push(input);
      return { MetricDataResults: [{ Id: 'requests', Values: values, Timestamps: timestamps }] };
    },
  };
}

export function albEvent({ method = 'GET', path = '/', query = {}, headers = {}, cfg = testConfig() } = {}) {
  const all = { accept: 'text/html', 'user-agent': 'Mozilla/5.0', ...headers };
  return {
    requestContext: { elb: { targetGroupArn: cfg.wakerTargetGroupArn } },
    httpMethod: method,
    path,
    multiValueQueryStringParameters: query,
    multiValueHeaders: Object.fromEntries(Object.entries(all).map(([k, v]) => [k, [].concat(v)])),
    body: '',
    isBase64Encoded: false,
  };
}

// Auto Scaling groups: [{ AutoScalingGroupName, MinSize, MaxSize, DesiredCapacity, TargetGroupARNs, Instances, Tags }].
// Scaling is immediate: DesiredCapacity N gives N InService instances i-<group>-<k>.
export function fakeAutoScaling(groups = []) {
  const state = { groups: structuredClone(groups), suspended: {}, updates: [], resumed: [] };
  const find = (name) => state.groups.find((g) => g.AutoScalingGroupName === name);
  const instancesFor = (group, count) => Array.from({ length: count }, (_, k) => ({
    InstanceId: `i-${group.AutoScalingGroupName}-${k}`, LifecycleState: 'InService',
  }));
  return {
    state,
    async describeAutoScalingGroups({ AutoScalingGroupNames, Filters } = {}) {
      let result = state.groups;
      if (AutoScalingGroupNames) result = result.filter((g) => AutoScalingGroupNames.includes(g.AutoScalingGroupName));
      for (const filter of Filters ?? []) {
        // tag-key: any value of the listed keys; tag:<key>: the listed values of that key (as Auto Scaling filters do).
        if (filter.Name === 'tag-key') result = result.filter((g) => (g.Tags ?? []).some((t) => filter.Values.includes(t.Key)));
        else result = result.filter((g) => (g.Tags ?? []).some((t) => t.Key === filter.Name.replace(/^tag:/, '') && filter.Values.includes(t.Value)));
      }
      return { AutoScalingGroups: structuredClone(result) };
    },
    async updateAutoScalingGroup(input) {
      state.updates.push(input);
      const group = find(input.AutoScalingGroupName);
      if (input.MinSize !== undefined) group.MinSize = input.MinSize;
      if (input.MaxSize !== undefined) group.MaxSize = input.MaxSize;
      if (input.DesiredCapacity !== undefined) {
        group.DesiredCapacity = input.DesiredCapacity;
        group.Instances = instancesFor(group, input.DesiredCapacity);
      }
      return {};
    },
    async suspendProcesses({ AutoScalingGroupName, ScalingProcesses }) {
      state.suspended[AutoScalingGroupName] = [...ScalingProcesses];
      return {};
    },
    async resumeProcesses({ AutoScalingGroupName, ScalingProcesses }) {
      state.resumed.push({ name: AutoScalingGroupName, processes: [...ScalingProcesses] });
      delete state.suspended[AutoScalingGroupName];
      return {};
    },
  };
}

export const asgGroup = (name, { min = 1, max = 2, desired = 1, targetGroups = [], tags = {}, instances } = {}) => ({
  AutoScalingGroupName: name,
  MinSize: min,
  MaxSize: max,
  DesiredCapacity: desired,
  TargetGroupARNs: targetGroups,
  Instances: instances ?? Array.from({ length: desired }, (_, k) => ({ InstanceId: `i-${name}-${k}`, LifecycleState: 'InService' })),
  Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
});

// ECS services: [{ serviceArn, clusterArn, desiredCount, runningCount, pendingCount, loadBalancers, tags }].
// UpdateService is immediate: runningCount follows desiredCount.
export function fakeEcs(services = []) {
  const state = { services: structuredClone(services), updates: [] };
  return {
    state,
    async describeServices({ cluster, services: arns }) {
      return { services: structuredClone(state.services.filter((s) => arns.includes(s.serviceArn) && s.clusterArn === cluster)) };
    },
    async updateService({ cluster, service, desiredCount }) {
      state.updates.push({ cluster, service, desiredCount });
      const found = state.services.find((s) => s.serviceArn === service);
      Object.assign(found, { desiredCount, runningCount: desiredCount, pendingCount: 0 });
      return {};
    },
  };
}

export function fakeTagging(ecs) {
  return {
    async getResources({ TagFilters, ResourceTypeFilters }) {
      // A filter without values matches any value of the key (as the tagging API does).
      const [{ Key, Values }] = TagFilters;
      const list = ResourceTypeFilters.includes('ecs:service') ? ecs.state.services : [];
      return {
        ResourceTagMappingList: list
          .filter((s) => (Values?.length ? Values.includes((s.tags ?? {})[Key]) : Key in (s.tags ?? {})))
          .map((s) => ({ ResourceARN: s.serviceArn, Tags: Object.entries(s.tags ?? {}).map(([k, v]) => ({ Key: k, Value: v })) })),
      };
    },
  };
}

export function fakeAppScaling(targets = []) {
  const state = { targets: structuredClone(targets), registrations: [] };
  return {
    state,
    async describeScalableTargets({ ResourceIds }) {
      return { ScalableTargets: structuredClone(state.targets.filter((t) => ResourceIds.includes(t.ResourceId))) };
    },
    async registerScalableTarget(input) {
      state.registrations.push(input);
      const found = state.targets.find((t) => t.ResourceId === input.ResourceId);
      if (found) Object.assign(found, input);
      return {};
    },
  };
}

export const ecsService = (name, { cluster = 'dmt-dev', desired = 1, running, targetGroups = [], tags = {} } = {}) => ({
  serviceArn: `arn:aws:ecs:eu-west-1:111122223333:service/${cluster}/${name}`,
  clusterArn: `arn:aws:ecs:eu-west-1:111122223333:cluster/${cluster}`,
  serviceName: name,
  desiredCount: desired,
  runningCount: running ?? desired,
  pendingCount: 0,
  loadBalancers: targetGroups.map((targetGroupArn) => ({ targetGroupArn, containerName: 'web', containerPort: 80 })),
  tags,
});

// RDS: instances { id: { status, cluster?, replicaSource?, tags } } and clusters { id: { status, engineMode?, tags } }.
// Start/stop move to starting/stopping; the next describe completes the transition (available/stopped).
export function fakeRds({ instances = {}, clusters = {} } = {}) {
  const state = { instances: structuredClone(instances), clusters: structuredClone(clusters), calls: [] };
  const settle = (db) => {
    if (db.status === 'starting') db.status = 'available';
    else if (db.status === 'stopping') db.status = 'stopped';
  };
  const arn = (type, id) => `arn:aws:rds:eu-west-1:111122223333:${type}:${id}`;
  return {
    state,
    arn,
    async describeDBInstances({ DBInstanceIdentifier }) {
      const db = state.instances[DBInstanceIdentifier];
      const status = db.status;
      settle(db);
      return { DBInstances: [{ DBInstanceIdentifier, DBInstanceArn: arn('db', DBInstanceIdentifier), DBInstanceStatus: status,
        DBClusterIdentifier: db.cluster, ReadReplicaSourceDBInstanceIdentifier: db.replicaSource, Engine: 'postgres' }] };
    },
    async describeDBClusters({ DBClusterIdentifier }) {
      const db = state.clusters[DBClusterIdentifier];
      const status = db.status;
      settle(db);
      return { DBClusters: [{ DBClusterIdentifier, DBClusterArn: arn('cluster', DBClusterIdentifier), Status: status, EngineMode: db.engineMode ?? 'provisioned' }] };
    },
    async startDBInstance({ DBInstanceIdentifier }) { state.calls.push(['start', DBInstanceIdentifier]); state.instances[DBInstanceIdentifier].status = 'starting'; return {}; },
    async stopDBInstance({ DBInstanceIdentifier }) { state.calls.push(['stop', DBInstanceIdentifier]); state.instances[DBInstanceIdentifier].status = 'stopping'; return {}; },
    async startDBCluster({ DBClusterIdentifier }) { state.calls.push(['start-cluster', DBClusterIdentifier]); state.clusters[DBClusterIdentifier].status = 'starting'; return {}; },
    async stopDBCluster({ DBClusterIdentifier }) { state.calls.push(['stop-cluster', DBClusterIdentifier]); state.clusters[DBClusterIdentifier].status = 'stopping'; return {}; },
  };
}

export function fakeRdsTagging(rds, workloadId = 'demo') {
  return {
    async getResources({ TagFilters, ResourceTypeFilters }) {
      // A filter without values matches any value of the key; each resource comes with its tags (as the tagging API does).
      const wanted = TagFilters[0].Values;
      const matching = (db) => {
        const value = (db.tags ?? {})['dormeto:workload'];
        return wanted?.length ? wanted.includes(value) : value !== undefined;
      };
      const list = [];
      if (ResourceTypeFilters.includes('rds:db')) {
        for (const [id, db] of Object.entries(rds.state.instances)) if (matching(db)) list.push({ arn: rds.arn('db', id), db });
      }
      if (ResourceTypeFilters.includes('rds:cluster')) {
        for (const [id, db] of Object.entries(rds.state.clusters)) if (matching(db)) list.push({ arn: rds.arn('cluster', id), db });
      }
      return { ResourceTagMappingList: list.map(({ arn, db }) => ({ ResourceARN: arn, Tags: Object.entries(db.tags ?? {}).map(([Key, Value]) => ({ Key, Value })) })) };
    },
  };
}

// A JSON merge patch (RFC 7396): null removes a key.
export function mergePatch(target, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out = { ...(target && typeof target === 'object' && !Array.isArray(target) ? target : {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key];
    else out[key] = mergePatch(out[key], value);
  }
  return out;
}

// A JSON patch (RFC 6902): add, replace, remove and test; a failed test or a missing path fails the whole patch.
export function jsonPatch(doc, ops) {
  const out = structuredClone(doc);
  const parse = (path) => path.split('/').slice(1).map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  for (const op of ops) {
    const keys = parse(op.path);
    const last = keys.pop();
    const parent = keys.reduce((node, key) => {
      if (node?.[key] === undefined) throw Object.assign(new Error(`path ${op.path} not found`), { name: 'KubernetesError', status: 422, reason: 'Invalid' });
      return node[key];
    }, out);
    if (op.op === 'test') {
      if (JSON.stringify(parent[last]) !== JSON.stringify(op.value)) throw Object.assign(new Error(`test of ${op.path} failed`), { name: 'KubernetesError', status: 422, reason: 'Invalid' });
    } else if (op.op === 'remove') {
      if (!(last in parent)) throw Object.assign(new Error(`path ${op.path} not found`), { name: 'KubernetesError', status: 422, reason: 'Invalid' });
      if (Array.isArray(parent)) parent.splice(Number(last), 1);
      else delete parent[last];
    } else if (op.op === 'replace' && !(last in parent)) {
      throw Object.assign(new Error(`path ${op.path} not found`), { name: 'KubernetesError', status: 422, reason: 'Invalid' });
    } else {
      parent[last] = structuredClone(op.value);
    }
  }
  return out;
}

// A cluster's API as lib/k8s.mjs's client gives it: owners (Deployments, StatefulSets), pods, nodes and KEDA
// ScaledObjects (keda: false, its API missing). A patch of an owner's scale sets its replicas; at 0 its pods terminate
// and are gone after stopAfter more lists of them (0: at once). Every call is recorded in state.calls; any other call
// fails, as a write the router must not make would.
// Ingresses (create, a JSON patch, delete; each write bumps resourceVersion and calls state.onIngress(ingress, before))
// and their Events (state.events: [{ involvedObject: { kind, name }, type, reason, message, lastTimestamp }]).
export function fakeKubernetes({ owners = [], pods = [], nodes = [], scaledObjects = [], ingresses = [], events = [], keda = true, stopAfter = 0 } = {}) {
  const state = {
    owners: structuredClone(owners), pods: structuredClone(pods), nodes: structuredClone(nodes), scaledObjects: structuredClone(scaledObjects),
    ingresses: structuredClone(ingresses), events: structuredClone(events), calls: [], stopping: new Map(), onIngress: () => {}, version: 100,
  };
  const INGRESS = /^\/apis\/networking\.k8s\.io\/v1\/namespaces\/([^/]+)\/ingresses(?:\/([^/]+))?$/;
  const ingressAt = (path) => {
    const [, namespace, name] = INGRESS.exec(path) ?? [];
    return { namespace, name, index: state.ingresses.findIndex((i) => i.metadata.namespace === namespace && i.metadata.name === name) };
  };
  const stored = (ingress) => {
    state.version += 1;
    return { ...ingress, metadata: { ...ingress.metadata, resourceVersion: String(state.version) } };
  };
  const notFound = (what) => Object.assign(new Error(`${what} not found`), { name: 'KubernetesError', status: 404, reason: 'NotFound' });
  const selects = (selector, labels = {}) => !selector || selector.split(',').every((term) => {
    const [key, value] = term.split('=');
    return labels[key] === value;
  });
  const OWNER = /^\/apis\/apps\/v1\/namespaces\/([^/]+)\/(deployments|statefulsets)\/([^/]+)(\/scale)?$/;
  const KINDS = { deployments: 'Deployment', statefulsets: 'StatefulSet' };
  const ownerOf = (path) => {
    const [, namespace, resource, name, scale] = OWNER.exec(path) ?? [];
    const owner = state.owners.find((o) => o.kind === KINDS[resource] && o.metadata.name === name && o.metadata.namespace === namespace);
    return { owner, scale, what: `${KINDS[resource]} ${namespace}/${name}` };
  };
  const labelsOf = (owner) => Object.entries(owner.spec.selector.matchLabels).map(([k, v]) => `${k}=${v}`).join(',');
  const podsOf = (namespace, selector) => state.pods.filter((p) => p.metadata.namespace === namespace && selects(selector, p.metadata.labels));
  // Each Deployment's ReplicaSet (<deployment>-5d4f8); an owner's controller terminates only its own pods.
  const replicaSetsOf = (namespace, selector) => state.owners.filter((o) => o.kind === 'Deployment' && o.metadata.namespace === namespace && selects(selector, o.spec.selector.matchLabels))
    .map((o) => ({ metadata: { name: `${o.metadata.name}-5d4f8`, namespace, labels: o.spec.selector.matchLabels, ownerReferences: [{ apiVersion: 'apps/v1', kind: 'Deployment', name: o.metadata.name, controller: true }] } }));
  const controls = (owner, pod) => {
    const ref = (pod.metadata.ownerReferences ?? []).find((r) => r.controller);
    return owner.kind === 'Deployment' ? ref?.kind === 'ReplicaSet' && ref.name === `${owner.metadata.name}-5d4f8` : ref?.kind === owner.kind && ref.name === owner.metadata.name;
  };
  return {
    state,
    async get(path) {
      state.calls.push(['GET', path]);
      if (OWNER.test(path)) {
        const { owner, what } = ownerOf(path);
        if (!owner) throw notFound(what);
        return structuredClone(owner);
      }
      if (INGRESS.test(path)) {
        const { namespace, name, index } = ingressAt(path);
        if (index < 0) throw notFound(`ingresses.networking.k8s.io "${name}" in ${namespace}`);
        return structuredClone(state.ingresses[index]);
      }
      const node = /^\/api\/v1\/nodes\/([^/]+)$/.exec(path);
      if (node) {
        const found = state.nodes.find((n) => n.metadata.name === node[1]);
        if (!found) throw notFound(`node ${node[1]}`);
        return structuredClone(found);
      }
      throw new Error(`unexpected call GET ${path}`);
    },
    async list(path, query = {}) {
      state.calls.push(['LIST', path, query]);
      const pods = /^\/api\/v1\/namespaces\/([^/]+)\/pods$/.exec(path);
      if (pods) {
        const found = podsOf(pods[1], query.labelSelector);
        for (const pod of found) {
          const left = state.stopping.get(pod);
          if (left === undefined) continue;
          if (left <= 0) state.pods = state.pods.filter((p) => p !== pod);
          else state.stopping.set(pod, left - 1);
        }
        return structuredClone(podsOf(pods[1], query.labelSelector));
      }
      const events = /^\/api\/v1\/namespaces\/([^/]+)\/events$/.exec(path);
      if (events) {
        const wanted = Object.fromEntries((query.fieldSelector ?? '').split(',').filter(Boolean).map((term) => term.split('=')));
        return structuredClone(state.events.filter((e) => (e.metadata?.namespace ?? events[1]) === events[1]
          && Object.entries(wanted).every(([key, value]) => e[key.split('.')[0]]?.[key.split('.')[1]] === value)));
      }
      const sets = /^\/apis\/apps\/v1\/namespaces\/([^/]+)\/replicasets$/.exec(path);
      if (sets) return structuredClone(replicaSetsOf(sets[1], query.labelSelector));
      const scaled = /^\/apis\/keda\.sh\/v1alpha1\/namespaces\/([^/]+)\/scaledobjects$/.exec(path);
      if (scaled) {
        if (!keda) throw notFound('the server could not find the requested resource');
        return structuredClone(state.scaledObjects.filter((s) => s.metadata.namespace === scaled[1]));
      }
      throw new Error(`unexpected call LIST ${path}`);
    },
    async patch(path, body, type = 'merge') {
      state.calls.push(['PATCH', path, body, type]);
      if (OWNER.test(path)) {
        const { owner, scale, what } = ownerOf(path);
        if (!owner) throw notFound(what);
        if (!scale || type !== 'merge') throw new Error(`unexpected call PATCH ${path}`);
        owner.spec.replicas = body.spec.replicas;
        if (owner.spec.replicas === 0) {
          for (const pod of podsOf(owner.metadata.namespace, labelsOf(owner)).filter((p) => controls(owner, p))) {
            pod.metadata.deletionTimestamp = '2026-10-11T10:00:00Z';
            state.stopping.set(pod, stopAfter);
          }
          if (stopAfter === 0) state.pods = state.pods.filter((p) => !state.stopping.has(p));
        }
        return { kind: 'Scale', spec: { replicas: owner.spec.replicas } };
      }
      if (INGRESS.test(path)) {
        const { name, index } = ingressAt(path);
        if (index < 0) throw notFound(`ingresses.networking.k8s.io "${name}"`);
        if (type !== 'json') throw new Error(`unexpected call PATCH ${path} (${type})`);
        const before = state.ingresses[index];
        state.ingresses[index] = stored(jsonPatch(before, body));
        await state.onIngress(structuredClone(state.ingresses[index]), structuredClone(before));
        return structuredClone(state.ingresses[index]);
      }
      const scaled = /^\/apis\/keda\.sh\/v1alpha1\/namespaces\/([^/]+)\/scaledobjects\/([^/]+)$/.exec(path);
      if (scaled) {
        const index = state.scaledObjects.findIndex((s) => s.metadata.namespace === scaled[1] && s.metadata.name === scaled[2]);
        if (index < 0) throw notFound(`scaledobject ${scaled[2]}`);
        state.scaledObjects[index] = mergePatch(state.scaledObjects[index], body);
        return structuredClone(state.scaledObjects[index]);
      }
      throw new Error(`unexpected call PATCH ${path}`);
    },
    // SelfSubjectRulesReview: state.review ({ resourceRules, incomplete }), or state.reviewError thrown.
    async rulesReview(namespace) {
      state.calls.push(['REVIEW', namespace]);
      if (state.reviewError) throw state.reviewError;
      return structuredClone(state.review ?? { resourceRules: [], nonResourceRules: [], incomplete: false });
    },
    // SelfSubjectAccessReview: state.allow(attributes), false without it.
    async accessReview(attributes) {
      state.calls.push(['ACCESS', attributes]);
      return Boolean(state.allow?.(attributes));
    },
    async create(path, body) {
      state.calls.push(['POST', path, body]);
      const { namespace } = ingressAt(path);
      if (!INGRESS.test(path) || ingressAt(path).name) throw new Error(`unexpected call POST ${path}`);
      if (state.ingresses.some((i) => i.metadata.namespace === namespace && i.metadata.name === body.metadata.name)) {
        throw Object.assign(new Error(`ingresses.networking.k8s.io "${body.metadata.name}" already exists`), { name: 'KubernetesError', status: 409, reason: 'AlreadyExists' });
      }
      const created = stored(structuredClone(body));
      state.ingresses.push(created);
      await state.onIngress(structuredClone(created), null);
      return structuredClone(created);
    },
    async remove(path) {
      state.calls.push(['DELETE', path]);
      if (!INGRESS.test(path)) throw new Error(`unexpected call DELETE ${path}`);
      const { name, index } = ingressAt(path);
      if (index < 0) throw notFound(`ingresses.networking.k8s.io "${name}"`);
      const [gone] = state.ingresses.splice(index, 1);
      await state.onIngress(null, structuredClone(gone));
      return { kind: 'Status', status: 'Success' };
    },
  };
}

export const k8sOwner = (name, { kind = 'Deployment', namespace = 'demo', replicas = 1, labels = { app: name } } = {}) => ({
  kind, metadata: { name, namespace }, spec: { replicas, selector: { matchLabels: labels } },
});

// A pod and its controller: by default a ReplicaSet of the Deployment its name starts with (<deployment>-5d4f8).
export const k8sPod = (name, {
  namespace = 'demo', labels = { app: name.replace(/-[^-]+$/, '') }, ip, node = 'ip-10-0-1-1.eu-west-1.compute.internal', phase = 'Running', ready = true,
  requests = { cpu: '250m', memory: '512Mi' }, init, annotations = {}, fargate = false, owner = { kind: 'ReplicaSet', name: `${name.replace(/-[^-]+$/, '')}-5d4f8` },
} = {}) => ({
  metadata: { name, namespace, labels, annotations, ...(owner ? { ownerReferences: [{ apiVersion: 'apps/v1', kind: owner.kind, name: owner.name, controller: true }] } : {}) },
  spec: {
    nodeName: node, schedulerName: fargate ? 'fargate-scheduler' : 'default-scheduler',
    containers: [{ name: 'app', resources: requests ? { requests } : {} }],
    ...(init ? { initContainers: [{ name: 'init', resources: { requests: init } }] } : {}),
  },
  status: { phase, ...(ip ? { podIP: ip } : {}), conditions: [{ type: 'Ready', status: ready ? 'True' : 'False' }] },
});

export const k8sNode = (name, { type = 'm5.large', os = 'linux', labels = {}, allocatable = { cpu: '1930m', memory: '7220184Ki' } } = {}) => ({
  metadata: { name, labels: { 'node.kubernetes.io/instance-type': type, 'kubernetes.io/os': os, ...labels } }, status: { allocatable },
});

export const k8sConfig = (kubernetes = {}, overrides = {}) => testConfig({
  instanceIds: [], wakeTimeoutSeconds: 300,
  kubernetes: { cluster: 'eks-demo', namespace: 'demo', owner: { kind: 'Deployment', name: 'web' }, switch: 'ingress', ...kubernetes },
  ...overrides,
});

// A workload behind an Ingress in an IngressGroup (the switch 'ingress'), and that Ingress.
export const k8sGroupedConfig = () => k8sConfig({ switch: 'ingress', ingress: { name: 'web', ruleIndex: 1, groupOrder: -100, service: { name: 'web', port: { number: 80 } } } });

// The customer's Ingress in its group: group-wide annotations Dormeto must not copy, target group ones it must.
export const k8sCustomerIngress = () => ({
  apiVersion: 'networking.k8s.io/v1', kind: 'Ingress',
  metadata: {
    name: 'web', namespace: 'demo', labels: { 'app.kubernetes.io/managed-by': 'Helm' },
    annotations: {
      [`alb.ingress.kubernetes.io/group.name`]: 'eks-demo-group',
      [`alb.ingress.kubernetes.io/listen-ports`]: '[{"HTTP": 80}, {"HTTPS": 443}]',
      [`alb.ingress.kubernetes.io/scheme`]: 'internet-facing',
      [`alb.ingress.kubernetes.io/certificate-arn`]: 'arn:aws:acm:eu-west-1:111122223333:certificate/abc',
      [`alb.ingress.kubernetes.io/ssl-redirect`]: '443',
      [`alb.ingress.kubernetes.io/tags`]: 'team=web',
      [`alb.ingress.kubernetes.io/load-balancer-attributes`]: 'idle_timeout.timeout_seconds=60',
      [`alb.ingress.kubernetes.io/security-groups`]: 'sg-1',
      [`alb.ingress.kubernetes.io/subnets`]: 'subnet-1,subnet-2',
      [`alb.ingress.kubernetes.io/wafv2-acl-arn`]: 'arn:aws:wafv2:eu-west-1:111122223333:regional/webacl/x/y',
      [`alb.ingress.kubernetes.io/target-type`]: 'ip',
      [`alb.ingress.kubernetes.io/healthcheck-path`]: '/health',
      [`alb.ingress.kubernetes.io/healthcheck-interval-seconds`]: '10',
      [`alb.ingress.kubernetes.io/success-codes`]: '200-299',
      [`alb.ingress.kubernetes.io/healthy-threshold-count`]: '2',
      [`alb.ingress.kubernetes.io/unhealthy-threshold-count`]: '3',
      [`alb.ingress.kubernetes.io/backend-protocol`]: 'HTTP',
      [`alb.ingress.kubernetes.io/backend-protocol-version`]: 'HTTP1',
      [`alb.ingress.kubernetes.io/target-group-attributes`]: 'deregistration_delay.timeout_seconds=30',
      [`alb.ingress.kubernetes.io/conditions.web`]: '[{"field":"http-header","httpHeaderConfig":{"httpHeaderName":"X-Env","values":["prod"]}}]',
      'meta.helm.sh/release-name': 'demos',
    },
  },
  spec: {
    ingressClassName: 'alb',
    rules: [
      { host: 'docs.example.com', http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'docs', port: { number: 80 } } } }] } },
      { host: 'web.example.com', http: { paths: [
        { path: '/', pathType: 'Prefix', backend: { service: { name: 'web', port: { number: 80 } } } },
        { path: '/static', pathType: 'Prefix', backend: { service: { name: 'cdn', port: { number: 80 } } } },
      ] } },
    ],
  },
});

