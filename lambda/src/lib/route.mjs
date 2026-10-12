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

// Rules of a workload: ruleArns, or the single ruleArn of configurations written before several rules were supported.
export const rulesOf = (cfg) => (cfg.ruleArns?.length ? cfg.ruleArns : [cfg.ruleArn].filter(Boolean));

// Route of the workload over all its rules: app or waker when every rule agrees, mixed when they differ, unknown when a
// rule is missing or has no weighted forward.
export function routeOf(rules, cfg) {
  const byArn = new Map(rules.map((r) => [r.RuleArn, r]));
  const targets = rulesOf(cfg).map((arn) => (byArn.has(arn) ? currentTarget(byArn.get(arn).Actions ?? [], cfg) : 'unknown'));
  if (!targets.length || targets.includes('unknown')) return 'unknown';
  return targets.every((t) => t === targets[0]) ? targets[0] : 'mixed';
}

// Rules by ARN, and the ARNs that no longer exist. ELBv2 fails the whole DescribeRules call when one rule is missing:
// then each rule is described on its own to tell which one is gone. Other errors are thrown.
export async function describeRulesOf(elbv2, arns) {
  if (!arns.length) return { rules: [], missing: [] };
  try {
    const { Rules = [] } = await elbv2.describeRules({ RuleArns: arns });
    return { rules: Rules, missing: arns.filter((a) => !Rules.some((r) => r.RuleArn === a)) };
  } catch (err) {
    if (err?.name !== 'RuleNotFoundException') throw err;
  }
  const rules = [];
  const missing = [];
  for (const arn of arns) {
    try {
      rules.push(...((await elbv2.describeRules({ RuleArns: [arn] })).Rules ?? []));
    } catch (err) {
      if (err?.name !== 'RuleNotFoundException') throw err;
      missing.push(arn);
    }
  }
  return { rules, missing };
}

// Switches every rule of the workload to the target; returns the rules it changed (none when already there).
// Towards the waker, a missing rule fails before any change (a stopped backend must never be left behind a rule).
// Towards the application, the rules that remain are switched and the missing ones reported (onMissing): a running
// backend must not stay behind the waiter page because one rule was deleted.
export async function setRoute(elbv2, cfg, target, { onMissing = () => {} } = {}) {
  if (!TARGETS.has(target)) throw new Error(`invalid target: ${target}`);
  const arns = rulesOf(cfg);
  if (!arns.length) throw new Error(`no rule configured for ${cfg.workloadId}`);
  const { rules, missing } = await describeRulesOf(elbv2, arns);
  if (missing.length) {
    if (target === 'waker' || missing.length === arns.length) throw new Error(`rule not found: ${missing.join(', ')}`);
    onMissing(missing);
  }
  const byArn = new Map(rules.map((r) => [r.RuleArn, r]));
  const weights = target === 'app'
    ? { [cfg.appTargetGroupArn]: 1, [cfg.wakerTargetGroupArn]: 0 }
    : { [cfg.appTargetGroupArn]: 0, [cfg.wakerTargetGroupArn]: 1 };
  const changed = [];
  for (const arn of arns.filter((a) => byArn.has(a))) {
    const rule = byArn.get(arn);
    if (currentTarget(rule.Actions, cfg) === target) continue;
    await elbv2.modifyRule({ RuleArn: arn, Actions: withWeights(rule.Actions, weights) });
    changed.push(arn);
  }
  return changed;
}
