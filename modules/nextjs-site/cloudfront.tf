/**
 * The distribution that fronts both origins and decides which one answers.
 *
 * The split is deliberately minimal — two behaviours, not a dozen:
 *
 *   /_next/static/*  goes to S3. These files are content-addressed, so they
 *                    are immutable and never need to consult the server.
 *
 *   everything else  goes to the Lambda. That includes prerendered pages,
 *                    which the server hands back with their own cache headers;
 *                    CloudFront honours those, so a static page is served from
 *                    the edge after its first request and the function is not
 *                    invoked again until it expires.
 *
 * Routing individual public files to S3 as well was considered and rejected:
 * it needs a behaviour per file or a fragile prefix convention, and it saves
 * only the first request of each, because everything after that is an edge
 * hit either way.
 */

resource "aws_cloudfront_origin_access_control" "assets" {
  name                              = "${var.name}-assets-oac"
  description                       = "OAC for ${var.domain_name} static assets"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_origin_access_control" "server" {
  name                              = "${var.name}-server-oac"
  description                       = "OAC for ${var.domain_name} server function"
  origin_access_control_origin_type = "lambda"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

data "aws_iam_policy_document" "assets" {
  statement {
    sid       = "AllowCloudFrontRead"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.assets.arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.site.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "assets" {
  bucket = aws_s3_bucket.assets.id
  policy = data.aws_iam_policy_document.assets.json
}

resource "aws_acm_certificate" "site" {
  provider = aws.us_east_1

  domain_name               = var.domain_name
  subject_alternative_names = var.alternate_domain_names
  validation_method         = "DNS"
  tags                      = local.tags

  lifecycle {
    create_before_destroy = true
  }
}

# Keyed on `domain_name` because `for_each` keys must be known at plan time and
# the validation CNAME is not — see the static-site module for the full note.
resource "aws_route53_record" "validation" {
  for_each = {
    for opt in aws_acm_certificate.site.domain_validation_options :
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

resource "aws_acm_certificate_validation" "site" {
  provider = aws.us_east_1

  certificate_arn         = aws_acm_certificate.site.arn
  validation_record_fqdns = [for r in aws_route53_record.validation : r.fqdn]
}

resource "aws_cloudfront_distribution" "site" {
  enabled         = true
  is_ipv6_enabled = true
  comment         = "${var.name} — ${var.domain_name}"
  aliases         = local.all_domains
  price_class     = "PriceClass_100"

  origin {
    origin_id                = "s3-assets"
    domain_name              = aws_s3_bucket.assets.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.assets.id
  }

  origin {
    origin_id                = "lambda-server"
    domain_name              = replace(replace(aws_lambda_function_url.server.function_url, "https://", ""), "/", "")
    origin_access_control_id = aws_cloudfront_origin_access_control.server.id

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id       = "lambda-server"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    # UseOriginCacheControlHeaders: the server decides what is cacheable, which
    # is the only source that knows — a prerendered page and a counter endpoint
    # arrive through the same behaviour and must be treated differently.
    cache_policy_id = "83da9c7e-98b4-4e11-a168-04f0df8e2c65"

    # AllViewerExceptHostHeader is mandatory for a Lambda Function URL origin:
    # the signature is computed over the origin's own host, so forwarding the
    # viewer's Host header makes every request fail signature validation.
    origin_request_policy_id = "b689b0a8-53d0-40ab-baf2-68738e2966ac"

    response_headers_policy_id = aws_cloudfront_response_headers_policy.site.id
  }

  ordered_cache_behavior {
    path_pattern           = "/_next/static/*"
    target_origin_id       = "s3-assets"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    # CachingOptimized — these keys are content-addressed, so a cache hit is
    # always correct and a miss is only ever a cold edge.
    cache_policy_id            = "658327ea-f89d-4fab-a63d-7e88639e58f6"
    response_headers_policy_id = aws_cloudfront_response_headers_policy.site.id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.site.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  tags = local.tags
}

resource "aws_cloudfront_response_headers_policy" "site" {
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
      access_control_max_age_sec = 63072000
      include_subdomains         = true
      preload                    = true
      override                   = true
    }

    dynamic "content_security_policy" {
      for_each = var.content_security_policy == null ? [] : [var.content_security_policy]
      content {
        content_security_policy = content_security_policy.value
        # Not overridden: the application sets its own CSP per response, and a
        # policy that replaced it here would silently defeat any per-route
        # tightening the app does.
        override = false
      }
    }
  }

  custom_headers_config {
    items {
      header   = "Permissions-Policy"
      value    = "camera=(), microphone=(), geolocation=(), interest-cohort=(), payment=(), usb=()"
      override = false
    }
  }
}

resource "aws_route53_record" "ipv4" {
  for_each = toset(local.all_domains)

  zone_id = var.hosted_zone_id
  name    = each.value
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.site.domain_name
    zone_id                = aws_cloudfront_distribution.site.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "ipv6" {
  for_each = toset(local.all_domains)

  zone_id = var.hosted_zone_id
  name    = each.value
  type    = "AAAA"

  alias {
    name                   = aws_cloudfront_distribution.site.domain_name
    zone_id                = aws_cloudfront_distribution.site.hosted_zone_id
    evaluate_target_health = false
  }
}
