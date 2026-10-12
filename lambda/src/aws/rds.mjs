import {
  DescribeDBClustersCommand,
  DescribeDBInstancesCommand,
  RDSClient,
  StartDBClusterCommand,
  StartDBInstanceCommand,
  StopDBClusterCommand,
  StopDBInstanceCommand,
} from '@aws-sdk/client-rds';

export function createRds(client = new RDSClient({})) {
  return {
    describeDBInstances: (input) => client.send(new DescribeDBInstancesCommand(input)),
    describeDBClusters: (input) => client.send(new DescribeDBClustersCommand(input)),
    startDBInstance: (input) => client.send(new StartDBInstanceCommand(input)),
    stopDBInstance: (input) => client.send(new StopDBInstanceCommand(input)),
    startDBCluster: (input) => client.send(new StartDBClusterCommand(input)),
    stopDBCluster: (input) => client.send(new StopDBClusterCommand(input)),
  };
}
