# A customer's application in another region, written as a customer would (no Dormeto resource): the manager installs a
# router in 121014831971/eu-west-3 by API calls and onboards it (vision docs/specs/2026-10-05-onboarding-design.md,
# acceptance 2). An internal load balancer behind CloudFront (a VPC origin): no public IPv4 at all, and Dormeto behind a
# CDN is tested too. About 20 USD a month napped, 24 always on (the load balancer hours).
variable "zone_id" {
  type    = string
  default = "Z01943593T1RNPIO8DLPX"
}

locals {
  name   = "paris-demo"
  domain = "paris.dev.dormeto.com"
}

provider "aws" {
  region              = "eu-west-3"
  profile             = "kloudy-dormeto-prd"
  allowed_account_ids = ["121014831971"]

  default_tags {
    tags = { env = "dev", project = "dormeto-test-customer" }
  }
}

# CloudFront's certificate lives in us-east-1.
provider "aws" {
  alias               = "us_east_1"
  region              = "us-east-1"
  profile             = "kloudy-dormeto-prd"
  allowed_account_ids = ["121014831971"]

  default_tags {
    tags = { env = "dev", project = "dormeto-test-customer" }
  }
}

data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_ssm_parameter" "al2023_arm64" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

resource "aws_vpc" "main" {
  cidr_block           = "10.41.0.0/16"
  enable_dns_hostnames = true
  tags                 = { Name = local.name }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
}

resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.main.id
  cidr_block              = cidrsubnet(aws_vpc.main.cidr_block, 8, count.index)
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = false
  tags                    = { Name = "${local.name}-public-${count.index}" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_security_group" "alb" {
  name   = "${local.name}-alb"
  vpc_id = aws_vpc.main.id
}

# Reached through CloudFront only. Its VPC origin connects through the service security group it creates in the VPC: that
# group is admitted by reference (a rule on the VPC's addresses does not match its traffic: found on 2026-10-05).
data "aws_security_group" "cloudfront" {
  vpc_id     = aws_vpc.main.id
  name       = "CloudFront-VPCOrigins-Service-SG"
  depends_on = [aws_cloudfront_vpc_origin.alb]
}

resource "aws_vpc_security_group_ingress_rule" "alb" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = data.aws_security_group.cloudfront.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
}

resource "aws_vpc_security_group_egress_rule" "alb" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.app.id
  ip_protocol                  = "tcp"
  from_port                    = 80
  to_port                      = 80
}

resource "aws_security_group" "app" {
  name   = "${local.name}-app"
  vpc_id = aws_vpc.main.id
}

resource "aws_vpc_security_group_ingress_rule" "app" {
  security_group_id            = aws_security_group.app.id
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = 80
  to_port                      = 80
}

resource "aws_vpc_security_group_egress_rule" "app" {
  security_group_id = aws_security_group.app.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_instance" "app" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.nano"
  subnet_id              = aws_subnet.public[0].id
  vpc_security_group_ids = [aws_security_group.app.id]
  # No public IPv4 (billed hourly while running): the ALB reaches it in the VPC, and it needs no internet (its web server
  # comes with the image, it only reads the instance metadata).
  associate_public_ip_address = false
  user_data                   = file("${path.module}/../dev/user-data.sh")
  user_data_replace_on_change = true

  metadata_options {
    http_tokens = "required"
  }

  root_block_device {
    volume_type = "gp3"
    encrypted   = true
  }

  tags = { Name = local.name }

  lifecycle {
    # Onboarding tags the instance: ignored until shadow rules and drift repair (R4c).
    ignore_changes = [ami, tags]
  }
}

resource "aws_lb" "main" {
  name                       = local.name
  internal                   = true
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.alb.id]
  subnets                    = aws_subnet.public[*].id
  drop_invalid_header_fields = true
  # Above the waker Lambda timeout: a held request must not be cut by the load balancer.
  idle_timeout = 120
}

resource "aws_lb_target_group" "app" {
  name                 = "paris-app"
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

resource "aws_lb_target_group_attachment" "app" {
  target_group_arn = aws_lb_target_group.app.arn
  target_id        = aws_instance.app.id
  port             = 80
}

resource "aws_acm_certificate" "main" {
  domain_name       = local.domain
  validation_method = "DNS"
  lifecycle {
    create_before_destroy = true
  }
}

# CloudFront's certificate for the same name (the origin keeps its own: CloudFront checks it against the Host it forwards).
resource "aws_acm_certificate" "cdn" {
  provider          = aws.us_east_1
  domain_name       = local.domain
  validation_method = "DNS"
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "validation" {
  for_each        = { for o in aws_acm_certificate.main.domain_validation_options : o.domain_name => o }
  zone_id         = var.zone_id
  name            = each.value.resource_record_name
  type            = each.value.resource_record_type
  records         = [each.value.resource_record_value]
  ttl             = 60
  allow_overwrite = true
}

# ACM usually gives both certificates of the domain the same record: written twice then (destroy both together).
resource "aws_route53_record" "cdn_validation" {
  for_each        = { for o in aws_acm_certificate.cdn.domain_validation_options : o.domain_name => o }
  zone_id         = var.zone_id
  name            = each.value.resource_record_name
  type            = each.value.resource_record_type
  records         = [each.value.resource_record_value]
  ttl             = 60
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "main" {
  certificate_arn         = aws_acm_certificate.main.arn
  validation_record_fqdns = [for r in aws_route53_record.validation : r.fqdn]
}

resource "aws_acm_certificate_validation" "cdn" {
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.cdn.arn
  validation_record_fqdns = [for r in aws_route53_record.cdn_validation : r.fqdn]
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
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
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.main.certificate_arn
  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      message_body = "Not found"
      status_code  = "404"
    }
  }
}

resource "aws_lb_listener_rule" "app" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 10
  condition {
    host_header {
      values = [local.domain]
    }
  }
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
  lifecycle {
    # Onboarding instruments the rule: ignored until R4c.
    ignore_changes = [action, tags]
  }
}

# CloudFront in front, the internal load balancer as a VPC origin (no extra charge). Dormeto behind a CDN needs the viewer's
# Host forwarded (its rules and the waker match it), nothing cached (the waker's answers change by the second, errors
# included) and an origin timeout above the waker's hold.
resource "aws_cloudfront_vpc_origin" "alb" {
  vpc_origin_endpoint_config {
    name                   = local.name
    arn                    = aws_lb.main.arn
    http_port              = 80
    https_port             = 443
    origin_protocol_policy = "https-only"
    origin_ssl_protocols {
      items    = ["TLSv1.2"]
      quantity = 1
    }
  }
}

data "aws_cloudfront_cache_policy" "disabled" {
  name = "Managed-CachingDisabled"
}

data "aws_cloudfront_origin_request_policy" "all_viewer" {
  name = "Managed-AllViewer"
}

resource "aws_cloudfront_distribution" "app" {
  enabled      = true
  aliases      = [local.domain]
  price_class  = "PriceClass_100"
  http_version = "http2and3"
  comment      = "${local.name}: internal load balancer as a VPC origin"

  origin {
    domain_name = aws_lb.main.dns_name
    origin_id   = "alb"
    vpc_origin_config {
      vpc_origin_id       = aws_cloudfront_vpc_origin.alb.id
      origin_read_timeout = 60
    }
  }

  default_cache_behavior {
    target_origin_id         = "alb"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer.id
    compress                 = true
  }

  dynamic "custom_error_response" {
    for_each = [502, 503, 504]
    content {
      error_code            = custom_error_response.value
      error_caching_min_ttl = 0
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.cdn.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}

resource "aws_route53_record" "app" {
  zone_id = var.zone_id
  name    = local.domain
  type    = "A"
  alias {
    name                   = aws_cloudfront_distribution.app.domain_name
    zone_id                = aws_cloudfront_distribution.app.hosted_zone_id
    evaluate_target_health = false
  }
}

output "load_balancer_arn" {
  value = aws_lb.main.arn
}

output "target_group_arn" {
  value = aws_lb_target_group.app.arn
}
