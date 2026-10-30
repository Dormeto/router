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

# The optional parts (null while their variable is false): what the measuring tool takes, and the addresses to probe.
output "optional" {
  value = {
    classic = {
      url      = one([for a in google_compute_global_address.classic : "http://${a.address}/"])
      url_map  = one(google_compute_url_map.classic[*].name)
      backends = { for k, s in google_compute_backend_service.classic : k => s.name }
    }
    neg = {
      url             = one([for a in google_compute_global_address.neg : "http://${a.address}/"])
      url_map         = one(google_compute_url_map.neg[*].name)
      backend_service = one(google_compute_backend_service.neg[*].name)
      group           = one(google_compute_network_endpoint_group.neg[*].name)
      instance        = one(google_compute_instance.neg[*].name)
    }
    sql = {
      instance = one(google_sql_database_instance.demo[*].name)
    }
    gke = {
      url             = one([for a in google_compute_global_address.gke : "http://${a.address}/"])
      url_map         = one(google_compute_url_map.gke[*].name)
      backend_service = one(google_compute_backend_service.gke[*].name)
      cluster         = one(google_container_cluster.demo[*].name)
    }
  }
}
