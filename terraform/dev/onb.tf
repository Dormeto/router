# Workload "onb" as a customer's Terraform writes it: an instance behind a target group and a host rule, without any
# Dormeto resource. The manager onboards and offboards it (vision docs/specs/2026-10-05-onboarding-design.md, acceptance 1).
locals {
  onb_domain = "onb.${local.domain}"
}

resource "aws_instance" "onb" {
  ami                         = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type               = var.instance_type
  subnet_id                   = aws_subnet.public[0].id
  vpc_security_group_ids      = [aws_security_group.app.id]
  user_data                   = file("${path.module}/user-data.sh")
  user_data_replace_on_change = true

  metadata_options {
    http_tokens = "required"
  }

  root_block_device {
    volume_type = "gp3"
    encrypted   = true
  }

  tags = {
    Name = "${local.name}-onb"
  }

  lifecycle {
    # Onboarding tags the instance (dormeto:workload, dormeto:tagged): until shadow rules and drift repair (R4c), the
    # customer side ignores those changes.
    ignore_changes = [ami, tags]
  }
}

resource "aws_lb_target_group" "onb" {
  name                 = "${local.name}-onb-app"
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

resource "aws_lb_target_group_attachment" "onb" {
  target_group_arn = aws_lb_target_group.onb.arn
  target_id        = aws_instance.onb.id
  port             = 80
}

resource "aws_lb_listener_rule" "onb" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 50

  condition {
    host_header {
      values = [local.onb_domain]
    }
  }

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.onb.arn
  }
  # No ignore_changes: onboarding adds a shadow rule before this one and never changes it (R4c).
}

resource "aws_acm_certificate" "onb" {
  domain_name       = local.onb_domain
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "onb_certificate_validation" {
  for_each = { for o in aws_acm_certificate.onb.domain_validation_options : o.domain_name => o }
  zone_id  = var.zone_id
  name     = each.value.resource_record_name
  type     = each.value.resource_record_type
  records  = [each.value.resource_record_value]
  ttl      = 300
}

resource "aws_acm_certificate_validation" "onb" {
  certificate_arn         = aws_acm_certificate.onb.arn
  validation_record_fqdns = [for r in aws_route53_record.onb_certificate_validation : r.fqdn]
}

resource "aws_lb_listener_certificate" "onb" {
  listener_arn    = aws_lb_listener.https.arn
  certificate_arn = aws_acm_certificate_validation.onb.certificate_arn
}

resource "aws_route53_record" "onb" {
  zone_id = var.zone_id
  name    = local.onb_domain
  type    = "A"

  alias {
    name                   = aws_lb.demo.dns_name
    zone_id                = aws_lb.demo.zone_id
    evaluate_target_health = false
  }
}
