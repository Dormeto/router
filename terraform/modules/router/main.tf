resource "aws_dynamodb_table" "router" {
  name         = "${var.name}-router"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }
  server_side_encryption {
    enabled = true
  }
}

data "archive_file" "lambda" {
  type        = "zip"
  source_dir  = var.lambda_source_dir
  output_path = "${path.root}/.build/${var.name}-router.zip"
}

resource "aws_cloudwatch_log_group" "waker" {
  name              = "/aws/lambda/${var.name}-waker"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "controller" {
  name              = "/aws/lambda/${var.name}-controller"
  retention_in_days = var.log_retention_days
}

resource "aws_lambda_function" "controller" {
  function_name    = "${var.name}-controller"
  role             = aws_iam_role.controller.arn
  runtime          = "nodejs24.x"
  architectures    = ["arm64"]
  handler          = "controller.handler"
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256
  timeout          = 900
  memory_size      = 256

  environment {
    variables = {
      DMT_TABLE = aws_dynamodb_table.router.name
    }
  }

  depends_on = [aws_cloudwatch_log_group.controller, aws_iam_role_policy.controller]
}

# Retries would duplicate wakes and naps: every controller action is driven by state instead.
resource "aws_lambda_function_event_invoke_config" "controller" {
  function_name          = aws_lambda_function.controller.function_name
  maximum_retry_attempts = 0
  # A throttled async event is re-queued for up to 6 hours by default: drop stale wake/nap events instead.
  maximum_event_age_in_seconds = 120
}

resource "aws_lambda_function" "waker" {
  function_name    = "${var.name}-waker"
  role             = aws_iam_role.waker.arn
  runtime          = "nodejs24.x"
  architectures    = ["arm64"]
  handler          = "waker.handler"
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256
  timeout          = var.waker_timeout_seconds
  memory_size      = 256

  environment {
    variables = {
      DMT_TABLE      = aws_dynamodb_table.router.name
      DMT_CONTROLLER = aws_lambda_function.controller.function_name
      DMT_TG_PREFIX  = "${var.name}-"
    }
  }

  depends_on = [aws_cloudwatch_log_group.waker, aws_iam_role_policy.waker]
}

resource "aws_scheduler_schedule" "check" {
  name                = "${var.name}-check"
  schedule_expression = var.check_schedule

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.controller.arn
    role_arn = aws_iam_role.scheduler.arn
    input    = jsonencode({ action = "check" })

    retry_policy {
      maximum_retry_attempts = 0
    }
  }
}
