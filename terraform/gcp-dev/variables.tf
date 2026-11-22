variable "project" {
  description = "The Google Cloud project."
  type        = string
  default     = "dormeto-dev2"
}

variable "region" {
  description = "The Google Cloud region: the subnets, the regional load balancer."
  type        = string
  default     = "europe-west1"
}

variable "zone" {
  description = "The Compute Engine zone of the demo VM and the managed group."
  type        = string
  default     = "europe-west1-b"
}

variable "aws_region" {
  type    = string
  default = "eu-west-1"
}

variable "aws_profile" {
  type    = string
  default = "kloudy-dormeto-prd"
}

variable "aws_account_id" {
  type    = string
  default = "121014831971"
}

variable "zone_id" {
  description = "Route 53 hosted zone of dormeto.com."
  type        = string
  default     = "Z01943593T1RNPIO8DLPX"
}

variable "domain" {
  description = "The global load balancer's host for the demo VM; mig.<domain> for the managed group, regional.<domain> for the regional load balancer."
  type        = string
  default     = "gcp.dev.dormeto.com"
}

variable "machine_type" {
  type    = string
  default = "e2-small"
}

variable "health_check_interval" {
  description = "Seconds between two health checks (G0 measures 5, then 1, the lowest Compute Engine accepts); the timeout is 5 s, or the interval when shorter."
  type        = number
  default     = 5

  validation {
    condition     = var.health_check_interval >= 1 && var.health_check_interval <= 300 && floor(var.health_check_interval) == var.health_check_interval
    error_message = "A whole number of seconds, from 1 to 300."
  }
}

# Optional parts, off by default: a plan with the defaults shows no change. They cost money while they exist (README), so
# they are turned on for the measures and the acceptance, on the user's word, and off after.
variable "enable_classic" {
  description = "A classic external Application Load Balancer (EXTERNAL, HTTP) on the demo VM's group."
  type        = bool
  default     = false
}

variable "enable_classic_standard" {
  description = "A classic external Application Load Balancer on the Standard network tier: a regional address and forwarding rule on a global HTTP proxy."
  type        = bool
  default     = false
}

variable "enable_ten" {
  description = "Ten small VMs, each in its own instance group with its own backend service, and a host rule ten-<n>.<domain> on a URL map of their own (ten_map)."
  type        = bool
  default     = false
}

variable "ten_map" {
  description = "The kind of load balancer and URL map for enable_ten: global or regional."
  type        = string
  default     = "global"

  validation {
    condition     = contains(["global", "regional"], var.ten_map)
    error_message = "global or regional."
  }
}

variable "enable_neg" {
  description = "A VM, a zonal NEG holding it and a global backend service on it, behind a load balancer of its own."
  type        = bool
  default     = false
}

variable "enable_sql" {
  description = "A PostgreSQL Cloud SQL instance, the smallest shared-core, 10 GB."
  type        = bool
  default     = false
}

variable "enable_gke" {
  description = "A zonal Standard GKE cluster with one small node, a backend service for its standalone NEG (gke-demo.yaml)."
  type        = bool
  default     = false
}

locals {
  name            = "dmt-dev"
  demo            = "dmt-demo"
  mig_domain      = "mig.${var.domain}"
  regional_domain = "regional.${var.domain}"

  # Every VM's: the app on 80, the stand-in on 8080 (startup.sh).
  startup_script = file("${path.module}/startup.sh")

  health_check = {
    interval  = var.health_check_interval
    timeout   = min(5, var.health_check_interval)
    healthy   = 2
    unhealthy = 2
  }
}

variable "enable_internal" {
  description = "Internal Application Load Balancers: a regional one and a cross-region one, each in front of a VM of its own, and a global proxy-only subnet. The measures reach them from a Cloud Run job with Direct VPC egress."
  type        = bool
  default     = false
}

variable "internal_region" {
  description = "The region of the regional internal load balancer, its VM and its subnets (a zone -b VM, 10.10.4.0/24 and the proxy-only 10.10.5.0/24); null: var.region. The cross-region one stays in var.region."
  type        = string
  default     = null
}

variable "enable_standalone" {
  description = "A small VM behind no load balancer, for a standalone workload."
  type        = bool
  default     = false
}
