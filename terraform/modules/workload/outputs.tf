output "workload_id" {
  value = var.workload_id
}

output "waker_target_group_arn" {
  value = aws_lb_target_group.waker.arn
}
