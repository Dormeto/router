import {
  DescribeServicesCommand, ECSClient, ListClustersCommand, ListServicesCommand, TagResourceCommand, UntagResourceCommand, UpdateServiceCommand,
} from '@aws-sdk/client-ecs';

export function createEcs(client = new ECSClient({})) {
  return {
    describeServices: (input) => client.send(new DescribeServicesCommand(input)),
    updateService: (input) => client.send(new UpdateServiceCommand(input)),
    listClusters: (input) => client.send(new ListClustersCommand(input)),
    listServices: (input) => client.send(new ListServicesCommand(input)),
    tagResource: (input) => client.send(new TagResourceCommand(input)),
    untagResource: (input) => client.send(new UntagResourceCommand(input)),
  };
}
