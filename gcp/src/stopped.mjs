// What a nap stops, named by what prices it (vision docs/specs/2026-11-09-google-cloud-manager-design.md, section 9.1), as AWS's
// lambda/src/lib/stopped.mjs does: each VM by machine type, zone, system and Spot, a Cloud SQL companion by tier, engine and edition. A
// backend that cannot be described is said (an unknown item), never guessed; describing never stops the nap.
import { k8sId } from '../../lambda/src/lib/kubernetes.mjs';

const ITEMS_MAX = 50;

const unknown = (backend, err) => ({ kind: 'unknown', backend, reason: String(err?.message ?? err).slice(0, 200) });
const nameOf = (url) => String(url).split('/').pop();

// The shared cores bill a fraction of a vCPU (the Compute Engine documentation lists them as such).
const SHARED_VCPUS = { 'e2-micro': 0.25, 'e2-small': 0.5, 'e2-medium': 1, 'f1-micro': 0.2, 'g1-small': 0.5 };
const familyOf = (type) => (type.startsWith('custom-') ? 'n1' : type.split('-')[0]);
const windowsOf = (vm) => (vm.disks ?? []).some((d) => d.boot && (d.licenses ?? []).some((l) => String(l).includes('/projects/windows-cloud/')));
const spotOf = (vm) => vm.scheduling?.provisioningModel === 'SPOT' || vm.scheduling?.preemptible === true;

// One VM: its item (count 1) or the unknown of its backend. A machine type is read once a nap.
async function vmItem(compute, types, vm) {
  try {
    const instance = await compute.getInstance(vm.zone, vm.name);
    const type = nameOf(instance.machineType);
    const key = `${vm.zone}/${type}`;
    if (!types.has(key)) types.set(key, compute.getMachineType(vm.zone, type));
    const { guestCpus, memoryMb } = await types.get(key);
    const vcpus = SHARED_VCPUS[type] ?? guestCpus;
    if (!Number.isFinite(vcpus) || !Number.isFinite(memoryMb)) throw new Error(`machine type ${type} has no vCPU count or memory`);
    return {
      kind: 'gce', machineType: type, family: familyOf(type), vcpus, memoryGb: memoryMb / 1024, count: 1,
      os: windowsOf(instance) ? 'windows' : 'linux', ...(spotOf(instance) ? { spot: true } : {}), ...(vm.suspended ? { suspended: true } : {}), zone: vm.zone,
    };
  } catch (err) {
    return unknown(vm.backend, err);
  }
}

// Equal items together, with their count; the order of the first of each.
function grouped(items) {
  const groups = new Map();
  for (const item of items) {
    const key = item.kind === 'gce' ? JSON.stringify({ ...item, count: 0 }) : JSON.stringify(item);
    const found = groups.get(key);
    if (found) found.count += 1;
    else groups.set(key, { ...item });
  }
  return [...groups.values()].map((item) => (item.kind === 'gce' ? item : (({ count, ...rest }) => rest)(item)));
}

// `db-custom-N-M`: N vCPUs and M MB; Enterprise Plus `db-perf-optimized-N-K`: K vCPUs, 8 GB each (Google's Enterprise Plus N tiers). The
// shared cores and any other tier: none.
function sizeOf(tier) {
  const custom = /^db-custom-(\d+)-(\d+)$/.exec(tier);
  if (custom) return { vcpus: Number(custom[1]), memoryGb: Number(custom[2]) / 1024 };
  const perf = /^db-perf-optimized-N-(\d+)$/.exec(tier);
  return perf ? { vcpus: Number(perf[1]), memoryGb: 8 * Number(perf[1]) } : {};
}
const ENGINES = { POSTGRES: 'postgres', MYSQL: 'mysql', SQLSERVER: 'sqlserver' };

async function databaseItems(cloudsql, name) {
  try {
    const instance = await cloudsql.get(name);
    const engine = ENGINES[String(instance.databaseVersion ?? '').split('_')[0]];
    const tier = instance.settings?.tier;
    if (!engine || !tier) return [unknown(`cloudsql-instance:${name}`, `its engine or tier is not readable (${instance.databaseVersion ?? 'no version'}, ${tier ?? 'no tier'})`)];
    return [{
      kind: 'cloudsql', tier, engine, edition: instance.settings.edition === 'ENTERPRISE_PLUS' ? 'enterprise-plus' : 'enterprise',
      ha: instance.settings.availabilityType === 'REGIONAL', region: instance.region, ...sizeOf(tier),
    }];
  } catch (err) {
    return err?.code === 404 ? [] : [unknown(`cloudsql-instance:${name}`, err)];
  }
}

const podsId = (backend) => `k8s:${k8sId({ cluster: `${backend.cluster.location}/${backend.cluster.name}`, namespace: backend.namespace, owner: backend.owner })}`;

// `vms`: the VMs the nap stopped or suspended, `backend` their status backend (`instance:<vm>`, `asg:<group>`); `pods`: the GKE backends;
// `companions`: the Cloud SQL instances stopped. At most 50 items.
export async function describeStopped({ compute, cloudsql }, { vms = [], pods = [], companions = [] }) {
  const types = new Map();
  const found = await Promise.all(vms.map((vm) => vmItem(compute, types, vm)));
  const unknownVms = [...new Map(found.filter((i) => i.kind === 'unknown').map((i) => [i.backend, i])).values()];
  const items = [
    ...grouped(found.filter((i) => i.kind === 'gce')),
    ...unknownVms,
    ...pods.map((backend) => unknown(podsId(backend), 'GKE pods are not priced')),
    ...(await Promise.all(companions.map((name) => databaseItems(cloudsql, name)))).flat(),
  ];
  return items.slice(0, ITEMS_MAX);
}
