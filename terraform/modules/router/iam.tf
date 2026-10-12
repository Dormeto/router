data "aws_region" "current" {}
data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  arn_prefix = "arn:${data.aws_partition.current.partition}"
  region     = data.aws_region.current.region
  account_id = data.aws_caller_identity.current.account_id
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
    actions   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
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
      actions   = ["ec2:DescribeInstances", "elasticloadbalancing:DescribeRules", "elasticloadbalancing:DescribeTargetHealth", "cloudwatch:GetMetricData", "autoscaling:DescribeAutoScalingGroups", "tag:GetResources", "ecs:DescribeServices", "application-autoscaling:DescribeScalableTargets"]
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
    actions   = ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:Scan"]
    resources = [aws_dynamodb_table.router.arn]
  }
  statement {
    actions   = ["ec2:DescribeInstances", "elasticloadbalancing:DescribeRules", "elasticloadbalancing:DescribeTargetHealth", "cloudwatch:GetMetricData"]
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
    actions   = ["autoscaling:DescribeAutoScalingGroups", "tag:GetResources", "ecs:DescribeServices", "application-autoscaling:DescribeScalableTargets"]
    resources = ["*"]
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
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.controller_failures.arn]
  }
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.controller.arn}:*"]
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
      values   = ["${local.arn_prefix}:scheduler:${local.region}:${local.account_id}:schedule/default/${var.name}-check"]
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
}

resource "aws_iam_role_policy" "scheduler" {
  name   = "scheduler"
  role   = aws_iam_role.scheduler.id
  policy = data.aws_iam_policy_document.scheduler.json
}
