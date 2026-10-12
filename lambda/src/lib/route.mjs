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

export async function setRoute(elbv2, cfg, target) {
  if (!TARGETS.has(target)) throw new Error(`invalid target: ${target}`);
  const { Rules = [] } = await elbv2.describeRules({ RuleArns: [cfg.ruleArn] });
  const rule = Rules[0];
  if (!rule) throw new Error(`rule not found: ${cfg.ruleArn}`);
  if (currentTarget(rule.Actions, cfg) === target) return false;
  const weights = target === 'app'
    ? { [cfg.appTargetGroupArn]: 1, [cfg.wakerTargetGroupArn]: 0 }
    : { [cfg.appTargetGroupArn]: 0, [cfg.wakerTargetGroupArn]: 1 };
  await elbv2.modifyRule({ RuleArn: cfg.ruleArn, Actions: withWeights(rule.Actions, weights) });
  return true;
}
