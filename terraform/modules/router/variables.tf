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

variable "router_version" {
  description = "Router version (package.json), exposed to the Lambdas as DMT_VERSION; DMT_BUILD is the code hash."
  type        = string
  default     = "0.0.0"
}

variable "no_wake_rules" {
  description = "No-wake rules: matching requests get the waiter page without waking, for every workload of this router (Lambda environment: keep it short, 4 KB in all). A rule matches when all its conditions match: source_ips (addresses or CIDR ranges, last X-Forwarded-For entry), path_prefixes, path_pattern (regular expression), user_agent_pattern (regular expression, case-insensitive), headers (name with an exact value or a pattern)."
  type = list(object({
    name               = string
    source_ips         = optional(list(string), [])
    path_prefixes      = optional(list(string), [])
    path_pattern       = optional(string)
    user_agent_pattern = optional(string)
    headers = optional(list(object({
      name    = string
      value   = optional(string)
      pattern = optional(string)
    })), [])
  }))
  default = []
  validation {
    condition     = alltrue([for r in var.no_wake_rules : can(regex("^[A-Za-z0-9._-]{1,64}$", r.name))]) && length(distinct([for r in var.no_wake_rules : r.name])) == length(var.no_wake_rules)
    error_message = "no_wake_rules names must be unique, 1-64 characters among letters, digits, '.', '_' and '-'."
  }
  validation {
    condition     = alltrue([for r in var.no_wake_rules : length(r.source_ips) + length(r.path_prefixes) + length(r.headers) > 0 || r.path_pattern != null || r.user_agent_pattern != null])
    error_message = "Each no-wake rule needs at least one condition."
  }
  validation {
    condition     = alltrue(flatten([for r in var.no_wake_rules : [for ip in r.source_ips : can(cidrhost(strcontains(ip, "/") ? ip : (strcontains(ip, ":") ? "${ip}/128" : "${ip}/32"), 0))]]))
    error_message = "no_wake_rules source_ips must be IPv4/IPv6 addresses or CIDR ranges."
  }
  validation {
    condition     = alltrue(flatten([for r in var.no_wake_rules : [for h in r.headers : (h.value == null) != (h.pattern == null)]]))
    error_message = "Each no_wake_rules header needs either value or pattern."
  }
}
