/**
 * Mail, DKIM, and domain-ownership records — unchanged from the old account,
 * because moving which AWS account owns the DNS zone does not change where
 * mail is routed or which services still sign it. `imported-dns.json` here is
 * byte-identical to the old account's copy; see that file's own header for
 * why it is checked in rather than regenerated.
 *
 * See stacks/oxagen/dns.tf in the old account for the CAA/wildcard trap this
 * repeats deliberately: no wildcard CNAME may exist in this zone while any
 * certificate here is issued or renewed by ACM.
 */

locals {
  imported_dns = jsondecode(file("${path.module}/imported-dns.json"))
}

resource "aws_route53_record" "imported" {
  for_each = local.imported_dns

  zone_id = aws_route53_zone.oxagen_sh.zone_id
  name    = each.value.name == "" ? "oxagen.sh" : "${each.value.name}.oxagen.sh"
  type    = each.value.type
  ttl     = each.value.ttl
  records = each.value.records
}

resource "aws_route53_record" "legacy_host" {
  for_each = var.legacy_subdomains

  zone_id = aws_route53_zone.oxagen_sh.zone_id
  name    = "${each.key}.oxagen.sh"
  type    = "CNAME"
  ttl     = 300
  records = [each.value]
}

resource "aws_route53_record" "caa" {
  zone_id = aws_route53_zone.oxagen_sh.zone_id
  name    = "oxagen.sh"
  type    = "CAA"
  ttl     = 300

  records = [for issuer in var.caa_issuers : "0 issue \"${issuer}\""]
}
