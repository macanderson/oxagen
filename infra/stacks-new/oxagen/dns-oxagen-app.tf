/**
 * oxagen.app, a domain Mac holds that only redirects to app.oxagen.sh
 * (ADR-236, which supersedes ADR-215).
 *
 * The name was bought at Vercel on 2026-09-27, in the `oxagen-inc` team, and
 * came into Route 53 as a vanity redirect to app.oxagen.sh
 * (dns-vanity-domains.tf, #4631 and #4641). Vercel stays the registrar, and
 * the registry has listed this zone's nameservers since 2026-09-28.
 *
 * ADR-215 moved the name out of the vanity set to serve the app there. The
 * `moved` blocks at the end re-addressed the zone, its mail and CAA records,
 * the certificate, and that certificate's validation records, so the
 * delegation and the issued certificate survived. They stay, because putting
 * the name back into the vanity set would move them again for nothing.
 *
 * Mac stopped the move on 2026-09-30, for now. The apex and www keep pointing
 * at the ALB, and a listener rule answers both with a 302 to app.oxagen.sh, so
 * no request on either name reaches the node. api, mcp, and docs on oxagen.app
 * are gone (#4882).
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
# The ALB
# ---------------------------------------------------------------------------

# Both names reach the ALB only to be redirected by the rule below.
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

  # The records point at the ALB only after it holds the certificate and the
  # redirect rule, so neither name reaches it before it can answer.
  depends_on = [
    aws_lb_listener_certificate.oxagen_app,
    aws_lb_listener_rule.oxagen_app_redirect,
  ]
}

# ---------------------------------------------------------------------------
# The redirect
# ---------------------------------------------------------------------------

# The same path and query on app.oxagen.sh. A 302, like every vanity redirect
# (dns-vanity-domains.tf): a browser may keep a 301 forever, and Mac stopped
# the move only for now (ADR-236).
resource "aws_lb_listener_rule" "oxagen_app_redirect" {
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
