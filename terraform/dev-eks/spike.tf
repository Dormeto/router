# The spike (vision docs/plans/2026-10-11-kubernetes.md, K0.2): a Lambda function answering "waker" behind a Lambda
# target group, the stand-in for Dormeto's waker that a second Ingress in the demo group forwards to.
data "archive_file" "spike" {
  count       = var.spike ? 1 : 0
  type        = "zip"
  output_path = "${path.module}/.build/spike.zip"

  source {
    filename = "index.mjs"
    content  = "export const handler = async () => ({ statusCode: 200, statusDescription: '200 OK', headers: { 'content-type': 'text/plain' }, isBase64Encoded: false, body: 'waker\\n' });\n"
  }
}

resource "aws_iam_role" "spike" {
  count = var.spike ? 1 : 0
  name  = "${var.name}-spike"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_lambda_function" "spike" {
  count            = var.spike ? 1 : 0
  function_name    = "${var.name}-spike-waker"
  role             = aws_iam_role.spike[0].arn
  runtime          = "nodejs24.x"
  handler          = "index.handler"
  filename         = data.archive_file.spike[0].output_path
  source_code_hash = data.archive_file.spike[0].output_base64sha256
}

resource "aws_lb_target_group" "spike" {
  count       = var.spike ? 1 : 0
  name        = "${var.name}-spike-waker"
  target_type = "lambda"
}

resource "aws_lambda_permission" "spike" {
  count         = var.spike ? 1 : 0
  statement_id  = "AllowAlb"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.spike[0].function_name
  principal     = "elasticloadbalancing.amazonaws.com"
  source_arn    = aws_lb_target_group.spike[0].arn
}

resource "aws_lb_target_group_attachment" "spike" {
  count            = var.spike ? 1 : 0
  target_group_arn = aws_lb_target_group.spike[0].arn
  target_id        = aws_lambda_function.spike[0].arn
  depends_on       = [aws_lambda_permission.spike]
}
