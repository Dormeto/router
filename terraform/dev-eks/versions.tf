terraform {
  required_version = "~> 1.16.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.67"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 3.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.8"
    }
    # The eks-access module's provider; its manifests are not used here (apply_manifest = false).
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.38"
    }
  }

  backend "s3" {
    bucket       = "terraform-states-121014831971-eu-west-1-an"
    key          = "router/dev-eks.tfstate"
    region       = "eu-west-1"
    profile      = "kloudy-dormeto-prd"
    use_lockfile = true
    encrypt      = true
  }
}
