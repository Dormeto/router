import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';

// EventBridge in the region of the bus written to (the manager's): one client per region.
export function createEvents(clients = new Map()) {
  const client = (region) => {
    if (!clients.has(region)) clients.set(region, new EventBridgeClient({ region }));
    return clients.get(region);
  };
  return { putEvents: (input, { region }) => client(region).send(new PutEventsCommand(input)) };
}
