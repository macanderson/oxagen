/**
 * A domain that exists only to send every request somewhere else.
 *
 * Used when a domain is retired in favour of another one but must keep
 * answering: its links are already in the wild, its mail still routes through
 * the same zone, and a name that stops resolving reads as an outage rather
 * than as a move.
 *
 * The whole redirect is a CloudFront Function on viewer-request. That matters
 * for three reasons:
 *
 *   - It is the cheapest place the work can happen. Viewer-request functions
 *     are billed per invocation at roughly a tenth of Lambda@Edge, run in
 *     well under a millisecond, and CloudFront's perpetual free tier covers
 *     this volume outright. The running cost of a domain redirected this way
 *     is the Route 53 hosted zone and nothing else.
 *   - Returning a response from viewer-request short-circuits the request
 *     entirely — no origin connection, no cache lookup, no S3 bucket to pay
 *     for or keep private. The distribution below therefore has an origin
 *     that deliberately does not exist.
 *   - It redirects before TLS-terminated content is ever served, so the
 *     domain never answers with a page of its own that a crawler could index
 *     as duplicate content.
 *
 * What this module is not: a path-preserving redirect. Every route collapses
 * onto one URL. If the two domains share a URL structure and paths should
 * carry across, this is the wrong module.
 */

terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
      # CloudFront reads certificates only out of us-east-1. The caller passes
      # a second, region-pinned provider so the rest of the stack stays free to
      # live wherever it likes.
      configuration_aliases = [aws.us_east_1]
    }
  }
}

locals {
  # `aliases` is every hostname the distribution answers on. The certificate
  # must cover all of them, and each needs its own Route 53 alias record.
  all_domains = concat([var.domain_name], var.alternate_domain_names)

  status_descriptions = {
    301 = "Moved Permanently"
    302 = "Found"
    307 = "Temporary Redirect"
    308 = "Permanent Redirect"
  }

  tags = merge(var.tags, {
    Site = var.name
  })
}

# ---------------------------------------------------------------------------
# Certificate
# ---------------------------------------------------------------------------

# A redirect still has to be served over HTTPS to be reached at all: a browser
# that has ever seen HSTS for this host, or a link written as `https://`, never
# gets far enough to be redirected if the TLS handshake fails.
resource "aws_acm_certificate" "redirect" {
  provider = aws.us_east_1

  domain_name               = var.domain_name
  subject_alternative_names = var.alternate_domain_names
  validation_method         = "DNS"

  tags = local.tags

  lifecycle {
    create_before_destroy = true
  }
}

# One validation record per name on the certificate.
#
# Keyed on `domain_name` specifically, and not on the record name it would be
# more natural to group by: `for_each` keys have to be known at plan time, and
# the CNAME ACM asks for is not — it does not exist until the certificate is
# requested. `domain_name` comes straight back out of this module's own
# configuration, so the set of keys is known before anything is created.
resource "aws_route53_record" "validation" {
  for_each = {
    for opt in aws_acm_certificate.redirect.domain_validation_options :
    opt.domain_name => {
      name   = opt.resource_record_name
      record = opt.resource_record_value
      type   = opt.resource_record_type
    }
  }

  zone_id         = var.hosted_zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 60
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "redirect" {
  provider = aws.us_east_1

  certificate_arn         = aws_acm_certificate.redirect.arn
  validation_record_fqdns = [for r in aws_route53_record.validation : r.fqdn]
}

# ---------------------------------------------------------------------------
# Edge behaviour
# ---------------------------------------------------------------------------

resource "aws_cloudfront_function" "redirect" {
  name    = "${var.name}-redirect"
  runtime = "cloudfront-js-2.0"
  comment = "Send every request for ${var.domain_name} to ${var.redirect_to}"
  publish = true

  code = templatefile("${path.module}/redirect.js.tftpl", {
    target             = var.redirect_to
    status_code        = var.status_code
    status_description = local.status_descriptions[var.status_code]
  })
}

# Deliberately narrower than the static sites' header policy, which sets HSTS
# with `includeSubdomains` and `preload`.
#
# This distribution answers for an apex whose subdomains are served by hosts it
# knows nothing about — mail gateways, a Stripe checkout, an application node
# somewhere else entirely. `includeSubdomains` would impose an HTTPS-only
# policy on all of them from a distribution that cannot see whether they can
# honour it, and `preload` would bake that into browsers in a form that takes
# months to withdraw. A retired domain is the last place to make a commitment
# that is hard to reverse, so the policy covers exactly this host.
resource "aws_cloudfront_response_headers_policy" "redirect" {
  name = "${var.name}-security-headers"

  security_headers_config {
    content_type_options {
      override = true
    }

    frame_options {
      frame_option = "DENY"
      override     = true
    }

    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }

    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = false
      preload                    = false
      override                   = true
    }
  }
}

# ---------------------------------------------------------------------------
# Distribution
# ---------------------------------------------------------------------------

resource "aws_cloudfront_distribution" "redirect" {
  enabled         = true
  is_ipv6_enabled = true
  comment         = "${var.name} — ${var.domain_name} redirects to ${var.redirect_to}"
  aliases         = local.all_domains
  price_class     = "PriceClass_100"

  # CloudFront requires an origin even when nothing will ever be fetched from
  # one. `.invalid` is reserved by RFC 2606 and guaranteed never to resolve,
  # which is the point: if the viewer-request function ever stopped returning
  # a response, this fails visibly with a 502 instead of quietly serving
  # somebody's real content under the retired domain's name. A placeholder
  # that happens to work is the failure this avoids — it would publish the
  # target site a second time at a second hostname, which is exactly the
  # duplicate content the redirect exists to prevent.
  origin {
    origin_id   = "unreachable"
    domain_name = "redirect-only.invalid"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id = "unreachable"

    # `redirect-to-https` rather than `allow-all`: a plain HTTP request is
    # answered with CloudFront's own 301 to the HTTPS URL of the same host,
    # which then reaches the function and is redirected onward. One extra
    # round trip buys a redirect chain that is never downgradeable.
    viewer_protocol_policy = "redirect-to-https"

    allowed_methods = ["GET", "HEAD", "OPTIONS"]
    cached_methods  = ["GET", "HEAD"]
    compress        = false

    # CachingDisabled, by its well-known managed-policy id. Nothing here is
    # cacheable — the function answers every request before the cache is
    # consulted — and naming the policy that says so keeps a future reader
    # from concluding the cache is doing work it is not.
    cache_policy_id = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"

    response_headers_policy_id = aws_cloudfront_response_headers_policy.redirect.id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.redirect.arn
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.redirect.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  tags = local.tags
}

# ---------------------------------------------------------------------------
# DNS
# ---------------------------------------------------------------------------

# An alias record, not a CNAME: alias lookups are free, resolve at the apex
# (which a CNAME cannot do), and return the distribution's current addresses
# without us tracking them.
resource "aws_route53_record" "ipv4" {
  for_each = toset(local.all_domains)

  zone_id = var.hosted_zone_id
  name    = each.value
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.redirect.domain_name
    zone_id                = aws_cloudfront_distribution.redirect.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "ipv6" {
  for_each = toset(local.all_domains)

  zone_id = var.hosted_zone_id
  name    = each.value
  type    = "AAAA"

  alias {
    name                   = aws_cloudfront_distribution.redirect.domain_name
    zone_id                = aws_cloudfront_distribution.redirect.hosted_zone_id
    evaluate_target_health = false
  }
}
