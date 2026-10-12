# The AWS Load Balancer Controller: it creates the demos' ALBs from their Ingresses and registers the pods of a
# TargetGroupBinding.
module "lbc_pod_identity" {
  source  = "terraform-aws-modules/eks-pod-identity/aws"
  version = "~> 2.0"

  name                            = "${var.name}-lbc"
  attach_aws_lb_controller_policy = true
  associations = {
    this = {
      cluster_name    = module.eks.cluster_name
      namespace       = "kube-system"
      service_account = "aws-load-balancer-controller"
    }
  }
}

resource "helm_release" "lbc" {
  name       = "aws-load-balancer-controller"
  namespace  = "kube-system"
  repository = "https://aws.github.io/eks-charts"
  chart      = "aws-load-balancer-controller"
  version    = "3.6.0"
  wait       = true

  values = [yamlencode({
    clusterName    = module.eks.cluster_name
    region         = var.region
    vpcId          = module.vpc.vpc_id
    replicaCount   = 1
    serviceAccount = { name = "aws-load-balancer-controller" }
    nodeSelector   = { "dormeto.dev/pool" = "system" }
    tolerations    = [{ key = "CriticalAddonsOnly", operator = "Exists" }]
  })]

  depends_on = [module.lbc_pod_identity, terraform_data.admin_access]
}

# On destroy, after the demos: wait until the controller has deleted its load balancers and target groups (they would
# keep billing and block the VPC's deletion), before the controller itself goes.
resource "terraform_data" "lbc_resources_gone" {
  input = { cluster = module.eks.cluster_name, region = var.region, profile = var.aws_profile }

  provisioner "local-exec" {
    when    = destroy
    command = <<-EOT
      for i in $(seq 60); do
        n=$(aws resourcegroupstaggingapi get-resources --region ${self.input.region} --profile ${self.input.profile} \
          --tag-filters Key=elbv2.k8s.aws/cluster,Values=${self.input.cluster} \
          --resource-type-filters elasticloadbalancing:loadbalancer elasticloadbalancing:targetgroup \
          --query 'length(ResourceTagMappingList)' --output text)
        [ "$n" = "0" ] && exit 0
        sleep 10
      done
      echo "the controller's load balancers or target groups are still there after 10 minutes" >&2; exit 1
    EOT
  }

  depends_on = [helm_release.lbc]
}
