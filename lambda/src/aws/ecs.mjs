import { DescribeServicesCommand, ECSClient, ListClustersCommand, ListServicesCommand, UpdateServiceCommand } from '@aws-sdk/client-ecs';

export function createEcs(client = new ECSClient({})) {
  return {
    describeServices: (input) => client.send(new DescribeServicesCommand(input)),
    updateService: (input) => client.send(new UpdateServiceCommand(input)),
    // Discovery (manager).
    listClusters: (input) => client.send(new ListClustersCommand(input)),
    listServices: (input) => client.send(new ListServicesCommand(input)),
  };
}
