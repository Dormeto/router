# Dormeto's access to the cluster, as a customer whose router is written in Terraform adds it (vision
# docs/specs/2026-10-11-kubernetes-design.md, section 4): the router's roles in the group dormeto:router and
# DmtDiscoveryRole with the view policy (the router's eks-access module), and that group's rights as Dormeto publishes
# them (kubernetes/dormeto-router.yaml). The manifest goes through a local chart: the kubernetes provider's manifests need
# the cluster at plan time, which a cluster this root creates is not. Gone with the cluster.
data "aws_iam_role" "dormeto" {
  for_each = var.dormeto_router == null ? toset([]) : toset(["controller", "waker", "onboarder"])
  name     = "${var.dormeto_router}-${each.key}"
}

module "dormeto_access" {
  count              = var.dormeto_router == null ? 0 : 1
  source             = "../modules/eks-access"
  cluster_name       = module.eks.cluster_name
  router_role_arns   = [for role in data.aws_iam_role.dormeto : role.arn]
  discovery_role_arn = "arn:aws:iam::${var.account_id}:role/DmtDiscoveryRole"
  apply_manifest     = false
}

resource "helm_release" "dormeto_access" {
  count  = var.dormeto_router == null ? 0 : 1
  name   = "dormeto-access"
  chart  = "${path.module}/charts/dormeto-access"
  values = [yamlencode({ manifest = file("${path.module}/../../kubernetes/dormeto-router.yaml") })]

  depends_on = [module.eks]
}
