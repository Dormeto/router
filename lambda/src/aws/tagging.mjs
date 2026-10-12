import { GetResourcesCommand, ResourceGroupsTaggingAPIClient } from '@aws-sdk/client-resource-groups-tagging-api';
import { BOUNDED } from './bounded.mjs';

export function createTagging(client = new ResourceGroupsTaggingAPIClient({ requestHandler: BOUNDED })) {
  return { getResources: (input) => client.send(new GetResourcesCommand(input)) };
}
