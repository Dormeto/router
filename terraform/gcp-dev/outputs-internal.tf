# What the measures of the internal load balancers need; null (so not stored, not shown in a plan) unless enable_internal.
output "internal" {
  description = "Each internal load balancer's URL map and address, and the regional one's region."
  value = var.enable_internal ? {
    regional = {
      url_map = google_compute_region_url_map.internal[0].name
      region  = local.internal_region
      address = google_compute_forwarding_rule.internal[0].ip_address
    }
    cross_region = {
      url_map = google_compute_url_map.internal[0].name
      address = google_compute_global_forwarding_rule.internal[0].ip_address
    }
  } : null
}
