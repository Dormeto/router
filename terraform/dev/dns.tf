resource "aws_acm_certificate" "demo" {
  domain_name       = local.domain
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "certificate_validation" {
  for_each = { for o in aws_acm_certificate.demo.domain_validation_options : o.domain_name => o }

  zone_id         = var.zone_id
  name            = each.value.resource_record_name
  type            = each.value.resource_record_type
  records         = [each.value.resource_record_value]
  ttl             = 60
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "demo" {
  certificate_arn         = aws_acm_certificate.demo.arn
  validation_record_fqdns = [for r in aws_route53_record.certificate_validation : r.fqdn]
}

resource "aws_route53_record" "demo" {
  zone_id = var.zone_id
  name    = local.domain
  type    = "A"

  alias {
    name                   = aws_lb.demo.dns_name
    zone_id                = aws_lb.demo.zone_id
    evaluate_target_health = false
  }
}
