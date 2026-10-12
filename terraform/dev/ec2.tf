data "aws_ssm_parameter" "al2023_arm64" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

resource "aws_security_group" "app" {
  name        = "${local.name}-demo-app"
  description = "Dormeto demo instance"
  vpc_id      = aws_vpc.demo.id
}

resource "aws_vpc_security_group_ingress_rule" "app_from_alb" {
  security_group_id            = aws_security_group.app.id
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = 80
  to_port                      = 80
}

resource "aws_vpc_security_group_egress_rule" "app_all" {
  security_group_id = aws_security_group.app.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_instance" "demo" {
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
    Name               = "${local.name}-demo"
    "dormeto:workload" = "demo"
  }

  lifecycle {
    # A newer AMI must not replace the instance; Dormeto stops and starts it.
    ignore_changes = [ami]
  }
}
