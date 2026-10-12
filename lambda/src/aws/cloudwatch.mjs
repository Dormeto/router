import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';

export function createCloudWatch(client = new CloudWatchClient({})) {
  return { getMetricData: (input) => client.send(new GetMetricDataCommand(input)) };
}
