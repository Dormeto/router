# The router's public image, one Artifact Registry repository per multi-region (europe, us, asia). Tags are immutable: a
# released version's image never changes. Anyone can pull: the one IAM change of the router's Terraform outside the CLI.
locals {
  locations = toset(["europe", "us", "asia"])
}

resource "google_artifact_registry_repository" "router" {
  for_each = local.locations

  location      = each.key
  repository_id = "router"
  format        = "DOCKER"
  description   = "The Dormeto router image, public."

  docker_config {
    immutable_tags = true
  }
}

resource "google_artifact_registry_repository_iam_member" "public_reader" {
  for_each = google_artifact_registry_repository.router

  location   = each.value.location
  repository = each.value.repository_id
  role       = "roles/artifactregistry.reader"
  member     = "allUsers"
}
