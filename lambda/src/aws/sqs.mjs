import { GetQueueAttributesCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { BOUNDED } from './bounded.mjs';

export function createSqs(client = new SQSClient({ requestHandler: BOUNDED })) {
  return {
    getQueueAttributes: (input) => client.send(new GetQueueAttributesCommand(input)),
    // The work queue (scale design §6): naps and the wakes of a router pause.
    sendMessage: (input) => client.send(new SendMessageCommand(input)),
  };
}
