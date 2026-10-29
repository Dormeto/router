# The demo VM, in an unmanaged instance group. Like every VM of this root it runs without a service account: attaching
# one is an IAM grant, and IAM changes go through the Dormeto CLI only (gcp/test/gcp-dev.test.mjs checks it).
resource "google_compute_instance" "demo" {
  name                      = local.demo
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
    # A newer Debian 12 image does not replace the VM between two measures.
    ignore_changes = [boot_disk[0].initialize_params[0].image]
  }
}

resource "google_compute_instance_group" "demo" {
  name      = local.demo
  zone      = var.zone
  network   = google_compute_network.dev.id
  instances = [google_compute_instance.demo.self_link]

  named_port {
    name = "app"
    port = 80
  }

  named_port {
    name = "standin"
    port = 8080
  }
}
