variable "name" {
  description = "Resource name prefix, for example dmt-dev."
  type        = string
  validation {
    # Waker target groups are <name>-<16-character workload id>, within the 32 characters of a target group name.
    condition     = length(var.name) <= 15
    error_message = "name must have at most 15 characters (waker target groups <name>-<workload id>)."
  }
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
  description = "EventBridge Scheduler expression of the check (idle naps and schedules). On the clock's 5-minute marks, so schedule times, multiples of 5 minutes, are met."
  type        = string
  default     = "cron(0/5 * * * ? *)"
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

variable "waker_memory_mb" {
  description = "Waker memory (Lambda CPU grows with it): 512 MB keeps the waiter page fast and loads the admin dashboard SDK clients in about 2 s on first use."
  type        = number
  default     = 512
}

variable "metrics_enabled" {
  description = "Publish CloudWatch metrics IgnoredRequests, DeferredRequests and Wakes per workload (namespace Dormeto, embedded metric format: no API call). Each metric costs about 0.30 USD per month."
  type        = bool
  default     = false
}

variable "ip_lists" {
  description = "IP reputation lists downloaded by the controller (refresh_hours) and used by the waker for every workload. url: http(s) URL, or s3://bucket/key read with the S3 API (the controller role gets s3:GetObject on that object; a bucket in another account must allow the role in its bucket policy, a customer managed KMS key in its key policy). action defer: a listed source only wakes through the waiter page probe (browser mode for it); ignore: never wakes. The x-dormeto-wake header and wake rules override the lists. Formats: JSON (every address or CIDR string) or text (first column). Behind a CDN or proxy the source is the proxy: do not use cloud range lists there."
  type = list(object({
    name          = string
    url           = string
    action        = optional(string, "defer")
    refresh_hours = optional(number, 24)
  }))
  default = []
  validation {
    condition     = alltrue([for l in var.ip_lists : can(regex("^[A-Za-z0-9._-]{1,64}$", l.name))]) && length(distinct([for l in var.ip_lists : l.name])) == length(var.ip_lists)
    error_message = "ip_lists names must be unique, 1-64 characters among letters, digits, '.', '_' and '-'."
  }
  validation {
    condition     = alltrue([for l in var.ip_lists : can(regex("^(https?://|s3://[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]/.+)", l.url)) && contains(["defer", "ignore"], l.action) && l.refresh_hours >= 1])
    error_message = "Each ip_lists entry needs an http(s) url or an s3://bucket/key URI, action defer or ignore, and refresh_hours of at least 1."
  }
}

variable "ip_lists_catalog" {
  description = "The manager's IP lists (output ip_lists_catalog of the manager): s3://<bucket>/catalog.json. The waker reads the catalog, manifests and data every 5 minutes (only what changed), the controller describes them; a list of ip_lists with the same name wins. The router also reads the manager's settings (settings.json) beside it. Null: only ip_lists."
  type        = string
  default     = null
  validation {
    condition     = var.ip_lists_catalog == null || can(regex("^s3://[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]/(.+/)?catalog\\.json$", var.ip_lists_catalog))
    error_message = "ip_lists_catalog must be s3://<bucket>/catalog.json (the manager's output)."
  }
}

variable "manager_event_bus_arn" {
  description = "Event bus of the manager (output event_bus_arn of the manager platform): the router sends its state after each idle check and each state change to it. Null: nothing sent, the manager calls the router instead."
  type        = string
  default     = null
}
