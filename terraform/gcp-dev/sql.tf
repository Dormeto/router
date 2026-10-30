# A PostgreSQL instance for the measures of S5 (stop and start by the activation policy): the smallest shared-core, 10 GB
# on a hard disk, a public address and no authorized network, so no connection can be made to it. No user, no database.
# Off by default (enable_sql). Cloud SQL keeps an instance's name for about a week after its deletion: a second apply
# soon after a destroy is refused.
resource "google_sql_database_instance" "demo" {
  count = var.enable_sql ? 1 : 0

  name                = "${local.demo}-sql"
  region              = var.region
  database_version    = "POSTGRES_16"
  deletion_protection = false

  settings {
    tier                        = "db-f1-micro"
    edition                     = "ENTERPRISE"
    availability_type           = "ZONAL"
    disk_type                   = "PD_HDD"
    disk_size                   = 10
    disk_autoresize             = false
    deletion_protection_enabled = false

    ip_configuration {
      ipv4_enabled = true
    }

    backup_configuration {
      enabled = false
    }
  }

  lifecycle {
    # The measuring tool (and later Dormeto) stops and starts it with the activation policy.
    ignore_changes = [settings[0].activation_policy]
  }
}
