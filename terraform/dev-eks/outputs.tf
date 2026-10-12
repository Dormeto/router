output "cluster_name" {
  value = module.eks.cluster_name
}

output "region" {
  value = var.region
}

output "kubeconfig_command" {
  value = "aws eks update-kubeconfig --name ${module.eks.cluster_name} --region ${var.region} --profile ${var.aws_profile}"
}

output "demo_urls" {
  value = concat([for h in local.hosts : "https://${h}.${var.domain}/"], var.target_group_binding ? ["https://bind.${var.domain}/"] : [])
}

output "group_load_balancer_arn" {
  value = data.aws_lb.group.arn
}

output "spike_target_group_arn" {
  value = var.spike ? aws_lb_target_group.spike[0].arn : null
}
