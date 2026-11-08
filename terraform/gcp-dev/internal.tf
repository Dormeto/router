# Internal Application Load Balancers (G5, spec part N): a regional one (INTERNAL_MANAGED, regional URL map and
# forwarding rule) and a cross-region one (INTERNAL_MANAGED, global URL map, a global forwarding rule that takes a
# subnet), each in front of a small VM of its own in an unmanaged group (not the demo VM: Dormeto naps that one), over
# HTTP. A client VM in the subnet, with no external address, reaches both: the measures log in with
# `gcloud compute ssh --tunnel-through-iap` (a firewall rule admits IAP's TCP forwarding range to port 22; no IAM
# change). The regional load balancer uses the proxy-only subnet network.tf already holds (REGIONAL_MANAGED_PROXY: one
# active per purpose, region and network); the cross-region one needs a GLOBAL_MANAGED_PROXY subnet, built here. Their
# URL maps ignore what Dormeto writes. Off by default (enable_internal).
locals {
  internal_tag = "${local.demo}-internal"
  client_tag   = "${local.demo}-client"
}

resource "google_compute_subnetwork" "proxy_global" {
  count = var.enable_internal ? 1 : 0

  name          = "${local.name}-proxy-global"
  network       = google_compute_network.dev.id
  region        = var.region
  ip_cidr_range = "10.10.3.0/24"
  purpose       = "GLOBAL_MANAGED_PROXY"
  role          = "ACTIVE"
}

# Google's health checkers and both kinds of proxies, to the internal VMs' port 80.
resource "google_compute_firewall" "internal" {
  count = var.enable_internal ? 1 : 0

  name          = "${local.name}-internal"
  network       = google_compute_network.dev.id
  direction     = "INGRESS"
  source_ranges = ["35.191.0.0/16", "130.211.0.0/22", google_compute_subnetwork.proxy.ip_cidr_range, google_compute_subnetwork.proxy_global[0].ip_cidr_range]
  target_tags   = [local.internal_tag]

  allow {
    protocol = "tcp"
    ports    = ["80"]
  }
}

# IAP's TCP forwarding range to the client VM's SSH port.
resource "google_compute_firewall" "internal_client" {
  count = var.enable_internal ? 1 : 0

  name          = "${local.name}-internal-client"
  network       = google_compute_network.dev.id
  direction     = "INGRESS"
  source_ranges = ["35.235.240.0/20"]
  target_tags   = [local.client_tag]

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}

resource "google_compute_instance" "internal" {
  for_each = var.enable_internal ? toset(["regional", "global"]) : toset([])

  name                      = "${local.demo}-internal-${each.key}"
  zone                      = var.zone
  machine_type              = var.machine_type
  tags                      = [local.internal_tag]
  allow_stopping_for_update = true

  boot_disk {
    initialize_params {
      image = "debian-cloud/debian-12"
      type  = "pd-balanced"
      size  = 10
    }
  }

  network_interface {
    subnetwork = google_compute_subnetwork.dev.id
  }

  metadata = {
    startup-script = local.startup_script
  }

  lifecycle {
    ignore_changes = [boot_disk[0].initialize_params[0].image]
  }
}

# The client: no external address, no service account, nothing to install (Debian 12 has curl).
resource "google_compute_instance" "internal_client" {
  count = var.enable_internal ? 1 : 0

  name                      = "${local.demo}-internal-client"
  zone                      = var.zone
  machine_type              = var.machine_type
  tags                      = [local.client_tag]
  allow_stopping_for_update = true

  boot_disk {
    initialize_params {
      image = "debian-cloud/debian-12"
      type  = "pd-balanced"
      size  = 10
    }
  }

  network_interface {
    subnetwork = google_compute_subnetwork.dev.id
  }

  metadata = {
    startup-script = "#!/bin/bash\n# Dormeto demo (terraform/gcp-dev): the client of the internal load balancers; the measures run curl on it.\ncommand -v curl >/dev/null\n"
  }

  lifecycle {
    ignore_changes = [boot_disk[0].initialize_params[0].image]
  }
}

resource "google_compute_instance_group" "internal" {
  for_each = var.enable_internal ? toset(["regional", "global"]) : toset([])

  name      = "${local.demo}-internal-${each.key}"
  zone      = var.zone
  network   = google_compute_network.dev.id
  instances = [google_compute_instance.internal[each.key].self_link]

  named_port {
    name = "app"
    port = 80
  }
}

# The regional kind.
resource "google_compute_region_backend_service" "internal_regional" {
  count = var.enable_internal ? 1 : 0

  name                            = "${local.demo}-internal-regional"
  region                          = var.region
  load_balancing_scheme           = "INTERNAL_MANAGED"
  protocol                        = "HTTP"
  port_name                       = "app"
  health_checks                   = [google_compute_region_health_check.demo.id]
  connection_draining_timeout_sec = 30

  backend {
    group           = google_compute_instance_group.internal["regional"].self_link
    balancing_mode  = "UTILIZATION"
    capacity_scaler = 1
  }
}

resource "google_compute_region_url_map" "internal" {
  count = var.enable_internal ? 1 : 0

  name            = "${local.name}-internal-regional"
  region          = var.region
  default_service = google_compute_region_backend_service.internal_regional[0].id

  lifecycle {
    ignore_changes = [default_service, default_route_action, host_rule, path_matcher]
  }
}

resource "google_compute_region_target_http_proxy" "internal" {
  count = var.enable_internal ? 1 : 0

  name    = "${local.name}-internal-regional"
  region  = var.region
  url_map = google_compute_region_url_map.internal[0].id
}

resource "google_compute_forwarding_rule" "internal" {
  count = var.enable_internal ? 1 : 0

  name                  = "${local.name}-internal-regional"
  region                = var.region
  load_balancing_scheme = "INTERNAL_MANAGED"
  ip_protocol           = "TCP"
  port_range            = "80"
  target                = google_compute_region_target_http_proxy.internal[0].id
  network               = google_compute_network.dev.id
  subnetwork            = google_compute_subnetwork.dev.id

  # The proxies need their subnet first.
  depends_on = [google_compute_subnetwork.proxy]
}

# The cross-region kind.
resource "google_compute_backend_service" "internal_global" {
  count = var.enable_internal ? 1 : 0

  name                            = "${local.demo}-internal-global"
  load_balancing_scheme           = "INTERNAL_MANAGED"
  protocol                        = "HTTP"
  port_name                       = "app"
  health_checks                   = [google_compute_health_check.demo.id]
  connection_draining_timeout_sec = 30

  backend {
    group           = google_compute_instance_group.internal["global"].self_link
    balancing_mode  = "UTILIZATION"
    capacity_scaler = 1
  }
}

resource "google_compute_url_map" "internal" {
  count = var.enable_internal ? 1 : 0

  name            = "${local.name}-internal-global"
  default_service = google_compute_backend_service.internal_global[0].id

  lifecycle {
    ignore_changes = [default_service, default_route_action, host_rule, path_matcher]
  }
}

resource "google_compute_target_http_proxy" "internal" {
  count = var.enable_internal ? 1 : 0

  name    = "${local.name}-internal-global"
  url_map = google_compute_url_map.internal[0].id
}

resource "google_compute_global_forwarding_rule" "internal" {
  count = var.enable_internal ? 1 : 0

  name                  = "${local.name}-internal-global"
  load_balancing_scheme = "INTERNAL_MANAGED"
  ip_protocol           = "TCP"
  port_range            = "80"
  target                = google_compute_target_http_proxy.internal[0].id
  network               = google_compute_network.dev.id
  subnetwork            = google_compute_subnetwork.dev.id

  depends_on = [google_compute_subnetwork.proxy_global]
}
