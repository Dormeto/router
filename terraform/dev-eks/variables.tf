variable "region" {
  type    = string
  default = "eu-west-1"
}

variable "aws_profile" {
  type    = string
  default = "kloudy-dormeto-prd"
}

variable "account_id" {
  type    = string
  default = "121014831971"
}

variable "name" {
  description = "The cluster's name, and the prefix of its resources."
  type        = string
  default     = "eks-demo"
}

# EKS's default version on 2026-10-11, in standard support until 2027-08 (extended support costs six times as much).
variable "kubernetes_version" {
  type    = string
  default = "1.36"
}

variable "admin_role_arn" {
  description = "The IAM role given cluster admin by an access entry (the user's SSO role: the e2e tool and the estimate read the cluster with it)."
  type        = string
  default     = "arn:aws:iam::121014831971:role/aws-reserved/sso.amazonaws.com/AWSReservedSSO_Admin_1b476e23b8b33efd"
}

variable "zone_id" {
  type    = string
  default = "Z01943593T1RNPIO8DLPX"
}

variable "domain" {
  description = "The demos' parent domain: <demo>.<domain>."
  type        = string
  default     = "eks.dev.dormeto.com"
}

variable "lone_ingress" {
  description = "A demo behind an Ingress outside any group (its own ALB, about $22 a month): for its acceptance runs."
  type        = bool
  default     = false
}

variable "target_group_binding" {
  description = "A demo behind a TargetGroupBinding to an ALB owned by this Terraform (about $22 a month): for its acceptance runs."
  type        = bool
  default     = false
}

variable "spike" {
  description = "The spike's Lambda target group (vision docs/plans/2026-10-11-kubernetes.md, K0.2)."
  type        = bool
  default     = false
}

variable "dormeto_router" {
  description = "The Terraform router (router/terraform/dev) whose roles get access entries in the group dormeto:router, with DmtDiscoveryRole's and the group's rights; null: none (a router the manager installs makes its own entries)."
  type        = string
  default     = "dmt-dev"
}
