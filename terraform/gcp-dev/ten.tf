# Ten small workloads on one URL map (M4, the ten-workloads measure): ten VMs, each in its own unmanaged instance group
# with its own backend service, and a host rule ten-<n>.<domain> to it on a URL map of their own, behind an HTTP load
# balancer of its own. ten_map picks the kind: "global" (EXTERNAL_MANAGED) or "regional" (EXTERNAL_MANAGED, Standard
# tier). A map of their own, because the demo's maps ignore changes to their host rules (the router writes them), and a
# host rule added there would never be applied. Off by default (enable_ten). Hosts have no DNS record: the measure sends
# the Host header to the address.
locals {
  ten_ids      = var.enable_ten ? toset([for n in range(1, 11) : tostring(n)]) : toset([])
  ten_global   = var.enable_ten && var.ten_map == "global" ? local.ten_ids : toset([])
  ten_regional = var.enable_ten && var.ten_map == "regional" ? local.ten_ids : toset([])
  ten_machine  = var.machine_type
}

resource "google_compute_instance" "ten" {
  for_each = local.ten_ids

  name                      = "${local.demo}-ten-${each.key}"
  zone                      = var.zone
  machine_type              = local.ten_machine
  tags                      = [local.demo]
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

resource "google_compute_instance_group" "ten" {
  for_each = local.ten_ids

  name      = "${local.demo}-ten-${each.key}"
  zone      = var.zone
  network   = google_compute_network.dev.id
  instances = [google_compute_instance.ten[each.key].self_link]

  named_port {
    name = "app"
    port = 80
  }
}

# The global kind.
resource "google_compute_backend_service" "ten" {
  for_each = local.ten_global

  name                            = "${local.demo}-ten-${each.key}"
  load_balancing_scheme           = "EXTERNAL_MANAGED"
  protocol                        = "HTTP"
  port_name                       = "app"
  health_checks                   = [google_compute_health_check.demo.id]
  connection_draining_timeout_sec = 30

  backend {
    group           = google_compute_instance_group.ten[each.key].self_link
    balancing_mode  = "UTILIZATION"
    capacity_scaler = 1
  }
}

resource "google_compute_url_map" "ten" {
  count = length(local.ten_global) > 0 ? 1 : 0

  name            = "${local.name}-ten"
  default_service = google_compute_backend_service.ten["1"].id

  dynamic "host_rule" {
    for_each = local.ten_global
    content {
      hosts        = ["ten-${host_rule.key}.${var.domain}"]
      path_matcher = "ten-${host_rule.key}"
    }
  }

  dynamic "path_matcher" {
    for_each = local.ten_global
    content {
      name            = "ten-${path_matcher.key}"
      default_service = google_compute_backend_service.ten[path_matcher.key].id
    }
  }

  lifecycle {
    # What the measuring tool switches, and what the router writes when it owns the map.
    ignore_changes = [default_service, default_route_action, host_rule, path_matcher]
  }
}

resource "google_compute_target_http_proxy" "ten" {
  count = length(local.ten_global) > 0 ? 1 : 0

  name    = "${local.name}-ten"
  url_map = google_compute_url_map.ten[0].id
}

resource "google_compute_global_address" "ten" {
  count = length(local.ten_global) > 0 ? 1 : 0

  name = "${local.name}-ten"
}

resource "google_compute_global_forwarding_rule" "ten" {
  count = length(local.ten_global) > 0 ? 1 : 0

  name                  = "${local.name}-ten"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_protocol           = "TCP"
  ip_address            = google_compute_global_address.ten[0].id
  port_range            = "80"
  target                = google_compute_target_http_proxy.ten[0].id
}

# The regional kind (Standard tier, like regional.tf).
resource "google_compute_region_backend_service" "ten" {
  for_each = local.ten_regional

  name                            = "${local.demo}-ten-r-${each.key}"
  region                          = var.region
  load_balancing_scheme           = "EXTERNAL_MANAGED"
  protocol                        = "HTTP"
  port_name                       = "app"
  health_checks                   = [google_compute_region_health_check.demo.id]
  connection_draining_timeout_sec = 30

  backend {
    group           = google_compute_instance_group.ten[each.key].self_link
    balancing_mode  = "UTILIZATION"
    capacity_scaler = 1
  }
}

resource "google_compute_region_url_map" "ten" {
  count = length(local.ten_regional) > 0 ? 1 : 0

  name            = "${local.name}-ten-r"
  region          = var.region
  default_service = google_compute_region_backend_service.ten["1"].id

  dynamic "host_rule" {
    for_each = local.ten_regional
    content {
      hosts        = ["ten-${host_rule.key}.${var.domain}"]
      path_matcher = "ten-${host_rule.key}"
    }
  }

  dynamic "path_matcher" {
    for_each = local.ten_regional
    content {
      name            = "ten-${path_matcher.key}"
      default_service = google_compute_region_backend_service.ten[path_matcher.key].id
    }
  }

  lifecycle {
    ignore_changes = [default_service, default_route_action, host_rule, path_matcher]
  }
}

resource "google_compute_region_target_http_proxy" "ten" {
  count = length(local.ten_regional) > 0 ? 1 : 0

  name    = "${local.name}-ten-r"
  region  = var.region
  url_map = google_compute_region_url_map.ten[0].id
}

resource "google_compute_address" "ten" {
  count = length(local.ten_regional) > 0 ? 1 : 0

  name         = "${local.name}-ten-r"
  region       = var.region
  network_tier = "STANDARD"
}

resource "google_compute_forwarding_rule" "ten" {
  count = length(local.ten_regional) > 0 ? 1 : 0

  name                  = "${local.name}-ten-r"
  region                = var.region
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_protocol           = "TCP"
  ip_address            = google_compute_address.ten[0].id
  port_range            = "80"
  target                = google_compute_region_target_http_proxy.ten[0].id
  network               = google_compute_network.dev.id
  network_tier          = "STANDARD"

  # The proxies need their subnet first.
  depends_on = [google_compute_subnetwork.proxy]
}
