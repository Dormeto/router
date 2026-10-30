# A VM in a zonal network endpoint group (GCE_VM_IP_PORT) behind a global backend service, for the measures of S3: does a
# stopped VM keep its endpoint, and how it comes back healthy. A URL map of its own (the global one ignores its host
# rules, so a host added there would not be applied), with its proxy, address and forwarding rule on port 80:
# http://<address in the outputs>/. Off by default (enable_neg).
resource "google_compute_instance" "neg" {
  count = var.enable_neg ? 1 : 0

  name                      = "${local.demo}-neg"
  zone                      = var.zone
  machine_type              = var.machine_type
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

resource "google_compute_network_endpoint_group" "neg" {
  count = var.enable_neg ? 1 : 0

  name                  = "${local.demo}-neg"
  zone                  = var.zone
  network               = google_compute_network.dev.id
  subnetwork            = google_compute_subnetwork.dev.id
  network_endpoint_type = "GCE_VM_IP_PORT"
  default_port          = 80
}

resource "google_compute_network_endpoint" "neg" {
  count = var.enable_neg ? 1 : 0

  network_endpoint_group = google_compute_network_endpoint_group.neg[0].name
  zone                   = var.zone
  instance               = google_compute_instance.neg[0].name
  ip_address             = google_compute_instance.neg[0].network_interface[0].network_ip
  port                   = 80
}

resource "google_compute_backend_service" "neg" {
  count = var.enable_neg ? 1 : 0

  name                  = "${local.demo}-neg"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTP"
  health_checks         = [google_compute_health_check.demo.id]
  # The router's drain, as the others.
  connection_draining_timeout_sec = 30

  backend {
    group                 = google_compute_network_endpoint_group.neg[0].id
    balancing_mode        = "RATE"
    max_rate_per_endpoint = 100
  }

  # The endpoint first: a backend service on an empty group is healthy-less until it exists.
  depends_on = [google_compute_network_endpoint.neg]
}

resource "google_compute_url_map" "neg" {
  count = var.enable_neg ? 1 : 0

  name            = "${local.name}-neg"
  default_service = google_compute_backend_service.neg[0].id

  lifecycle {
    # What the measuring tool switches, and what the router writes when it owns the map.
    ignore_changes = [default_service, default_route_action, host_rule, path_matcher]
  }
}

resource "google_compute_target_http_proxy" "neg" {
  count = var.enable_neg ? 1 : 0

  name    = "${local.name}-neg"
  url_map = google_compute_url_map.neg[0].id
}

resource "google_compute_global_address" "neg" {
  count = var.enable_neg ? 1 : 0

  name = "${local.name}-neg"
}

resource "google_compute_global_forwarding_rule" "neg" {
  count = var.enable_neg ? 1 : 0

  name                  = "${local.name}-neg"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_protocol           = "TCP"
  ip_address            = google_compute_global_address.neg[0].id
  port_range            = "80"
  target                = google_compute_target_http_proxy.neg[0].id
}
