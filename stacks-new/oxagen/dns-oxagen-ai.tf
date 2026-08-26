/**
 * oxagen.ai, replicated into the new account. Same structure as
 * stacks/oxagen/dns-oxagen-ai.tf in the old account: a redirect for the
 * website, live mail, and six A records pointing at a Google Cloud load
 * balancer this migration does not touch (see AGENTS-equivalent scope note —
 * this is Amazon infrastructure changing accounts, not a rehost of a service
 * that was never on AWS).
 */

resource "aws_route53_zone" "oxagen_ai" {
  name    = "oxagen.ai"
  comment = "oxagen.ai — retired as a website, redirects to oxagen.sh; still carries live mail and services"
}

locals {
  imported_dns_oxagen_ai = jsondecode(file("${path.module}/imported-dns-oxagen-ai.json"))
}

resource "aws_route53_record" "oxagen_ai_imported" {
  for_each = local.imported_dns_oxagen_ai

  zone_id = aws_route53_zone.oxagen_ai.zone_id
  name    = each.value.name == "" ? "oxagen.ai" : "${each.value.name}.oxagen.ai"
  type    = each.value.type
  ttl     = each.value.ttl
  records = each.value.records
}

resource "aws_route53_record" "oxagen_ai_elsewhere" {
  for_each = var.oxagen_ai_elsewhere

  zone_id = aws_route53_zone.oxagen_ai.zone_id
  name    = "${each.key}.oxagen.ai"
  type    = "A"
  ttl     = 300
  records = [each.value]
}

resource "aws_route53_record" "oxagen_ai_caa" {
  zone_id = aws_route53_zone.oxagen_ai.zone_id
  name    = "oxagen.ai"
  type    = "CAA"
  ttl     = 300

  records = [for issuer in var.caa_issuers : "0 issue \"${issuer}\""]
}

module "oxagen_ai_redirect" {
  source = "../../modules/redirect-site"

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  name                   = "oxagen-ai-redirect"
  domain_name            = "oxagen.ai"
  alternate_domain_names = ["www.oxagen.ai"]
  hosted_zone_id         = aws_route53_zone.oxagen_ai.zone_id
  redirect_to            = var.oxagen_ai_redirect_to
  status_code            = 301

  tags = { Brand = local.brand }
}
