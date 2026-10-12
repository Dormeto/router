import { resolveRules } from './rules.mjs';

const TARGETS = new Set(['app', 'waker']);

export function withWeights(actions, weights) {
  const managed = new Set(Object.keys(weights));
  let found = false;
  const next = actions.map((action) => {
    const copy = structuredClone(action);
    const groups = copy.ForwardConfig?.TargetGroups;
    if (copy.Type === 'forward' && groups?.some((tg) => managed.has(tg.TargetGroupArn))) {
      found = true;
      copy.ForwardConfig.TargetGroups = groups.map((tg) =>
        managed.has(tg.TargetGroupArn) ? { ...tg, Weight: weights[tg.TargetGroupArn] } : tg);
      // ModifyRule rejects TargetGroupArn together with a multi target group ForwardConfig.
      delete copy.TargetGroupArn;
    }
    // DescribeRules never returns the OIDC client secret: keep the stored one.
    if (copy.AuthenticateOidcConfig && !copy.AuthenticateOidcConfig.ClientSecret) {
      copy.AuthenticateOidcConfig.UseExistingClientSecret = true;
    }
    return copy;
  });
  if (!found) throw new Error('no forward action references the managed target groups');
  return next;
}

export function currentTarget(actions, cfg) {
  const forward = actions.find((a) => a.Type === 'forward' && a.ForwardConfig?.TargetGroups);
  if (!forward) return 'unknown';
  const weight = (arn) => forward.ForwardConfig.TargetGroups.find((tg) => tg.TargetGroupArn === arn)?.Weight ?? 0;
  const app = weight(cfg.appTargetGroupArn);
  const waker = weight(cfg.wakerTargetGroupArn);
  if (app > 0 && waker === 0) return 'app';
  if (app === 0 && waker > 0) return 'waker';
  return 'mixed';
}

// Conditions of a rule as text: "host a.example.com, path /static/*".
export function conditionsOf(rule) {
  const parts = (rule.Conditions ?? []).map((c) => {
    if (c.Field === 'host-header') return `host ${(c.HostHeaderConfig?.Values ?? c.Values ?? []).join(' | ')}`;
    if (c.Field === 'path-pattern') return `path ${(c.PathPatternConfig?.Values ?? c.Values ?? []).join(' | ')}`;
    return c.Field;
  });
  return parts.join(', ') || 'any';
}

// First host name of a rule's host-header condition, or null.
export const hostOf = (rule) => {
  const c = rule?.Conditions?.find((x) => x.Field === 'host-header');
  return c?.HostHeaderConfig?.Values?.[0] ?? c?.Values?.[0] ?? null;
};

// Route over the instrumented rules of a workload: app or waker when every rule agrees, mixed when they differ, unknown
// without any rule or when a rule has no weighted forward.
export function routeOf(rules, cfg) {
  const targets = rules.map((r) => currentTarget(r.Actions ?? [], cfg));
  if (!targets.length || targets.includes('unknown')) return 'unknown';
  return targets.every((t) => t === targets[0]) ? targets[0] : 'mixed';
}

// Switches every instrumented rule of the workload (found from its target group) to the target; returns the rules it
// changed. Towards the waker, any rule it cannot switch fails the call before any change: that rule would send traffic
// to the stopped backend. Towards the application, the instrumented rules are switched and the issues reported
// (onIssues): a running backend must not stay behind the waiter page.
// allowIssues: the backend is already stopped (external stop, failed wake), so the guard no longer protects anything and
// the instrumented rules must reach the waker.
export async function setRoute(elbv2, cfg, target, { onIssues = () => {}, found, allowIssues = false } = {}) {
  if (!TARGETS.has(target)) throw new Error(`invalid target: ${target}`);
  const { instrumented, issues } = found ?? (await resolveRules(elbv2, [cfg])).get(cfg.workloadId);
  if (issues.length) {
    if (target === 'waker' && !allowIssues) throw new Error(`cannot switch to the waker: ${issues.map((i) => i.reason).join('; ')}`);
    onIssues(issues);
  }
  const weights = target === 'app'
    ? { [cfg.appTargetGroupArn]: 1, [cfg.wakerTargetGroupArn]: 0 }
    : { [cfg.appTargetGroupArn]: 0, [cfg.wakerTargetGroupArn]: 1 };
  const changed = [];
  for (const rule of instrumented) {
    if (currentTarget(rule.Actions, cfg) === target) continue;
    await elbv2.modifyRule({ RuleArn: rule.RuleArn, Actions: withWeights(rule.Actions, weights) });
    changed.push(rule.RuleArn);
  }
  return changed;
}
