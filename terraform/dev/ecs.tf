# Third demo workload: the same demo page served by an ECS Fargate service, on ecs.<env>.dormeto.com.

resource "aws_ecs_cluster" "demo" {
  name = local.name
}

# demo-ecs runs on Fargate Spot (the manager's R9.5 prices it at Spot prices); demo-rds stays on the Fargate launch type.
resource "aws_ecs_cluster_capacity_providers" "demo" {
  cluster_name       = aws_ecs_cluster.demo.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]
}

resource "aws_cloudwatch_log_group" "demo_ecs" {
  name              = "/ecs/${local.name}-demo-ecs"
  retention_in_days = 14
}

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "demo_ecs_execution" {
  name               = "${local.name}-demo-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "demo_ecs_execution" {
  role       = aws_iam_role.demo_ecs_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_ecs_task_definition" "demo" {
  family                   = "${local.name}-demo-ecs"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.demo_ecs_execution.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  container_definitions = jsonencode([{
    name         = "web"
    image        = "public.ecr.aws/docker/library/python:3.13-alpine"
    essential    = true
    portMappings = [{ containerPort = 80, protocol = "tcp" }]
    command = ["sh", "-c", join(" && ", [
      "mkdir -p /srv",
      "printf '<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Dormeto demo</title></head><body><h1>Dormeto demo</h1><p>ECS task <code>%s</code> started at <time>%s</time>.</p></body></html>' \"$(hostname)\" \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\" > /srv/index.html",
      "exec python3 -m http.server 80 --directory /srv",
    ])]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.demo_ecs.name
        awslogs-region        = var.region
        awslogs-stream-prefix = "web"
      }
    }
  }])
}

resource "aws_lb_target_group" "ecs_app" {
  name                 = "${local.name}-demo-ecs-app"
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

resource "aws_ecs_service" "demo" {
  name                              = "${local.name}-demo-ecs"
  cluster                           = aws_ecs_cluster.demo.id
  task_definition                   = aws_ecs_task_definition.demo.arn
  desired_count                     = 1
  health_check_grace_period_seconds = 30
  propagate_tags                    = "SERVICE"
  # Moving from the launch type to a capacity provider strategy needs a new deployment.
  force_new_deployment = true

  capacity_provider_strategy {
    capacity_provider = "FARGATE_SPOT"
    weight            = 1
  }

  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = true # pull the image without a NAT gateway
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.ecs_app.arn
    container_name   = "web"
    container_port   = 80
  }

  tags = { "dormeto:workload" = "demo-ecs" }

  lifecycle {
    # Dormeto scales the service to 0 and back.
    ignore_changes = [desired_count]
  }

  # The target group must be attached to the load balancer before the service registers tasks in it.
  depends_on = [aws_lb_listener_rule.demo_ecs, aws_ecs_cluster_capacity_providers.demo]
}

resource "aws_lb_listener_rule" "demo_ecs" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 30

  condition {
    host_header {
      values = [local.ecs_domain]
    }
  }

  action {
    type = "forward"
    forward {
      target_group {
        arn    = aws_lb_target_group.ecs_app.arn
        weight = 1
      }
      target_group {
        arn    = module.demo_ecs_workload.waker_target_group_arn
        weight = 0
      }
    }
  }

  tags = { "dormeto:workload" = "demo-ecs" }

  lifecycle {
    ignore_changes = [action]
  }
}

resource "aws_lb_listener_rule" "admin_ecs" {
  count        = var.admin_dashboard_enabled ? 1 : 0
  listener_arn = aws_lb_listener.https.arn
  priority     = 7

  condition {
    host_header {
      values = [local.ecs_domain]
    }
  }

  condition {
    path_pattern {
      values = ["/_dormeto/*"]
    }
  }

  action {
    type             = "forward"
    target_group_arn = module.demo_ecs_workload.waker_target_group_arn
  }

  tags = { "dormeto:workload" = "demo-ecs", "dormeto:role" = "admin" }
}

module "demo_ecs_workload" {
  source      = "../modules/workload"
  router      = module.router
  workload_id = "demo-ecs"
  tags        = { team = "search", env = "dev" }
  # Scanners that do not run JavaScript never wake it; API paths wake it directly.
  wake_mode                   = "browser"
  wake_rules                  = [{ name = "api", path_prefixes = ["/api/"] }]
  app_target_group_arn        = aws_lb_target_group.ecs_app.arn
  app_target_group_arn_suffix = aws_lb_target_group.ecs_app.arn_suffix
  load_balancer_arn_suffix    = aws_lb.demo.arn_suffix
  wait_seconds                = var.wait_seconds
  idle_minutes                = var.idle_minutes
  admin_enabled               = var.admin_dashboard_enabled
  admin_secret                = var.admin_dashboard_enabled ? random_password.admin[0].result : null
  admin_secret_parameter      = var.admin_dashboard_enabled ? aws_ssm_parameter.admin_secret[0].name : null
}
