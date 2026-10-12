# Karpenter launches the demos' nodes and removes them once empty: naps then free whole nodes (the spec's section 9).
module "karpenter" {
  source  = "terraform-aws-modules/eks/aws//modules/karpenter"
  version = "~> 21.0"

  cluster_name                    = module.eks.cluster_name
  node_iam_role_use_name_prefix   = false
  node_iam_role_name              = "${var.name}-karpenter-node"
  create_pod_identity_association = true
}

resource "helm_release" "karpenter" {
  name       = "karpenter"
  namespace  = "kube-system"
  repository = "oci://public.ecr.aws/karpenter"
  chart      = "karpenter"
  version    = "1.14.0"
  wait       = true

  values = [yamlencode({
    replicas     = 1
    nodeSelector = { "dormeto.dev/pool" = "system" }
    tolerations  = [{ key = "CriticalAddonsOnly", operator = "Exists" }]
    settings = {
      clusterName       = module.eks.cluster_name
      clusterEndpoint   = module.eks.cluster_endpoint
      interruptionQueue = module.karpenter.queue_name
    }
    controller = { resources = { requests = { cpu = "100m", memory = "256Mi" }, limits = { memory = "512Mi" } } }
  })]
}

# On destroy, after the NodePool is gone: wait until Karpenter's instances are terminated (they would keep billing and
# block the VPC's deletion).
resource "terraform_data" "karpenter_nodes_gone" {
  input = { cluster = module.eks.cluster_name, region = var.region, profile = var.aws_profile }

  provisioner "local-exec" {
    when    = destroy
    command = <<-EOT
      for i in $(seq 60); do
        n=$(aws ec2 describe-instances --region ${self.input.region} --profile ${self.input.profile} \
          --filters Name=tag:karpenter.sh/discovery,Values=${self.input.cluster} Name=instance-state-name,Values=pending,running,stopping,stopped \
          --query 'length(Reservations[].Instances[])' --output text)
        [ "$n" = "0" ] && exit 0
        sleep 10
      done
      echo "Karpenter's instances are still there after 10 minutes" >&2; exit 1
    EOT
  }

  depends_on = [helm_release.karpenter]
}

resource "helm_release" "karpenter_config" {
  name      = "karpenter-config"
  namespace = "kube-system"
  chart     = "${path.module}/charts/karpenter-config"

  values = [yamlencode({
    cluster  = module.eks.cluster_name
    nodeRole = module.karpenter.node_iam_role_name
  })]

  depends_on = [terraform_data.karpenter_nodes_gone]
}
