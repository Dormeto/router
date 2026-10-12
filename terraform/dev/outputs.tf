output "url" {
  value = "https://${local.domain}/"
}

output "workload_id" {
  value = module.demo_workload.workload_id
}

output "instance_id" {
  value = aws_instance.demo.id
}

output "rule_arn" {
  value = aws_lb_listener_rule.demo.arn
}

output "table_name" {
  value = module.router.table_name
}

output "waker_function_name" {
  value = module.router.waker_function_name
}

output "controller_function_name" {
  value = module.router.controller_function_name
}

output "admin_url" {
  description = "Secret URL of the admin dashboard (empty when the feature flag is off)."
  value       = var.admin_dashboard_enabled ? "https://${local.domain}/_dormeto/${random_password.admin[0].result}/" : ""
  sensitive   = true
}

output "controller_failures_queue_url" {
  value = module.router.controller_failures_queue_url
}

output "workloads" {
  description = "Per-workload endpoints for the e2e CLI (sensitive: contains the admin URLs)."
  sensitive   = true
  value = {
    demo = {
      url         = "https://${local.domain}/"
      rule_arn    = aws_lb_listener_rule.demo.arn
      instance_id = aws_instance.demo.id
      asg_name    = null
      admin_url   = var.admin_dashboard_enabled ? "https://${local.domain}/_dormeto/${random_password.admin[0].result}/" : ""
    }
    demo-ecs = {
      url         = "https://${local.ecs_domain}/"
      rule_arn    = aws_lb_listener_rule.demo_ecs.arn
      instance_id = null
      asg_name    = null
      admin_url   = var.admin_dashboard_enabled ? "https://${local.ecs_domain}/_dormeto/${random_password.admin[0].result}/" : ""
    }
    demo-asg = {
      url         = "https://${local.asg_domain}/"
      rule_arn    = aws_lb_listener_rule.demo_asg.arn
      instance_id = null
      asg_name    = aws_autoscaling_group.demo.name
      admin_url   = var.admin_dashboard_enabled ? "https://${local.asg_domain}/_dormeto/${random_password.admin[0].result}/" : ""
    }
  }
}

output "onb_target_group_arn" {
  description = "Target group of the customer-style workload onb (onboarded by the manager)."
  value       = aws_lb_target_group.onb.arn
}
