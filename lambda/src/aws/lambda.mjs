import { AddPermissionCommand, GetAccountSettingsCommand, InvokeCommand, LambdaClient, RemovePermissionCommand } from '@aws-sdk/client-lambda';
import { BOUNDED } from './bounded.mjs';

export function createLambda(client = new LambdaClient({ requestHandler: BOUNDED })) {
  // The client of the Kubernetes proxies' synchronous invocations, made on the first one. A proxy answers within its
  // 15-second timeout (its own Timeout answer after 3 s without a connection or 10 s without an answer): waiting longer
  // than that brings its answer back, where BOUNDED's 10 seconds of silence would cut it and the SDK send it again.
  let synchronous;
  const proxies = () => (synchronous ??= new LambdaClient({ requestHandler: { connectionTimeout: 3_000, requestTimeout: 20_000, socketTimeout: 20_000, throwOnRequestTimeout: true } }));
  return {
    invokeAsync: (functionName, payload) => client.send(new InvokeCommand({
      FunctionName: functionName,
      InvocationType: 'Event',
      Payload: Buffer.from(JSON.stringify(payload)),
    })),
    // A Kubernetes proxy (lib/k8s.mjs): its parsed answer; a function error (a crash, its timeout) throws, and the AWS
    // errors (ResourceNotFoundException, ResourceNotReadyException, TooManyRequestsException…) as the SDK raises them.
    invoke: async (functionName, payload) => {
      const out = await proxies().send(new InvokeCommand({
        FunctionName: functionName,
        InvocationType: 'RequestResponse',
        Payload: Buffer.from(JSON.stringify(payload)),
      }));
      const text = out.Payload?.length ? Buffer.from(out.Payload).toString() : '';
      const value = text ? JSON.parse(text) : undefined;
      if (out.FunctionError) throw Object.assign(new Error(`${value?.errorType ?? out.FunctionError}: ${value?.errorMessage ?? 'the function failed'}`), { name: 'FunctionError' });
      return value;
    },
    // Onboarding: the load balancer may invoke the waker for the workload's target group.
    addPermission: (input) => client.send(new AddPermissionCommand(input)),
    removePermission: (input) => client.send(new RemovePermissionCommand(input)),
    // Router health: the account's concurrency limit in the region.
    getAccountSettings: (input) => client.send(new GetAccountSettingsCommand(input)),
  };
}
