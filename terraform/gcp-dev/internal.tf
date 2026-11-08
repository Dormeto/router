# Internal Application Load Balancers (G5, spec part N): a regional one (INTERNAL_MANAGED, regional URL map and
# forwarding rule) and a cross-region one (INTERNAL_MANAGED, global URL map, a global forwarding rule that takes a
# subnet), each in front of a small VM of its own in an unmanaged group (not the demo VM: Dormeto naps that one), over
# HTTP. No client VM: the measures reach both from a Cloud Run job with Direct VPC egress (README). The regional load
# balancer uses the proxy-only subnet network.tf already holds (REGIONAL_MANAGED_PROXY: one active per purpose, region
# and network), or, when internal_region names another region, a subnet and a proxy-only subnet of that region
# (network.tf) with a VM in its zone `-b` and a health check of its own; the cross-region one needs a
# GLOBAL_MANAGED_PROXY subnet, built here, and stays in var.region. Their URL maps ignore what Dormeto writes. Off by
# default (enable_internal).
locals {
  internal_tag = "${local.demo}-internal"
  # The regional load balancer's region: var.internal_region, or the demo's.
  internal_region = var.internal_region != null ? var.internal_region : var.region
  # True when that is another region (and the load balancers are on): its own subnets, zone and health check.
  internal_other = var.enable_internal && local.internal_region != var.region
  internal_zone  = local.internal_other ? "${local.internal_region}-b" : var.zone
  # The regional load balancer's subnet and health check: the demo's own, or the other region's.
  internal_subnet       = local.internal_other ? google_compute_subnetwork.dev_internal[0].id : google_compute_subnetwork.dev.id
  internal_health_check = local.internal_other ? google_compute_region_health_check.internal[0].id : google_compute_region_health_check.demo.id
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

# Google's health checkers and the proxies (the other region's too), to the internal VMs' port 80.
resource "google_compute_firewall" "internal" {
  count = var.enable_internal ? 1 : 0

  name          = "${local.name}-internal"
  network       = google_compute_network.dev.id
  direction     = "INGRESS"
  source_ranges = concat(["35.191.0.0/16", "130.211.0.0/22", google_compute_subnetwork.proxy.ip_cidr_range, google_compute_subnetwork.proxy_global[0].ip_cidr_range], local.internal_other ? [google_compute_subnetwork.proxy_internal[0].ip_cidr_range] : [])
  target_tags   = [local.internal_tag]

  allow {
    protocol = "tcp"
    ports    = ["80"]
  }
}

resource "google_compute_instance" "internal" {
  for_each = var.enable_internal ? toset(["regional", "global"]) : toset([])

  name                      = "${local.demo}-internal-${each.key}"
  zone                      = each.key == "regional" ? local.internal_zone : var.zone
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
    subnetwork = each.key == "regional" ? local.internal_subnet : google_compute_subnetwork.dev.id
  }

  metadata = {
    startup-script = local.startup_script
  }

  lifecycle {
    ignore_changes = [boot_disk[0].initialize_params[0].image]
  }
}

resource "google_compute_instance_group" "internal" {
  for_each = var.enable_internal ? toset(["regional", "global"]) : toset([])

  name      = "${local.demo}-internal-${each.key}"
  zone      = each.key == "regional" ? local.internal_zone : var.zone
  network   = google_compute_network.dev.id
  instances = [google_compute_instance.internal[each.key].self_link]

  named_port {
    name = "app"
    port = 80
  }
}

# The regional kind. In another region it has a health check of its own (a regional one is the region's).
resource "google_compute_region_health_check" "internal" {
  count = local.internal_other ? 1 : 0

  name                = "${local.demo}-internal"
  region              = local.internal_region
  check_interval_sec  = local.health_check.interval
  timeout_sec         = local.health_check.timeout
  healthy_threshold   = local.health_check.healthy
  unhealthy_threshold = local.health_check.unhealthy

  http_health_check {
    port         = 80
    request_path = "/"
  }
}

resource "google_compute_region_backend_service" "internal_regional" {
  count = var.enable_internal ? 1 : 0

  name                            = "${local.demo}-internal-regional"
  region                          = local.internal_region
  load_balancing_scheme           = "INTERNAL_MANAGED"
  protocol                        = "HTTP"
  port_name                       = "app"
  health_checks                   = [local.internal_health_check]
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
  region          = local.internal_region
  default_service = google_compute_region_backend_service.internal_regional[0].id

  lifecycle {
    ignore_changes = [default_service, default_route_action, host_rule, path_matcher]
  }
}

resource "google_compute_region_target_http_proxy" "internal" {
  count = var.enable_internal ? 1 : 0

  name    = "${local.name}-internal-regional"
  region  = local.internal_region
  url_map = google_compute_region_url_map.internal[0].id
}

resource "google_compute_forwarding_rule" "internal" {
  count = var.enable_internal ? 1 : 0

  name                  = "${local.name}-internal-regional"
  region                = local.internal_region
  load_balancing_scheme = "INTERNAL_MANAGED"
  ip_protocol           = "TCP"
  port_range            = "80"
  target                = google_compute_region_target_http_proxy.internal[0].id
  network               = google_compute_network.dev.id
  subnetwork            = local.internal_subnet

  # The proxies need their subnet first.
  depends_on = [google_compute_subnetwork.proxy, google_compute_subnetwork.proxy_internal]
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
