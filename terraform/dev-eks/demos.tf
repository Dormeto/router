# The acceptance's demo workloads (the spec's section 12), in a local chart: four behind one IngressGroup (a Deployment,
# a StatefulSet, one with an HPA, one on Fargate), and as the variables say one behind a lone Ingress and one behind a
# TargetGroupBinding.
locals {
  group = "${var.name}-group"
  hosts = concat(["web", "cache", "api", "docs"], var.lone_ingress ? ["solo"] : [])
}

resource "aws_acm_certificate" "demos" {
  domain_name       = "*.${var.domain}"
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "validation" {
  for_each = { for o in aws_acm_certificate.demos.domain_validation_options : o.domain_name => o }

  zone_id = var.zone_id
  name    = each.value.resource_record_name
  type    = each.value.resource_record_type
  records = [each.value.resource_record_value]
  ttl     = 300
}

resource "aws_acm_certificate_validation" "demos" {
  certificate_arn         = aws_acm_certificate.demos.arn
  validation_record_fqdns = [for r in aws_route53_record.validation : r.fqdn]
}

resource "helm_release" "demos" {
  name             = "demos"
  namespace        = "demo"
  create_namespace = true
  chart            = "${path.module}/charts/demos"
  timeout          = 900

  values = [yamlencode({
    domain             = var.domain
    group              = local.group
    certificateArn     = aws_acm_certificate_validation.demos.certificate_arn
    lone               = var.lone_ingress
    targetGroupBinding = var.target_group_binding ? aws_lb_target_group.bind[0].arn : ""
    bindSecurityGroup  = var.target_group_binding ? aws_security_group.bind[0].id : ""
  })]

  depends_on = [terraform_data.lbc_resources_gone, helm_release.karpenter_config, module.eks]
}

# The controller creates the group's ALB (and the lone Ingress's) once the demos exist: wait for them, then name them.
resource "terraform_data" "albs" {
  triggers_replace = [helm_release.demos.id, var.lone_ingress]

  provisioner "local-exec" {
    command = <<-EOT
      for stack in ${local.group} ${var.lone_ingress ? "demo/solo" : ""}; do
        for i in $(seq 60); do
          n=$(aws resourcegroupstaggingapi get-resources --region ${var.region} --profile ${var.aws_profile} \
            --tag-filters Key=elbv2.k8s.aws/cluster,Values=${var.name} Key=ingress.k8s.aws/stack,Values=$stack \
            --resource-type-filters elasticloadbalancing:loadbalancer --query 'length(ResourceTagMappingList)' --output text)
          [ "$n" = "1" ] && break
          [ "$i" = "60" ] && { echo "no load balancer for $stack after 10 minutes" >&2; exit 1; }
          sleep 10
        done
      done
    EOT
  }
}

data "aws_lb" "group" {
  tags       = { "elbv2.k8s.aws/cluster" = var.name, "ingress.k8s.aws/stack" = local.group }
  depends_on = [terraform_data.albs]
}

data "aws_lb" "solo" {
  count      = var.lone_ingress ? 1 : 0
  tags       = { "elbv2.k8s.aws/cluster" = var.name, "ingress.k8s.aws/stack" = "demo/solo" }
  depends_on = [terraform_data.albs]
}

resource "aws_route53_record" "demos" {
  for_each = toset(local.hosts)

  zone_id = var.zone_id
  name    = "${each.key}.${var.domain}"
  type    = "A"

  alias {
    name                   = each.key == "solo" ? data.aws_lb.solo[0].dns_name : data.aws_lb.group.dns_name
    zone_id                = each.key == "solo" ? data.aws_lb.solo[0].zone_id : data.aws_lb.group.zone_id
    evaluate_target_health = false
  }
}
