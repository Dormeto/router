import {
  ApplicationAutoScalingClient,
  DescribeScalableTargetsCommand,
  RegisterScalableTargetCommand,
} from '@aws-sdk/client-application-auto-scaling';

export function createAppScaling(client = new ApplicationAutoScalingClient({})) {
  return {
    describeScalableTargets: (input) => client.send(new DescribeScalableTargetsCommand(input)),
    registerScalableTarget: (input) => client.send(new RegisterScalableTargetCommand(input)),
  };
}
