# A cluster's Kubernetes proxy (vision docs/specs/2026-10-24-private-eks-endpoints-design.md, section 4), checked at plan
# time against mock providers (tfenv exec test, no AWS call). The names follow the rule of lambda/src/lib/kube-proxy-name.mjs,
# pinned by lambda/test/fixtures/kube-proxy-names.json.
mock_provider "aws" {
  mock_data "aws_partition" {
    defaults = { partition = "aws" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  mock_data "aws_region" {
    defaults = { region = "eu-west-1" }
  }
  mock_data "aws_eks_cluster" {
    defaults = {
      endpoint              = "https://ABCDEF.gr7.eu-west-1.eks.amazonaws.com"
      certificate_authority = [{ data = "Q0E=" }]
      vpc_config = [{
        subnet_ids                = ["subnet-aaa", "subnet-bbb"]
        vpc_id                    = "vpc-123"
        cluster_security_group_id = "sg-cluster"
      }]
    }
  }
}
mock_provider "archive" {}

variables {
  router_name       = "dmt-dev"
  lambda_source_dir = "../../../lambda/src"
  cluster_name      = "prod"
  router_version    = "0.33.0"
}

run "a_short_cluster_name_is_kept_and_the_proxy_runs_in_the_clusters_vpc" {
  command = plan
  assert {
    condition     = aws_lambda_function.proxy.function_name == "dmt-dev-kube-prod" && aws_security_group.proxy[0].name == "dmt-dev-kube-prod" && aws_iam_role.proxy.name == "dmt-dev-eu-west-1-kube-prod"
    error_message = "function and security group <router>-kube-<cluster>, role <router>-<region>-kube-<cluster>"
  }
  assert {
    condition     = aws_lambda_function.proxy.handler == "kube-proxy.handler" && aws_lambda_function.proxy.runtime == "nodejs24.x" && aws_lambda_function.proxy.architectures == tolist(["arm64"]) && aws_lambda_function.proxy.memory_size == 128 && aws_lambda_function.proxy.timeout == 15
    error_message = "the router's runtime, arm64, 128 MB, 15 seconds"
  }
  assert {
    condition     = aws_lambda_function.proxy.environment[0].variables.DMT_CLUSTER == "prod" && aws_lambda_function.proxy.environment[0].variables.DMT_ENDPOINT == "https://ABCDEF.gr7.eu-west-1.eks.amazonaws.com" && aws_lambda_function.proxy.environment[0].variables.DMT_CA == "Q0E=" && aws_lambda_function.proxy.environment[0].variables.DMT_VERSION == "0.33.0"
    error_message = "the cluster, its endpoint and certificate authority, the version"
  }
  assert {
    condition     = toset(aws_lambda_function.proxy.vpc_config[0].subnet_ids) == toset(["subnet-aaa", "subnet-bbb"])
    error_message = "the cluster's subnets"
  }
  assert {
    condition     = aws_cloudwatch_log_group.proxy.name == "/aws/lambda/dmt-dev-kube-prod" && aws_cloudwatch_log_group.proxy.retention_in_days == 14
    error_message = "the function's log group"
  }
  assert {
    condition     = aws_lambda_function.proxy.tags == tomap({ "dormeto:role" = "kubernetes-proxy", "dormeto:cluster" = "prod" }) && aws_security_group.proxy[0].tags == tomap({ "dormeto:role" = "kubernetes-proxy", "dormeto:cluster" = "prod" })
    error_message = "tags"
  }
}

run "its_own_group_only_reaches_the_cluster_security_group_on_443_and_is_admitted_there" {
  command = plan
  assert {
    condition     = length(aws_security_group.proxy) == 1 && aws_security_group.proxy[0].vpc_id == "vpc-123"
    error_message = "a security group of its own, in the cluster's VPC"
  }
  assert {
    condition     = length(aws_vpc_security_group_egress_rule.proxy) == 1 && aws_vpc_security_group_egress_rule.proxy[0].referenced_security_group_id == "sg-cluster" && aws_vpc_security_group_egress_rule.proxy[0].ip_protocol == "tcp" && aws_vpc_security_group_egress_rule.proxy[0].from_port == 443 && aws_vpc_security_group_egress_rule.proxy[0].to_port == 443
    error_message = "the only egress: TCP 443 to the cluster security group"
  }
  assert {
    condition     = length(aws_vpc_security_group_ingress_rule.cluster) == 1 && aws_vpc_security_group_ingress_rule.cluster[0].security_group_id == "sg-cluster" && aws_vpc_security_group_ingress_rule.cluster[0].ip_protocol == "tcp" && aws_vpc_security_group_ingress_rule.cluster[0].from_port == 443 && aws_vpc_security_group_ingress_rule.cluster[0].to_port == 443
    error_message = "the cluster security group admits TCP 443 from the proxy's"
  }
}

run "a_long_cluster_name_is_cut_with_its_hash" {
  command = plan
  variables {
    cluster_name = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx-first-variant-of-a-long-cluster-name"
    router_name  = "dmtr-dev"
  }
  assert {
    condition     = aws_lambda_function.proxy.function_name == "dmtr-dev-kube-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx-d069a213" && length(aws_lambda_function.proxy.function_name) == 64
    error_message = "the fixture's name, 64 characters"
  }
  assert {
    condition     = aws_lambda_function.proxy.function_name == aws_security_group.proxy[0].name && length(aws_iam_role.proxy.name) <= 64 && endswith(aws_iam_role.proxy.name, substr(sha256(var.cluster_name), 0, 8))
    error_message = "the group follows the function, the role the same rule, all ending with the hash"
  }
}

run "the_fixtures_long_name_case" {
  command = plan
  variables {
    router_name  = "dmtr-dev"
    cluster_name = "Zaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
  assert {
    condition     = aws_lambda_function.proxy.function_name == "dmtr-dev-kube-Zaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-8583fe6d"
    error_message = "the fixture's name for this prefix and cluster"
  }
  assert {
    condition     = aws_iam_role.proxy.name == "dmtr-dev-eu-west-1-kube-Zaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-8583fe6d"
    error_message = "the fixture's name for the role's prefix"
  }
}

run "given_security_groups_are_used_and_none_is_made" {
  command = plan
  variables {
    security_group_ids = ["sg-given"]
    subnet_ids         = ["subnet-ccc"]
    log_retention_days = 3
  }
  assert {
    condition     = length(aws_security_group.proxy) == 0 && length(aws_vpc_security_group_egress_rule.proxy) == 0 && length(aws_vpc_security_group_ingress_rule.cluster) == 0
    error_message = "neither a group nor its rules"
  }
  assert {
    condition     = toset(aws_lambda_function.proxy.vpc_config[0].security_group_ids) == toset(["sg-given"]) && toset(aws_lambda_function.proxy.vpc_config[0].subnet_ids) == toset(["subnet-ccc"])
    error_message = "the given groups and subnets"
  }
  assert {
    condition     = aws_cloudwatch_log_group.proxy.retention_in_days == 3
    error_message = "log retention"
  }
}
