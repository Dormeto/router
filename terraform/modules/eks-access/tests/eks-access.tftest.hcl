# The access of a router to an EKS cluster (vision docs/specs/2026-10-11-kubernetes-design.md, section 4), checked at plan
# time against mock providers (tfenv exec test, no AWS or Kubernetes call).
mock_provider "aws" {
  mock_data "aws_partition" {
    defaults = { partition = "aws" }
  }
}
mock_provider "kubernetes" {}

variables {
  cluster_name = "eks-demo"
  router_role_arns = [
    "arn:aws:iam::111122223333:role/dormeto/router/dmtr-dev-eu-west-1-controller",
    "arn:aws:iam::111122223333:role/dormeto/router/dmtr-dev-eu-west-1-waker",
    "arn:aws:iam::111122223333:role/dormeto/router/dmtr-dev-eu-west-1-onboarder",
  ]
  discovery_role_arn = "arn:aws:iam::111122223333:role/DmtDiscoveryRole"
}

run "router_roles_join_the_dormeto_router_group_and_discovery_reads" {
  command = plan
  assert {
    condition     = length(aws_eks_access_entry.router) == 3 && alltrue([for e in aws_eks_access_entry.router : e.kubernetes_groups == toset(["dormeto:router"]) && e.cluster_name == "eks-demo"])
    error_message = "each router role has an access entry in the group dormeto:router"
  }
  assert {
    condition     = length(aws_eks_access_policy_association.discovery) == 1 && aws_eks_access_policy_association.discovery[0].policy_arn == "arn:aws:eks::aws:cluster-access-policy/AmazonEKSViewPolicy"
    error_message = "discovery reads the cluster with the view policy (no Secrets)"
  }
  assert {
    condition     = aws_eks_access_policy_association.discovery[0].access_scope[0].type == "cluster"
    error_message = "the view policy is cluster-wide"
  }
  assert {
    condition     = toset(keys(kubernetes_manifest.router)) == toset(["ClusterRole/dormeto-router", "ClusterRoleBinding/dormeto-router", "ValidatingAdmissionPolicy/dormeto-router-ingresses", "ValidatingAdmissionPolicyBinding/dormeto-router-ingresses"])
    error_message = "the published manifest is applied, object by object"
  }
}

run "without_discovery_nor_manifest" {
  command = plan
  variables {
    discovery_role_arn = null
    apply_manifest     = false
  }
  assert {
    condition     = length(aws_eks_access_entry.discovery) == 0 && length(aws_eks_access_policy_association.discovery) == 0
    error_message = "no discovery entry without its role"
  }
  assert {
    condition     = length(kubernetes_manifest.router) == 0
    error_message = "the manifest is left to kubectl"
  }
}

run "router_roles_required" {
  command = plan
  variables {
    router_role_arns = []
  }
  expect_failures = [var.router_role_arns]
}
