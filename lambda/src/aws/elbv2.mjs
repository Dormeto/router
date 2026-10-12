import {
  AddTagsCommand,
  CreateTargetGroupCommand,
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
} from '@aws-sdk/client-elastic-load-balancing-v2';

export function createElbv2(client = new ElasticLoadBalancingV2Client({})) {
  return {
    describeRules: (input) => client.send(new DescribeRulesCommand(input)),
    modifyRule: (input) => client.send(new ModifyRuleCommand(input)),
    describeTargetHealth: (input) => client.send(new DescribeTargetHealthCommand(input)),
    // The rules of a workload are found from its target group (lib/rules.mjs).
    describeTargetGroups: (input) => client.send(new DescribeTargetGroupsCommand(input)),
    describeListeners: (input) => client.send(new DescribeListenersCommand(input)),
    describeTags: (input) => client.send(new DescribeTagsCommand(input)),
    // Onboarding (lib/onboarding.mjs): the waker target group and the rule tags.
    createTargetGroup: (input) => client.send(new CreateTargetGroupCommand(input)),
    modifyTargetGroupAttributes: (input) => client.send(new ModifyTargetGroupAttributesCommand(input)),
    deleteTargetGroup: (input) => client.send(new DeleteTargetGroupCommand(input)),
    registerTargets: (input) => client.send(new RegisterTargetsCommand(input)),
    deregisterTargets: (input) => client.send(new DeregisterTargetsCommand(input)),
    addTags: (input) => client.send(new AddTagsCommand(input)),
    removeTags: (input) => client.send(new RemoveTagsCommand(input)),
  };
}
