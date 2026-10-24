variable "router_name" {
  description = "The router's name (its module's name, for example dmt-dev): the proxy is named <router_name>-kube-<cluster>, which the router's functions find from their DMT_KUBE_PROXY_PREFIX."
  type        = string
}

variable "lambda_source_dir" {
  description = "The router's Lambda source directory (the one given to the router module): the proxy is its handler kube-proxy.handler."
  type        = string
}

variable "cluster_name" {
  description = "The EKS cluster whose endpoint is private (or limited to some addresses) and whose private access is on."
  type        = string
}

variable "subnet_ids" {
  description = "Subnets of the proxy; null: the cluster's own subnets."
  type        = list(string)
  default     = null
}

variable "security_group_ids" {
  description = "Security groups of the proxy; null: a group of its own, whose only egress is TCP 443 to the VPC's IPv4 blocks, admitted by the cluster security group. Given: used as they are, nothing is made or opened (they must reach the VPC on TCP 443, and the cluster security group must admit them)."
  type        = list(string)
  default     = null
}

variable "log_retention_days" {
  type    = number
  default = 14
}

variable "router_version" {
  description = "Router version (package.json), exposed to the proxy as DMT_VERSION; the router's ping reports it."
  type        = string
  default     = "0.0.0"
}
