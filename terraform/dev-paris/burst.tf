# The acceptance at scale (vision docs/specs/2026-10-05-scale-design.md section 7): a burst of onboardings in this account
# and region, queued by the manager's slots (3 at a time). `burst` small applications, each with its own instance, target
# group and host rule on the load balancer (burst<N>.paris.dev.dormeto.com, never served); 0 outside the test (about
# 4 USD a month each while they exist: the instance and its volume). At most about 48: once onboarded each takes 2 target
# groups and 2 rules of the load balancer's 100 of each (paris-app takes 2 of each too). Offboard them in the manager
# before setting it back to 0.
variable "burst" {
  type    = number
  default = 0
}

resource "aws_instance" "burst" {
  count                       = var.burst
  ami                         = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type               = "t4g.nano"
  subnet_id                   = aws_subnet.public[count.index % 2].id
  vpc_security_group_ids      = [aws_security_group.app.id]
  associate_public_ip_address = false
  user_data                   = file("${path.module}/../dev/user-data.sh")

  metadata_options {
    http_tokens = "required"
  }

  root_block_device {
    volume_type = "gp3"
    encrypted   = true
  }

  tags = { Name = "${local.name}-burst-${count.index}" }

  lifecycle {
    # Onboarding tags the instance.
    ignore_changes = [ami, tags]
  }
}

resource "aws_lb_target_group" "burst" {
  count                = var.burst
  name                 = "paris-burst-${count.index}"
  port                 = 80
  protocol             = "HTTP"
  vpc_id               = aws_vpc.main.id
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

resource "aws_lb_target_group_attachment" "burst" {
  count            = var.burst
  target_group_arn = aws_lb_target_group.burst[count.index].arn
  target_id        = aws_instance.burst[count.index].id
  port             = 80
}

resource "aws_lb_listener_rule" "burst" {
  count        = var.burst
  listener_arn = aws_lb_listener.https.arn
  priority     = 100 + 10 * count.index
  condition {
    host_header {
      values = ["burst${count.index}.${local.domain}"]
    }
  }
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.burst[count.index].arn
  }
  lifecycle {
    # Onboarding instruments the rule.
    ignore_changes = [action, tags]
  }
}
