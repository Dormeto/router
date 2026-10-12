variable "cluster_name" {
  description = "The EKS cluster the router's workloads run in (authentication mode API or API_AND_CONFIG_MAP)."
  type        = string
}

variable "router_role_arns" {
  description = "The router's roles that call the cluster: its controller, waker and onboarder."
  type        = list(string)
  validation {
    condition     = length(var.router_role_arns) > 0 && alltrue([for arn in var.router_role_arns : can(regex("^arn:aws[a-z-]*:iam::[0-9]{12}:role/", arn))])
    error_message = "router_role_arns: the IAM role ARNs of the router's controller, waker and onboarder."
  }
}

variable "discovery_role_arn" {
  description = "DmtDiscoveryRole of the account, read-only on the cluster (AmazonEKSViewPolicy); null: no entry."
  type        = string
  default     = null
}

variable "apply_manifest" {
  description = "Apply the published ClusterRole, its binding and the Ingress admission policy with the kubernetes provider; false: apply kubernetes/dormeto-router.yaml with kubectl instead."
  type        = bool
  default     = true
}
