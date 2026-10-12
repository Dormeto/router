variable "router" {
  description = "Outputs of the router module."
  type = object({
    name                = string
    table_name          = string
    waker_function_name = string
    waker_function_arn  = string
  })
}

variable "workload_id" {
  type = string
  validation {
    condition     = can(regex("^[a-z0-9-]{1,20}$", var.workload_id))
    error_message = "workload_id must be 1-20 characters of lower-case letters, digits and hyphens (target group name limit)."
  }
}

variable "rule_arn" {
  type = string
}

variable "app_target_group_arn" {
  type = string
}

variable "app_target_group_arn_suffix" {
  type = string
}

variable "load_balancer_arn_suffix" {
  type = string
}

variable "instance_ids" {
  type = list(string)
}

variable "wait_seconds" {
  type    = number
  default = 20
}

variable "idle_minutes" {
  type    = number
  default = 15
}

variable "drain_seconds" {
  description = "Wait between the route switch and the instance stop. Must exceed ALB rule propagation (about 12 s measured)."
  type        = number
  default     = 30
}

variable "wake_timeout_seconds" {
  type    = number
  default = 600
}

variable "failed_retry_seconds" {
  type    = number
  default = 60
}

variable "max_holders" {
  description = "Maximum held requests. Keep it well below the account Lambda concurrency (10 in this account)."
  type        = number
  default     = 5
}

variable "poll_seconds" {
  type    = number
  default = 3
}

variable "admin_enabled" {
  description = "Feature flag of the admin dashboard behind /_dormeto/<admin_secret>/."
  type        = bool
  default     = false
}

variable "admin_secret" {
  description = "Secret path segment of the admin dashboard (24-64 alphanumeric characters)."
  type        = string
  default     = null
  sensitive   = true
  validation {
    condition     = var.admin_secret == null || can(regex("^[A-Za-z0-9]{24,64}$", var.admin_secret))
    error_message = "admin_secret must be 24-64 alphanumeric characters."
  }
}
