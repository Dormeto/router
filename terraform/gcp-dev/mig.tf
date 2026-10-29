# The managed group: two VMs from this template (no service account either), an autoscaler from 2 to 3.
resource "google_compute_instance_template" "demo_mig" {
  name_prefix  = "${local.demo}-mig-"
  machine_type = var.machine_type
  tags         = [local.demo]

  disk {
    source_image = "debian-cloud/debian-12"
    disk_type    = "pd-balanced"
    disk_size_gb = 10
    boot         = true
    auto_delete  = true
  }

  network_interface {
    subnetwork = google_compute_subnetwork.dev.id
  }

  metadata = {
    startup-script = local.startup_script
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "google_compute_instance_group_manager" "demo_mig" {
  name               = "${local.demo}-mig"
  zone               = var.zone
  base_instance_name = "${local.demo}-mig"

  # No target_size: the autoscaler sets it.
  version {
    instance_template = google_compute_instance_template.demo_mig.self_link_unique
  }

  named_port {
    name = "app"
    port = 80
  }
}

resource "google_compute_autoscaler" "demo_mig" {
  name   = "${local.demo}-mig"
  zone   = var.zone
  target = google_compute_instance_group_manager.demo_mig.id

  autoscaling_policy {
    min_replicas    = 2
    max_replicas    = 3
    cooldown_period = 60
    mode            = "ON"

    cpu_utilization {
      target = 0.6
    }
  }

  lifecycle {
    # The measuring tool (and later Dormeto) turns it off for a stop or suspend, and back on.
    ignore_changes = [autoscaling_policy[0].mode]
  }
}
