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
      DMT_TABLE    = aws_dynamodb_table.router.name
      DMT_VERSION  = var.router_version
      DMT_BUILD    = local.build
      DMT_IP_LISTS = local.ip_lists
      # The manager's lists (R6b): empty, none.
      DMT_IP_LISTS_CATALOG = var.ip_lists_catalog == null ? "" : var.ip_lists_catalog
      DMT_TG_PREFIX        = "${var.name}-"
      DMT_NO_WAKE_RULES    = jsonencode(local.no_wake_rules)
      DMT_CHECK_SCHEDULE   = var.check_schedule
      # Router health and configuration (manager Routers view): the waker's metrics, the failure queues.
      DMT_METRICS        = tostring(var.metrics_enabled)
      DMT_WAKER_FUNCTION = "${var.name}-waker"
      DMT_FAILURE_QUEUES = jsonencode({ check = aws_sqs_queue.check_failures.url, controller = aws_sqs_queue.controller_failures.url })
      # Drift repair of the workloads the manager onboarded, requested by the idle check (a router without the drift
      # queue invokes the onboarder).
      DMT_ONBOARDER = "${var.name}-onboarder"
      # The manager's event bus (scale design §3): empty, the router publishes nothing.
      DMT_MANAGER_BUS = var.manager_event_bus_arn == null ? "" : var.manager_event_bus_arn
      # The work queue (scale design §6): naps and the wakes of a router pause.
      DMT_WORK_QUEUE = aws_sqs_queue.work.url
      # The drift queue: the idle check's repair requests, read with the drift events.
      DMT_DRIFT_QUEUE = aws_sqs_queue.drift.url
      # The Kubernetes proxies (R10.6), named <prefix><cluster> (module kubernetes-proxy).
      DMT_KUBE_PROXY_PREFIX = "${var.name}-kube-"
    }
  }

  depends_on = [aws_cloudwatch_log_group.controller, aws_iam_role_policy.controller]
}

# The work queue (scale design §6): naps and the wakes of a router pause, read by the controller 10 at a time (one per
# invocation: minutes long); a message is refused after 10 minutes anyway, and visible again after the controller's 15.
resource "aws_sqs_queue" "work" {
  name                       = "${var.name}-work"
  message_retention_seconds  = 345600
  visibility_timeout_seconds = 960
  sqs_managed_sse_enabled    = true
  redrive_policy             = jsonencode({ deadLetterTargetArn = aws_sqs_queue.controller_failures.arn, maxReceiveCount = 3 })
}

resource "aws_lambda_event_source_mapping" "work" {
  event_source_arn                   = aws_sqs_queue.work.arn
  function_name                      = aws_lambda_function.controller.arn
  batch_size                         = 1
  maximum_batching_window_in_seconds = 0
  function_response_types            = ["ReportBatchItemFailures"]
  scaling_config {
    maximum_concurrency = 10
  }
  depends_on = [aws_iam_role_policy.controller]
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
      DMT_TABLE       = aws_dynamodb_table.router.name
      DMT_CONTROLLER  = aws_lambda_function.controller.function_name
      DMT_TG_PREFIX   = "${var.name}-"
      DMT_VERSION     = var.router_version
      DMT_MANAGER_BUS = var.manager_event_bus_arn == null ? "" : var.manager_event_bus_arn
      DMT_BUILD       = local.build
      # Router default no-wake rules, for every workload.
      DMT_NO_WAKE_RULES    = jsonencode(local.no_wake_rules)
      DMT_METRICS          = tostring(var.metrics_enabled)
      DMT_IP_LISTS         = local.ip_lists
      DMT_IP_LISTS_CATALOG = var.ip_lists_catalog == null ? "" : var.ip_lists_catalog
      # The Kubernetes proxies (R10.6), named <prefix><cluster> (module kubernetes-proxy).
      DMT_KUBE_PROXY_PREFIX = "${var.name}-kube-"
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
      # The Kubernetes proxies (R10.6), named <prefix><cluster> (module kubernetes-proxy).
      DMT_KUBE_PROXY_PREFIX = "${var.name}-kube-"
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

# The load balancers of the account invoke the waker from the router's waker target groups (<name>-<workload id>): one
# statement whatever the number of workloads (a function's resource policy is limited to 20 KB). Design section 7.
# Named outside the alb-<workload id> statements of routers before 0.20.0 (which offboarding removes).
resource "aws_lambda_permission" "waker_alb" {
  statement_id  = "dormeto-alb"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.waker.function_name
  principal     = "elasticloadbalancing.amazonaws.com"
  source_arn    = "${local.arn_prefix}:elasticloadbalancing:${local.region}:${local.account_id}:targetgroup/${var.name}-*/*"

  # A replacement never leaves the waker without a permission.
  lifecycle {
    create_before_destroy = true
  }
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

# Drift events go to a queue the onboarder reads in batches (60 seconds, 2 at a time): each workload repaired once per
# batch, whatever the number of events (scale design §6).
resource "aws_sqs_queue" "drift" {
  name                       = "${var.name}-drift"
  message_retention_seconds  = 86400
  visibility_timeout_seconds = 360
  sqs_managed_sse_enabled    = true
  redrive_policy             = jsonencode({ deadLetterTargetArn = aws_sqs_queue.controller_failures.arn, maxReceiveCount = 3 })
}

data "aws_iam_policy_document" "drift_queue" {
  statement {
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.drift.arn]
    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_cloudwatch_event_rule.drift.arn]
    }
  }
}

resource "aws_sqs_queue_policy" "drift" {
  queue_url = aws_sqs_queue.drift.id
  policy    = data.aws_iam_policy_document.drift_queue.json
}

resource "aws_cloudwatch_event_target" "drift" {
  rule = aws_cloudwatch_event_rule.drift.name
  arn  = aws_sqs_queue.drift.arn
}

resource "aws_lambda_event_source_mapping" "drift" {
  event_source_arn                   = aws_sqs_queue.drift.arn
  function_name                      = aws_lambda_function.onboarder.arn
  batch_size                         = 100
  maximum_batching_window_in_seconds = 60
  function_response_types            = ["ReportBatchItemFailures"]
  scaling_config {
    maximum_concurrency = 2
  }
  depends_on = [aws_iam_role_policy.onboarder]
}
