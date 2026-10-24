# A Kubernetes proxy for a cluster whose endpoint the router cannot reach from outside (vision
# docs/specs/2026-10-24-private-eks-endpoints-design.md, sections 4 and 6), for a router written in Terraform: a small
# Lambda function in the cluster's VPC, the router's own handler kube-proxy.handler, that relays the router's and
# discovery's calls to the cluster's API. The manager makes the same function with API calls for the routers it installs.
data "aws_partition" "current" {}
data "aws_region" "current" {}

data "aws_eks_cluster" "this" {
  name = var.cluster_name
}

data "aws_vpc" "cluster" {
  id = data.aws_eks_cluster.this.vpc_config[0].vpc_id
}

locals {
  # One rule for the router, the manager and this module (lambda/src/lib/kube-proxy-name.mjs, pinned by
  # lambda/test/fixtures/kube-proxy-names.json): the cluster's name when the prefix and it fit in 64 characters (Lambda's
  # limit), else its first characters, a hyphen and the first 8 hexadecimal characters of its SHA-256.
  hash          = substr(sha256(var.cluster_name), 0, 8)
  function_name = "${var.router_name}-kube-${local.part_function}"
  role_name     = "${var.router_name}-${data.aws_region.current.region}-kube-${local.part_role}"

  function_prefix = "${var.router_name}-kube-"
  role_prefix     = "${var.router_name}-${data.aws_region.current.region}-kube-"
  part_function   = length(local.function_prefix) + length(var.cluster_name) <= 64 ? var.cluster_name : "${substr(var.cluster_name, 0, 64 - length(local.function_prefix) - 9)}-${local.hash}"
  part_role       = length(local.role_prefix) + length(var.cluster_name) <= 64 ? var.cluster_name : "${substr(var.cluster_name, 0, 64 - length(local.role_prefix) - 9)}-${local.hash}"

  vpc        = data.aws_eks_cluster.this.vpc_config[0]
  subnet_ids = var.subnet_ids == null ? local.vpc.subnet_ids : var.subnet_ids
  own_group  = var.security_group_ids == null
  group_ids  = local.own_group ? [aws_security_group.proxy[0].id] : var.security_group_ids
  tags       = { "dormeto:role" = "kubernetes-proxy", "dormeto:cluster" = var.cluster_name }
  # The VPC's associated IPv4 blocks (the primary one is among its associations).
  vpc_cidrs  = toset([for a in data.aws_vpc.cluster.cidr_block_associations : a.cidr_block if a.state == "associated"])
  cluster_sg = local.vpc.cluster_security_group_id
  build      = substr(data.archive_file.lambda.output_sha256, 0, 12)
}

data "archive_file" "lambda" {
  type        = "zip"
  source_dir  = var.lambda_source_dir
  output_path = "${path.root}/.build/${local.function_name}.zip"
}

resource "aws_cloudwatch_log_group" "proxy" {
  name              = "/aws/lambda/${local.function_name}"
  retention_in_days = var.log_retention_days
  tags              = local.tags
}

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "proxy" {
  name               = local.role_name
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
  tags               = local.tags
}

# What Lambda requires of a VPC function's role, and its logs: the same as the blueprint's kubeProxy.rolePolicy
# (lambda/test/blueprint.test.mjs keeps them equal).
data "aws_iam_policy_document" "proxy" {
  statement {
    actions   = ["ec2:CreateNetworkInterface", "ec2:DescribeNetworkInterfaces", "ec2:DescribeSubnets", "ec2:DeleteNetworkInterface", "ec2:AssignPrivateIpAddresses", "ec2:UnassignPrivateIpAddresses"]
    resources = ["*"]
  }
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.proxy.arn}:*"]
  }
}

resource "aws_iam_role_policy" "proxy" {
  name   = "proxy"
  role   = aws_iam_role.proxy.id
  policy = data.aws_iam_policy_document.proxy.json
}

# The proxy's own group: its default egress rule (everything) is removed, since the group declares no rule inline; the
# only egress is TCP 443 to the VPC's IPv4 blocks (the endpoint's network interfaces are in them). A rule naming the
# cluster security group would keep EKS from deleting that group with the cluster.
resource "aws_security_group" "proxy" {
  count       = local.own_group ? 1 : 0
  name        = local.function_name
  description = "Dormeto Kubernetes proxy of cluster ${var.cluster_name}"
  vpc_id      = local.vpc.vpc_id
  tags        = local.tags

  # Lambda can take longer than the provider's default to release the function's network interfaces (the manager waits an
  # hour); a cluster recreated in another VPC under the same name needs the new group first (names are unique per VPC).
  timeouts {
    delete = "60m"
  }
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_egress_rule" "proxy" {
  for_each          = local.own_group ? local.vpc_cidrs : toset([])
  security_group_id = aws_security_group.proxy[0].id
  cidr_ipv4         = each.value
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "Kubernetes API of cluster ${var.cluster_name}"
  tags              = local.tags
}

resource "aws_vpc_security_group_ingress_rule" "cluster" {
  count                        = local.own_group ? 1 : 0
  security_group_id            = local.cluster_sg
  referenced_security_group_id = aws_security_group.proxy[0].id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  description                  = "Dormeto Kubernetes proxy ${local.function_name}"
  tags                         = local.tags
}

resource "aws_lambda_function" "proxy" {
  function_name    = local.function_name
  role             = aws_iam_role.proxy.arn
  runtime          = "nodejs24.x"
  architectures    = ["arm64"]
  handler          = "kube-proxy.handler"
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256
  timeout          = 15
  memory_size      = 128
  tags             = local.tags

  vpc_config {
    subnet_ids         = local.subnet_ids
    security_group_ids = local.group_ids
  }

  environment {
    variables = {
      DMT_CLUSTER  = var.cluster_name
      DMT_ENDPOINT = data.aws_eks_cluster.this.endpoint
      # The cluster reports its certificate authority base64-encoded; the proxy expects the PEM text.
      DMT_CA      = base64decode(data.aws_eks_cluster.this.certificate_authority[0].data)
      DMT_VERSION = var.router_version
      DMT_BUILD   = local.build
    }
  }

  # The rules must exist before the function connects, and go after it on destroy (Lambda holds its network interfaces).
  depends_on = [aws_cloudwatch_log_group.proxy, aws_iam_role_policy.proxy, aws_vpc_security_group_egress_rule.proxy, aws_vpc_security_group_ingress_rule.cluster]
}
