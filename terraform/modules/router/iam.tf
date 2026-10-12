data "aws_region" "current" {}
data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  arn_prefix = "arn:${data.aws_partition.current.partition}"
  # s3://bucket/key of the IP lists stored in S3, as object ARNs.
  s3_list_objects = [for l in var.ip_lists : "${local.arn_prefix}:s3:::${trimprefix(l.url, "s3://")}" if startswith(l.url, "s3://")]
  region          = data.aws_region.current.region
  account_id      = data.aws_caller_identity.current.account_id
}

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "waker" {
  name               = "${var.name}-waker"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "waker" {
  statement {
    # Query: IP list parts and, for the admin dashboard, statistics.
    actions   = ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:Query"]
    resources = [aws_dynamodb_table.router.arn]
  }
  statement {
    actions   = ["lambda:InvokeFunction"]
    resources = ["${local.arn_prefix}:lambda:${local.region}:${local.account_id}:function:${var.name}-controller"]
  }
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.waker.arn}:*"]
  }
  dynamic "statement" {
    for_each = var.admin_enabled ? [1] : []
    content {
      sid       = "AdminDashboardRead"
      actions   = ["ec2:DescribeInstances", "elasticloadbalancing:DescribeRules", "elasticloadbalancing:DescribeTargetHealth", "elasticloadbalancing:DescribeTargetGroups", "elasticloadbalancing:DescribeListeners", "elasticloadbalancing:DescribeTags", "cloudwatch:GetMetricData", "autoscaling:DescribeAutoScalingGroups", "tag:GetResources", "ecs:DescribeServices", "application-autoscaling:DescribeScalableTargets", "rds:DescribeDBInstances", "rds:DescribeDBClusters"]
      resources = ["*"]
    }
  }
}

resource "aws_iam_role_policy" "waker" {
  name   = "waker"
  role   = aws_iam_role.waker.id
  policy = data.aws_iam_policy_document.waker.json
}

resource "aws_iam_role" "controller" {
  name               = "${var.name}-controller"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "controller" {
  statement {
    # Query: daily statistics (manager status and list). DeleteItem: pause records (resume, automatic resume).
    actions   = ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:Scan", "dynamodb:Query", "dynamodb:DeleteItem"]
    resources = [aws_dynamodb_table.router.arn]
  }
  statement {
    # Describes: the rules of a workload are found from its target group (load balancer, listeners, rules, tags);
    # router health: the account's Lambda concurrency limit.
    actions   = ["ec2:DescribeInstances", "elasticloadbalancing:DescribeRules", "elasticloadbalancing:DescribeTargetHealth", "elasticloadbalancing:DescribeTargetGroups", "elasticloadbalancing:DescribeListeners", "elasticloadbalancing:DescribeTags", "cloudwatch:GetMetricData", "lambda:GetAccountSettings"]
    resources = ["*"]
  }
  statement {
    actions   = ["ec2:StartInstances", "ec2:StopInstances"]
    resources = ["${local.arn_prefix}:ec2:${local.region}:${local.account_id}:instance/*"]
    condition {
      test     = "Null"
      variable = "aws:ResourceTag/dormeto:workload"
      values   = ["false"]
    }
  }
  statement {
    actions   = ["elasticloadbalancing:ModifyRule"]
    resources = ["${local.arn_prefix}:elasticloadbalancing:${local.region}:${local.account_id}:listener-rule/app/*"]
    # Only rules onboarded in Dormeto (tagged dormeto:workload).
    condition {
      test     = "Null"
      variable = "aws:ResourceTag/dormeto:workload"
      values   = ["false"]
    }
  }
  statement {
    actions   = ["autoscaling:DescribeAutoScalingGroups", "tag:GetResources", "ecs:DescribeServices", "application-autoscaling:DescribeScalableTargets", "rds:DescribeDBInstances", "rds:DescribeDBClusters"]
    resources = ["*"]
  }
  statement {
    actions   = ["rds:StartDBInstance", "rds:StopDBInstance", "rds:StartDBCluster", "rds:StopDBCluster"]
    resources = ["${local.arn_prefix}:rds:${local.region}:${local.account_id}:db:*", "${local.arn_prefix}:rds:${local.region}:${local.account_id}:cluster:*"]
    # Only databases onboarded in Dormeto (tagged dormeto:workload).
    condition {
      test     = "Null"
      variable = "aws:ResourceTag/dormeto:workload"
      values   = ["false"]
    }
  }
  statement {
    actions   = ["ecs:UpdateService"]
    resources = ["${local.arn_prefix}:ecs:${local.region}:${local.account_id}:service/*/*"]
    # Only services onboarded in Dormeto (tagged dormeto:workload).
    condition {
      test     = "Null"
      variable = "aws:ResourceTag/dormeto:workload"
      values   = ["false"]
    }
  }
  statement {
    actions   = ["application-autoscaling:RegisterScalableTarget"]
    resources = ["${local.arn_prefix}:application-autoscaling:${local.region}:${local.account_id}:scalable-target/*"]
  }
  statement {
    actions   = ["autoscaling:UpdateAutoScalingGroup", "autoscaling:SuspendProcesses", "autoscaling:ResumeProcesses"]
    resources = ["${local.arn_prefix}:autoscaling:${local.region}:${local.account_id}:autoScalingGroup:*:autoScalingGroupName/*"]
    # Only groups onboarded in Dormeto (tagged dormeto:workload).
    condition {
      test     = "Null"
      variable = "aws:ResourceTag/dormeto:workload"
      values   = ["false"]
    }
  }
  statement {
    # The scheduled check fans naps out to the controller itself, and asks the onboarder to repair drift.
    actions   = ["lambda:InvokeFunction"]
    resources = ["${local.arn_prefix}:lambda:${local.region}:${local.account_id}:function:${var.name}-controller", "${local.arn_prefix}:lambda:${local.region}:${local.account_id}:function:${var.name}-onboarder"]
  }
  statement {
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.controller_failures.arn]
  }
  statement {
    # Router health: messages waiting in the failure queues.
    actions   = ["sqs:GetQueueAttributes"]
    resources = [aws_sqs_queue.controller_failures.arn, aws_sqs_queue.check_failures.arn]
  }
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.controller.arn}:*"]
  }
  dynamic "statement" {
    # IP lists given as s3:// URIs: read their objects only (a bucket in another account also needs its bucket policy).
    for_each = length(local.s3_list_objects) > 0 ? [1] : []
    content {
      sid       = "IpListObjects"
      actions   = ["s3:GetObject"]
      resources = local.s3_list_objects
    }
  }
}

resource "aws_iam_role_policy" "controller" {
  name   = "controller"
  role   = aws_iam_role.controller.id
  policy = data.aws_iam_policy_document.controller.json
}

data "aws_iam_policy_document" "scheduler_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      # EventBridge Scheduler presents its schedule group as the source, not the schedule: pinning the schedule ARN
      # broke every scheduled check from 2026-10-03 to 2026-10-04 (target errors, no nap).
      values = ["${local.arn_prefix}:scheduler:${local.region}:${local.account_id}:schedule-group/default"]
    }
  }
}

resource "aws_iam_role" "scheduler" {
  name               = "${var.name}-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
}

data "aws_iam_policy_document" "scheduler" {
  statement {
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.controller.arn]
  }
  statement {
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.check_failures.arn]
  }
}

resource "aws_iam_role_policy" "scheduler" {
  name   = "scheduler"
  role   = aws_iam_role.scheduler.id
  policy = data.aws_iam_policy_document.scheduler.json
}

resource "aws_iam_role" "onboarder" {
  name               = "${var.name}-onboarder"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

locals {
  # The only tag keys the onboarder may add or remove on customer resources and on its waker target groups.
  onboarder_tag_keys = ["dormeto:workload", "dormeto:tagged", "dormeto:router", "dormeto:shadows"]
}

data "aws_iam_policy_document" "onboarder" {
  statement {
    # Workload configuration, runtime state and pauses (offboarding deletes them).
    actions   = ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:Query", "dynamodb:Scan", "dynamodb:DeleteItem"]
    resources = [aws_dynamodb_table.router.arn]
  }
  statement {
    # Finding the rules and the backends of a target group, whatever their tags.
    actions   = ["elasticloadbalancing:DescribeTargetGroups", "elasticloadbalancing:DescribeListeners", "elasticloadbalancing:DescribeRules", "elasticloadbalancing:DescribeTags", "elasticloadbalancing:DescribeTargetHealth", "ec2:DescribeInstances", "autoscaling:DescribeAutoScalingGroups", "ecs:ListClusters", "ecs:ListServices", "ecs:DescribeServices", "rds:DescribeDBInstances", "rds:DescribeDBClusters"]
    resources = ["*"]
  }
  statement {
    # Waker target groups only (named after the router).
    actions   = ["elasticloadbalancing:CreateTargetGroup", "elasticloadbalancing:ModifyTargetGroupAttributes", "elasticloadbalancing:DeleteTargetGroup", "elasticloadbalancing:RegisterTargets", "elasticloadbalancing:DeregisterTargets"]
    resources = ["${local.arn_prefix}:elasticloadbalancing:${local.region}:${local.account_id}:targetgroup/${var.name}-*/*"]
  }
  statement {
    # Instrumenting a customer rule in place (untagged until then), restoring it, mirroring a shadow's conditions.
    actions   = ["elasticloadbalancing:ModifyRule"]
    resources = ["${local.arn_prefix}:elasticloadbalancing:${local.region}:${local.account_id}:listener-rule/app/*"]
  }
  statement {
    # Shadow rules: created on the customer's listener (tagged on creation).
    actions   = ["elasticloadbalancing:CreateRule"]
    resources = ["${local.arn_prefix}:elasticloadbalancing:${local.region}:${local.account_id}:listener/app/*", "${local.arn_prefix}:elasticloadbalancing:${local.region}:${local.account_id}:listener-rule/app/*"]
  }
  statement {
    # Shadow rules only: moved before their customer rule again, deleted at offboarding.
    actions   = ["elasticloadbalancing:DeleteRule", "elasticloadbalancing:SetRulePriorities"]
    resources = ["${local.arn_prefix}:elasticloadbalancing:${local.region}:${local.account_id}:listener-rule/app/*"]
    condition {
      test     = "Null"
      variable = "aws:ResourceTag/dormeto:workload"
      values   = ["false"]
    }
  }
  statement {
    actions = ["elasticloadbalancing:AddTags", "elasticloadbalancing:RemoveTags"]
    resources = [
      "${local.arn_prefix}:elasticloadbalancing:${local.region}:${local.account_id}:listener-rule/app/*",
      "${local.arn_prefix}:elasticloadbalancing:${local.region}:${local.account_id}:targetgroup/${var.name}-*/*",
    ]
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "aws:TagKeys"
      values   = local.onboarder_tag_keys
    }
  }
  statement {
    # Backends: the workload tag and the onboarder marker only.
    actions = ["ec2:CreateTags", "ec2:DeleteTags", "autoscaling:CreateOrUpdateTags", "autoscaling:DeleteTags", "ecs:TagResource", "ecs:UntagResource", "rds:AddTagsToResource", "rds:RemoveTagsFromResource"]
    resources = [
      "${local.arn_prefix}:ec2:${local.region}:${local.account_id}:instance/*",
      "${local.arn_prefix}:autoscaling:${local.region}:${local.account_id}:autoScalingGroup:*:autoScalingGroupName/*",
      "${local.arn_prefix}:ecs:${local.region}:${local.account_id}:service/*/*",
      "${local.arn_prefix}:rds:${local.region}:${local.account_id}:db:*",
      "${local.arn_prefix}:rds:${local.region}:${local.account_id}:cluster:*",
    ]
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "aws:TagKeys"
      values   = local.onboarder_tag_keys
    }
  }
  statement {
    actions   = ["lambda:AddPermission", "lambda:RemovePermission"]
    resources = [aws_lambda_function.waker.arn]
  }
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.onboarder.arn}:*"]
  }
}

resource "aws_iam_role_policy" "onboarder" {
  name   = "onboarder"
  role   = aws_iam_role.onboarder.id
  policy = data.aws_iam_policy_document.onboarder.json
}
