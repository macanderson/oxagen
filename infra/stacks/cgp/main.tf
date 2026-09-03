/**
 * The Context Graph Protocol brand: its own DNS zone and its microsite.
 *
 * CGP is the most self-contained of the three — it owns
 * `contextgraphprotocol.org` outright and shares nothing with the other
 * stacks, so this stack reads no other brand's state and exports nothing they
 * consume.
 *
 * The site is a Next.js app whose every route prerenders, so it ships as a
 * static export behind CloudFront rather than needing a server.
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

# The previous zone authorised three certificate authorities and Amazon was
# not among them, which would have blocked ACM from issuing here at all. See
# the Oxagen stack's dns.tf for the full argument; the same trap applies to
# every domain being moved.
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
