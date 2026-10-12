variable "env" {
  type    = string
  default = "dev"
}

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

variable "zone_id" {
  description = "Route 53 hosted zone of dormeto.com."
  type        = string
  default     = "Z01943593T1RNPIO8DLPX"
}

variable "zone_name" {
  type    = string
  default = "dormeto.com"
}

variable "instance_type" {
  type    = string
  default = "t4g.nano"
}

variable "idle_minutes" {
  type    = number
  default = 15
}

variable "wait_seconds" {
  description = "Maximum time the waker holds a request before the waiter page. 35 s covers a wake (~13 s) plus the 15 s route grace window."
  type        = number
  default     = 35
}

locals {
  name   = "dmt-${var.env}"
  domain = "${var.env}.${var.zone_name}"
}

variable "admin_dashboard_enabled" {
  description = "Feature flag: lightweight admin dashboard behind a secret URL on the demo domain."
  type        = bool
  default     = true
}
