// What a nap stops (R9a), for the manager's savings: priced by type, never by guess.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeStopped, strategyCounts } from '../src/lib/stopped.mjs';

const ec2 = (instances) => ({
  async describeInstances({ InstanceIds }) {
    return { Reservations: [{ Instances: InstanceIds.map((id) => ({ InstanceId: id, ...instances[id] })) }] };
  },
});
const SERVICE = 'arn:aws:ecs:eu-west-1:111122223333:service/app/web';
const CLUSTER = 'arn:aws:ecs:eu-west-1:111122223333:cluster/app';
const ecs = ({ service, task, refuse = false }) => ({
  async describeServices() { return { services: [{ serviceArn: SERVICE, clusterArn: CLUSTER, taskDefinition: 'arn:td/web:3', ...service }] }; },
  async describeTaskDefinition() {
    if (refuse) throw Object.assign(new Error('not authorized to perform: ecs:DescribeTaskDefinition'), { name: 'AccessDeniedException' });
    return { taskDefinition: task };
  },
});
const rds = ({ instances = {}, clusters = {} }) => ({
  async describeDBInstances({ DBInstanceIdentifier, Filters }) {
    if (Filters) return { DBInstances: Object.entries(instances).filter(([, i]) => i.DBClusterIdentifier === Filters[0].Values[0]).map(([id, i]) => ({ DBInstanceIdentifier: id, ...i })) };
    return { DBInstances: [{ DBInstanceIdentifier, ...instances[DBInstanceIdentifier] }] };
  },
  async describeDBClusters({ DBClusterIdentifier }) { return { DBClusters: [{ DBClusterIdentifier, ...clusters[DBClusterIdentifier] }] }; },
});

test('EC2 instances by type and OS; an Auto Scaling group at its desired capacity by the types of its instances', async () => {
  const stopped = await describeStopped({
    ec2: ec2({ 'i-1': { InstanceType: 't3.medium', PlatformDetails: 'Linux/UNIX' }, 'i-2': { InstanceType: 'm5.large', PlatformDetails: 'Windows' },
      'i-3': { InstanceType: 't3.small', PlatformDetails: 'Linux/UNIX' }, 'i-4': { InstanceType: 't3a.small', PlatformDetails: 'Linux/UNIX' }, 'i-5': { InstanceType: 't3.small', PlatformDetails: 'Linux/UNIX' } }),
  }, [{ kind: 'instance', id: 'i-1' }, { kind: 'instance', id: 'i-2' }, { kind: 'asg', name: 'web', desired: 3, instances: ['i-3', 'i-4', 'i-5'] }]);
  assert.deepEqual(stopped, [
    { kind: 'ec2', type: 't3.medium', count: 1, os: 'Linux' },
    { kind: 'ec2', type: 'm5.large', count: 1, os: 'Windows' },
    { kind: 'ec2', type: 't3.small', count: 2, os: 'Linux' },
    { kind: 'ec2', type: 't3a.small', count: 1, os: 'Linux' },
  ]);
});

test('an OS that is neither Linux nor Windows is said as it is (the manager does not price it)', async () => {
  const [item] = await describeStopped({ ec2: ec2({ 'i-1': { InstanceType: 'm5.large', PlatformDetails: 'Red Hat Enterprise Linux' } }) }, [{ kind: 'instance', id: 'i-1' }]);
  assert.deepEqual(item, { kind: 'ec2', type: 'm5.large', count: 1, os: 'Red Hat Enterprise Linux' });
});

test('Windows with its own license or with SQL Server is said as it is, not as plain Windows (review I3)', async () => {
  const items = await describeStopped({ ec2: ec2({ 'i-1': { InstanceType: 'm5.large', PlatformDetails: 'Windows BYOL' }, 'i-2': { InstanceType: 'm5.large', PlatformDetails: 'Windows with SQL Server Standard' } }) },
    [{ kind: 'instance', id: 'i-1' }, { kind: 'instance', id: 'i-2' }]);
  assert.deepEqual(items.map((i) => i.os), ['Windows BYOL', 'Windows with SQL Server Standard']);
});

test('a Fargate service: its task size times its desired count; ARM; on a capacity provider; one on EC2 capacity is not counted', async () => {
  const task = { cpu: '512', memory: '1024', runtimePlatform: { cpuArchitecture: 'ARM64', operatingSystemFamily: 'LINUX' } };
  assert.deepEqual(await describeStopped({ ecs: ecs({ service: { launchType: 'FARGATE' }, task }) }, [{ kind: 'ecs', id: SERVICE, cluster: CLUSTER, desired: 2 }]),
    [{ kind: 'fargate', vcpu: 0.5, memoryGb: 1, count: 2, arch: 'arm64', os: 'Linux' }]);
  const provider = await describeStopped({ ecs: ecs({ service: { capacityProviderStrategy: [{ capacityProvider: 'FARGATE', weight: 1 }] }, task: { cpu: '256', memory: '512' } }) },
    [{ kind: 'ecs', id: SERVICE, cluster: CLUSTER, desired: 1 }]);
  assert.deepEqual(provider, [{ kind: 'fargate', vcpu: 0.25, memoryGb: 0.5, count: 1, arch: 'x86_64', os: 'Linux' }]);
  assert.deepEqual(await describeStopped({ ecs: ecs({ service: { launchType: 'EC2' }, task }) }, [{ kind: 'ecs', id: SERVICE, cluster: CLUSTER, desired: 2 }]), []);
});

test('a task size the boundary refuses is an unknown item, and the nap goes on', async () => {
  const stopped = await describeStopped({ ecs: ecs({ service: { launchType: 'FARGATE' }, refuse: true }) }, [{ kind: 'ecs', id: SERVICE, cluster: CLUSTER, desired: 1 }]);
  assert.equal(stopped.length, 1);
  assert.equal(stopped[0].kind, 'unknown');
  assert.equal(stopped[0].backend, `ecs:${SERVICE}`);
  assert.match(stopped[0].reason, /DescribeTaskDefinition/);
});

test('RDS instances (Multi-AZ said), the provisioned instances of an Aurora cluster, Aurora Serverless v2 at its minimum', async () => {
  const stopped = await describeStopped({
    rds: rds({
      instances: {
        shop: { DBInstanceClass: 'db.t4g.micro', Engine: 'postgres', MultiAZ: true },
        'aur-1': { DBInstanceClass: 'db.r6g.large', Engine: 'aurora-postgresql', DBClusterIdentifier: 'aur' },
        'srv-1': { DBInstanceClass: 'db.serverless', Engine: 'aurora-mysql', DBClusterIdentifier: 'srv' },
      },
      clusters: { aur: { Engine: 'aurora-postgresql' }, srv: { Engine: 'aurora-mysql', ServerlessV2ScalingConfiguration: { MinCapacity: 0.5, MaxCapacity: 4 } } },
    }),
  }, [{ kind: 'rds-instance', id: 'shop' }, { kind: 'rds-cluster', id: 'aur' }, { kind: 'rds-cluster', id: 'srv' }]);
  assert.deepEqual(stopped, [
    { kind: 'rds', class: 'db.t4g.micro', engine: 'postgres', multiAz: true },
    { kind: 'rds', class: 'db.r6g.large', engine: 'aurora-postgresql', multiAz: false },
    { kind: 'aurora-serverless', engine: 'aurora-mysql', acu: 0.5 },
  ]);
});

// R9.5a: what ran on Spot, for the manager to price it at Spot prices.
test('an instance on Spot is said so; a group\'s on-demand and Spot instances of one type are two items', async () => {
  const stopped = await describeStopped({
    ec2: ec2({ 'i-1': { InstanceType: 't3.medium', PlatformDetails: 'Linux/UNIX', InstanceLifecycle: 'spot' },
      'i-2': { InstanceType: 't3.medium', PlatformDetails: 'Linux/UNIX' }, 'i-3': { InstanceType: 't3.medium', PlatformDetails: 'Linux/UNIX', InstanceLifecycle: 'spot' }, 'i-4': { InstanceType: 't3.medium', PlatformDetails: 'Linux/UNIX' } }),
  }, [{ kind: 'instance', id: 'i-1' }, { kind: 'asg', name: 'web', desired: 3, instances: ['i-2', 'i-3', 'i-4'] }]);
  assert.deepEqual(stopped, [
    { kind: 'ec2', type: 't3.medium', count: 1, os: 'Linux', spot: true },
    { kind: 'ec2', type: 't3.medium', count: 2, os: 'Linux' },
    { kind: 'ec2', type: 't3.medium', count: 1, os: 'Linux', spot: true },
  ]);
});

test('a group of Spot instances whose desired capacity was not all described: the rest added to its first item', async () => {
  const stopped = await describeStopped({ ec2: ec2({ 'i-1': { InstanceType: 't3.small', PlatformDetails: 'Linux/UNIX', InstanceLifecycle: 'spot' } }) },
    [{ kind: 'asg', name: 'web', desired: 3, instances: ['i-1'] }]);
  assert.deepEqual(stopped, [{ kind: 'ec2', type: 't3.small', count: 3, os: 'Linux', spot: true }]);
});

test('a capacity provider strategy splits the desired count as ECS places it: the base first, then the weights', () => {
  const counts = (strategy, desired) => Object.fromEntries(strategyCounts(strategy, desired));
  assert.deepEqual(counts([{ capacityProvider: 'FARGATE', base: 1, weight: 1 }, { capacityProvider: 'FARGATE_SPOT', weight: 3 }], 5), { FARGATE: 2, FARGATE_SPOT: 3 });
  // Rounded with the largest remainder: always the desired count.
  const even = counts([{ capacityProvider: 'FARGATE', weight: 1 }, { capacityProvider: 'FARGATE_SPOT', weight: 1 }], 3);
  assert.equal(even.FARGATE + even.FARGATE_SPOT, 3);
  assert.ok([1, 2].includes(even.FARGATE));
  assert.deepEqual(counts([{ capacityProvider: 'FARGATE', base: 5, weight: 1 }, { capacityProvider: 'FARGATE_SPOT', weight: 1 }], 2), { FARGATE: 2, FARGATE_SPOT: 0 });
  // No weight: the base's provider takes the rest.
  assert.deepEqual(counts([{ capacityProvider: 'FARGATE', base: 1, weight: 0 }, { capacityProvider: 'FARGATE_SPOT', weight: 0 }], 3), { FARGATE: 3, FARGATE_SPOT: 0 });
  assert.deepEqual(counts([{ capacityProvider: 'app-asg', weight: 1 }, { capacityProvider: 'FARGATE_SPOT', weight: 1 }], 4), { 'app-asg': 2, FARGATE_SPOT: 2 });
});

test('a Fargate service on Fargate and Fargate Spot: an item each; on Fargate Spot only, one Spot item; a share on EC2 capacity not counted', async () => {
  const task = { cpu: '256', memory: '512' };
  const size = { kind: 'fargate', vcpu: 0.25, memoryGb: 0.5, arch: 'x86_64', os: 'Linux' };
  const of = (capacityProviderStrategy, desired) => describeStopped({ ecs: ecs({ service: { capacityProviderStrategy }, task }) }, [{ kind: 'ecs', id: SERVICE, cluster: CLUSTER, desired }]);
  assert.deepEqual(await of([{ capacityProvider: 'FARGATE', base: 1, weight: 1 }, { capacityProvider: 'FARGATE_SPOT', weight: 3 }], 5),
    [{ ...size, count: 2 }, { ...size, count: 3, spot: true }]);
  assert.deepEqual(await of([{ capacityProvider: 'FARGATE_SPOT', weight: 1 }], 2), [{ ...size, count: 2, spot: true }]);
  assert.deepEqual(await of([{ capacityProvider: 'app-asg', weight: 1 }, { capacityProvider: 'FARGATE_SPOT', weight: 1 }], 4), [{ ...size, count: 2, spot: true }]);
});
