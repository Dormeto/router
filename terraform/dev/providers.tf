provider "aws" {
  region              = var.region
  profile             = var.aws_profile
  allowed_account_ids = [var.account_id]

  default_tags {
    tags = {
      env     = var.env
      project = "dormeto"
    }
  }
}
