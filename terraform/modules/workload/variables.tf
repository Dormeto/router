variable "router" {
  description = "Outputs of the router module."
  type = object({
    name               = string
    table_name         = string
    waker_function_arn = string
    waker_permission   = string
  })
}

variable "workload_id" {
  type = string
  validation {
    # Waker target group <router>-<workload_id> within 32 characters, router names of at most 15.
    condition     = can(regex("^[a-z0-9-]{1,16}$", var.workload_id))
    error_message = "workload_id must be 1-16 characters of lower-case letters, digits and hyphens (target group name limit)."
  }
}

variable "name" {
  description = "Name shown to people (manager, admin page); never in a resource name. Defaults to workload_id."
  type        = string
  default     = null
  validation {
    condition     = var.name == null || (length(trimspace(var.name)) > 0 && length(trimspace(var.name)) <= 64 && can(regex("^[^\\x00-\\x1f\\x7f]*$", var.name)))
    error_message = "name must have 1 to 64 characters, without control characters."
  }
}

variable "rule_arn" {
  description = "Deprecated, not read by routers from 0.15.0 (the rules are found from the application target group). Kept for routers before 0.15.0 during an upgrade."
  type        = string
  default     = null
}

variable "rule_arns" {
  description = "Deprecated, not read by routers from 0.15.0 (the rules are found from the application target group). Kept for routers before 0.15.0 during an upgrade."
  type        = list(string)
  default     = []
}

variable "app_target_group_arn" {
  description = "Application target group: it identifies the workload. Its rules are every listener rule of its load balancer that forwards to it, found at runtime. Instrument each one: a weighted forward to this target group (weight 1) and to the waker target group (output waker_target_group_arn, weight 0), the tag dormeto:workload = <workload_id>, and lifecycle ignore_changes = [action]. Any other rule forwarding to the target group keeps the workload awake (shown as an issue in its status)."
  type        = string
}

variable "app_target_group_arn_suffix" {
  type = string
}

variable "load_balancer_arn_suffix" {
  type = string
}

variable "instance_ids" {
  description = "Static list of instances. Empty (default): instances are discovered from the app target group (tag dormeto:workload=<workload_id>)."
  type        = list(string)
  default     = []
}

variable "wait_seconds" {
  description = "Maximum time the waker holds a request before the waiter page. 60 s covers a wake (36-51 s measured from the first request) plus the 15 s route grace window."
  type        = number
  default     = 60
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
  description = "Maximum requests held at the same time per workload (each one uses a Lambda execution for up to wait_seconds). Keep it well below the account Lambda concurrency (1000 in this account)."
  type        = number
  default     = 50
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

variable "admin_secret_parameter" {
  description = "Name of the SSM SecureString parameter holding the admin secret, recorded in the workload configuration so that operators and tools (dormeto-e2e) can retrieve it with AWS credentials. The Lambdas only use the hash."
  type        = string
  default     = null
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

variable "no_wake_rules" {
  description = "No-wake rules: matching requests get the waiter page without waking the workload. A rule matches when all its conditions match: source_ips (addresses or CIDR ranges, last X-Forwarded-For entry), path_prefixes, path_pattern (regular expression), user_agent_pattern (regular expression, case-insensitive), headers (name with an exact value or a pattern)."
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

variable "wake_mode" {
  description = "any: every request that passes the filters wakes the workload. browser: only the waiter page probe (JavaScript), the x-dormeto-wake: 1 header and wake_rules wake it; other requests get the waiter page at once."
  type        = string
  default     = "any"
  validation {
    condition     = contains(["any", "browser"], var.wake_mode)
    error_message = "wake_mode must be any or browser."
  }
}

variable "wake_rules" {
  description = "Wake rules (wake_mode browser): matching requests wake the workload without the waiter page probe, for example API paths. Same format as no_wake_rules; no-wake rules and the built-in filters still win."
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
    condition     = alltrue([for r in var.wake_rules : can(regex("^[A-Za-z0-9._-]{1,64}$", r.name))]) && length(distinct([for r in var.wake_rules : r.name])) == length(var.wake_rules)
    error_message = "wake_rules names must be unique, 1-64 characters among letters, digits, '.', '_' and '-'."
  }
  validation {
    condition     = alltrue([for r in var.wake_rules : length(r.source_ips) + length(r.path_prefixes) + length(r.headers) > 0 || r.path_pattern != null || r.user_agent_pattern != null])
    error_message = "Each wake rule needs at least one condition."
  }
  validation {
    condition     = alltrue(flatten([for r in var.wake_rules : [for ip in r.source_ips : can(cidrhost(strcontains(ip, "/") ? ip : (strcontains(ip, ":") ? "${ip}/128" : "${ip}/32"), 0))]]))
    error_message = "wake_rules source_ips must be IPv4/IPv6 addresses or CIDR ranges."
  }
  validation {
    condition     = alltrue(flatten([for r in var.wake_rules : [for h in r.headers : (h.value == null) != (h.pattern == null)]]))
    error_message = "Each wake_rules header needs either value or pattern."
  }
}
