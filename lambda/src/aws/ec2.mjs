import { CreateTagsCommand, DeleteTagsCommand, DescribeInstancesCommand, EC2Client, ModifyInstanceAttributeCommand, StartInstancesCommand, StopInstancesCommand } from '@aws-sdk/client-ec2';

export function createEc2(client = new EC2Client({})) {
  return {
    describeInstances: (input) => client.send(new DescribeInstancesCommand(input)),
    startInstances: (input) => client.send(new StartInstancesCommand(input)),
    stopInstances: (input) => client.send(new StopInstancesCommand(input)),
    createTags: (input) => client.send(new CreateTagsCommand(input)),
    deleteTags: (input) => client.send(new DeleteTagsCommand(input)),
    // Fallback instance types (R7a): a stopped instance's type.
    modifyInstanceAttribute: (input) => client.send(new ModifyInstanceAttributeCommand(input)),
  };
}
