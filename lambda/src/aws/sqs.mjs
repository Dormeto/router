import { GetQueueAttributesCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';

export function createSqs(client = new SQSClient({})) {
  return {
    getQueueAttributes: (input) => client.send(new GetQueueAttributesCommand(input)),
    // The work queue (scale design §6): naps and the wakes of a router pause.
    sendMessage: (input) => client.send(new SendMessageCommand(input)),
  };
}
