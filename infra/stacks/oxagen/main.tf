/**
 * The Oxagen brand: the `oxagen.sh` DNS zone, the public marketing site, and
 * the documentation site.
 *
 * This stack owns the zone that the other two brands' subdomains live in
 * (`stella.oxagen.sh`, `cgp.oxagen.sh`), so it is applied first and exports
 * the zone id the others take as input. That is the only coupling between the
 * three stacks, and it runs in one direction: nothing here reads Stella's or
 * CGP's state.
 */

locals {
  brand = "oxagen"
}

module "brand" {
  source = "../../modules/brand-group"

  brand        = local.brand
  display_name = "Oxagen"
}

# ---------------------------------------------------------------------------
# DNS
# ---------------------------------------------------------------------------

# The zone is created empty and the domain's nameservers are repointed at it by
# hand at the registrar — the domains are registered with Vercel, which
# Terraform has no provider credentials for here. `tofu output nameservers` is
# what gets typed into that form.
resource "aws_route53_zone" "oxagen_sh" {
  name    = "oxagen.sh"
  comment = "Oxagen — apex, docs, and the subdomains delegated to other brands"
}

# ---------------------------------------------------------------------------
# oxagen.sh — the marketing site
# ---------------------------------------------------------------------------

# Hand-authored HTML with `read/index.html`-style subdirectories, so clean URLs
# resolve through the directory-index rule rather than a `.html` suffix.
module "web" {
  source = "../../modules/static-site"

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  name                   = "oxagen-web"
  bucket_name            = "oxagen-web-${var.account_id}"
  domain_name            = "oxagen.sh"
  alternate_domain_names = ["www.oxagen.sh"]
  hosted_zone_id         = aws_route53_zone.oxagen_sh.zone_id
  url_rewrite_mode       = "directory_index"
  not_found_path         = "/index.html"

  tags = { Brand = local.brand }
}

# ---------------------------------------------------------------------------
# docs.oxagen.sh — the documentation site
# ---------------------------------------------------------------------------

# A Next.js static export. Neither its `redirects()` nor its `rewrites()`
# survives an export — both are implemented by the Next server, which an
# exported site does not ship — so both are reproduced at the edge below,
# transcribed from `apps/docs/next.config.mjs`. They are the reason a URL that
# works on the current host keeps working after cutover.
# Runs on Lambda rather than shipping as files. The site is almost entirely
# prerendered, but `/api/search` serves the docs search index and `/sitemap.xml`
# is generated per request — and both its `redirects()` and its `rewrites()`
# are implemented by the Next server. A static export would have to reproduce
# all four at the edge; running the server keeps them the app's business, which
# is where they are already written and tested.
module "docs" {
  source = "../../modules/nextjs-site"

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  name        = "oxagen-docs"
  bucket_name = "oxagen-docs-${var.account_id}"
  domain_name = "docs.oxagen.sh"
  region      = var.region

  hosted_zone_id = aws_route53_zone.oxagen_sh.zone_id

  bundle_path = var.docs_bundle_path
  bundle_hash = var.docs_bundle_hash

  tags = { Brand = local.brand }
}
