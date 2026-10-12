import {
  AutoScalingClient,
  DescribeAutoScalingGroupsCommand,
  ResumeProcessesCommand,
  SuspendProcessesCommand,
  UpdateAutoScalingGroupCommand,
} from '@aws-sdk/client-auto-scaling';

export function createAutoScaling(client = new AutoScalingClient({})) {
  return {
    describeAutoScalingGroups: (input) => client.send(new DescribeAutoScalingGroupsCommand(input)),
    updateAutoScalingGroup: (input) => client.send(new UpdateAutoScalingGroupCommand(input)),
    suspendProcesses: (input) => client.send(new SuspendProcessesCommand(input)),
    resumeProcesses: (input) => client.send(new ResumeProcessesCommand(input)),
  };
}
