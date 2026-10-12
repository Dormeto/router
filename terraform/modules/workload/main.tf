locals {
  # camelCase JSON for the Lambdas; unset conditions stay null or empty (ignored).
  no_wake_rules = [for r in var.no_wake_rules : {
    name             = r.name
    sourceIps        = r.source_ips
    pathPrefixes     = r.path_prefixes
    pathPattern      = r.path_pattern
    userAgentPattern = r.user_agent_pattern
    headers          = [for h in r.headers : { name = h.name, value = h.value, pattern = h.pattern }]
  }]
  wake_rules = [for r in var.wake_rules : {
    name             = r.name
    sourceIps        = r.source_ips
    pathPrefixes     = r.path_prefixes
    pathPattern      = r.path_pattern
    userAgentPattern = r.user_agent_pattern
    headers          = [for h in r.headers : { name = h.name, value = h.value, pattern = h.pattern }]
  }]
}

resource "aws_lb_target_group" "waker" {
  name                               = "${var.router.name}-${var.workload_id}"
  target_type                        = "lambda"
  lambda_multi_value_headers_enabled = true
}

resource "aws_lambda_permission" "alb" {
  statement_id  = "alb-${var.workload_id}"
  action        = "lambda:InvokeFunction"
  function_name = var.router.waker_function_name
  principal     = "elasticloadbalancing.amazonaws.com"
  source_arn    = aws_lb_target_group.waker.arn
}

resource "aws_lb_target_group_attachment" "waker" {
  target_group_arn = aws_lb_target_group.waker.arn
  target_id        = var.router.waker_function_arn
  depends_on       = [aws_lambda_permission.alb]
}

resource "aws_dynamodb_table_item" "config" {
  table_name = var.router.table_name
  hash_key   = "pk"
  range_key  = "sk"
  item = jsonencode({
    pk = { S = "WL#${var.workload_id}" }
    sk = { S = "CFG" }
    config = { S = jsonencode({
      workloadId              = var.workload_id
      ruleArn                 = var.rule_arn
      appTargetGroupArn       = var.app_target_group_arn
      wakerTargetGroupArn     = aws_lb_target_group.waker.arn
      loadBalancerDimension   = var.load_balancer_arn_suffix
      appTargetGroupDimension = var.app_target_group_arn_suffix
      instanceIds             = var.instance_ids
      waitSeconds             = var.wait_seconds
      idleMinutes             = var.idle_minutes
      drainSeconds            = var.drain_seconds
      wakeTimeoutSeconds      = var.wake_timeout_seconds
      failedRetrySeconds      = var.failed_retry_seconds
      maxHolders              = var.max_holders
      pollSeconds             = var.poll_seconds
      noWakeRules             = local.no_wake_rules
      wakeMode                = var.wake_mode
      wakeRules               = local.wake_rules
      admin = {
        enabled    = var.admin_enabled && var.admin_secret != null
        secretHash = var.admin_enabled && var.admin_secret != null ? sha256(var.admin_secret) : ""
        # Where operators retrieve the secret (with ssm:GetParameter): never the secret itself.
        secretParameter = var.admin_enabled && var.admin_secret_parameter != null ? var.admin_secret_parameter : ""
      }
    }) }
  })
}

# Initial runtime state only: the Lambdas own it afterwards.
resource "aws_dynamodb_table_item" "run" {
  table_name = var.router.table_name
  hash_key   = "pk"
  range_key  = "sk"
  item = jsonencode({
    pk         = { S = "WL#${var.workload_id}" }
    sk         = { S = "RUN" }
    state      = { S = "AWAKE" }
    version    = { N = "0" }
    awakeSince = { N = "0" }
    holders    = { N = "0" }
    wakeCount  = { N = "0" }
  })

  lifecycle {
    ignore_changes = [item]
  }
}
