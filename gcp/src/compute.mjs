// Compute Engine (REST, v1): what the router reads of a workload's VMs, groups and load balancer, what it does to
// them at a nap and a wake, and the waker backend service it creates. Global load balancer only (spec section 2).
//
// `CALLS` is each function's permissions: the manifest's router grants (gcp/access.json) must hold them all
// (test/permissions.test.mjs). Regional managed groups and autoscalers need the same permissions as zonal ones.
//
// A group is `{ kind: 'zonal' | 'regional', location, name }`. What changes something waits for its operation.
const COMPUTE = 'https://compute.googleapis.com/compute/v1';
const WAIT_MS = 120_000;
const ACTIONS = ['stop', 'start', 'suspend', 'resume'];

export const CALLS = {
  getInstance: ['compute.instances.get'],
  listInstances: ['compute.instances.list'],
  getGroup: ['compute.instanceGroups.get'],
  listGroupInstances: ['compute.instanceGroups.list'],
  getManagedGroup: ['compute.instanceGroupManagers.get'],
  listManagedInstances: ['compute.instanceGroupManagers.list'],
  getAutoscaler: ['compute.autoscalers.get'],
  setAutoscalerMode: ['compute.autoscalers.update'],
  getBackendService: ['compute.backendServices.get'],
  listBackendServices: ['compute.backendServices.list'],
  getBackendServiceHealth: ['compute.backendServices.get'],
  insertBackendService: ['compute.backendServices.create', 'compute.backendServices.use', 'compute.regionNetworkEndpointGroups.use'],
  deleteBackendService: ['compute.backendServices.delete'],
  getNetworkEndpointGroup: ['compute.regionNetworkEndpointGroups.get'],
  getHealthCheck: ['compute.healthChecks.get'],
  getMachineType: ['compute.machineTypes.get'],
  listForwardingRules: ['compute.globalForwardingRules.list'],
  listTargetHttpProxies: ['compute.targetHttpProxies.list'],
  listTargetHttpsProxies: ['compute.targetHttpsProxies.list'],
  ...Object.fromEntries(ACTIONS.map((a) => [`${a}Instance`, [`compute.instances.${a}`]])),
  ...Object.fromEntries(ACTIONS.map((a) => [`${a}Instances`, ['compute.instanceGroupManagers.update']])),
};

export function createCompute({ google, project, now = Date.now }) {
  const base = `${COMPUTE}/projects/${project}`;
  const e = encodeURIComponent;
  const scope = ({ kind, location }) => `${base}/${kind === 'regional' ? 'regions' : 'zones'}/${e(location)}`;
  const managedUrl = (group) => `${scope(group)}/instanceGroupManagers/${e(group.name)}`;
  const waited = async (operation) => {
    await google.waitCompute(operation, now() + WAIT_MS);
    return operation;
  };
  const list = async (url) => {
    const items = [];
    let page = '';
    do {
      const answer = await google.request('GET', page ? `${url}?pageToken=${e(page)}` : url);
      items.push(...(answer.items ?? []));
      page = answer.nextPageToken ?? '';
    } while (page);
    return items;
  };
  const zone = (z) => `${base}/zones/${e(z)}`;

  const calls = {
    getInstance: (z, name) => google.request('GET', `${zone(z)}/instances/${e(name)}`),
    listInstances: (z) => list(`${zone(z)}/instances`),
    // An unmanaged group's members (`instance` URLs and their `status`).
    getGroup: (z, name) => google.request('GET', `${zone(z)}/instanceGroups/${e(name)}`),
    listGroupInstances: async (z, name) => (await google.request('POST', `${zone(z)}/instanceGroups/${e(name)}/listInstances`, { instanceState: 'ALL' })).items ?? [],
    getManagedGroup: (group) => google.request('GET', managedUrl(group)),
    listManagedInstances: async (group) => (await google.request('POST', `${managedUrl(group)}/listManagedInstances`)).managedInstances ?? [],
    getAutoscaler: (group) => google.request('GET', `${scope(group)}/autoscalers/${e(group.name)}`),
    // The autoscaler is named like its group in the group's own location (`mode`: ON, OFF, ONLY_SCALE_OUT).
    setAutoscalerMode: async (group, mode) => waited(await google.request(
      'PATCH',
      `${scope(group)}/autoscalers?autoscaler=${e(group.name)}`,
      { name: group.name, autoscalingPolicy: { mode } },
    )),
    getBackendService: (name) => google.request('GET', `${base}/global/backendServices/${e(name)}`),
    listBackendServices: () => list(`${base}/global/backendServices`),
    getBackendServiceHealth: (name, group) => google.request('POST', `${base}/global/backendServices/${e(name)}/getHealth`, { group }),
    insertBackendService: async (body) => waited(await google.request('POST', `${base}/global/backendServices`, body)),
    deleteBackendService: async (name) => waited(await google.request('DELETE', `${base}/global/backendServices/${e(name)}`)),
    getNetworkEndpointGroup: (region, name) => google.request('GET', `${base}/regions/${e(region)}/networkEndpointGroups/${e(name)}`),
    getHealthCheck: (name) => google.request('GET', `${base}/global/healthChecks/${e(name)}`),
    getMachineType: (z, name) => google.request('GET', `${zone(z)}/machineTypes/${e(name)}`),
    listForwardingRules: () => list(`${base}/global/forwardingRules`),
    listTargetHttpProxies: () => list(`${base}/global/targetHttpProxies`),
    listTargetHttpsProxies: () => list(`${base}/global/targetHttpsProxies`),
  };
  for (const action of ACTIONS) {
    calls[`${action}Instance`] = async (z, name) => waited(await google.request('POST', `${zone(z)}/instances/${e(name)}/${action}`));
    // `instances`: the VMs' URLs, as listManagedInstances gives them.
    calls[`${action}Instances`] = async (group, instances) => waited(await google.request('POST', `${managedUrl(group)}/${action}Instances`, { instances }));
  }
  return calls;
}
