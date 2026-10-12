// The clients of one idle check (scale design §6): each workload's lookup of its tagged Auto Scaling groups, ECS services
// and databases (resolveBackends) is answered from one listing of everything tagged dormeto:workload, made once per
// check, instead of a call per workload. Every other call goes through.
import { WORKLOAD_TAG } from './backends.mjs';

const TYPES = ['ecs:service', 'rds:db', 'rds:cluster'];

// ecs:service → arn:aws:ecs:…:service/…; rds:db → arn:aws:rds:…:db:…; rds:cluster → arn:aws:rds:…:cluster:….
function isType(arn, type) {
  const parts = arn.split(':');
  const [service, resource] = type.split(':');
  return parts[2] === service && (parts[5] ?? '').startsWith(service === 'ecs' ? `${resource}/` : resource) && (service === 'ecs' || parts[5] === resource);
}

async function allPages(call, key, token) {
  const items = [];
  let next;
  do {
    const page = await call(next);
    items.push(...(page[key] ?? []));
    next = page[token];
  } while (next);
  return items;
}

const tagged = (tags, value) => (tags ?? []).some((t) => t.Key === WORKLOAD_TAG && t.Value === value);

export function checkScope(clients) {
  const { autoscaling, tagging } = clients;
  let groups;
  let resources;
  // The workload a per-workload lookup asks for, or undefined (any other call).
  const groupQuery = (input) => {
    const f = input?.Filters;
    return f?.length === 1 && f[0].Name === `tag:${WORKLOAD_TAG}` && f[0].Values?.length === 1 && !input.NextToken ? f[0].Values[0] : undefined;
  };
  const resourceQuery = (input) => {
    const f = input?.TagFilters;
    const types = input?.ResourceTypeFilters ?? [];
    return f?.length === 1 && f[0].Key === WORKLOAD_TAG && f[0].Values?.length === 1 && !input.PaginationToken && types.every((t) => TYPES.includes(t)) ? f[0].Values[0] : undefined;
  };
  return {
    ...clients,
    ...(autoscaling ? {
      autoscaling: {
        ...autoscaling,
        async describeAutoScalingGroups(input) {
          const workload = groupQuery(input);
          if (workload === undefined) return autoscaling.describeAutoScalingGroups(input);
          groups ??= allPages((next) => autoscaling.describeAutoScalingGroups({ Filters: [{ Name: 'tag-key', Values: [WORKLOAD_TAG] }], ...(next ? { NextToken: next } : {}) }), 'AutoScalingGroups', 'NextToken');
          return { AutoScalingGroups: (await groups).filter((g) => tagged(g.Tags, workload)) };
        },
      },
    } : {}),
    ...(tagging ? {
      tagging: {
        ...tagging,
        async getResources(input) {
          const workload = resourceQuery(input);
          if (workload === undefined) return tagging.getResources(input);
          resources ??= allPages((next) => tagging.getResources({ TagFilters: [{ Key: WORKLOAD_TAG }], ResourceTypeFilters: TYPES, ...(next ? { PaginationToken: next } : {}) }), 'ResourceTagMappingList', 'PaginationToken');
          const types = input.ResourceTypeFilters?.length ? input.ResourceTypeFilters : TYPES;
          return { ResourceTagMappingList: (await resources).filter((m) => types.some((type) => isType(m.ResourceARN, type)) && tagged(m.Tags, workload)) };
        },
      },
    } : {}),
  };
}
