import {
  DescribeServicesCommand, DescribeTaskDefinitionCommand, ECSClient, ListClustersCommand, ListServicesCommand, TagResourceCommand, UntagResourceCommand, UpdateServiceCommand,
} from '@aws-sdk/client-ecs';
import { BOUNDED } from './bounded.mjs';

export function createEcs(client = new ECSClient({ requestHandler: BOUNDED })) {
  return {
    describeServices: (input) => client.send(new DescribeServicesCommand(input)),
    describeTaskDefinition: (input) => client.send(new DescribeTaskDefinitionCommand(input)),
    updateService: (input) => client.send(new UpdateServiceCommand(input)),
    listClusters: (input) => client.send(new ListClustersCommand(input)),
    listServices: (input) => client.send(new ListServicesCommand(input)),
    tagResource: (input) => client.send(new TagResourceCommand(input)),
    untagResource: (input) => client.send(new UntagResourceCommand(input)),
  };
}
