// The name of a cluster's proxy function, security group and role (vision docs/specs/2026-10-24-private-eks-endpoints-design.md,
// section 4): the prefix and the cluster's name when they fit in 64 characters (Lambda's limit, the tightest), else the
// cluster's first characters, a hyphen and the first 8 hexadecimal characters of the name's SHA-256. The manager applies
// the same rule, pinned by test/fixtures/kube-proxy-names.json.
import { createHash } from 'node:crypto';

const MAX = 64;
const HASH = 8;

export function kubeProxyName(prefix, cluster) {
  if (prefix.length + cluster.length <= MAX) return `${prefix}${cluster}`;
  const hash = createHash('sha256').update(cluster).digest('hex').slice(0, HASH);
  return `${prefix}${cluster.slice(0, MAX - prefix.length - HASH - 1)}-${hash}`;
}
