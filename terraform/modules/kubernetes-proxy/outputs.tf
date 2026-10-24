output "function_name" {
  description = "The proxy's function name, <router_name>-kube-<cluster>."
  value       = aws_lambda_function.proxy.function_name
}

output "function_arn" {
  value = aws_lambda_function.proxy.arn
}

output "role_arn" {
  value = aws_iam_role.proxy.arn
}

output "security_group_id" {
  description = "The proxy's own security group, null when security_group_ids was given."
  value       = one(aws_security_group.proxy[*].id)
}
