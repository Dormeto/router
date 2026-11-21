output "workload_id" {
  value = var.workload_id
}

output "waker_target_group_arn" {
  description = "An HTTP workload's waker target group; null for a standalone workload."
  value       = local.standalone ? null : aws_lb_target_group.waker[0].arn
}
