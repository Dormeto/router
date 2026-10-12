# Fourth demo workload: an ECS Fargate service with a PostgreSQL database as companion backend, on rds.<env>.dormeto.com.

resource "aws_security_group" "db" {
  name        = "${local.name}-demo-db"
  description = "Dormeto demo database"
  vpc_id      = aws_vpc.demo.id
}

resource "aws_vpc_security_group_ingress_rule" "db_from_app" {
  security_group_id            = aws_security_group.db.id
  referenced_security_group_id = aws_security_group.app.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

resource "aws_db_subnet_group" "demo" {
  name       = "${local.name}-demo"
  subnet_ids = aws_subnet.public[*].id
}

resource "aws_db_instance" "demo" {
  identifier                  = "${local.name}-demo-rds"
  engine                      = "postgres"
  instance_class              = "db.t4g.micro"
  allocated_storage           = 20
  storage_type                = "gp3"
  storage_encrypted           = true
  db_name                     = "demo"
  username                    = "dormeto"
  manage_master_user_password = true
  db_subnet_group_name        = aws_db_subnet_group.demo.name
  vpc_security_group_ids      = [aws_security_group.db.id]
  publicly_accessible         = false
  multi_az                    = false
  backup_retention_period     = 1
  skip_final_snapshot         = true
  deletion_protection         = false
  apply_immediately           = true

  tags = { "dormeto:workload" = "demo-rds" }
}

resource "aws_lb_target_group" "rds_app" {
  name                 = "${local.name}-demo-rds-app"
  port                 = 80
  protocol             = "HTTP"
  vpc_id               = aws_vpc.demo.id
  target_type          = "ip"
  deregistration_delay = 10

  health_check {
    path                = "/"
    interval            = 5
    timeout             = 2
    healthy_threshold   = 2
    unhealthy_threshold = 2
    matcher             = "200"
  }
}

resource "aws_ecs_service" "demo_rds" {
  name                              = "${local.name}-demo-rds"
  cluster                           = aws_ecs_cluster.demo.id
  task_definition                   = aws_ecs_task_definition.demo.arn
  desired_count                     = 1
  launch_type                       = "FARGATE"
  health_check_grace_period_seconds = 30
  propagate_tags                    = "SERVICE"

  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.rds_app.arn
    container_name   = "web"
    container_port   = 80
  }

  tags = { "dormeto:workload" = "demo-rds" }

  lifecycle {
    ignore_changes = [desired_count]
  }

  depends_on = [aws_lb_listener_rule.demo_rds]
}

resource "aws_lb_listener_rule" "demo_rds" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 40

  condition {
    host_header {
      values = [local.rds_domain]
    }
  }

  action {
    type = "forward"
    forward {
      target_group {
        arn    = aws_lb_target_group.rds_app.arn
        weight = 1
      }
      target_group {
        arn    = module.demo_rds_workload.waker_target_group_arn
        weight = 0
      }
    }
  }

  tags = { "dormeto:workload" = "demo-rds" }

  lifecycle {
    ignore_changes = [action]
  }
}

resource "aws_lb_listener_rule" "admin_rds" {
  count        = var.admin_dashboard_enabled ? 1 : 0
  listener_arn = aws_lb_listener.https.arn
  priority     = 8

  condition {
    host_header {
      values = [local.rds_domain]
    }
  }

  condition {
    path_pattern {
      values = ["/_dormeto/*"]
    }
  }

  action {
    type             = "forward"
    target_group_arn = module.demo_rds_workload.waker_target_group_arn
  }

  tags = { "dormeto:workload" = "demo-rds", "dormeto:role" = "admin" }
}

module "demo_rds_workload" {
  source                      = "../modules/workload"
  router                      = module.router
  workload_id                 = "demo-rds"
  app_target_group_arn        = aws_lb_target_group.rds_app.arn
  app_target_group_arn_suffix = aws_lb_target_group.rds_app.arn_suffix
  load_balancer_arn_suffix    = aws_lb.demo.arn_suffix
  wait_seconds                = var.wait_seconds
  idle_minutes                = var.idle_minutes
  # A database takes 5-10 minutes to start: the wake spans several controller invocations.
  wake_timeout_seconds   = 1800
  admin_enabled          = var.admin_dashboard_enabled
  admin_secret           = var.admin_dashboard_enabled ? random_password.admin[0].result : null
  admin_secret_parameter = var.admin_dashboard_enabled ? aws_ssm_parameter.admin_secret[0].name : null
}
