# The global external Application Load Balancer: https://gcp.dev.dormeto.com/ to the demo VM's app (or its stand-in,
# when the measuring tool switches it), https://mig.gcp.dev.dormeto.com/ to the managed group.
resource "google_compute_health_check" "demo" {
  name                = local.demo
  check_interval_sec  = local.health_check.interval
  timeout_sec         = local.health_check.timeout
  healthy_threshold   = local.health_check.healthy
  unhealthy_threshold = local.health_check.unhealthy

  http_health_check {
    port         = 80
    request_path = "/"
  }
}

locals {
  # Every backend balances by utilization: an instance group behind several backend services needs compatible modes.
  global_backends = {
    app     = { name = "${local.demo}-app", port = "app", group = google_compute_instance_group.demo.self_link }
    standin = { name = "${local.demo}-standin", port = "standin", group = google_compute_instance_group.demo.self_link }
    mig_app = { name = "${local.demo}-mig-app", port = "app", group = google_compute_instance_group_manager.demo_mig.instance_group }
  }
}

resource "google_compute_backend_service" "demo" {
  for_each = local.global_backends

  name                  = each.value.name
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTP"
  port_name             = each.value.port
  health_checks         = [google_compute_health_check.demo.id]
  # The router's drain (Google's default is 300 s, which a managed group's stop or suspend waits for: README).
  connection_draining_timeout_sec = 30

  backend {
    group           = each.value.group
    balancing_mode  = "UTILIZATION"
    capacity_scaler = 1
  }
}

resource "google_compute_url_map" "dev" {
  name            = local.name
  default_service = google_compute_backend_service.demo["app"].id

  # Every backend service, the stand-in included: a destroy deletes the map first, whichever service it names.
  depends_on = [google_compute_backend_service.demo]

  host_rule {
    hosts        = [var.domain]
    path_matcher = "app"
  }

  host_rule {
    hosts        = [local.mig_domain]
    path_matcher = "mig"
  }

  path_matcher {
    name            = "app"
    default_service = google_compute_backend_service.demo["app"].id
  }

  path_matcher {
    name            = "mig"
    default_service = google_compute_backend_service.demo["mig_app"].id
  }

  lifecycle {
    # The services the measuring tool (and later Dormeto) switches: as default services, or with `switch --weighted` in
    # the default route actions' weighted backend services (only one of the two can be set).
    ignore_changes = [
      default_service,
      default_route_action,
      path_matcher[0].default_service,
      path_matcher[0].default_route_action,
      path_matcher[1].default_service,
      path_matcher[1].default_route_action,
    ]
  }
}

# Google-managed: active once both names resolve to the address (15 to 60 minutes after the apply).
resource "google_compute_managed_ssl_certificate" "dev" {
  name = local.name

  managed {
    domains = [var.domain, local.mig_domain]
  }
}

resource "google_compute_target_https_proxy" "dev" {
  name             = local.name
  url_map          = google_compute_url_map.dev.id
  ssl_certificates = [google_compute_managed_ssl_certificate.dev.id]
}

resource "google_compute_global_address" "dev" {
  name = local.name
}

resource "google_compute_global_forwarding_rule" "dev" {
  name                  = local.name
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_protocol           = "TCP"
  ip_address            = google_compute_global_address.dev.id
  port_range            = "443"
  target                = google_compute_target_https_proxy.dev.id
}
