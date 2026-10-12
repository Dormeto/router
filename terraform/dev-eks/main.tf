# A customer's EKS cluster, written as a customer would (no Dormeto resource): the manager discovers its workloads,
# grants cluster access and onboards them (vision docs/specs/2026-10-11-kubernetes-design.md, section 12). Kept while
# R10.5 is built, then created for each e2e campaign and destroyed after: about $155 a month while it exists (the
# control plane $73, one NAT gateway $35, the demo ALB $22, the system node $25), the demos napped by Dormeto.
data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  azs = slice(data.aws_availability_zones.available.names, 0, 2)
}

# Its own network, so destroying the cluster leaves nothing: Fargate pods run in private subnets only, and the dev
# network has no NAT gateway.
module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 6.0"

  name               = var.name
  cidr               = "10.40.0.0/16"
  azs                = local.azs
  public_subnets     = ["10.40.0.0/20", "10.40.16.0/20"]
  private_subnets    = ["10.40.64.0/18", "10.40.128.0/18"]
  enable_nat_gateway = true
  single_nat_gateway = true

  public_subnet_tags  = { "kubernetes.io/role/elb" = "1" }
  private_subnet_tags = { "kubernetes.io/role/internal-elb" = "1", "karpenter.sh/discovery" = var.name }
}

module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 21.0"

  name               = var.name
  kubernetes_version = var.kubernetes_version

  # Public and open to every address: the routers' Lambda functions reach it (the spec's section 4).
  endpoint_public_access = true
  authentication_mode    = "API"

  # The audit log only, a week: it shows every call the routers make to the cluster (the spike, the e2e). The api and
  # authenticator logs would add CloudWatch ingestion (the controllers renew their leases every few seconds) that no
  # test reads.
  enabled_log_types                      = ["audit"]
  cloudwatch_log_group_retention_in_days = 7

  enable_cluster_creator_admin_permissions = false
  access_entries = {
    admin = {
      principal_arn = var.admin_role_arn
      policy_associations = {
        admin = {
          policy_arn   = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy"
          access_scope = { type = "cluster" }
        }
      }
    }
  }

  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnets

  addons = {
    vpc-cni                = { before_compute = true }
    eks-pod-identity-agent = { before_compute = true }
    kube-proxy             = {}
    coredns = {
      configuration_values = jsonencode({
        replicaCount = 1
        tolerations  = [{ key = "CriticalAddonsOnly", operator = "Exists" }]
      })
    }
    metrics-server = {
      configuration_values = jsonencode({
        tolerations = [{ key = "CriticalAddonsOnly", operator = "Exists" }]
      })
    }
  }

  # The system pods (CoreDNS, metrics-server, the Load Balancer Controller, Karpenter) on one small node, tainted so the
  # demos land on Karpenter's nodes (their naps then free whole nodes) or on Fargate.
  eks_managed_node_groups = {
    system = {
      ami_type       = "AL2023_ARM_64_STANDARD"
      instance_types = ["t4g.medium"]
      min_size       = 1
      max_size       = 2
      desired_size   = 1
      labels         = { "dormeto.dev/pool" = "system" }
      taints = {
        critical = { key = "CriticalAddonsOnly", value = "true", effect = "NO_SCHEDULE" }
      }
    }
  }

  fargate_profiles = {
    demo = { selectors = [{ namespace = "demo-fargate" }] }
  }

  node_security_group_tags = { "karpenter.sh/discovery" = var.name }
}
