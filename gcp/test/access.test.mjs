// The Google Cloud manifest (vision docs/specs/2026-10-29-google-cloud-design.md, sections 4 and 9): every API, custom
// role, router grant and operator permission, the one source the CLI's checks, the router's adapters and the website
// are compared with.
//
// Placeholders: `{project}`, `{projectNumber}`, `{region}` and `{database}` appear in the router grants' conditions,
// and `{project}` in the name of a grant's custom role (`projects/{project}/roles/<id>`), which the CLI fills the same
// way. Nowhere else.
//
// Regional managed instance groups, regional instance groups and regional autoscalers have no permissions of their own:
// Compute Engine checks `compute.instanceGroupManagers.*`, `compute.instanceGroups.*` and `compute.autoscalers.*` for
// the zonal and the regional methods alike (its REST reference, method by method).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const MANIFEST = new URL('../access.json', import.meta.url);
const load = async () => JSON.parse(await readFile(MANIFEST, 'utf8'));

const PERMISSION = /^[a-z]+(\.[a-zA-Z]+){2,}$/;
const ROLE_ID = /^[a-zA-Z0-9_.]{3,64}$/;
const PLACEHOLDERS = ['{project}', '{projectNumber}', '{region}', '{database}'];

// Ruling 1 of the plan's ledger: the commands and their steps, in order.
const STEPS = {
  check: ['read'],
  install: ['read', 'apis', 'roles', 'serviceAccount', 'projectBindings', 'tag', 'database', 'queue'],
  'install-router': ['image', 'cloudRun', 'neg', 'job'],
  uninstall: ['read', 'job', 'neg', 'cloudRun', 'queue', 'database', 'projectBindings', 'tag', 'serviceAccount', 'roles'],
  workloads: ['invoke'],
  onboard: ['invoke', 'tag'],
  offboard: ['invoke', 'tag'],
};

// Every list of permissions in the manifest, named for the failure messages.
function permissionLists(m) {
  return [
    ...Object.entries(m.roles).map(([id, role]) => [`roles.${id}`, role.permissions]),
    ...Object.entries(m.predefined).map(([role, list]) => [`predefined.${role}`, list]),
    ...Object.entries(m.operator).flatMap(([command, steps]) => Object.entries(steps).map(([step, list]) => [`operator.${command}.${step}`, list])),
    ...Object.entries(m.features ?? {}).flatMap(([name, f]) => [
      ...Object.entries(f.roles).map(([id, role]) => [`features.${name}.roles.${id}`, role.permissions]),
      ...Object.entries(f.operator).flatMap(([command, steps]) => Object.entries(steps).map(([step, list]) => [`features.${name}.operator.${command}.${step}`, list])),
    ]),
  ];
}

const includesAll = (list, wanted, where) => {
  const missing = wanted.filter((p) => !list.includes(p));
  assert.deepEqual(missing, [], `${where} lacks ${missing.join(', ')}`);
};

test('the manifest is valid JSON, version 1, with its seven sections', async () => {
  const m = await load();
  assert.deepEqual(Object.keys(m), ['version', 'apis', 'roles', 'predefined', 'router', 'operator', 'features']);
  assert.equal(m.version, 1);
});

test('the APIs are G1\'s ten', async () => {
  const { apis } = await load();
  assert.deepEqual(apis, ['compute', 'run', 'firestore', 'cloudtasks', 'cloudscheduler', 'monitoring', 'artifactregistry', 'iam', 'cloudresourcemanager', 'logging'].map((a) => `${a}.googleapis.com`));
});

test('every permission is well formed and listed once in its list', async () => {
  const m = await load();
  for (const [where, list] of permissionLists(m)) {
    assert.ok(Array.isArray(list) && list.length > 0, `${where} lists no permission`);
    for (const p of list) assert.match(p, PERMISSION, `${where}: ${p}`);
    const twice = list.filter((p, i) => list.indexOf(p) !== i);
    assert.deepEqual(twice, [], `${where} lists ${twice.join(', ')} twice`);
  }
});

test('the custom roles: IDs, titles and descriptions as Google accepts them, no permission in both', async () => {
  const { roles } = await load();
  assert.deepEqual(Object.keys(roles), ['dormetoRouter', 'dormetoRouterBackends']);
  for (const [id, role] of Object.entries(roles)) {
    assert.match(id, ROLE_ID);
    assert.deepEqual(Object.keys(role), ['title', 'description', 'permissions'], id);
    assert.ok(role.title.length > 0 && role.title.length <= 100, `${id}: title of 1 to 100 characters`);
    assert.ok(role.description.length > 0 && role.description.length <= 256, `${id}: description of 1 to 256 characters`);
  }
  const both = roles.dormetoRouter.permissions.filter((p) => roles.dormetoRouterBackends.permissions.includes(p));
  assert.deepEqual(both, [], 'the conditional role must not repeat an unconditional permission');
});

// Each custom role's permissions exactly, so that a permission in the wrong role fails.
const sorted = (list) => [...list].sort();

test('dormetoRouter holds spec section 4\'s permissions, exactly', async () => {
  const { roles } = await load();
  assert.deepEqual(sorted(roles.dormetoRouter.permissions), sorted([
    'compute.urlMaps.get', 'compute.urlMaps.list', 'compute.urlMaps.update',
    'compute.backendServices.get', 'compute.backendServices.use', 'compute.backendServices.create', 'compute.backendServices.delete',
    'compute.regionNetworkEndpointGroups.use',
    'compute.globalForwardingRules.list', 'compute.targetHttpProxies.list', 'compute.targetHttpsProxies.list',
    'compute.instances.get',
    'compute.instanceGroups.get',
    'compute.instanceGroupManagers.get',
    'compute.autoscalers.get', 'compute.autoscalers.update',
    'compute.machineTypes.get',
    'compute.globalOperations.get', 'compute.zoneOperations.get', 'compute.regionOperations.get',
    'monitoring.timeSeries.list',
    // S3: zonal NEGs of VMs (spec section 6): read only, the waker's backend service names the regional one.
    'compute.networkEndpointGroups.get',
    // S4: regional and classic load balancers (spec section 7).
    'compute.regionUrlMaps.get', 'compute.regionUrlMaps.list', 'compute.regionUrlMaps.update',
    'compute.regionBackendServices.get', 'compute.regionBackendServices.use', 'compute.regionBackendServices.create', 'compute.regionBackendServices.delete',
    'compute.regionTargetHttpProxies.list', 'compute.regionTargetHttpsProxies.list', 'compute.forwardingRules.list',
  ]));
});

test('dormetoRouterBackends holds what starts, stops, suspends and resumes the backends, exactly', async () => {
  const { roles } = await load();
  assert.deepEqual(sorted(roles.dormetoRouterBackends.permissions), sorted([
    'compute.instances.start', 'compute.instances.stop', 'compute.instances.suspend', 'compute.instances.resume',
    'compute.instanceGroupManagers.update', 'compute.instanceGroupManagers.use',
  ]));
  // An autoscaler cannot carry a tag: under the tag condition its change would always be refused (ruling 7).
  assert.ok(roles.dormetoRouter.permissions.includes('compute.autoscalers.update'));
  assert.ok(!roles.dormetoRouterBackends.permissions.includes('compute.autoscalers.update'));
  // The router changes nothing in IAM and binds no tag (spec sections 5 and 11).
  for (const p of Object.values(roles).flatMap((r) => r.permissions)) {
    assert.doesNotMatch(p, /\.(setIamPolicy|createTagBinding|deleteTagBinding)$|^iam\.|^resourcemanager\./, p);
  }
});

test('the router\'s six grants, where and on which condition', async () => {
  const m = await load();
  assert.deepEqual(m.router, [
    { role: 'projects/{project}/roles/dormetoRouter', on: 'project' },
    {
      role: 'projects/{project}/roles/dormetoRouterBackends',
      on: 'project',
      condition: { title: 'Dormeto-managed resources', expression: "resource.matchTag('{project}/dormeto', 'managed')" },
    },
    {
      role: 'roles/datastore.user',
      on: 'project',
      condition: { title: 'The router\'s database', expression: 'resource.name == "projects/{project}/databases/{database}"' },
    },
    { role: 'roles/cloudtasks.enqueuer', on: 'queue' },
    { role: 'roles/run.invoker', on: 'controller' },
    { role: 'roles/iam.serviceAccountUser', on: 'serviceAccount' },
  ]);
  for (const grant of m.router) {
    assert.ok(['project', 'queue', 'controller', 'serviceAccount'].includes(grant.on), grant.role);
    const custom = grant.role.match(/^projects\/\{project\}\/roles\/(.+)$/);
    if (custom) assert.ok(m.roles[custom[1]], `${grant.role}: no such custom role`);
    else assert.ok(m.predefined[grant.role], `${grant.role}: not in predefined`);
  }
  // Each role defined is granted.
  assert.deepEqual(Object.keys(m.roles).map((id) => `projects/{project}/roles/${id}`).filter((r) => !m.router.some((g) => g.role === r)), []);
  assert.deepEqual(Object.keys(m.predefined).filter((r) => !m.router.some((g) => g.role === r)), []);
});

test('the conditions name the tag and the database through placeholders', async () => {
  const { router } = await load();
  const conditions = router.filter((g) => g.condition).map((g) => g.condition.expression);
  assert.ok(conditions.some((e) => e.includes("'{project}/dormeto'")));
  assert.ok(conditions.some((e) => e.includes('{database}')));
});

test('placeholders appear only in the conditions and in the custom roles\' names, and only the four known', async () => {
  const m = await load();
  const found = [];
  const walk = (value, path) => {
    if (typeof value === 'string') {
      for (const [p] of value.matchAll(/\{[^}]*\}/g)) found.push([path, p, value]);
    } else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`);
    }
  };
  walk(m, '');
  assert.ok(found.length > 0);
  for (const [path, placeholder, value] of found) {
    assert.ok(PLACEHOLDERS.includes(placeholder), `${path}: unknown placeholder ${placeholder}`);
    const inCondition = /^(\.features\.[a-z-]+)?\.router\.\d+\.condition\.expression$/.test(path);
    const inRoleName = /^(\.features\.[a-z-]+)?\.router\.\d+\.role$/.test(path) && /^projects\/\{project\}\/roles\/[a-zA-Z0-9_.]+$/.test(value);
    assert.ok(inCondition || inRoleName, `${path}: ${placeholder} outside a condition or a custom role's name`);
  }
});

test('the predefined roles list the permissions the router relies on', async () => {
  const { predefined } = await load();
  assert.deepEqual(Object.keys(predefined), ['roles/datastore.user', 'roles/cloudtasks.enqueuer', 'roles/run.invoker', 'roles/iam.serviceAccountUser']);
  includesAll(predefined['roles/datastore.user'], ['datastore.entities.get', 'datastore.entities.list', 'datastore.entities.create', 'datastore.entities.update', 'datastore.entities.delete'], 'roles/datastore.user');
  assert.deepEqual(predefined['roles/cloudtasks.enqueuer'], ['cloudtasks.tasks.create']);
  assert.deepEqual(predefined['roles/run.invoker'], ['run.routes.invoke']);
  assert.deepEqual(predefined['roles/iam.serviceAccountUser'], ['iam.serviceAccounts.actAs']);
});

test('the operator\'s commands and steps, each with at least one permission', async () => {
  const { operator } = await load();
  assert.deepEqual(Object.keys(operator), Object.keys(STEPS));
  for (const [command, steps] of Object.entries(STEPS)) {
    assert.deepEqual(Object.keys(operator[command]), steps, command);
    for (const step of steps) assert.ok(operator[command][step].length > 0, `${command}.${step}`);
  }
});

test('the operator\'s permissions of spec section 4, step by step', async () => {
  const { operator: o } = await load();
  const read = ['resourcemanager.projects.get', 'resourcemanager.projects.getIamPolicy', 'serviceusage.services.list', 'serviceusage.services.use'];
  includesAll(o.check.read, read, 'check.read');
  includesAll(o.install.read, read, 'install.read');
  includesAll(o.uninstall.read, read, 'uninstall.read');
  includesAll(o.install.apis, ['serviceusage.services.enable'], 'install.apis');
  includesAll(o.install.roles, ['iam.roles.get', 'iam.roles.create', 'iam.roles.update', 'iam.roles.undelete'], 'install.roles');
  includesAll(o.install.serviceAccount, ['iam.serviceAccounts.get', 'iam.serviceAccounts.create', 'iam.serviceAccounts.getIamPolicy', 'iam.serviceAccounts.setIamPolicy', 'iam.serviceAccounts.actAs'], 'install.serviceAccount');
  includesAll(o.install.projectBindings, ['resourcemanager.projects.setIamPolicy'], 'install.projectBindings');
  includesAll(o.install.tag, ['resourcemanager.tagKeys.create', 'resourcemanager.tagKeys.get', 'resourcemanager.tagValues.create', 'resourcemanager.tagValues.get'], 'install.tag');
  includesAll(o.install.database, ['datastore.databases.create', 'datastore.databases.get', 'datastore.entities.create', 'datastore.entities.get'], 'install.database');
  includesAll(o.install.queue, ['cloudtasks.queues.create', 'cloudtasks.queues.get', 'cloudtasks.queues.getIamPolicy', 'cloudtasks.queues.setIamPolicy'], 'install.queue');
  includesAll(o['install-router'].image, ['artifactregistry.repositories.get', 'artifactregistry.dockerimages.get'], 'install-router.image');
  includesAll(o['install-router'].cloudRun, ['run.services.create', 'run.services.get', 'run.services.update', 'run.services.getIamPolicy', 'run.services.setIamPolicy', 'iam.serviceAccounts.actAs'], 'install-router.cloudRun');
  includesAll(o['install-router'].neg, ['compute.regionNetworkEndpointGroups.create', 'compute.regionNetworkEndpointGroups.get', 'compute.regionOperations.get'], 'install-router.neg');
  includesAll(o['install-router'].job, ['cloudscheduler.jobs.create', 'cloudscheduler.jobs.get', 'cloudscheduler.jobs.update', 'iam.serviceAccounts.actAs'], 'install-router.job');
  for (const command of ['workloads', 'onboard', 'offboard']) includesAll(o[command].invoke, ['run.routes.invoke'], `${command}.invoke`);
  includesAll(o.onboard.tag, ['compute.instances.createTagBinding', 'resourcemanager.tagValueBindings.create'], 'onboard.tag');
  includesAll(o.offboard.tag, ['compute.instances.deleteTagBinding', 'resourcemanager.tagValueBindings.delete'], 'offboard.tag');
});

test('uninstall: the matching deletes, step by step, and the project policy', async () => {
  const { operator: { uninstall: u } } = await load();
  includesAll(u.job, ['cloudscheduler.jobs.delete'], 'uninstall.job');
  includesAll(u.neg, ['compute.regionNetworkEndpointGroups.delete'], 'uninstall.neg');
  includesAll(u.cloudRun, ['run.services.delete'], 'uninstall.cloudRun');
  includesAll(u.queue, ['cloudtasks.queues.delete'], 'uninstall.queue');
  includesAll(u.database, ['datastore.databases.delete'], 'uninstall.database');
  includesAll(u.projectBindings, ['resourcemanager.projects.getIamPolicy', 'resourcemanager.projects.setIamPolicy'], 'uninstall.projectBindings');
  includesAll(u.tag, ['resourcemanager.tagValues.delete', 'resourcemanager.tagKeys.delete'], 'uninstall.tag');
  includesAll(u.serviceAccount, ['iam.serviceAccounts.delete'], 'uninstall.serviceAccount');
  includesAll(u.roles, ['iam.roles.delete'], 'uninstall.roles');
});

test('no permission Google does not have: resourcemanager.tagValues.use appears nowhere', async () => {
  // A tag value's binding is resourcemanager.tagValueBindings.create and .delete (ruling 6).
  assert.doesNotMatch(await readFile(MANIFEST, 'utf8'), /resourcemanager\.tagValues\.use/);
});

test('npm test runs the Google Cloud tests', async () => {
  const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.match(pkg.scripts.test, /"gcp\/test\/\*\.test\.mjs"/);
  assert.match(pkg.scripts.test, /"lambda\/test\/\*\.test\.mjs"/);
});

// Spec sections 4, 8 and 9: optional features, not in `apis`.
test('features: cloud-sql and gke, their APIs apart from the ten', async () => {
  const m = await load();
  assert.deepEqual(Object.keys(m.features), ['cloud-sql', 'gke']);
  assert.deepEqual(m.features['cloud-sql'].apis, ['sqladmin.googleapis.com']);
  assert.deepEqual(m.features.gke.apis, ['container.googleapis.com']);
  for (const api of ['sqladmin.googleapis.com', 'container.googleapis.com']) assert.ok(!m.apis.includes(api), `${api} must not be in apis`);
  for (const f of Object.values(m.features)) assert.deepEqual(Object.keys(f), ['apis', 'roles', 'router', 'operator']);
});

test('features: dormetoRouterKubernetes holds exactly the cluster get and connect', async () => {
  const { features } = await load();
  assert.deepEqual(Object.keys(features.gke.roles), ['dormetoRouterKubernetes']);
  assert.deepEqual(sorted(features.gke.roles.dormetoRouterKubernetes.permissions), ['container.clusters.connect', 'container.clusters.get']);
  assert.deepEqual(features.gke.router, [{ role: 'projects/{project}/roles/dormetoRouterKubernetes', on: 'project' }]);
});

test('features: the cloudsql.instances.update grant carries the tag condition, get does not', async () => {
  const { features, router } = await load();
  const roles = features['cloud-sql'].roles;
  assert.deepEqual(Object.keys(roles), ['dormetoRouterDatabasesRead', 'dormetoRouterDatabases']);
  assert.deepEqual(roles.dormetoRouterDatabasesRead.permissions, ['cloudsql.instances.get']);
  assert.deepEqual(roles.dormetoRouterDatabases.permissions, ['cloudsql.instances.update']);
  const tagCondition = router.find((g) => g.role.endsWith('/dormetoRouterBackends')).condition;
  assert.deepEqual(features['cloud-sql'].router, [
    { role: 'projects/{project}/roles/dormetoRouterDatabasesRead', on: 'project' },
    { role: 'projects/{project}/roles/dormetoRouterDatabases', on: 'project', condition: tagCondition },
  ]);
});

test('features: every grant names a role of its feature; roles are valid and none repeats a permission of the base roles', async () => {
  const m = await load();
  const base = new Set(Object.values(m.roles).flatMap((r) => r.permissions));
  for (const [name, f] of Object.entries(m.features)) {
    for (const [id, role] of Object.entries(f.roles)) {
      assert.match(id, ROLE_ID);
      assert.deepEqual(Object.keys(role), ['title', 'description', 'permissions'], id);
      assert.ok(role.title.length > 0 && role.title.length <= 100, id);
      assert.ok(role.description.length > 0 && role.description.length <= 256, id);
      for (const p of role.permissions) assert.ok(!base.has(p), `${id}: ${p} is in a base role`);
    }
    for (const grant of f.router) assert.ok(f.roles[/\/roles\/(.+)$/.exec(grant.role)[1]], `${name}: ${grant.role}`);
    assert.deepEqual(Object.keys(f.roles).filter((id) => !f.router.some((g) => g.role.endsWith(`/${id}`))), [], `${name}: a role not granted`);
  }
});

test('features: the operator permissions of Cloud SQL and GKE', async () => {
  const { features } = await load();
  assert.deepEqual(features['cloud-sql'].operator, {
    onboard: { tag: ['cloudsql.instances.get', 'cloudsql.instances.listTagBindings', 'cloudsql.instances.createTagBinding'] },
    offboard: { tag: ['cloudsql.instances.listTagBindings', 'cloudsql.instances.deleteTagBinding'] },
  });
  assert.deepEqual(features.gke.operator, {
    onboard: { cluster: ['container.clusters.get', 'container.roles.create', 'container.roles.update', 'container.roleBindings.create', 'container.roleBindings.update', 'container.deployments.get', 'container.statefulSets.get', 'container.services.get', 'container.roles.escalate', 'container.roles.bind', 'container.clusters.connect', 'container.services.list', 'container.deployments.list', 'container.statefulSets.list', 'container.replicaSets.get', 'container.replicaSets.list', 'container.pods.list', 'container.roles.get', 'container.roleBindings.get', 'datastore.databases.get', 'datastore.entities.get', 'datastore.entities.update'] },
    offboard: { cluster: ['container.roles.delete', 'container.roleBindings.delete', 'container.roleBindings.update', 'container.roles.bind', 'container.clusters.connect', 'container.clusters.get', 'container.roles.get', 'container.roleBindings.get', 'datastore.databases.get', 'datastore.entities.get', 'datastore.entities.update'] },
  });
});
