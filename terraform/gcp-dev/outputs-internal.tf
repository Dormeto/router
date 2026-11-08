# What the measures of the internal load balancers need; null (so not stored, not shown in a plan) unless enable_internal.
output "internal" {
  description = "Each internal load balancer's URL map and address, and the client VM (gcloud compute ssh --tunnel-through-iap)."
  value = var.enable_internal ? {
    regional = {
      url_map = google_compute_region_url_map.internal[0].name
      region  = var.region
      address = google_compute_forwarding_rule.internal[0].ip_address
    }
    cross_region = {
      url_map = google_compute_url_map.internal[0].name
      address = google_compute_global_forwarding_rule.internal[0].ip_address
    }
    client = {
      name = google_compute_instance.internal_client[0].name
      zone = var.zone
    }
  } : null
}
