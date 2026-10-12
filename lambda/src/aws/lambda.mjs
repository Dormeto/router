import { AddPermissionCommand, GetAccountSettingsCommand, InvokeCommand, LambdaClient, RemovePermissionCommand } from '@aws-sdk/client-lambda';

export function createLambda(client = new LambdaClient({})) {
  return {
    invokeAsync: (functionName, payload) => client.send(new InvokeCommand({
      FunctionName: functionName,
      InvocationType: 'Event',
      Payload: Buffer.from(JSON.stringify(payload)),
    })),
    // Onboarding: the load balancer may invoke the waker for the workload's target group.
    addPermission: (input) => client.send(new AddPermissionCommand(input)),
    removePermission: (input) => client.send(new RemovePermissionCommand(input)),
    // Router health: the account's concurrency limit in the region.
    getAccountSettings: (input) => client.send(new GetAccountSettingsCommand(input)),
  };
}
