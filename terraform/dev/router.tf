module "router" {
  source                = "../modules/router"
  name                  = local.name
  lambda_source_dir     = "${path.module}/../../lambda/src"
  waker_timeout_seconds = var.wait_seconds + 10
  router_version        = jsondecode(file("${path.module}/../../package.json")).version
  admin_enabled         = var.admin_dashboard_enabled
  metrics_enabled       = true
  # Sources of the unwanted wakes seen in dev (see vision docs/plans/2026-10-04-ip-reputation-lists.md).
  ip_lists = [
    { name = "ipsum", url = "https://raw.githubusercontent.com/stamparm/ipsum/master/ipsum.txt" },
    { name = "aws", url = "https://ip-ranges.amazonaws.com/ip-ranges.json" },
    { name = "gcp", url = "https://www.gstatic.com/ipranges/cloud.json" },
    { name = "digitalocean", url = "https://digitalocean.com/geo/google.csv" },
    # Read with the S3 API (ip-lists.tf); the object key is static so the controller policy is known at plan.
    { name = "censys", url = "s3://${local.ip_lists_bucket}/scanners/censys.txt", action = "ignore" },
  ]
  # Lets dormeto-e2e check that a matching request (and its waiter probe) never wakes a workload.
  no_wake_rules = [{ name = "e2e-no-wake", headers = [{ name = "x-dormeto-e2e", value = "no-wake" }] }]
  # The dev manager's event bus (manager platform output event_bus_arn): the router reports its state there.
  manager_event_bus_arn = "arn:aws:events:eu-west-1:121014831971:event-bus/dmt-dev-manager"
}

module "demo_workload" {
  source                      = "../modules/workload"
  router                      = module.router
  workload_id                 = "demo"
  no_wake_rules               = [{ name = "uptime-monitor", user_agent_pattern = "^dormeto-uptime/" }]
  app_target_group_arn        = aws_lb_target_group.app.arn
  app_target_group_arn_suffix = aws_lb_target_group.app.arn_suffix
  load_balancer_arn_suffix    = aws_lb.demo.arn_suffix
  wait_seconds                = var.wait_seconds
  idle_minutes                = var.idle_minutes
  admin_enabled               = var.admin_dashboard_enabled
  admin_secret                = var.admin_dashboard_enabled ? random_password.admin[0].result : null
  admin_secret_parameter      = var.admin_dashboard_enabled ? aws_ssm_parameter.admin_secret[0].name : null
}
