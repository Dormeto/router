import { GetResourcesCommand, ResourceGroupsTaggingAPIClient } from '@aws-sdk/client-resource-groups-tagging-api';

export function createTagging(client = new ResourceGroupsTaggingAPIClient({})) {
  return { getResources: (input) => client.send(new GetResourcesCommand(input)) };
}
