/**
 * oxagen.app, the production web app's own domain (ADR-215).
 *
 * The name was bought at Vercel on 2026-09-27, in the `oxagen-inc` team, and
 * came into Route 53 as a vanity redirect to app.oxagen.sh
 * (dns-vanity-domains.tf, #4631 and #4641). Vercel stays the registrar, and
 * the registry has listed this zone's nameservers since 2026-09-28.
 *
 * This file takes the name out of the vanity set without recreating anything
 * the delegation or the certificate depends on. The `moved` blocks at the end
 * re-address the zone, its mail and CAA records, the certificate the redirect
 * was served with, and that certificate's validation records. A new zone would
 * come with new nameservers while the registrar still named the old ones.
 *
 * What changes: the certificate joins the ALB's HTTPS listener, and the apex
 * and www records move from the CloudFront redirect to the ALB. The redirect's
 * distribution, function, header policy, and IPv6 records are destroyed. The
 * ALB has no IPv6 address, so the names lose their AAAA records, as
 * app.oxagen.sh never had any.
 *
 * Until the cutover, the ALB answers both names itself with a 302 to the same
 * path on app.oxagen.sh, which is the job the CloudFront redirect did. That
 * keeps this change independent of Caddyfile.alb, which reaches the node only
 * when someone installs it by hand. The cutover deletes the rule once Caddy
 * routes both names to the app.
 */

resource "aws_route53_zone" "oxagen_app" {
  name    = "oxagen.app"
  comment = "Oxagen: the production web app. Sends no mail."
}

# ---------------------------------------------------------------------------
# No mail, and Amazon alone may issue certificates
# ---------------------------------------------------------------------------

# The same records dns-vanity-domains.tf gives every vanity domain, carried
# over unchanged: the app sends its mail from other domains. Remove the three
# mail records together if oxagen.app ever starts sending.
resource "aws_route53_record" "oxagen_app_null_mx" {
  zone_id = aws_route53_zone.oxagen_app.zone_id
  name    = "oxagen.app"
  type    = "MX"
  ttl     = 3600
  records = ["0 ."]
}

resource "aws_route53_record" "oxagen_app_spf" {
  zone_id = aws_route53_zone.oxagen_app.zone_id
  name    = "oxagen.app"
  type    = "TXT"
  ttl     = 3600
  records = ["v=spf1 -all"]
}

resource "aws_route53_record" "oxagen_app_dmarc" {
  zone_id = aws_route53_zone.oxagen_app.zone_id
  name    = "_dmarc.oxagen.app"
  type    = "TXT"
  ttl     = 3600
  records = ["v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s"]
}

resource "aws_route53_record" "oxagen_app_caa" {
  zone_id = aws_route53_zone.oxagen_app.zone_id
  name    = "oxagen.app"
  type    = "CAA"
  ttl     = 300
  records = ["0 issue \"amazon.com\""]
}

# ---------------------------------------------------------------------------
# Certificate
# ---------------------------------------------------------------------------

# The certificate the CloudFront redirect was served with, adopted rather than
# requested again, because it is issued and its validation records are in the
# zone. It keeps the us-east-1 provider alias it was created through. The ALB
# is in us-east-1 as well, so its listener can use it.
resource "aws_acm_certificate" "oxagen_app" {
  provider = aws.us_east_1

  domain_name               = "oxagen.app"
  subject_alternative_names = ["www.oxagen.app"]
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = { Brand = local.brand }
}

resource "aws_route53_record" "oxagen_app_cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.oxagen_app.domain_validation_options : dvo.domain_name => {
      name  = dvo.resource_record_name
      type  = dvo.resource_record_type
      value = dvo.resource_record_value
    }
  }

  zone_id         = aws_route53_zone.oxagen_app.zone_id
  name            = each.value.name
  type            = each.value.type
  ttl             = 60
  records         = [each.value.value]
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "oxagen_app" {
  provider = aws.us_east_1

  certificate_arn         = aws_acm_certificate.oxagen_app.arn
  validation_record_fqdns = [for r in aws_route53_record.oxagen_app_cert_validation : r.fqdn]
}

# Beside the app.oxagen.sh certificate rather than in it: the ALB picks one by
# SNI. A new name on `aws_acm_certificate.app` would replace the certificate
# every oxagen.sh host is served with.
resource "aws_lb_listener_certificate" "oxagen_app" {
  listener_arn    = aws_lb_listener.https.arn
  certificate_arn = aws_acm_certificate_validation.oxagen_app.certificate_arn
}

# ---------------------------------------------------------------------------
# Until the cutover
# ---------------------------------------------------------------------------

# The same path and query on app.oxagen.sh, as a 302, which a browser does not
# cache. Delete this rule, and its entry in the records' `depends_on` below, in
# the cutover PR (ADR-215, step 5). By then Caddy must route both names to the
# app, which answers them itself.
resource "aws_lb_listener_rule" "oxagen_app_until_cutover" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 10

  condition {
    host_header {
      values = ["oxagen.app", "www.oxagen.app"]
    }
  }

  action {
    type = "redirect"

    redirect {
      host        = "app.oxagen.sh"
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_302"
    }
  }

  tags = { Brand = local.brand }
}

# ---------------------------------------------------------------------------
# The ALB
# ---------------------------------------------------------------------------

# www answers only to redirect to the apex, which the app does.
resource "aws_route53_record" "oxagen_app_alb" {
  for_each = toset(["oxagen.app", "www.oxagen.app"])

  zone_id = aws_route53_zone.oxagen_app.zone_id
  name    = each.value
  type    = "A"

  alias {
    name                   = aws_lb.app.dns_name
    zone_id                = aws_lb.app.zone_id
    evaluate_target_health = true
  }

  # The records move to the ALB only after it holds the certificate and the
  # redirect rule, so neither name reaches it before it can answer.
  depends_on = [
    aws_lb_listener_certificate.oxagen_app,
    aws_lb_listener_rule.oxagen_app_until_cutover,
  ]
}

# ---------------------------------------------------------------------------
# The API
# ---------------------------------------------------------------------------

# api.oxagen.app serves the API beside api.oxagen.sh, which stays in service
# for the CLIs, webhooks, and OAuth callbacks that call it (ADR-215, amendment
# of 2026-09-28, #4709). No listener rule redirects it: a webhook POST and an
# Authorization header do not survive a redirect. Until Caddyfile.alb is
# installed with the name, Caddy answers it with a 404.
#
# The name has its own certificate. A new name on either certificate above
# would replace one the ALB is serving.
resource "aws_acm_certificate" "api_oxagen_app" {
  domain_name       = "api.oxagen.app"
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = { Brand = local.brand }
}

resource "aws_route53_record" "api_oxagen_app_cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.api_oxagen_app.domain_validation_options : dvo.domain_name => {
      name  = dvo.resource_record_name
      type  = dvo.resource_record_type
      value = dvo.resource_record_value
    }
  }

  zone_id         = aws_route53_zone.oxagen_app.zone_id
  name            = each.value.name
  type            = each.value.type
  ttl             = 60
  records         = [each.value.value]
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "api_oxagen_app" {
  certificate_arn         = aws_acm_certificate.api_oxagen_app.arn
  validation_record_fqdns = [for r in aws_route53_record.api_oxagen_app_cert_validation : r.fqdn]
}

resource "aws_lb_listener_certificate" "api_oxagen_app" {
  listener_arn    = aws_lb_listener.https.arn
  certificate_arn = aws_acm_certificate_validation.api_oxagen_app.certificate_arn
}

resource "aws_route53_record" "api_oxagen_app" {
  zone_id = aws_route53_zone.oxagen_app.zone_id
  name    = "api.oxagen.app"
  type    = "A"

  alias {
    name                   = aws_lb.app.dns_name
    zone_id                = aws_lb.app.zone_id
    evaluate_target_health = true
  }

  # The name reaches the ALB only after the ALB holds its certificate.
  depends_on = [aws_lb_listener_certificate.api_oxagen_app]
}

# ---------------------------------------------------------------------------
# Out of the vanity set
# ---------------------------------------------------------------------------

moved {
  from = aws_route53_zone.vanity["oxagen.app"]
  to   = aws_route53_zone.oxagen_app
}

moved {
  from = aws_route53_record.vanity_null_mx["oxagen.app"]
  to   = aws_route53_record.oxagen_app_null_mx
}

moved {
  from = aws_route53_record.vanity_spf["oxagen.app"]
  to   = aws_route53_record.oxagen_app_spf
}

moved {
  from = aws_route53_record.vanity_dmarc["oxagen.app"]
  to   = aws_route53_record.oxagen_app_dmarc
}

moved {
  from = aws_route53_record.vanity_caa["oxagen.app"]
  to   = aws_route53_record.oxagen_app_caa
}

moved {
  from = module.vanity_redirect["oxagen.app"].aws_acm_certificate.redirect
  to   = aws_acm_certificate.oxagen_app
}

moved {
  from = module.vanity_redirect["oxagen.app"].aws_route53_record.validation["oxagen.app"]
  to   = aws_route53_record.oxagen_app_cert_validation["oxagen.app"]
}

moved {
  from = module.vanity_redirect["oxagen.app"].aws_route53_record.validation["www.oxagen.app"]
  to   = aws_route53_record.oxagen_app_cert_validation["www.oxagen.app"]
}

moved {
  from = module.vanity_redirect["oxagen.app"].aws_acm_certificate_validation.redirect
  to   = aws_acm_certificate_validation.oxagen_app
}

moved {
  from = module.vanity_redirect["oxagen.app"].aws_route53_record.ipv4["oxagen.app"]
  to   = aws_route53_record.oxagen_app_alb["oxagen.app"]
}

moved {
  from = module.vanity_redirect["oxagen.app"].aws_route53_record.ipv4["www.oxagen.app"]
  to   = aws_route53_record.oxagen_app_alb["www.oxagen.app"]
}
