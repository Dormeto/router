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
