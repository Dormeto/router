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
  install: ['read', 'apis', 'roles', 'serviceAccount', 'projectBindings', 'tag', 'database', 'queue', 'logView'],
  'install-router': ['image', 'cloudRun', 'neg', 'job'],
  uninstall: ['read', 'job', 'neg', 'cloudRun', 'logView', 'queue', 'database', 'projectBindings', 'tag', 'serviceAccount', 'roles'],
  workloads: ['invoke'],
  onboard: ['invoke', 'tag', 'requestLogs'],
  offboard: ['invoke', 'tag', 'requestLogs'],
  connect: ['read', 'apis', 'federation', 'serviceAccounts', 'roles', 'projectBindings', 'folderBindings', 'organizationBindings', 'controller', 'tag'],
  disconnect: ['read', 'controller', 'tag', 'projectBindings', 'folderBindings', 'organizationBindings', 'roles', 'serviceAccounts', 'federation'],
};

// Every list of permissions in the manifest, named for the failure messages.
function permissionLists(m) {
  return [
    ...Object.entries(m.roles).map(([id, role]) => [`roles.${id}`, role.permissions]),
    ...Object.entries(m.predefined).map(([role, list]) => [`predefined.${role}`, list]),
    ...Object.entries(m.operator).flatMap(([command, steps]) => Object.entries(steps).map(([step, list]) => [`operator.${command}.${step}`, list])),
    ...Object.entries(m.manager.roles).map(([id, role]) => [`manager.roles.${id}`, role.permissions]),
    ['manager.roles.dormetoDiscovery.organizationPermissions', m.manager.roles.dormetoDiscovery.organizationPermissions],
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

test('the manifest is valid JSON, version 1, with its eight sections', async () => {
  const m = await load();
  assert.deepEqual(Object.keys(m), ['version', 'apis', 'roles', 'predefined', 'router', 'operator', 'features', 'manager']);
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

test('dormetoRouterBackends holds what starts, stops, suspends and resumes the backends, and changes a stopped VM\'s machine type, exactly', async () => {
  const { roles } = await load();
  assert.deepEqual(sorted(roles.dormetoRouterBackends.permissions), sorted([
    'compute.instances.start', 'compute.instances.stop', 'compute.instances.suspend', 'compute.instances.resume', 'compute.instances.setMachineType',
    'compute.instanceGroupManagers.update', 'compute.instanceGroupManagers.use',
  ]));
  assert.match(roles.dormetoRouterBackends.description, /change the machine type of a stopped VM/);
  assert.match(roles.dormetoRouterBackends.description, /dormeto=managed/);
  // An autoscaler cannot carry a tag: under the tag condition its change would always be refused (ruling 7).
  assert.ok(roles.dormetoRouter.permissions.includes('compute.autoscalers.update'));
  assert.ok(!roles.dormetoRouterBackends.permissions.includes('compute.autoscalers.update'));
  // The router changes nothing in IAM and binds no tag (spec sections 5 and 11).
  for (const p of Object.values(roles).flatMap((r) => r.permissions)) {
    assert.doesNotMatch(p, /\.(setIamPolicy|createTagBinding|deleteTagBinding)$|^iam\.|^resourcemanager\./, p);
  }
});

// The log view's grant (G4, the design's section 5): its role reads a view's entries, and its condition names the router's view alone,
// so that the router reads the load balancers' requests and never the applications' logs.
const LOG_VIEW_GRANT = {
  role: 'roles/logging.viewAccessor',
  on: 'project',
  condition: { title: 'The router\'s log view', expression: 'resource.name == "projects/{project}/locations/global/buckets/_Default/views/dmtr-{region}-lb"' },
};

test('the router\'s seven grants, where and on which condition', async () => {
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
    LOG_VIEW_GRANT,
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

test('the conditions name the tag, the database and the log view through placeholders', async () => {
  const { router } = await load();
  const conditions = router.filter((g) => g.condition).map((g) => g.condition.expression);
  assert.ok(conditions.some((e) => e.includes("'{project}/dormeto'")));
  assert.ok(conditions.some((e) => e.includes('{database}')));
  assert.ok(conditions.some((e) => e.includes('/buckets/_Default/views/dmtr-{region}-lb"')));
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
  // The manager section has its own placeholders (its test below).
  walk({ ...m, manager: undefined }, '');
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
  assert.deepEqual(Object.keys(predefined), ['roles/datastore.user', 'roles/logging.viewAccessor', 'roles/cloudtasks.enqueuer', 'roles/run.invoker', 'roles/iam.serviceAccountUser']);
  assert.deepEqual(predefined['roles/logging.viewAccessor'], ['logging.views.access']);
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

// The log view, made by the install and removed by the uninstall; the backend service's logConfig, set by an onboarding's
// --request-logs and set back by its offboarding, with the operator's rights, not the router's (the design's section 5).
test('the log view\'s steps and the request logs\' steps, exactly', async () => {
  const { operator: o, roles } = await load();
  // update: a later fix of the view's filter, applied to an existing install.
  assert.deepEqual(o.install.logView, ['logging.views.create', 'logging.views.get', 'logging.views.update']);
  assert.deepEqual(o.uninstall.logView, ['logging.views.get', 'logging.views.delete']);
  // The CLI waits for each operation it starts (WaitCompute): a global service's and a regional one's.
  const requestLogs = [
    'compute.backendServices.get', 'compute.backendServices.update', 'compute.regionBackendServices.get', 'compute.regionBackendServices.update',
    'compute.globalOperations.get', 'compute.regionOperations.get',
  ];
  assert.deepEqual(o.onboard.requestLogs, requestLogs);
  assert.deepEqual(o.offboard.requestLogs, requestLogs);
  // The router never changes a customer's backend service.
  for (const p of ['compute.backendServices.update', 'compute.regionBackendServices.update']) assert.ok(!roles.dormetoRouter.permissions.includes(p), p);
});

// A refused or interrupted onboarding takes back what it added (the CLI's undoBindings and undoGrant), for the operator `check` approved.
test('onboard: its step holds the deletes of its undo, each with what it undoes', async () => {
  const { operator: { onboard }, features } = await load();
  includesAll(onboard.tag, ['resourcemanager.tagValueBindings.delete', 'compute.instances.deleteTagBinding', 'compute.instanceGroupManagers.deleteTagBinding'], 'onboard.tag');
  includesAll(features['cloud-sql'].operator.onboard.tag, ['cloudsql.instances.deleteTagBinding'], 'cloud-sql onboard.tag');
  includesAll(features.gke.operator.onboard.cluster, ['container.roles.delete', 'container.roleBindings.delete'], 'gke onboard.cluster');
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
  assert.deepEqual(roles.dormetoRouterDatabasesRead.permissions, ['cloudsql.instances.get', 'cloudsql.instances.list']);
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
    onboard: { tag: ['cloudsql.instances.get', 'cloudsql.instances.listTagBindings', 'cloudsql.instances.createTagBinding', 'cloudsql.instances.deleteTagBinding', 'datastore.entities.get'] },
    offboard: { tag: ['cloudsql.instances.get', 'cloudsql.instances.listTagBindings', 'cloudsql.instances.deleteTagBinding'] },
  });
  assert.deepEqual(features.gke.operator, {
    onboard: { cluster: ['container.clusters.get', 'container.roles.create', 'container.roles.update', 'container.roleBindings.create', 'container.roleBindings.update', 'container.services.get', 'container.roles.escalate', 'container.roles.bind', 'container.clusters.connect', 'container.replicaSets.list', 'container.pods.list', 'container.roles.get', 'container.roleBindings.get', 'container.roles.delete', 'container.roleBindings.delete', 'datastore.databases.get', 'datastore.entities.get', 'datastore.entities.update'] },
    offboard: { cluster: ['container.roles.delete', 'container.roleBindings.delete', 'container.roleBindings.update', 'container.roles.bind', 'container.clusters.connect', 'container.clusters.get', 'container.roles.get', 'container.roleBindings.get', 'datastore.databases.get', 'datastore.entities.get', 'datastore.entities.update'] },
  });
});

// Design 2026-11-09-google-cloud-manager, sections 4.1, 4.2 and 4.4: what `dormeto gcp connect` turns on, creates and
// grants for the manager.
const MANAGER_PLACEHOLDERS = ['{env}', '{account}', '{hostNumber}', '{awsRole}', '{project}', '{role}'];

test('manager: its keys, in order', async () => {
  const { manager } = await load();
  assert.deepEqual(Object.keys(manager), ['apis', 'federation', 'serviceAccounts', 'roles', 'grants', 'impersonation']);
  assert.deepEqual(manager.apis, ['iam', 'iamcredentials', 'sts', 'cloudresourcemanager', 'cloudbilling'].map((a) => `${a}.googleapis.com`));
  assert.deepEqual(Object.keys(manager.roles), ['dormetoDiscovery', 'dormetoCommand']);
  for (const [id, role] of Object.entries(manager.roles)) {
    assert.match(id, ROLE_ID);
    assert.deepEqual(Object.keys(role), id === 'dormetoDiscovery' ? ['title', 'description', 'permissions', 'organizationPermissions', 'note'] : ['title', 'description', 'permissions'], id);
    assert.ok(role.title.length > 0 && role.title.length <= 100, `${id}: title`);
    assert.ok(role.description.length > 0 && role.description.length <= 256, `${id}: description`);
  }
});

test('manager: the federation and the two accounts, as design 4.1 names them', async () => {
  const { manager } = await load();
  assert.deepEqual(manager.federation, {
    pool: 'dmt-{env}',
    provider: 'aws-{account}',
    condition: "assertion.arn.startsWith('arn:aws:sts::{account}:assumed-role/dmt-{env}-manager-')",
    mapping: { 'google.subject': 'assertion.arn', 'attribute.aws_role': "assertion.arn.extract('assumed-role/{role}/')" },
  });
  assert.deepEqual(manager.serviceAccounts, { discovery: 'dmt-{env}-discovery', command: 'dmt-{env}-command' });
});

test('manager: the provider ID, filled for a 12-digit account, matches Google\'s rule and does not start with gcp-', async () => {
  const { manager } = await load();
  const id = manager.federation.provider.replaceAll('{account}', '121014831971');
  assert.equal(id, 'aws-121014831971');
  assert.match(id, /^[a-z0-9-]{4,32}$/);
  assert.ok(!id.startsWith('gcp-'));
});

test('manager: dormetoDiscovery holds only get, list and monitoring.timeSeries.list', async () => {
  const { manager } = await load();
  const { permissions: list, organizationPermissions: org } = manager.roles.dormetoDiscovery;
  for (const p of [...list, ...org]) assert.ok(/\.(get|list)$/.test(p) || p === 'monitoring.timeSeries.list', p);
  // A role defined in a project takes only permissions testable on a project; folders' and organizations' are added where the role is defined in an organization.
  assert.deepEqual(list.filter((p) => /^resourcemanager\.(folders|organizations)\./.test(p) || p === 'resourcemanager.projects.list'), []);
  assert.deepEqual(org, ['resourcemanager.folders.get', 'resourcemanager.folders.list', 'resourcemanager.organizations.get']);
  assert.deepEqual(org.filter((p) => list.includes(p)), []);
  // The manifest says so itself, for the CLI and the website that read it.
  assert.equal(manager.roles.dormetoDiscovery.note, 'organizationPermissions are added only where the role is defined in an organization: Google refuses folder and organization permissions in a role defined in a project.');
  includesAll(list, ['resourcemanager.projects.get', 'run.services.get', 'run.services.list', 'monitoring.timeSeries.list'], 'dormetoDiscovery');
  for (const kind of ['urlMaps', 'regionUrlMaps', 'backendServices', 'regionBackendServices', 'targetHttpProxies', 'targetHttpsProxies', 'regionTargetHttpProxies', 'regionTargetHttpsProxies', 'globalForwardingRules', 'forwardingRules', 'instanceGroups', 'instanceGroupManagers', 'instances', 'networkEndpointGroups']) {
    includesAll(list, [`compute.${kind}.get`, `compute.${kind}.list`], 'dormetoDiscovery');
  }
  // The scan lists a project's Cloud SQL instances as standalone candidates and tells a read replica (Plan 5's ruling): reads only, after Cloud Run's.
  includesAll(list, ['cloudsql.instances.get', 'cloudsql.instances.list'], 'dormetoDiscovery');
  assert.deepEqual(list.filter((p) => p.startsWith('cloudsql.')), ['cloudsql.instances.get', 'cloudsql.instances.list']);
  assert.deepEqual(list.slice(list.indexOf('run.services.list') + 1), ['cloudsql.instances.get', 'cloudsql.instances.list', 'monitoring.timeSeries.list']);
  assert.match(manager.roles.dormetoDiscovery.description, /Cloud SQL instances/);
  assert.match(manager.roles.dormetoDiscovery.description, /Read only\.$/);
  assert.equal(list.length + org.length, 37);
});

test('manager: each dormetoCommand permission is a tag permission the onboarding, the offboarding or the Cloud SQL feature already needs', async () => {
  const { manager, operator, features } = await load();
  const allowed = new Set([...operator.onboard.tag, ...operator.offboard.tag, ...features['cloud-sql'].operator.onboard.tag, ...features['cloud-sql'].operator.offboard.tag]);
  const list = manager.roles.dormetoCommand.permissions;
  for (const p of list) assert.ok(allowed.has(p), `${p} is no tag permission of the operator`);
  // The tag value's own permissions come from roles/resourcemanager.tagUser, the invoke from roles/run.invoker.
  assert.deepEqual(list.filter((p) => /^resourcemanager\./.test(p) || p === 'run.routes.invoke'), []);
  includesAll(list, ['compute.instances.listTagBindings', 'compute.instances.createTagBinding', 'compute.instances.deleteTagBinding', 'compute.instanceGroupManagers.listTagBindings', 'compute.instanceGroupManagers.createTagBinding', 'compute.instanceGroupManagers.deleteTagBinding', 'cloudsql.instances.get', 'cloudsql.instances.listTagBindings', 'cloudsql.instances.createTagBinding', 'cloudsql.instances.deleteTagBinding'], 'dormetoCommand');
});

test('manager: the grants at the scopes and in each router project', async () => {
  const { manager } = await load();
  assert.deepEqual(manager.grants, {
    scopes: [{ account: 'discovery', role: 'dormetoDiscovery', on: 'scope' }],
    routerProjects: [
      { account: 'command', role: 'roles/run.invoker', on: 'controller' },
      { account: 'command', role: 'roles/resourcemanager.tagUser', on: 'tagValue' },
      { account: 'command', role: 'dormetoCommand', on: 'project' },
    ],
  });
});

test('manager: the impersonation, workloadIdentityUser per account for its roles only', async () => {
  const { manager } = await load();
  const i = manager.impersonation;
  assert.equal(i.role, 'roles/iam.workloadIdentityUser');
  assert.equal(i.principalSet, 'principalSet://iam.googleapis.com/projects/{hostNumber}/locations/global/workloadIdentityPools/dmt-{env}/attribute.aws_role/{awsRole}');
  assert.deepEqual(i.discovery, ['dmt-{env}-manager-discovery', 'dmt-{env}-manager-api', 'dmt-{env}-manager-savings']);
  assert.deepEqual(i.command, ['dmt-{env}-manager-operations', 'dmt-{env}-manager-api', 'dmt-{env}-manager-fleet']);
  assert.match(i.note, /measured live \(M1\).*getOpenIdToken/);
  assert.match(i.note, /No roles\/iam\.serviceAccountOpenIdTokenCreator is needed/);
  assert.doesNotMatch(JSON.stringify(manager.grants), /serviceAccountOpenIdTokenCreator/);
});

test('manager: placeholders are the known few, and the roles carry none', async () => {
  const { manager } = await load();
  const found = JSON.stringify(manager).match(/\{[A-Za-z]*\}/g) ?? [];
  assert.ok(found.length > 0);
  for (const p of found) assert.ok(MANAGER_PLACEHOLDERS.includes(p), `unknown placeholder ${p}`);
  assert.doesNotMatch(JSON.stringify(manager.roles), /\{[A-Za-z]*\}/);
});

test('manager: connect and disconnect never ask for a policy the manager would change at run time', async () => {
  const { operator, manager } = await load();
  // testIamPermissions needs no permission; the tag value's grant is the only one at a tag.
  assert.deepEqual(operator.connect.tag, ['resourcemanager.tagValues.get', 'resourcemanager.tagValues.getIamPolicy', 'resourcemanager.tagValues.setIamPolicy']);
  includesAll(operator.connect.federation, ['iam.workloadIdentityPools.create', 'iam.workloadIdentityPools.undelete', 'iam.workloadIdentityPoolProviders.create', 'iam.workloadIdentityPoolProviders.undelete'], 'connect.federation');
  includesAll(operator.disconnect.federation, ['iam.workloadIdentityPools.delete', 'iam.workloadIdentityPoolProviders.delete'], 'disconnect.federation');
  includesAll(operator.connect.serviceAccounts, ['iam.serviceAccounts.create', 'iam.serviceAccounts.setIamPolicy'], 'connect.serviceAccounts');
  includesAll(operator.disconnect.serviceAccounts, ['iam.serviceAccounts.delete'], 'disconnect.serviceAccounts');
  includesAll(operator.connect.apis, ['serviceusage.services.enable'], 'connect.apis');
  // Each scope kind's step holds only that resource's permissions, so a check at a project asks for nothing of a folder's.
  for (const c of ['connect', 'disconnect']) {
    for (const kind of ['project', 'folder', 'organization']) {
      assert.deepEqual(operator[c][`${kind}Bindings`], [`resourcemanager.${kind}s.getIamPolicy`, `resourcemanager.${kind}s.setIamPolicy`], `${c}.${kind}Bindings`);
    }
    assert.ok(!operator[c].read.includes('resourcemanager.projects.list'), `${c}.read`);
  }
  assert.ok(manager);
});
