import { DescribeClusterCommand, EKSClient } from '@aws-sdk/client-eks';
import { BOUNDED } from './bounded.mjs';

// The clusters of Kubernetes workloads: their endpoint and certificate authority, and the credentials lib/k8s.mjs signs
// the EKS tokens with (the router's role, as the SDK resolves it).
export function createEks(client = new EKSClient({ requestHandler: BOUNDED })) {
  return {
    describeCluster: (input) => client.send(new DescribeClusterCommand(input)),
    credentials: () => client.config.credentials(),
  };
}
