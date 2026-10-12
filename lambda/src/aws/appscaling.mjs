import {
  ApplicationAutoScalingClient,
  DescribeScalableTargetsCommand,
  RegisterScalableTargetCommand,
} from '@aws-sdk/client-application-auto-scaling';
import { BOUNDED } from './bounded.mjs';

export function createAppScaling(client = new ApplicationAutoScalingClient({ requestHandler: BOUNDED })) {
  return {
    describeScalableTargets: (input) => client.send(new DescribeScalableTargetsCommand(input)),
    registerScalableTarget: (input) => client.send(new RegisterScalableTargetCommand(input)),
  };
}
