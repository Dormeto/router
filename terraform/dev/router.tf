module "router" {
  source                = "../modules/router"
  name                  = local.name
  lambda_source_dir     = "${path.module}/../../lambda/src"
  waker_timeout_seconds = var.wait_seconds + 10
  router_version        = jsondecode(file("${path.module}/../../package.json")).version
  admin_enabled         = var.admin_dashboard_enabled
  metrics_enabled       = true
  # Lets dormeto-e2e check that a matching request (and its waiter probe) never wakes a workload.
  no_wake_rules = [{ name = "e2e-no-wake", headers = [{ name = "x-dormeto-e2e", value = "no-wake" }] }]
}

module "demo_workload" {
  source                      = "../modules/workload"
  router                      = module.router
  workload_id                 = "demo"
  no_wake_rules               = [{ name = "uptime-monitor", user_agent_pattern = "^dormeto-uptime/" }]
  rule_arn                    = aws_lb_listener_rule.demo.arn
  app_target_group_arn        = aws_lb_target_group.app.arn
  app_target_group_arn_suffix = aws_lb_target_group.app.arn_suffix
  load_balancer_arn_suffix    = aws_lb.demo.arn_suffix
  wait_seconds                = var.wait_seconds
  idle_minutes                = var.idle_minutes
  admin_enabled               = var.admin_dashboard_enabled
  admin_secret                = var.admin_dashboard_enabled ? random_password.admin[0].result : null
  admin_secret_parameter      = var.admin_dashboard_enabled ? aws_ssm_parameter.admin_secret[0].name : null
}
