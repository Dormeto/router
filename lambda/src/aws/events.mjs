import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';

// EventBridge in the region of the bus written to (the manager's): one client per region. Bounded: a publish never holds
// a check or a wake for long (the next check sends the whole state again).
export function createEvents(clients = new Map()) {
  const client = (region) => {
    if (!clients.has(region)) clients.set(region, new EventBridgeClient({ region, maxAttempts: 2, requestHandler: { connectionTimeout: 1000, requestTimeout: 2000, socketTimeout: 2000, throwOnRequestTimeout: true } }));
    return clients.get(region);
  };
  return { putEvents: (input, { region }) => client(region).send(new PutEventsCommand(input)) };
}
