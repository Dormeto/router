# kubernetes-proxy

A Kubernetes proxy for one EKS cluster, for a router written in Terraform (module `router`). The router and discovery
reach a cluster whose API endpoint is private (or public but limited to some addresses, with private access on) through
a small Lambda function in the cluster's VPC: the router's handler `kube-proxy.handler`, which relays their calls to the
cluster's API. The manager makes the same function, with API calls, for the routers it installs; a router in Terraform
uses this module (design: `docs/specs/2026-10-24-private-eks-endpoints-design.md`, sections 4 and 6).

```hcl
module "kubernetes_proxy" {
  source            = "../modules/kubernetes-proxy"
  router_name       = module.router.name # the router module's name, for example dmt-dev
  lambda_source_dir = "${path.module}/../../lambda/src"
  cluster_name      = "prod"
  router_version    = jsondecode(file("${path.module}/../../package.json")).version
}
```

Use it once per such cluster, with the aws provider configured for the cluster's account and region. Also give the
router's roles access to the cluster (module `eks-access`): the proxy only carries their calls.

## Inputs

| Name | Default | Meaning |
|---|---|---|
| `router_name` | required | The router's name. The proxy is `<router_name>-kube-<cluster>`: the router's functions find it from their `DMT_KUBE_PROXY_PREFIX` (`<name>-kube-`, set by the router module). |
| `lambda_source_dir` | required | The router's Lambda source directory, the one given to the router module. |
| `cluster_name` | required | The EKS cluster. |
| `subnet_ids` | `null` | Subnets of the proxy; `null`: the cluster's own (`vpc_config.subnet_ids`). |
| `security_group_ids` | `null` | `null`: a security group of its own, as below. Given: used as they are; nothing is made or opened, they must reach the cluster security group on TCP 443, which must admit them. |
| `log_retention_days` | `14` | Retention of the function's log group. |
| `router_version` | `0.0.0` | Exposed as `DMT_VERSION` (the router's ping reports it). |

## What it creates

- the function `<router_name>-kube-<cluster>` (Node.js 24, arm64, 128 MB, 15 seconds) in the cluster's subnets, with
  `DMT_CLUSTER`, `DMT_ENDPOINT` and `DMT_CA` read from the cluster, its log group, and its role
  `<router_name>-<region>-kube-<cluster>` (network-interface rights and its logs only);
- without `security_group_ids`: a security group of the same name in the cluster's VPC, whose only egress is TCP 443
  to the cluster security group (its default allow-all egress is removed), and one ingress rule on the cluster
  security group admitting TCP 443 from it (the group EKS attaches to the endpoint's network interfaces);
- all tagged `dormeto:role = kubernetes-proxy` and `dormeto:cluster = <name>`.

A cluster name too long for the 64 characters of a function name is cut: its first characters, `-` and the first 8
hexadecimal characters of its SHA-256 (the same rule as `lambda/src/lib/kube-proxy-name.mjs`, which the module's test
checks against `lambda/test/fixtures/kube-proxy-names.json`).

## Destroy it before the cluster's VPC

Lambda keeps the network interfaces of a VPC function for a while after the function is deleted (it can take minutes),
and they hold the subnets and the security group: destroying the VPC, its subnets or the group first fails or hangs.
Destroy this module (or remove it from the configuration and apply) first, and the VPC after. Terraform orders the proxy
before the rules it depends on, but not before a VPC it knows nothing about.

## Test

`tfenv exec init -backend=false && tfenv exec test` (mock providers, no AWS call).
