/**
 * The Stella brand in the new account: nothing but its own Resource Group
 * and one DNS alias record.
 *
 * Old account: this stack also held a `nextjs-site` (Lambda) module that
 * never served traffic — stella.oxagen.sh was actually served by Caddy on
 * the shared node, via a record hand-overridden outside Terraform. That
 * whole trap doesn't exist here: `stella.oxagen.sh` is a plain alias to
 * Oxagen's ALB from the start, same as docs/app/api/mcp, just declared in
 * Stella's own state so the resource carries the right Brand tag.
 *
 * `alb_dns_name`/`alb_zone_id` are copied by hand from
 * `stacks-new/oxagen`'s `alb` output, same pattern this repository already
 * uses for `parent_zone_id` — a plain value instead of
 * `terraform_remote_state`, so this stack's plans do not depend on Oxagen's
 * state file being present and readable.
 */

locals {
  brand = "stella"
}

module "brand" {
  source = "../../modules/brand-group"

  brand        = local.brand
  display_name = "Stella"
}

resource "aws_route53_record" "stella" {
  zone_id = var.parent_zone_id
  name    = "stella.oxagen.sh"
  type    = "A"

  alias {
    name                   = var.alb_dns_name
    zone_id                = var.alb_zone_id
    evaluate_target_health = true
  }
}
