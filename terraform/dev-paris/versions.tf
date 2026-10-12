terraform {
  required_version = "~> 1.16.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.67"
    }
  }

  backend "s3" {
    bucket       = "terraform-states-121014831971-eu-west-1-an"
    key          = "router/dev-paris.tfstate"
    region       = "eu-west-1"
    profile      = "kloudy-dormeto-prd"
    use_lockfile = true
    encrypt      = true
  }
}
