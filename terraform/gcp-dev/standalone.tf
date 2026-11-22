# A small VM that no load balancer serves, for a standalone workload (vision standalone workloads design; plan 5's acceptance):
# onboarded by its path (the output `standalone`), napped on its signals, a schedule or a person. No instance group, no startup
# script, no external address (as the demo VMs), no service account. Off by default (enable_standalone). No desired_status: an
# apply never starts it again once Dormeto stopped it (docs/scenarios/google-cloud-compute-engine.md's Terraform advice).
resource "google_compute_instance" "standalone" {
  count = var.enable_standalone ? 1 : 0

  name                      = "${local.demo}-standalone"
  zone                      = var.zone
  machine_type              = "e2-micro"
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

  lifecycle {
    # A newer Debian 12 image does not replace the VM between two measures.
    ignore_changes = [boot_disk[0].initialize_params[0].image]
  }
}
