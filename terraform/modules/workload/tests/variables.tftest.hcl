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

run "tags_are_written_to_the_config_and_default_to_none" {
  command = apply
  variables {
    tags = { team = "payments", "cost center" = "é 日本_.:/=+-@" }
  }
  assert {
    condition     = jsondecode(jsondecode(aws_dynamodb_table_item.config.item).config.S).tags == { team = "payments", "cost center" = "é 日本_.:/=+-@" }
    error_message = "the tags are in the config"
  }
}

run "no_tags_is_an_empty_object" {
  command = apply
  assert {
    condition     = jsondecode(jsondecode(aws_dynamodb_table_item.config.item).config.S).tags == {}
    error_message = "tags default to {}"
  }
}

run "more_than_50_tags_refused" {
  command = plan
  variables {
    tags = { for i in range(51) : "k${i}" => "v" }
  }
  expect_failures = [var.tags]
}

run "an_empty_key_is_refused" {
  command = plan
  variables {
    tags = { "" = "v" }
  }
  expect_failures = [var.tags]
}

run "a_key_of_129_characters_is_refused" {
  command = plan
  variables {
    tags = { (join("", [for i in range(129) : "k"])) = "v" }
  }
  expect_failures = [var.tags]
}

run "a_value_of_257_characters_is_refused" {
  command = plan
  variables {
    tags = { team = join("", [for i in range(257) : "v"]) }
  }
  expect_failures = [var.tags]
}

run "a_comma_in_a_value_is_refused" {
  command = plan
  variables {
    tags = { team = "a,b" }
  }
  expect_failures = [var.tags]
}

run "the_reserved_prefix_is_refused_in_any_case" {
  command = plan
  variables {
    tags = { "Dormeto:x" = "1" }
  }
  expect_failures = [var.tags]
}
