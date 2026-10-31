# A classic external Application Load Balancer (load balancing scheme EXTERNAL), HTTP only, on the demo VM's group:
# http://<its address>/ (the README reads it with gcloud), for the measures of the swap (the classic one has no custom error response).
# Off by default (enable_classic). The backend services balance by utilization like every other of the group.
resource "google_compute_backend_service" "classic" {
  for_each = var.enable_classic ? toset(["app", "standin"]) : toset([])

  name                  = "${local.demo}-classic-${each.key}"
  load_balancing_scheme = "EXTERNAL"
  protocol              = "HTTP"
  port_name             = each.key
  health_checks         = [google_compute_health_check.demo.id]
  # The router's drain, as the others.
  connection_draining_timeout_sec = 30

  backend {
    group           = google_compute_instance_group.demo.self_link
    balancing_mode  = "UTILIZATION"
    capacity_scaler = 1
  }
}

resource "google_compute_url_map" "classic" {
  count = var.enable_classic ? 1 : 0

  name            = "${local.name}-classic"
  default_service = google_compute_backend_service.classic["app"].id

  # Both backend services: a destroy deletes the map first, whichever it names.
  depends_on = [google_compute_backend_service.classic]

  lifecycle {
    # What the measuring tool switches, and what the router writes when it owns the map.
    ignore_changes = [default_service, default_route_action, host_rule, path_matcher]
  }
}

resource "google_compute_target_http_proxy" "classic" {
  count = var.enable_classic ? 1 : 0

  name    = "${local.name}-classic"
  url_map = google_compute_url_map.classic[0].id
}

resource "google_compute_global_address" "classic" {
  count = var.enable_classic ? 1 : 0

  name = "${local.name}-classic"
}

resource "google_compute_global_forwarding_rule" "classic" {
  count = var.enable_classic ? 1 : 0

  name                  = "${local.name}-classic"
  load_balancing_scheme = "EXTERNAL"
  ip_protocol           = "TCP"
  ip_address            = google_compute_global_address.classic[0].id
  port_range            = "80"
  target                = google_compute_target_http_proxy.classic[0].id
}
