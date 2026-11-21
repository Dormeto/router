# The workload module's two forms (vision standalone workloads design §5): a target group and its load balancer (HTTP), or a
# resource (standalone), one of the two; a standalone workload has no waker target group, and its own settings. No AWS call.
mock_provider "aws" {
  mock_resource "aws_lb_target_group" {
    defaults = { arn = "arn:aws:elasticloadbalancing:eu-west-1:111111111111:targetgroup/dmt-dev-shop/fedcba9876543210" }
  }
}

variables {
  router      = { name = "dmt-dev", table_name = "dmt-dev", waker_function_arn = "arn:aws:lambda:eu-west-1:111111111111:function:dmt-dev-waker", waker_permission = "p" }
  workload_id = "batch"
}

run "a_standalone_workload_writes_its_resource_and_no_waker" {
  command = apply
  variables {
    resource_arn     = "arn:aws:ec2:eu-west-1:111111111111:instance/i-0123456789abcdef0"
    name             = "Batch"
    idle_cpu_percent = "off"
    idle_metric      = { namespace = "Batch", name = "QueueDepth", dimensions = { Queue = "$${resource}" }, statistic = "Maximum", below = 1 }
    databases        = [{ kind = "rds-instance", id = "orders" }]
    hibernate        = false
  }
  assert {
    condition = jsondecode(jsondecode(aws_dynamodb_table_item.config.item).config.S) == {
      workloadId = "batch", kind = "standalone", resourceArn = "arn:aws:ec2:eu-west-1:111111111111:instance/i-0123456789abcdef0", name = "Batch", tags = {},
      databases  = [{ kind = "rds-instance", id = "orders" }], idleCpuPercent = "off",
      idleMetric = { namespace = "Batch", name = "QueueDepth", dimensions = { Queue = "$${resource}" }, statistic = "Maximum", below = 1 },
      inherits   = ["idleMinutes", "wakeTimeoutSeconds", "idleNetworkBytes"], hibernate = false,
    }
    error_message = "the standalone record: its resource, its settings, inherits; no target group, waker, rule or waker setting"
  }
  assert {
    condition     = length(aws_lb_target_group.waker) == 0 && length(aws_lb_target_group_attachment.waker) == 0 && output.waker_target_group_arn == null
    error_message = "no waker target group"
  }
  assert {
    condition     = jsondecode(aws_dynamodb_table_item.run.item).state.S == "AWAKE"
    error_message = "its run"
  }
}

run "a_standalone_workload_numbers" {
  command = apply
  variables {
    resource_arn         = "arn:aws:rds:eu-west-1:111111111111:db:orders"
    idle_minutes         = 240
    wake_timeout_seconds = 1800
    idle_cpu_percent     = 2.5
    idle_network_bytes   = 10000
  }
  assert {
    condition     = jsondecode(jsondecode(aws_dynamodb_table_item.config.item).config.S).idleCpuPercent == 2.5 && jsondecode(jsondecode(aws_dynamodb_table_item.config.item).config.S).idleNetworkBytes == 10000
    error_message = "numbers stay numbers"
  }
  assert {
    condition     = jsondecode(jsondecode(aws_dynamodb_table_item.config.item).config.S).inherits == ["idleMetric"]
    error_message = "only idleMetric is left to the levels"
  }
}

run "neither_a_target_group_nor_a_resource_is_refused" {
  command         = plan
  expect_failures = [var.resource_arn]
}

run "both_a_target_group_and_a_resource_are_refused" {
  command = plan
  variables {
    resource_arn                = "arn:aws:ec2:eu-west-1:111111111111:instance/i-0123456789abcdef0"
    app_target_group_arn        = "arn:aws:elasticloadbalancing:eu-west-1:111111111111:targetgroup/shop/0123456789abcdef"
    app_target_group_arn_suffix = "targetgroup/shop/0123456789abcdef"
    load_balancer_arn_suffix    = "app/lb/0123456789abcdef"
  }
  expect_failures = [var.resource_arn]
}

run "a_resource_must_be_one_dormeto_naps" {
  command = plan
  variables {
    resource_arn = "arn:aws:s3:::bucket"
  }
  expect_failures = [var.resource_arn]
}

run "a_target_group_needs_its_load_balancer" {
  command = plan
  variables {
    app_target_group_arn = "arn:aws:elasticloadbalancing:eu-west-1:111111111111:targetgroup/shop/0123456789abcdef"
  }
  expect_failures = [var.app_target_group_arn]
}

run "the_waker_settings_are_refused_for_a_standalone_workload" {
  command = plan
  variables {
    resource_arn  = "arn:aws:ec2:eu-west-1:111111111111:instance/i-0123456789abcdef0"
    wait_seconds  = 30
    wake_mode     = "browser"
    no_wake_rules = [{ name = "health", path_prefixes = ["/health"] }]
  }
  expect_failures = [var.resource_arn]
}

run "the_idle_signals_are_refused_for_an_http_workload" {
  command = plan
  variables {
    app_target_group_arn        = "arn:aws:elasticloadbalancing:eu-west-1:111111111111:targetgroup/shop/0123456789abcdef"
    app_target_group_arn_suffix = "targetgroup/shop/0123456789abcdef"
    load_balancer_arn_suffix    = "app/lb/0123456789abcdef"
    idle_network_bytes          = 1000
  }
  expect_failures = [var.idle_network_bytes]
}

run "idle_cpu_percent_from_0_to_100_or_off" {
  command = plan
  variables {
    resource_arn     = "arn:aws:ec2:eu-west-1:111111111111:instance/i-0123456789abcdef0"
    idle_cpu_percent = 101
  }
  expect_failures = [var.idle_cpu_percent]
}

run "idle_network_bytes_a_whole_number_or_off" {
  command = plan
  variables {
    resource_arn       = "arn:aws:ec2:eu-west-1:111111111111:instance/i-0123456789abcdef0"
    idle_network_bytes = 1.5
  }
  expect_failures = [var.idle_network_bytes]
}

run "idle_metric_off_or_a_metric" {
  command = plan
  variables {
    resource_arn = "arn:aws:ec2:eu-west-1:111111111111:instance/i-0123456789abcdef0"
    idle_metric  = { namespace = "Batch", name = "QueueDepth", dimensions = {}, statistic = "p99", below = 1 }
  }
  expect_failures = [var.idle_metric]
}

run "idle_metric_off_is_written" {
  command = apply
  variables {
    resource_arn = "arn:aws:ec2:eu-west-1:111111111111:instance/i-0123456789abcdef0"
    idle_metric  = "off"
  }
  assert {
    condition     = jsondecode(jsondecode(aws_dynamodb_table_item.config.item).config.S).idleMetric == "off"
    error_message = "off is written"
  }
}

run "idle_metric_only_resource_is_replaced" {
  command = plan
  variables {
    resource_arn = "arn:aws:ec2:eu-west-1:111111111111:instance/i-0123456789abcdef0"
    idle_metric  = { namespace = "Batch", name = "QueueDepth", dimensions = { Queue = "$${instance}" }, statistic = "Maximum", below = 1 }
  }
  expect_failures = [var.idle_metric]
}

run "idle_metric_a_dimension_name_of_at_most_255" {
  command = plan
  variables {
    resource_arn = "arn:aws:ec2:eu-west-1:111111111111:instance/i-0123456789abcdef0"
    idle_metric  = { namespace = "Batch", name = "QueueDepth", dimensions = { (join("", [for i in range(256) : "d"])) = "v" }, statistic = "Maximum", below = 1 }
  }
  expect_failures = [var.idle_metric]
}

run "idle_metric_no_unknown_field" {
  command = plan
  variables {
    resource_arn = "arn:aws:ec2:eu-west-1:111111111111:instance/i-0123456789abcdef0"
    idle_metric  = { namespace = "Batch", name = "QueueDepth", dimensions = {}, statistic = "Maximum", below = 1, unit = "Count" }
  }
  expect_failures = [var.idle_metric]
}

run "idle_metric_below_a_number" {
  command = plan
  variables {
    resource_arn = "arn:aws:ec2:eu-west-1:111111111111:instance/i-0123456789abcdef0"
    idle_metric  = { namespace = "Batch", name = "QueueDepth", dimensions = {}, statistic = "Maximum", below = "1" }
  }
  expect_failures = [var.idle_metric]
}
