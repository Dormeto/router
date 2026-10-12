import { DeleteItemCommand, DynamoDBClient, GetItemCommand, QueryCommand, ScanCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { BOUNDED } from './bounded.mjs';

export function createDynamo(client = new DynamoDBClient({ requestHandler: BOUNDED })) {
  return {
    getItem: (input) => client.send(new GetItemCommand(input)),
    updateItem: (input) => client.send(new UpdateItemCommand(input)),
    scan: (input) => client.send(new ScanCommand(input)),
    query: (input) => client.send(new QueryCommand(input)),
    deleteItem: (input) => client.send(new DeleteItemCommand(input)),
  };
}
