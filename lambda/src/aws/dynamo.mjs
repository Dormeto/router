import { DynamoDBClient, GetItemCommand, QueryCommand, ScanCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';

export function createDynamo(client = new DynamoDBClient({})) {
  return {
    getItem: (input) => client.send(new GetItemCommand(input)),
    updateItem: (input) => client.send(new UpdateItemCommand(input)),
    scan: (input) => client.send(new ScanCommand(input)),
    query: (input) => client.send(new QueryCommand(input)),
  };
}
