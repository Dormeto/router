# A TargetGroupBinding: the ALB, its listener and rule owned by this Terraform, the controller only registering the pods
# of the demo's Service (today's switching of the rule works as it is).
resource "aws_security_group" "bind" {
  count  = var.target_group_binding ? 1 : 0
  name   = "${var.name}-bind"
  vpc_id = module.vpc.vpc_id

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = [module.vpc.vpc_cidr_block]
  }
}

resource "aws_lb" "bind" {
  count              = var.target_group_binding ? 1 : 0
  name               = "${var.name}-bind"
  load_balancer_type = "application"
  subnets            = module.vpc.public_subnets
  security_groups    = [aws_security_group.bind[0].id]
}

resource "aws_lb_target_group" "bind" {
  count       = var.target_group_binding ? 1 : 0
  name        = "${var.name}-bind"
  port        = 80
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = module.vpc.vpc_id

  health_check {
    path    = "/"
    matcher = "200"
  }
}

resource "aws_lb_listener" "bind" {
  count             = var.target_group_binding ? 1 : 0
  load_balancer_arn = aws_lb.bind[0].arn
  port              = 443
  protocol          = "HTTPS"
  certificate_arn   = aws_acm_certificate_validation.demos.certificate_arn

  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      status_code  = "404"
    }
  }
}

resource "aws_lb_listener_rule" "bind" {
  count        = var.target_group_binding ? 1 : 0
  listener_arn = aws_lb_listener.bind[0].arn
  priority     = 10

  condition {
    host_header {
      values = ["bind.${var.domain}"]
    }
  }
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.bind[0].arn
  }
}

resource "aws_route53_record" "bind" {
  count   = var.target_group_binding ? 1 : 0
  zone_id = var.zone_id
  name    = "bind.${var.domain}"
  type    = "A"

  alias {
    name                   = aws_lb.bind[0].dns_name
    zone_id                = aws_lb.bind[0].zone_id
    evaluate_target_health = false
  }
}
