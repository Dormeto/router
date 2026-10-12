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

// Switches every rule of the workload to the target; returns the rules it changed (none when already there). All the
// rules are read first: a missing rule fails before any change.
export async function setRoute(elbv2, cfg, target) {
  if (!TARGETS.has(target)) throw new Error(`invalid target: ${target}`);
  const arns = rulesOf(cfg);
  const { Rules = [] } = await elbv2.describeRules({ RuleArns: arns });
  const byArn = new Map(Rules.map((r) => [r.RuleArn, r]));
  const missing = arns.find((arn) => !byArn.has(arn));
  if (missing) throw new Error(`rule not found: ${missing}`);
  const weights = target === 'app'
    ? { [cfg.appTargetGroupArn]: 1, [cfg.wakerTargetGroupArn]: 0 }
    : { [cfg.appTargetGroupArn]: 0, [cfg.wakerTargetGroupArn]: 1 };
  const changed = [];
  for (const arn of arns) {
    const rule = byArn.get(arn);
    if (currentTarget(rule.Actions, cfg) === target) continue;
    await elbv2.modifyRule({ RuleArn: arn, Actions: withWeights(rule.Actions, weights) });
    changed.push(arn);
  }
  return changed;
}
