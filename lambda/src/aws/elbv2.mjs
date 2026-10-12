import {
  AddTagsCommand,
  DescribeAccountLimitsCommand,
  CreateRuleCommand,
  CreateTargetGroupCommand,
  DeleteRuleCommand,
  DeleteTargetGroupCommand,
  DeregisterTargetsCommand,
  DescribeListenersCommand,
  DescribeRulesCommand,
  DescribeTagsCommand,
  DescribeTargetGroupsCommand,
  DescribeTargetHealthCommand,
  ElasticLoadBalancingV2Client,
  ModifyRuleCommand,
  ModifyTargetGroupAttributesCommand,
  RegisterTargetsCommand,
  RemoveTagsCommand,
  SetRulePrioritiesCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';

// Adaptive retries (scale design §6): under throttling, a crowded account's calls slow down instead of failing.
export function createElbv2(client = new ElasticLoadBalancingV2Client({ retryMode: 'adaptive', maxAttempts: 8 })) {
  return {
    describeRules: (input) => client.send(new DescribeRulesCommand(input)),
    modifyRule: (input) => client.send(new ModifyRuleCommand(input)),
    describeTargetHealth: (input) => client.send(new DescribeTargetHealthCommand(input)),
    // The rules of a workload are found from its target group (lib/rules.mjs).
    describeTargetGroups: (input) => client.send(new DescribeTargetGroupsCommand(input)),
    describeListeners: (input) => client.send(new DescribeListenersCommand(input)),
    describeTags: (input) => client.send(new DescribeTagsCommand(input)),
    // Onboarding checks the quotas of the load balancer and the region (scale design §6).
    describeAccountLimits: (input) => client.send(new DescribeAccountLimitsCommand(input)),
    // Onboarding (lib/onboarding.mjs): the waker target group and the rule tags.
    createTargetGroup: (input) => client.send(new CreateTargetGroupCommand(input)),
    modifyTargetGroupAttributes: (input) => client.send(new ModifyTargetGroupAttributesCommand(input)),
    deleteTargetGroup: (input) => client.send(new DeleteTargetGroupCommand(input)),
    registerTargets: (input) => client.send(new RegisterTargetsCommand(input)),
    deregisterTargets: (input) => client.send(new DeregisterTargetsCommand(input)),
    addTags: (input) => client.send(new AddTagsCommand(input)),
    removeTags: (input) => client.send(new RemoveTagsCommand(input)),
    // Shadow rules (R4c): created before a customer rule, moved before it again, deleted at offboarding.
    createRule: (input) => client.send(new CreateRuleCommand(input)),
    deleteRule: (input) => client.send(new DeleteRuleCommand(input)),
    setRulePriorities: (input) => client.send(new SetRulePrioritiesCommand(input)),
  };
}
