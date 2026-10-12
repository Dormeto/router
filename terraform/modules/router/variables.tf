variable "name" {
  description = "Resource name prefix, for example dmt-dev."
  type        = string
}

variable "lambda_source_dir" {
  description = "Directory zipped into both Lambda functions."
  type        = string
}

variable "waker_timeout_seconds" {
  description = "Waker Lambda timeout. Must exceed the largest workload waitSeconds by at least 5 seconds."
  type        = number
  default     = 70
}

variable "check_schedule" {
  description = "EventBridge Scheduler expression of the idle check."
  type        = string
  default     = "rate(5 minutes)"
}

variable "log_retention_days" {
  type    = number
  default = 14
}

variable "admin_enabled" {
  description = "Grant the waker the read-only permissions of the admin dashboard."
  type        = bool
  default     = false
}
