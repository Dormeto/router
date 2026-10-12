output "name" {
  value = var.name
}

output "table_name" {
  value = aws_dynamodb_table.router.name
}

output "table_arn" {
  value = aws_dynamodb_table.router.arn
}

output "waker_function_name" {
  value = aws_lambda_function.waker.function_name
}

output "waker_function_arn" {
  value = aws_lambda_function.waker.arn
}

output "controller_function_name" {
  value = aws_lambda_function.controller.function_name
}

output "controller_function_arn" {
  value = aws_lambda_function.controller.arn
}

output "controller_failures_queue_url" {
  value = aws_sqs_queue.controller_failures.url
}

output "onboarder_function_name" {
  value = aws_lambda_function.onboarder.function_name
}

output "onboarder_function_arn" {
  value = aws_lambda_function.onboarder.arn
}

# Workloads depend on it (the router object passed to the workload module): the waker target group is registered once
# the load balancers may invoke the waker.
output "waker_permission" {
  value = aws_lambda_permission.waker_alb.statement_id
}
