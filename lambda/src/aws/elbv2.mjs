import {
  DescribeListenersCommand,
  DescribeLoadBalancersCommand,
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
    // Discovery (manager).
    describeLoadBalancers: (input) => client.send(new DescribeLoadBalancersCommand(input)),
    describeListeners: (input) => client.send(new DescribeListenersCommand(input)),
    describeTargetGroups: (input) => client.send(new DescribeTargetGroupsCommand(input)),
    describeTags: (input) => client.send(new DescribeTagsCommand(input)),
  };
}
