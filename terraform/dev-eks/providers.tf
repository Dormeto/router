provider "aws" {
  region              = var.region
  profile             = var.aws_profile
  allowed_account_ids = [var.account_id]

  default_tags {
    tags = { env = "dev", project = "dormeto-test-customer" }
  }
}

# Helm talks to the cluster with the caller's token (its access entry, main.tf). Its repositories are its own, under
# .terraform: the caller's Helm repositories are never read (one without a cached index fails every chart lookup).
provider "helm" {
  repository_config_path = "${path.module}/.terraform/helm/repositories.yaml"
  repository_cache       = "${path.module}/.terraform/helm/cache"

  kubernetes = {
    host                   = module.eks.cluster_endpoint
    cluster_ca_certificate = base64decode(module.eks.cluster_certificate_authority_data)
    exec = {
      api_version = "client.authentication.k8s.io/v1beta1"
      command     = "aws"
      args        = ["eks", "get-token", "--cluster-name", module.eks.cluster_name, "--region", var.region, "--profile", var.aws_profile]
    }
  }
}
