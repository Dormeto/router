# A classic external Application Load Balancer on the Standard network tier (M1): the same HTTP map as classic.tf, but
# with a regional external address and a regional forwarding rule that targets the global HTTP proxy (Google's Standard
# tier for the classic Application Load Balancer). Off by default (enable_classic_standard). Its backend services balance
# by utilization like every other of the group, and it is a load balancer of its own: classic.tf is left as it is.
resource "google_compute_backend_service" "classic_standard" {
  for_each = var.enable_classic_standard ? toset(["app", "standin"]) : toset([])

  name                  = "${local.demo}-classic-std-${each.key}"
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

resource "google_compute_url_map" "classic_standard" {
  count = var.enable_classic_standard ? 1 : 0

  name            = "${local.name}-classic-std"
  default_service = google_compute_backend_service.classic_standard["app"].id

  # Both backend services: a destroy deletes the map first, whichever it names.
  depends_on = [google_compute_backend_service.classic_standard]

  lifecycle {
    # What the measuring tool switches, and what the router writes when it owns the map.
    ignore_changes = [default_service, default_route_action, host_rule, path_matcher]
  }
}

resource "google_compute_target_http_proxy" "classic_standard" {
  count = var.enable_classic_standard ? 1 : 0

  name    = "${local.name}-classic-std"
  url_map = google_compute_url_map.classic_standard[0].id
}

resource "google_compute_address" "classic_standard" {
  count = var.enable_classic_standard ? 1 : 0

  name         = "${local.name}-classic-std"
  region       = var.region
  network_tier = "STANDARD"
}

resource "google_compute_forwarding_rule" "classic_standard" {
  count = var.enable_classic_standard ? 1 : 0

  name                  = "${local.name}-classic-std"
  region                = var.region
  load_balancing_scheme = "EXTERNAL"
  ip_protocol           = "TCP"
  ip_address            = google_compute_address.classic_standard[0].id
  port_range            = "80"
  target                = google_compute_target_http_proxy.classic_standard[0].id
  network_tier          = "STANDARD"
}
