/**
 * The Context Graph Protocol brand, replicated into the new account.
 *
 * Identical in shape to `stacks/cgp` in the old account — CGP is fully
 * self-contained (owns its own zone, shares nothing with Oxagen or Stella) —
 * so this is the same module call against a different account's provider and
 * backend. See stacks/cgp/main.tf for the design notes; they still apply.
 */

locals {
  brand = "cgp"
}

module "brand" {
  source = "../../modules/brand-group"

  brand        = local.brand
  display_name = "Context Graph Protocol"
}

resource "aws_route53_zone" "cgp" {
  name    = "contextgraphprotocol.org"
  comment = "Context Graph Protocol — microsite and specification"
}

resource "aws_route53_record" "caa" {
  zone_id = aws_route53_zone.cgp.zone_id
  name    = "contextgraphprotocol.org"
  type    = "CAA"
  ttl     = 300

  records = [for issuer in var.caa_issuers : "0 issue \"${issuer}\""]
}

module "site" {
  source = "../../modules/static-site"

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  name                    = "cgp-site"
  bucket_name             = "cgp-site-${var.account_id}"
  domain_name             = "contextgraphprotocol.org"
  alternate_domain_names  = ["www.contextgraphprotocol.org"]
  hosted_zone_id          = aws_route53_zone.cgp.zone_id
  url_rewrite_mode        = "html_suffix"
  immutable_path_patterns = ["/_next/static/*"]

  tags = { Brand = local.brand }
}
