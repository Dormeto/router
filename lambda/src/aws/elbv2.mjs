import {
  DescribeListenersCommand,
  DescribeRulesCommand,
  DescribeTagsCommand,
  DescribeTargetGroupsCommand,
  DescribeTargetHealthCommand,
  ElasticLoadBalancingV2Client,
  ModifyRuleCommand,
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
  };
}
