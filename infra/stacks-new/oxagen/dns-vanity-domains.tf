/**
 * Vanity domains: names Oxagen holds so that a person who types one of them
 * reaches Oxagen, and that serve nothing of their own. `oxagen.dev`, bought on
 * 2026-09-27 (#4629), sends its visitors to the docs, per `var.vanity_domains`.
 *
 * `oxagen.app` was bought the same day and began here as a redirect to the
 * app. Its zone, records, and certificate moved to dns-oxagen-app.tf for the
 * app's move (ADR-215). The move stopped (ADR-236), and that file answers the
 * name with the same kind of redirect, from the ALB.
 *
 * Each vanity domain gets three kinds of record:
 *
 *   - A redirect for the apex and `www`, through `modules/redirect-site`.
 *   - Records that say the domain sends no mail. A domain named like the
 *     product with no SPF or DMARC record lets anyone send mail that claims
 *     to come from it, and gives receivers no policy telling them to refuse.
 *   - A CAA record naming Amazon alone, because ACM is the only issuer these
 *     names need.
 *
 * The redirect is a 302, and that is deliberate. Clients may keep a 301
 * forever. That is what let `oxagen.app` become the app's host: a browser
 * that had cached `oxagen.app -> app.oxagen.sh` as permanent would bounce
 * between the two hosts once the app moved. A 302 keeps that decision open.
 * Switch to 301 once the target is settled.
 *
 * These domains are registered at Vercel, which Terraform has no credentials
 * for here, so a person moves the nameservers by hand. The order matters:
 *
 *   1. Apply with `delegated = false`. This creates each zone and its records
 *      and nothing that depends on the zone answering publicly.
 *   2. Paste `tofu output vanity_domain_nameservers` into Vercel under
 *      Domains, then the domain, then Nameservers.
 *   3. Once `dig NS <domain>` returns `awsdns` hosts, set `delegated = true`
 *      and apply again. That creates the certificate, the CloudFront
 *      distribution, and the alias records.
 *
 * Step 3 before step 2 fails the apply. ACM validates the certificate through
 * the zone, so while the world still asks Vercel, validation waits until its
 * timeout. Between steps 2 and 3 the domain resolves to nothing, which is no
 * worse than the parking page it replaces. `.app` and `.dev` are on the HSTS
 * preload list as whole TLDs, so no host under them works over plain HTTP.
 * A redirect without a certificate would not be reachable either.
 */

resource "aws_route53_zone" "vanity" {
  for_each = var.vanity_domains

  name    = each.key
  comment = "Oxagen: redirects to ${each.value.redirect_to} and sends no mail"
}

# ---------------------------------------------------------------------------
# No mail
# ---------------------------------------------------------------------------

# A null MX (RFC 7505) tells senders the domain accepts no mail, so a message
# addressed to it fails at once instead of retrying for days.
resource "aws_route53_record" "vanity_null_mx" {
  for_each = aws_route53_zone.vanity

  zone_id = each.value.zone_id
  name    = each.key
  type    = "MX"
  ttl     = 3600
  records = ["0 ."]
}

# No host may send as this domain.
resource "aws_route53_record" "vanity_spf" {
  for_each = aws_route53_zone.vanity

  zone_id = each.value.zone_id
  name    = each.key
  type    = "TXT"
  ttl     = 3600
  records = ["v=spf1 -all"]
}

# Receivers that honour DMARC refuse anything claiming this domain or a
# subdomain of it. There is no `rua` address because nothing legitimate sends
# from here, so a report could only describe spoofing, and nobody reads that
# mailbox. Remove these three records together if a domain starts sending.
resource "aws_route53_record" "vanity_dmarc" {
  for_each = aws_route53_zone.vanity

  zone_id = each.value.zone_id
  name    = "_dmarc.${each.key}"
  type    = "TXT"
  ttl     = 3600
  records = ["v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s"]
}

# ---------------------------------------------------------------------------
# Certificate authority authorisation
# ---------------------------------------------------------------------------

# Narrower than `var.caa_issuers`, which also names Google, Sectigo and Let's
# Encrypt because services under `oxagen.sh` hold their certificates. Nothing
# under these domains does. Add an issuer here when something does.
resource "aws_route53_record" "vanity_caa" {
  for_each = aws_route53_zone.vanity

  zone_id = each.value.zone_id
  name    = each.key
  type    = "CAA"
  ttl     = 300
  records = ["0 issue \"amazon.com\""]
}

# ---------------------------------------------------------------------------
# The redirects
# ---------------------------------------------------------------------------

module "vanity_redirect" {
  source = "../../modules/redirect-site"

  for_each = { for domain, cfg in var.vanity_domains : domain => cfg if cfg.delegated }

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  name                   = "${replace(each.key, ".", "-")}-redirect"
  domain_name            = each.key
  alternate_domain_names = ["www.${each.key}"]
  hosted_zone_id         = aws_route53_zone.vanity[each.key].zone_id
  redirect_to            = each.value.redirect_to
  status_code            = 302

  tags = { Brand = local.brand }
}
