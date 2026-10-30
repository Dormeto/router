# The regional external Application Load Balancer, HTTP: http://regional.gcp.dev.dormeto.com/, for G0's comparison
# of the switch (spec section 2: the regional one if the global one switches too slowly). Its backend services use the
# demo VM's unmanaged group too: one instance group may serve several backend services, global and regional, when
# their balancing modes are compatible (README).
resource "google_compute_region_health_check" "demo" {
  name                = "${local.demo}-regional"
  region              = var.region
  check_interval_sec  = local.health_check.interval
  timeout_sec         = local.health_check.timeout
  healthy_threshold   = local.health_check.healthy
  unhealthy_threshold = local.health_check.unhealthy

  http_health_check {
    port         = 80
    request_path = "/"
  }
}

resource "google_compute_region_backend_service" "demo" {
  for_each = toset(["app", "standin"])

  name                  = "${local.demo}-regional-${each.key}"
  region                = var.region
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTP"
  port_name             = each.key
  health_checks         = [google_compute_region_health_check.demo.id]
  # The router's drain, as the global ones.
  connection_draining_timeout_sec = 30

  backend {
    group           = google_compute_instance_group.demo.self_link
    balancing_mode  = "UTILIZATION"
    capacity_scaler = 1
  }
}

resource "google_compute_region_url_map" "dev" {
  name            = "${local.name}-regional"
  region          = var.region
  default_service = google_compute_region_backend_service.demo["app"].id

  # Both backend services: a destroy deletes the map first, whichever it names.
  depends_on = [google_compute_region_backend_service.demo]

  lifecycle {
    # The service the measuring tool switches: the default service, or with `switch --weighted` the default route
    # action's weighted backend services; and what the router writes when it owns the map: its host rule and matcher.
    ignore_changes = [default_service, default_route_action, host_rule, path_matcher]
  }
}

resource "google_compute_region_target_http_proxy" "dev" {
  name    = "${local.name}-regional"
  region  = var.region
  url_map = google_compute_region_url_map.dev.id
}

resource "google_compute_address" "regional" {
  name         = "${local.name}-regional"
  region       = var.region
  network_tier = "STANDARD"
}

resource "google_compute_forwarding_rule" "regional" {
  name                  = "${local.name}-regional"
  region                = var.region
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_protocol           = "TCP"
  ip_address            = google_compute_address.regional.id
  port_range            = "80"
  target                = google_compute_region_target_http_proxy.dev.id
  network               = google_compute_network.dev.id
  network_tier          = "STANDARD"

  # The proxies need their subnet first.
  depends_on = [google_compute_subnetwork.proxy]
}
