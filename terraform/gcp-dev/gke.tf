# A zonal Standard GKE cluster with one e2-small node, for the measures of S6, and a backend service for the standalone
# NEG that gke-demo.yaml's Service makes (the NEG is Kubernetes', not Terraform's: the README attaches it). The node runs
# as the default compute service account, unchanged: no service_account here. Off by default (enable_gke).
resource "google_compute_subnetwork" "gke" {
  count = var.enable_gke ? 1 : 0

  name          = "${local.name}-gke"
  network       = google_compute_network.dev.id
  region        = var.region
  ip_cidr_range = "10.10.2.0/24"

  secondary_ip_range {
    range_name    = "pods"
    ip_cidr_range = "10.20.0.0/16"
  }

  secondary_ip_range {
    range_name    = "services"
    ip_cidr_range = "10.21.0.0/20"
  }
}

resource "google_container_cluster" "demo" {
  count = var.enable_gke ? 1 : 0

  name       = "${local.demo}-gke"
  location   = var.zone
  network    = google_compute_network.dev.id
  subnetwork = google_compute_subnetwork.gke[0].id

  # The node pool below is the only one.
  remove_default_node_pool = true
  initial_node_count       = 1
  deletion_protection      = false

  ip_allocation_policy {
    cluster_secondary_range_name  = "pods"
    services_secondary_range_name = "services"
  }

  # The router reaches the cluster by its DNS endpoint, with IAM and no VPC (spec section 8).
  control_plane_endpoints_config {
    dns_endpoint_config {
      allow_external_traffic = true
    }
  }

  # The Gateway of gke-demo.yaml (M10).
  gateway_api_config {
    channel = "CHANNEL_STANDARD"
  }
}

resource "google_container_node_pool" "demo" {
  count = var.enable_gke ? 1 : 0

  name       = "main"
  cluster    = google_container_cluster.demo[0].id
  location   = var.zone
  node_count = 1

  node_config {
    machine_type = "e2-small"
    disk_size_gb = 20
    # The firewall rule below targets it.
    tags = ["${local.demo}-gke"]
  }
}

# Google's health checkers to the pods' port (8080), through the nodes.
resource "google_compute_firewall" "gke" {
  count = var.enable_gke ? 1 : 0

  name          = "${local.name}-gke"
  network       = google_compute_network.dev.id
  direction     = "INGRESS"
  source_ranges = ["35.191.0.0/16", "130.211.0.0/22"]
  target_tags   = ["${local.demo}-gke"]

  allow {
    protocol = "tcp"
    ports    = ["8080"]
  }
}

resource "google_compute_health_check" "gke" {
  count = var.enable_gke ? 1 : 0

  name                = "${local.demo}-gke"
  check_interval_sec  = local.health_check.interval
  timeout_sec         = local.health_check.timeout
  healthy_threshold   = local.health_check.healthy
  unhealthy_threshold = local.health_check.unhealthy

  http_health_check {
    port_specification = "USE_SERVING_PORT"
    request_path       = "/"
  }
}

# The NEG `dmt-demo-gke` (one per zone of the nodes) is attached by hand after the manifest (README): the backends are
# the NEG's, not Terraform's.
resource "google_compute_backend_service" "gke" {
  count = var.enable_gke ? 1 : 0

  name                  = "${local.demo}-gke"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTP"
  health_checks         = [google_compute_health_check.gke[0].id]
  # The router's drain, as the others.
  connection_draining_timeout_sec = 30

  lifecycle {
    ignore_changes = [backend]
  }
}

resource "google_compute_url_map" "gke" {
  count = var.enable_gke ? 1 : 0

  name            = "${local.name}-gke"
  default_service = google_compute_backend_service.gke[0].id

  lifecycle {
    # What the measuring tool switches, and what the router writes when it owns the map.
    ignore_changes = [default_service, default_route_action, host_rule, path_matcher]
  }
}

resource "google_compute_target_http_proxy" "gke" {
  count = var.enable_gke ? 1 : 0

  name    = "${local.name}-gke"
  url_map = google_compute_url_map.gke[0].id
}

resource "google_compute_global_address" "gke" {
  count = var.enable_gke ? 1 : 0

  name = "${local.name}-gke"
}

resource "google_compute_global_forwarding_rule" "gke" {
  count = var.enable_gke ? 1 : 0

  name                  = "${local.name}-gke"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_protocol           = "TCP"
  ip_address            = google_compute_global_address.gke[0].id
  port_range            = "80"
  target                = google_compute_target_http_proxy.gke[0].id
}
