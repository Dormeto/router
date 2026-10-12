# Second demo workload: the same web server behind an Auto Scaling group, on asg.<env>.dormeto.com.

resource "aws_launch_template" "demo_asg" {
  name                   = "${local.name}-demo-asg"
  image_id               = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = var.instance_type
  vpc_security_group_ids = [aws_security_group.app.id]
  user_data              = base64encode(file("${path.module}/user-data.sh"))

  metadata_options {
    http_tokens = "required"
  }

  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_type = "gp3"
      encrypted   = true
    }
  }

  tag_specifications {
    resource_type = "instance"
    tags          = { Name = "${local.name}-demo-asg", "dormeto:workload" = "demo-asg" }
  }
}

resource "aws_lb_target_group" "asg_app" {
  name                 = "${local.name}-demo-asg-app"
  port                 = 80
  protocol             = "HTTP"
  vpc_id               = aws_vpc.demo.id
  target_type          = "instance"
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

resource "aws_autoscaling_group" "demo" {
  name                      = "${local.name}-demo-asg"
  min_size                  = 1
  max_size                  = 2
  desired_capacity          = 1
  vpc_zone_identifier       = aws_subnet.public[*].id
  target_group_arns         = [aws_lb_target_group.asg_app.arn]
  health_check_type         = "ELB"
  health_check_grace_period = 60

  launch_template {
    id      = aws_launch_template.demo_asg.id
    version = "$Latest"
  }

  # Naps return the instances to the pool (stopped) and wakes restart them: faster than launching new ones. The web
  # server is an enabled systemd unit, so it starts at boot (user data runs at the first boot only).
  warm_pool {
    pool_state = "Stopped"
    min_size   = 0
    instance_reuse_policy {
      reuse_on_scale_in = true
    }
  }

  tag {
    key                 = "dormeto:workload"
    value               = "demo-asg"
    propagate_at_launch = true
  }

  tag {
    key                 = "Name"
    value               = "${local.name}-demo-asg"
    propagate_at_launch = true
  }

  lifecycle {
    # Dormeto scales the group to 0 and back, and suspends scaling processes while it naps.
    ignore_changes = [min_size, max_size, desired_capacity, suspended_processes]
  }
}

resource "aws_lb_listener_rule" "demo_asg" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 20

  condition {
    host_header {
      values = [local.asg_domain]
    }
  }

  action {
    type = "forward"
    forward {
      target_group {
        arn    = aws_lb_target_group.asg_app.arn
        weight = 1
      }
      target_group {
        arn    = module.demo_asg_workload.waker_target_group_arn
        weight = 0
      }
    }
  }

  tags = { "dormeto:workload" = "demo-asg" }

  lifecycle {
    ignore_changes = [action]
  }
}

# A second rule of the same workload (same target group): Dormeto switches both rules together.
resource "aws_lb_listener_rule" "demo_asg_static" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 19

  condition {
    host_header {
      values = [local.asg_domain]
    }
  }

  condition {
    path_pattern {
      values = ["/static/*"]
    }
  }

  action {
    type = "forward"
    forward {
      target_group {
        arn    = aws_lb_target_group.asg_app.arn
        weight = 1
      }
      target_group {
        arn    = module.demo_asg_workload.waker_target_group_arn
        weight = 0
      }
    }
  }

  tags = { "dormeto:workload" = "demo-asg" }

  lifecycle {
    ignore_changes = [action]
  }
}

resource "aws_lb_listener_rule" "admin_asg" {
  count        = var.admin_dashboard_enabled ? 1 : 0
  listener_arn = aws_lb_listener.https.arn
  priority     = 6

  condition {
    host_header {
      values = [local.asg_domain]
    }
  }

  condition {
    path_pattern {
      values = ["/_dormeto/*"]
    }
  }

  action {
    type             = "forward"
    target_group_arn = module.demo_asg_workload.waker_target_group_arn
  }

  tags = { "dormeto:workload" = "demo-asg", "dormeto:role" = "admin" }
}

module "demo_asg_workload" {
  source                      = "../modules/workload"
  router                      = module.router
  workload_id                 = "demo-asg"
  rule_arns                   = [aws_lb_listener_rule.demo_asg.arn, aws_lb_listener_rule.demo_asg_static.arn]
  app_target_group_arn        = aws_lb_target_group.asg_app.arn
  app_target_group_arn_suffix = aws_lb_target_group.asg_app.arn_suffix
  load_balancer_arn_suffix    = aws_lb.demo.arn_suffix
  wait_seconds                = var.wait_seconds
  idle_minutes                = var.idle_minutes
  admin_enabled               = var.admin_dashboard_enabled
  admin_secret                = var.admin_dashboard_enabled ? random_password.admin[0].result : null
  admin_secret_parameter      = var.admin_dashboard_enabled ? aws_ssm_parameter.admin_secret[0].name : null
}
