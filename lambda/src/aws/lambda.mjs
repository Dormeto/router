import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';

export function createLambda(client = new LambdaClient({})) {
  return {
    invokeAsync: (functionName, payload) => client.send(new InvokeCommand({
      FunctionName: functionName,
      InvocationType: 'Event',
      Payload: Buffer.from(JSON.stringify(payload)),
    })),
  };
}
