import { DescribeServicesCommand, ECSClient, UpdateServiceCommand } from '@aws-sdk/client-ecs';

export function createEcs(client = new ECSClient({})) {
  return {
    describeServices: (input) => client.send(new DescribeServicesCommand(input)),
    updateService: (input) => client.send(new UpdateServiceCommand(input)),
  };
}
