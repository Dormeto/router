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

run "hibernate_is_absent_from_the_config_by_default" {
  command = apply
  assert {
    condition     = !contains(keys(jsondecode(jsondecode(aws_dynamodb_table_item.config.item).config.S)), "hibernate")
    error_message = "hibernate is written only when set, so an apply never writes false by default"
  }
}

run "hibernate_false_is_written_to_the_config" {
  command = apply
  variables {
    hibernate = false
  }
  assert {
    condition     = jsondecode(jsondecode(aws_dynamodb_table_item.config.item).config.S).hibernate == false
    error_message = "hibernate false is in the config"
  }
}

run "hibernate_true_is_written_to_the_config" {
  command = apply
  variables {
    hibernate = true
  }
  assert {
    condition     = jsondecode(jsondecode(aws_dynamodb_table_item.config.item).config.S).hibernate == true
    error_message = "hibernate true is in the config"
  }
}

# The branded waiting page (router 0.35.0): the PAGE item, written without a by (a Terraform item), only when set.
run "waiting_page_is_not_written_by_default" {
  command = apply
  assert {
    condition     = length(aws_dynamodb_table_item.page) == 0
    error_message = "no waiting_page, no PAGE item"
  }
}

run "a_template_waiting_page_is_written_to_its_own_item_without_a_by" {
  command = apply
  variables {
    waiting_page = {
      mode        = "template"
      icon        = "none"
      title       = "Acme portal"
      description = "Our test environment sleeps at night.\nIt wakes on the first visit."
    }
  }
  assert {
    condition     = jsondecode(aws_dynamodb_table_item.page[0].item).pk.S == "WL#shop" && jsondecode(aws_dynamodb_table_item.page[0].item).sk.S == "PAGE"
    error_message = "WL#<id> / PAGE"
  }
  assert {
    condition     = jsondecode(jsondecode(aws_dynamodb_table_item.page[0].item).page.S) == { mode = "template", icon = "none", title = "Acme portal", description = "Our test environment sleeps at night.\nIt wakes on the first visit." }
    error_message = "the document is the module's object"
  }
  assert {
    condition     = !contains(keys(jsondecode(aws_dynamodb_table_item.page[0].item)), "by") && !contains(keys(jsondecode(aws_dynamodb_table_item.page[0].item)), "at")
    error_message = "no by: the router knows Terraform wrote it"
  }
  assert {
    condition     = !contains(keys(jsondecode(jsondecode(aws_dynamodb_table_item.config.item).config.S)), "waitingPage")
    error_message = "never a field of the configuration, which is scanned at every check"
  }
}

run "null_fields_are_dropped_and_a_custom_page_is_its_html" {
  command = apply
  variables {
    waiting_page = {
      mode = "custom"
      html = "<!doctype html><p data-dormeto=\"status\"></p>"
    }
  }
  assert {
    condition     = jsondecode(jsondecode(aws_dynamodb_table_item.page[0].item).page.S) == { mode = "custom", html = "<!doctype html><p data-dormeto=\"status\"></p>" }
    error_message = "no null icon, title or description"
  }
}

run "a_template_waiting_page_takes_an_inline_icon" {
  command = plan
  variables {
    waiting_page = {
      mode = "template"
      icon = "data:image/png;base64,iVBORw0KGgo="
    }
  }
}

run "waiting_page_mode_is_template_or_custom" {
  command = plan
  variables {
    waiting_page = { mode = "pdf" }
  }
  expect_failures = [var.waiting_page]
}

run "waiting_page_title_at_most_80_characters_on_one_line" {
  command = plan
  variables {
    waiting_page = { mode = "template", title = join("", [for i in range(81) : "x"]) }
  }
  expect_failures = [var.waiting_page]
}

run "waiting_page_title_is_one_line" {
  command = plan
  variables {
    waiting_page = { mode = "template", title = "two\nlines" }
  }
  expect_failures = [var.waiting_page]
}

run "waiting_page_description_at_most_500_characters" {
  command = plan
  variables {
    waiting_page = { mode = "template", description = join("", [for i in range(501) : "x"]) }
  }
  expect_failures = [var.waiting_page]
}

run "waiting_page_icon_is_auto_none_or_an_image_data_uri" {
  command = plan
  variables {
    waiting_page = { mode = "template", icon = "https://example.com/i.png" }
  }
  expect_failures = [var.waiting_page]
}

run "waiting_page_template_has_no_html" {
  command = plan
  variables {
    waiting_page = { mode = "template", html = "<p>x</p>" }
  }
  expect_failures = [var.waiting_page]
}

run "waiting_page_custom_has_html_and_nothing_else" {
  command = plan
  variables {
    waiting_page = { mode = "custom", title = "Acme", html = "<p>x</p>" }
  }
  expect_failures = [var.waiting_page]
}

run "waiting_page_custom_needs_html" {
  command = plan
  variables {
    waiting_page = { mode = "custom" }
  }
  expect_failures = [var.waiting_page]
}

run "waiting_page_html_is_not_blank_and_at_most_256_kib" {
  command = plan
  variables {
    waiting_page = { mode = "custom", html = "  \n " }
  }
  expect_failures = [var.waiting_page]
}

run "waiting_page_html_over_256_kib_is_refused" {
  command = plan
  variables {
    waiting_page = { mode = "custom", html = "${join("", [for i in range(256) : format("%01024d", 0)])}0" }
  }
  expect_failures = [var.waiting_page]
}

run "waiting_page_html_of_exactly_256_kib_is_accepted" {
  command = plan
  variables {
    waiting_page = { mode = "custom", html = join("", [for i in range(256) : format("%01024d", 0)]) }
  }
}
