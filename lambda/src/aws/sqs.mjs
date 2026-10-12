import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';

export function createSqs(client = new SQSClient({})) {
  return { getQueueAttributes: (input) => client.send(new GetQueueAttributesCommand(input)) };
}
