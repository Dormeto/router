import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { BOUNDED } from './bounded.mjs';

export function createCloudWatch(client = new CloudWatchClient({ requestHandler: BOUNDED })) {
  return { getMetricData: (input) => client.send(new GetMetricDataCommand(input)) };
}
