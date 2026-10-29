# Google's credentials come from the caller's environment, never from this code: GOOGLE_OAUTH_ACCESS_TOKEN set to
# gcloud's token for the dormeto-dev configuration (README).
provider "google" {
  project = var.project
  region  = var.region
  zone    = var.zone

  default_labels = {
    env     = "dev"
    project = "dormeto"
  }
}

# Route 53 only: the records of gcp.dev.dormeto.com.
provider "aws" {
  region              = var.aws_region
  profile             = var.aws_profile
  allowed_account_ids = [var.aws_account_id]

  default_tags {
    tags = {
      env     = "dev"
      project = "dormeto"
    }
  }
}
