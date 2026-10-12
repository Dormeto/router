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
  # Daily statistics items (STATS#<day>) expire after 35 days.
  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }
}

locals {
  # Identifies the exact deployed code: first 12 hex characters of the Lambda zip SHA-256.
  build = substr(data.archive_file.lambda.output_sha256, 0, 12)
  # camelCase JSON for the Lambdas; unset conditions stay null or empty (ignored).
  ip_lists = jsonencode([for l in var.ip_lists : { name = l.name, url = l.url, action = l.action, refreshHours = l.refresh_hours }])
  no_wake_rules = [for r in var.no_wake_rules : {
    name             = r.name
    sourceIps        = r.source_ips
    pathPrefixes     = r.path_prefixes
    pathPattern      = r.path_pattern
    userAgentPattern = r.user_agent_pattern
    headers          = [for h in r.headers : { name = h.name, value = h.value, pattern = h.pattern }]
  }]
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
      DMT_TABLE          = aws_dynamodb_table.router.name
      DMT_VERSION        = var.router_version
      DMT_BUILD          = local.build
      DMT_IP_LISTS       = local.ip_lists
      DMT_TG_PREFIX      = "${var.name}-"
      DMT_NO_WAKE_RULES  = jsonencode(local.no_wake_rules)
      DMT_CHECK_SCHEDULE = var.check_schedule
      # Router health and configuration (manager Routers view): the waker's metrics, the failure queues.
      DMT_METRICS        = tostring(var.metrics_enabled)
      DMT_WAKER_FUNCTION = "${var.name}-waker"
      DMT_FAILURE_QUEUES = jsonencode({ check = aws_sqs_queue.check_failures.url, controller = aws_sqs_queue.controller_failures.url })
      # Drift repair of the workloads the manager onboarded, requested by the idle check.
      DMT_ONBOARDER = "${var.name}-onboarder"
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

  # Failed or dropped wake/nap events land in a queue instead of only in the logs.
  destination_config {
    on_failure {
      destination = aws_sqs_queue.controller_failures.arn
    }
  }

  depends_on = [aws_iam_role_policy.controller]
}

resource "aws_sqs_queue" "controller_failures" {
  name                      = "${var.name}-controller-failures"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
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
  memory_size      = var.waker_memory_mb

  environment {
    variables = {
      DMT_TABLE      = aws_dynamodb_table.router.name
      DMT_CONTROLLER = aws_lambda_function.controller.function_name
      DMT_TG_PREFIX  = "${var.name}-"
      DMT_VERSION    = var.router_version
      DMT_BUILD      = local.build
      # Router default no-wake rules, for every workload.
      DMT_NO_WAKE_RULES = jsonencode(local.no_wake_rules)
      DMT_METRICS       = tostring(var.metrics_enabled)
      DMT_IP_LISTS      = local.ip_lists
    }
  }

  depends_on = [aws_cloudwatch_log_group.waker, aws_iam_role_policy.waker]
}

resource "aws_cloudwatch_log_group" "onboarder" {
  name              = "/aws/lambda/${var.name}-onboarder"
  retention_in_days = var.log_retention_days
}

# Onboards and offboards workloads for the manager (vision docs/specs/2026-10-05-onboarding-design.md), with its own role:
# the controller keeps its least privilege.
resource "aws_lambda_function" "onboarder" {
  function_name    = "${var.name}-onboarder"
  role             = aws_iam_role.onboarder.arn
  runtime          = "nodejs24.x"
  architectures    = ["arm64"]
  handler          = "onboarder.handler"
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256
  # Finding the backends lists every Auto Scaling group and ECS service of the region.
  timeout     = 300
  memory_size = 256

  environment {
    variables = {
      DMT_TABLE              = aws_dynamodb_table.router.name
      DMT_TG_PREFIX          = "${var.name}-"
      DMT_VERSION            = var.router_version
      DMT_BUILD              = local.build
      DMT_WAKER_FUNCTION     = aws_lambda_function.waker.function_name
      DMT_WAKER_FUNCTION_ARN = aws_lambda_function.waker.arn
    }
  }

  depends_on = [aws_cloudwatch_log_group.onboarder, aws_iam_role_policy.onboarder]
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
    # source = schedule: the controller records the scheduled checks (health of the automatic naps).
    input = jsonencode({ action = "check", source = "schedule" })

    retry_policy {
      maximum_retry_attempts = 0
    }

    # A failed scheduled check lands here with its error code and message (visible, not silently dropped).
    dead_letter_config {
      arn = aws_sqs_queue.check_failures.arn
    }
  }
}

resource "aws_sqs_queue" "check_failures" {
  name                      = "${var.name}-check-failures"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

# Drift repair (vision docs/specs/2026-10-05-onboarding-design.md, R4c): CloudTrail events on rules, target groups and the
# dormeto:workload tags, not caused by the router itself (its roles' sessions), invoke the onboarder (pattern shared with
# the blueprint).
resource "aws_cloudwatch_event_rule" "drift" {
  name        = "${var.name}-drift"
  description = "Dormeto: rules, target groups and workload tags changed outside the router"
  event_pattern = replace(replace(replace(file("${path.module}/../../../install/drift-pattern.json"),
    "$${name}", var.name), "$${partition}", data.aws_partition.current.partition), "$${account}", local.account_id)
}

resource "aws_cloudwatch_event_target" "drift" {
  rule = aws_cloudwatch_event_rule.drift.name
  arn  = aws_lambda_function.onboarder.arn
}

resource "aws_lambda_permission" "drift" {
  statement_id  = "drift-events"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.onboarder.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.drift.arn
}
