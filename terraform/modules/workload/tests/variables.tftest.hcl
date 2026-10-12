# The workload module's inputs (R7a): what a failed wake does, checked at plan time (tfenv exec test, no AWS call).
mock_provider "aws" {
  mock_resource "aws_lb_target_group" {
    defaults = { arn = "arn:aws:elasticloadbalancing:eu-west-1:111111111111:targetgroup/dmt-dev-shop/fedcba9876543210" }
  }
}

variables {
  router                      = { name = "dmt-dev", table_name = "dmt-dev", waker_function_arn = "arn:aws:lambda:eu-west-1:111111111111:function:dmt-dev-waker", waker_permission = "p" }
  workload_id                 = "shop"
  app_target_group_arn        = "arn:aws:elasticloadbalancing:eu-west-1:111111111111:targetgroup/shop/0123456789abcdef"
  app_target_group_arn_suffix = "targetgroup/shop/0123456789abcdef"
  load_balancer_arn_suffix    = "app/lb/0123456789abcdef"
}

run "defaults_and_fallbacks_are_written_to_the_config" {
  # Applied against the mock provider: nothing is created in AWS.
  command = apply
  variables {
    fallback_instance_types = ["t3a.medium", "m6i.large"]
  }
  assert {
    condition     = jsondecode(jsondecode(aws_dynamodb_table_item.config.item).config.S).failedRetrySeconds == 60
    error_message = "failedRetrySeconds defaults to 60"
  }
  assert {
    condition     = jsondecode(jsondecode(aws_dynamodb_table_item.config.item).config.S).fallbackInstanceTypes == ["t3a.medium", "m6i.large"]
    error_message = "the fallback types are in the config"
  }
}

run "failed_retry_seconds_from_10_to_600" {
  command = plan
  variables {
    failed_retry_seconds = 5
  }
  expect_failures = [var.failed_retry_seconds]
}

run "failed_retry_seconds_above_600_refused" {
  command = plan
  variables {
    failed_retry_seconds = 601
  }
  expect_failures = [var.failed_retry_seconds]
}

run "fallback_instance_types_must_be_instance_types" {
  command = plan
  variables {
    fallback_instance_types = ["t3a medium"]
  }
  expect_failures = [var.fallback_instance_types]
}
