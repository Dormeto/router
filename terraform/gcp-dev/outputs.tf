output "urls" {
  description = "The demo's addresses: the VM's app (global), the managed group's (global), the VM's app (regional)."
  value = {
    vm       = "https://${var.domain}/"
    mig      = "https://${local.mig_domain}/"
    regional = "http://${local.regional_domain}/"
  }
}

output "addresses" {
  value = {
    global   = google_compute_global_address.dev.address
    regional = google_compute_address.regional.address
  }
}

output "url_maps" {
  description = "What `node gcp/tools/measure.mjs switch` switches: --url-map, and --region for the regional one."
  value = {
    global   = google_compute_url_map.dev.name
    regional = google_compute_region_url_map.dev.name
  }
}

output "backend_services" {
  value = {
    global   = { for k, s in google_compute_backend_service.demo : k => s.name }
    regional = { for k, s in google_compute_region_backend_service.demo : k => s.name }
  }
}
