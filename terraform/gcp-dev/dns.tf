resource "aws_route53_record" "gcp" {
  for_each = {
    (var.domain)            = google_compute_global_address.dev.address
    (local.mig_domain)      = google_compute_global_address.dev.address
    (local.regional_domain) = google_compute_address.regional.address
  }

  zone_id = var.zone_id
  name    = each.key
  type    = "A"
  ttl     = 60
  records = [each.value]
}
