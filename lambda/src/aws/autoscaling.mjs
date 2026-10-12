import {
  AutoScalingClient,
  CreateOrUpdateTagsCommand,
  DeleteTagsCommand,
  DescribeAutoScalingGroupsCommand,
  DescribeScalingActivitiesCommand,
  ResumeProcessesCommand,
  SuspendProcessesCommand,
  UpdateAutoScalingGroupCommand,
} from '@aws-sdk/client-auto-scaling';

export function createAutoScaling(client = new AutoScalingClient({})) {
  return {
    describeAutoScalingGroups: (input) => client.send(new DescribeAutoScalingGroupsCommand(input)),
    // A wake's failed launches (R7a).
    describeScalingActivities: (input) => client.send(new DescribeScalingActivitiesCommand(input)),
    updateAutoScalingGroup: (input) => client.send(new UpdateAutoScalingGroupCommand(input)),
    suspendProcesses: (input) => client.send(new SuspendProcessesCommand(input)),
    resumeProcesses: (input) => client.send(new ResumeProcessesCommand(input)),
    createOrUpdateTags: (input) => client.send(new CreateOrUpdateTagsCommand(input)),
    deleteTags: (input) => client.send(new DeleteTagsCommand(input)),
  };
}
