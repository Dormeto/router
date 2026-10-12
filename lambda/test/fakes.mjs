import { matches, STATES } from '../src/lib/state.mjs';
import { currentTarget } from '../src/lib/route.mjs';

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
    onSleep: (fn) => hooks.push(fn),
    async sleep(ms) {
      t += ms;
      for (const hook of hooks) await hook(t);
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

export function fakeStore({ config, run, clock }) {
  const state = { run: structuredClone(run) };
  const copy = () => structuredClone(state.run);
  return {
    state,
    async getConfig(id) { return id === config.workloadId ? structuredClone(config) : null; },
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
    async setPendingWake() {
      if (state.run.state !== STATES.NAPPING) return false;
      state.run.pendingWake = true;
      return true;
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

export function fakeElbv2(cfg, { target = 'app', healthy = 1 } = {}) {
  const [app, waker] = target === 'app' ? [1, 0] : [0, 1];
  const state = {
    healthy,
    modifyCount: 0,
    actions: [{
      Type: 'forward',
      Order: 1,
      ForwardConfig: {
        TargetGroups: [{ TargetGroupArn: cfg.appTargetGroupArn, Weight: app }, { TargetGroupArn: cfg.wakerTargetGroupArn, Weight: waker }],
        TargetGroupStickinessConfig: { Enabled: false },
      },
    }],
  };
  return {
    state,
    async describeRules({ RuleArns }) {
      return { Rules: RuleArns[0] === cfg.ruleArn ? [{ RuleArn: cfg.ruleArn, Actions: structuredClone(state.actions) }] : [] };
    },
    async modifyRule({ Actions }) {
      state.modifyCount += 1;
      state.actions = structuredClone(Actions);
      return {};
    },
    async describeTargetHealth() {
      // Explicit targets ([{ Id, State }]) when a test sets them, else `healthy` anonymous healthy targets.
      if (state.targets) {
        return { TargetHealthDescriptions: state.targets.map((t) => ({ Target: { Id: t.Id }, TargetHealth: { State: t.State } })) };
      }
      return { TargetHealthDescriptions: Array.from({ length: state.healthy }, (_, i) => ({ Target: { Id: `i-${i}` }, TargetHealth: { State: 'healthy' } })) };
    },
  };
}

export const routeOf = (elbv2, cfg) => currentTarget(elbv2.state.actions, cfg);

export function fakeEc2(ids, { state = 'running' } = {}) {
  const s = { instances: Object.fromEntries(ids.map((id) => [id, state])), tags: {}, started: 0, stopped: 0, onStart: [], onStop: [] };
  return {
    state: s,
    async describeInstances({ InstanceIds }) {
      return {
        Reservations: [{
          Instances: InstanceIds.map((id) => ({
            InstanceId: id,
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
        const key = filter.Name.replace(/^tag:/, '');
        result = result.filter((g) => (g.Tags ?? []).some((t) => t.Key === key && filter.Values.includes(t.Value)));
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
      const [{ Key, Values }] = TagFilters;
      const list = ResourceTypeFilters.includes('ecs:service') ? ecs.state.services : [];
      return {
        ResourceTagMappingList: list
          .filter((s) => Values.includes((s.tags ?? {})[Key]))
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
      const wanted = TagFilters[0].Values;
      const list = [];
      if (ResourceTypeFilters.includes('rds:db')) {
        for (const [id, db] of Object.entries(rds.state.instances)) if (wanted.includes((db.tags ?? {})['dormeto:workload'])) list.push(rds.arn('db', id));
      }
      if (ResourceTypeFilters.includes('rds:cluster')) {
        for (const [id, db] of Object.entries(rds.state.clusters)) if (wanted.includes((db.tags ?? {})['dormeto:workload'])) list.push(rds.arn('cluster', id));
      }
      return { ResourceTagMappingList: list.map((ResourceARN) => ({ ResourceARN })) };
    },
  };
}
