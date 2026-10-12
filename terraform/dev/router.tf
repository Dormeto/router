module "router" {
  source                = "../modules/router"
  name                  = local.name
  lambda_source_dir     = "${path.module}/../../lambda/src"
  waker_timeout_seconds = var.wait_seconds + 10
}

module "demo_workload" {
  source                      = "../modules/workload"
  router                      = module.router
  workload_id                 = "demo"
  rule_arn                    = aws_lb_listener_rule.demo.arn
  app_target_group_arn        = aws_lb_target_group.app.arn
  app_target_group_arn_suffix = aws_lb_target_group.app.arn_suffix
  load_balancer_arn_suffix    = aws_lb.demo.arn_suffix
  instance_ids                = [aws_instance.demo.id]
  wait_seconds                = var.wait_seconds
  idle_minutes                = var.idle_minutes
}
