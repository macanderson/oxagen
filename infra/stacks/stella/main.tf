/**
 * The Stella brand: the documentation and marketing site at
 * `stella.oxagen.sh`.
 *
 * Stella is its own product and its own brand, but its hostname is a subdomain
 * of one the Oxagen stack owns. DNS naming and resource ownership are
 * separated here rather than conflated: every resource this stack creates is
 * tagged `Brand = stella`, lives in Stella's own Resource Group, and is
 * recorded in Stella's own Terraform state — while its two DNS records are
 * written into the `oxagen.sh` zone, because that is simply where the name
 * lives.
 *
 * The alternative, delegating `stella.oxagen.sh` to a zone of its own, would
 * buy tidier DNS ownership for an extra hosted zone and a delegation that has
 * to stay in step across two stacks. It is worth revisiting if Stella ever
 * takes an apex domain of its own; today it would be ceremony.
 *
 * The site runs on Lambda rather than as a static export because three of its
 * routes genuinely execute: `/api/hit` counts installs, `/install.sh` proxies
 * and counts the install script, and `/api/search` runs the docs search index.
 */

locals {
  brand = "stella"
}

module "brand" {
  source = "../../modules/brand-group"

  brand        = local.brand
  display_name = "Stella"
}

module "site" {
  source = "../../modules/nextjs-site"

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  name        = "stella-site"
  bucket_name = "stella-site-${var.account_id}"
  domain_name = "stella.oxagen.sh"
  region      = var.region

  # Written into the zone the Oxagen stack owns — see the note above.
  hosted_zone_id = var.parent_zone_id

  bundle_path = var.bundle_path
  bundle_hash = var.bundle_hash

  # The application sets its own Content-Security-Policy in `next.config.mjs`,
  # and an exported build is not in play here — the Next server runs, so its
  # `headers()` are applied per response. Adding one at the edge would either
  # duplicate it or, if overriding, quietly replace a policy the application
  # authored deliberately.
  content_security_policy = null

  environment = var.server_environment

  tags = { Brand = local.brand }
}
