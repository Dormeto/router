resource "aws_security_group" "alb" {
  name        = "${local.name}-demo-alb"
  description = "Dormeto demo ALB"
  vpc_id      = aws_vpc.demo.id
}

resource "aws_vpc_security_group_ingress_rule" "alb" {
  for_each          = toset(["80", "443"])
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = tonumber(each.value)
  to_port           = tonumber(each.value)
}

resource "aws_vpc_security_group_egress_rule" "alb_to_app" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.app.id
  ip_protocol                  = "tcp"
  from_port                    = 80
  to_port                      = 80
}

resource "aws_lb" "demo" {
  name                       = "${local.name}-demo"
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.alb.id]
  subnets                    = aws_subnet.public[*].id
  drop_invalid_header_fields = true
}

resource "aws_lb_target_group" "app" {
  name                 = "${local.name}-demo-app"
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

resource "aws_lb_target_group_attachment" "app" {
  target_group_arn = aws_lb_target_group.app.arn
  target_id        = aws_instance.demo.id
  port             = 80
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.demo.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.demo.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.demo.certificate_arn

  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      message_body = "Not found"
      status_code  = "404"
    }
  }
}

resource "aws_lb_listener_rule" "demo" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 10

  condition {
    host_header {
      values = [local.domain]
    }
  }

  action {
    type = "forward"
    forward {
      target_group {
        arn    = aws_lb_target_group.app.arn
        weight = 1
      }
      target_group {
        arn    = module.demo_workload.waker_target_group_arn
        weight = 0
      }
    }
  }

  tags = { "dormeto:workload" = "demo" }

  lifecycle {
    # The Dormeto controller flips the weights at runtime.
    ignore_changes = [action]
  }
}
