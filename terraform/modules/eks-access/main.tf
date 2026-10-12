# A router's access to an EKS cluster (vision docs/specs/2026-10-11-kubernetes-design.md, section 4), for a customer who
# writes it in Terraform rather than letting the manager create the access entries: the router's roles in the Kubernetes
# group dormeto:router, whose rights come from the published manifest (kubernetes/dormeto-router.yaml); discovery's role
# with the view policy. The caller configures the aws and kubernetes providers for the cluster.
data "aws_partition" "current" {}

locals {
  # The published manifest, one object per document.
  manifest = [for doc in split("\n---\n", file("${path.module}/../../../kubernetes/dormeto-router.yaml")) : yamldecode(doc) if trimspace(replace(doc, "/(?m)^#.*$/", "")) != ""]
}

resource "aws_eks_access_entry" "router" {
  for_each          = toset(var.router_role_arns)
  cluster_name      = var.cluster_name
  principal_arn     = each.value
  kubernetes_groups = ["dormeto:router"]
  type              = "STANDARD"
}

resource "aws_eks_access_entry" "discovery" {
  count         = var.discovery_role_arn == null ? 0 : 1
  cluster_name  = var.cluster_name
  principal_arn = var.discovery_role_arn
  type          = "STANDARD"
}

resource "aws_eks_access_policy_association" "discovery" {
  count         = var.discovery_role_arn == null ? 0 : 1
  cluster_name  = var.cluster_name
  principal_arn = aws_eks_access_entry.discovery[0].principal_arn
  policy_arn    = "arn:${data.aws_partition.current.partition}:eks::aws:cluster-access-policy/AmazonEKSViewPolicy"
  access_scope {
    type = "cluster"
  }
}

resource "kubernetes_manifest" "router" {
  for_each = { for object in local.manifest : "${object.kind}/${object.metadata.name}" => object if var.apply_manifest }
  manifest = each.value
}
