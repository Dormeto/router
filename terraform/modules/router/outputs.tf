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
