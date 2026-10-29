resource "google_compute_network" "dev" {
  name                    = local.name
  auto_create_subnetworks = false
}

# The VMs: no external address, no NAT (they install nothing; the load balancers reach them).
resource "google_compute_subnetwork" "dev" {
  name          = local.name
  network       = google_compute_network.dev.id
  region        = var.region
  ip_cidr_range = "10.10.0.0/24"
}

# The regional external Application Load Balancer's proxies.
resource "google_compute_subnetwork" "proxy" {
  name          = "${local.name}-proxy"
  network       = google_compute_network.dev.id
  region        = var.region
  ip_cidr_range = "10.10.1.0/24"
  purpose       = "REGIONAL_MANAGED_PROXY"
  role          = "ACTIVE"
}

# Google's front ends and health checkers, and the regional load balancer's proxies, to the demo's two ports.
resource "google_compute_firewall" "demo" {
  name          = "${local.name}-demo"
  network       = google_compute_network.dev.id
  direction     = "INGRESS"
  source_ranges = ["35.191.0.0/16", "130.211.0.0/22", google_compute_subnetwork.proxy.ip_cidr_range]
  target_tags   = [local.demo]

  allow {
    protocol = "tcp"
    ports    = ["80", "8080"]
  }
}
