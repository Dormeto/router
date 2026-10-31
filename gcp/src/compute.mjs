// Compute Engine (REST, v1): what the router reads of a workload's VMs, groups and load balancer, what it does to
// them at a nap and a wake, and the waker backend service it creates. A load balancer's parts are global (a global or a classic
// load balancer), or regional under `Region` names, which take the region first.
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
  // Google's reference asks .get on the group of both list calls.
  listGroupInstances: ['compute.instanceGroups.get'],
  getManagedGroup: ['compute.instanceGroupManagers.get'],
  listManagedInstances: ['compute.instanceGroupManagers.get'],
  getAutoscaler: ['compute.autoscalers.get'],
  setAutoscalerMode: ['compute.autoscalers.update', 'compute.zoneOperations.get', 'compute.regionOperations.get'],
  getBackendService: ['compute.backendServices.get'],
  getBackendServiceHealth: ['compute.backendServices.get'],
  insertBackendService: ['compute.backendServices.create', 'compute.backendServices.use', 'compute.regionNetworkEndpointGroups.use', 'compute.globalOperations.get'],
  deleteBackendService: ['compute.backendServices.delete', 'compute.globalOperations.get'],
  getZonalNetworkEndpointGroup: ['compute.networkEndpointGroups.get'],
  listNetworkEndpoints: ['compute.networkEndpointGroups.get'],
  getMachineType: ['compute.machineTypes.get'],
  listForwardingRules: ['compute.globalForwardingRules.list'],
  listTargetHttpProxies: ['compute.targetHttpProxies.list'],
  listTargetHttpsProxies: ['compute.targetHttpsProxies.list'],
  getRegionBackendService: ['compute.regionBackendServices.get'],
  getRegionBackendServiceHealth: ['compute.regionBackendServices.get'],
  insertRegionBackendService: ['compute.regionBackendServices.create', 'compute.regionBackendServices.use', 'compute.regionNetworkEndpointGroups.use', 'compute.regionOperations.get'],
  deleteRegionBackendService: ['compute.regionBackendServices.delete', 'compute.regionOperations.get'],
  listRegionForwardingRules: ['compute.forwardingRules.list'],
  listRegionTargetHttpProxies: ['compute.regionTargetHttpProxies.list'],
  listRegionTargetHttpsProxies: ['compute.regionTargetHttpsProxies.list'],
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
  // A POST that only reads (google.mjs's READING_POST): the endpoints of a zonal NEG, page after page.
  const listEndpoints = async (url) => {
    const items = [];
    let page = '';
    do {
      const answer = await google.request('POST', page ? `${url}?pageToken=${e(page)}` : url);
      items.push(...(answer.items ?? []));
      page = answer.nextPageToken ?? '';
    } while (page);
    return items;
  };
  const zone = (z) => `${base}/zones/${e(z)}`;
  const region = (r) => `${base}/regions/${e(r)}`;

  const calls = {
    getInstance: (z, name) => google.request('GET', `${zone(z)}/instances/${e(name)}`),
    // An unmanaged group's members (`instance` URLs and their `status`).
    listGroupInstances: async (z, name) => (await google.request('POST', `${zone(z)}/instanceGroups/${e(name)}/listInstances`, { instanceState: 'ALL' })).items ?? [],
    getManagedGroup: (group) => google.request('GET', managedUrl(group)),
    listManagedInstances: async (group) => (await google.request('POST', `${managedUrl(group)}/listManagedInstances`)).managedInstances ?? [],
    // An autoscaler: `{ kind, location, name }`, in its group's location, under its own name (the last segment of the
    // group's `status.autoscaler`; none there: the group has none). `mode`: ON, OFF, ONLY_SCALE_OUT.
    getAutoscaler: (autoscaler) => google.request('GET', `${scope(autoscaler)}/autoscalers/${e(autoscaler.name)}`),
    setAutoscalerMode: async (autoscaler, mode) => waited(await google.request(
      'PATCH',
      `${scope(autoscaler)}/autoscalers?autoscaler=${e(autoscaler.name)}`,
      { name: autoscaler.name, autoscalingPolicy: { mode } },
    )),
    getBackendService: (name) => google.request('GET', `${base}/global/backendServices/${e(name)}`),
    getBackendServiceHealth: (name, group) => google.request('POST', `${base}/global/backendServices/${e(name)}/getHealth`, { group }),
    insertBackendService: async (body) => waited(await google.request('POST', `${base}/global/backendServices`, body)),
    deleteBackendService: async (name) => waited(await google.request('DELETE', `${base}/global/backendServices/${e(name)}`)),
    // A zonal NEG (`networkEndpointType`, `annotations`, `description`) and its endpoints (`networkEndpoint.instance`, `.ipAddress`, `.port`).
    getZonalNetworkEndpointGroup: (z, name) => google.request('GET', `${zone(z)}/networkEndpointGroups/${e(name)}`),
    listNetworkEndpoints: (z, name) => listEndpoints(`${zone(z)}/networkEndpointGroups/${e(name)}/listNetworkEndpoints`),
    getMachineType: (z, name) => google.request('GET', `${zone(z)}/machineTypes/${e(name)}`),
    listForwardingRules: () => list(`${base}/global/forwardingRules`),
    listTargetHttpProxies: () => list(`${base}/global/targetHttpProxies`),
    listTargetHttpsProxies: () => list(`${base}/global/targetHttpsProxies`),
    getRegionBackendService: (r, name) => google.request('GET', `${region(r)}/backendServices/${e(name)}`),
    getRegionBackendServiceHealth: (r, name, group) => google.request('POST', `${region(r)}/backendServices/${e(name)}/getHealth`, { group }),
    insertRegionBackendService: async (r, body) => waited(await google.request('POST', `${region(r)}/backendServices`, body)),
    deleteRegionBackendService: async (r, name) => waited(await google.request('DELETE', `${region(r)}/backendServices/${e(name)}`)),
    listRegionForwardingRules: (r) => list(`${region(r)}/forwardingRules`),
    listRegionTargetHttpProxies: (r) => list(`${region(r)}/targetHttpProxies`),
    listRegionTargetHttpsProxies: (r) => list(`${region(r)}/targetHttpsProxies`),
  };
  for (const action of ACTIONS) {
    calls[`${action}Instance`] = async (z, name) => waited(await google.request('POST', `${zone(z)}/instances/${e(name)}/${action}`));
    // `instances`: the VMs' URLs, as listManagedInstances gives them.
    calls[`${action}Instances`] = async (group, instances) => waited(await google.request('POST', `${managedUrl(group)}/${action}Instances`, { instances }));
  }
  return calls;
}
