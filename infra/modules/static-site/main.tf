/**
 * A statically-hosted site: private S3 origin, CloudFront in front of it, an
 * ACM certificate, and the Route 53 records that point the domain at the
 * distribution.
 *
 * Every cost-bearing knob in here is set to its cheapest useful value, because
 * these sites serve documentation at low traffic and the account is being
 * migrated onto a "cheapest humanly possible" budget:
 *
 *   - `PriceClass_100` restricts edge locations to North America and Europe.
 *     The other price classes buy Asia/South America latency we have no
 *     audience for yet, at roughly double the per-GB rate.
 *   - No access logging. CloudFront standard logs are free to emit but the S3
 *     storage and PUT requests they generate are not, and nothing consumes
 *     them today. Turning this on is a deliberate later decision, not a
 *     default.
 *   - No WAF. A web ACL is ~$5/month per distribution before a single request
 *     is inspected — more than the entire hosting bill for all four sites.
 *   - No bucket versioning. Every object is reproducible from a `git` checkout
 *     plus a build, so paying to retain overwritten copies buys nothing.
 *
 * CloudFront's perpetual free tier (1 TB egress and 10M requests per month)
 * covers this traffic outright, so the running cost of a site built from this
 * module is the S3 storage of its own assets — cents per month.
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

  tags = merge(var.tags, {
    Site = var.name
  })
}

# ---------------------------------------------------------------------------
# Origin bucket
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "site" {
  bucket = var.bucket_name
  tags   = local.tags
}

resource "aws_s3_bucket_public_access_block" "site" {
  bucket                  = aws_s3_bucket.site.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "site" {
  bucket = aws_s3_bucket.site.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# A multipart upload that fails partway leaves its parts billable but
# invisible in the console. Seven days is long enough for any legitimate
# retry and short enough that abandoned parts never accumulate.
resource "aws_s3_bucket_lifecycle_configuration" "site" {
  bucket = aws_s3_bucket.site.id

  rule {
    id     = "abort-incomplete-multipart-uploads"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# The bucket stays private: CloudFront reaches it through an Origin Access
# Control, which signs each origin request with SigV4. Nothing else can read
# it, so there is no path to the origin that bypasses the distribution's
# security headers or its cache.
resource "aws_cloudfront_origin_access_control" "site" {
  name                              = "${var.name}-oac"
  description                       = "OAC for ${var.domain_name}"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

data "aws_iam_policy_document" "site" {
  statement {
    sid     = "AllowCloudFrontRead"
    actions = ["s3:GetObject"]

    resources = ["${aws_s3_bucket.site.arn}/*"]

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

resource "aws_s3_bucket_policy" "site" {
  bucket = aws_s3_bucket.site.id
  policy = data.aws_iam_policy_document.site.json
}

# ---------------------------------------------------------------------------
# Certificate
# ---------------------------------------------------------------------------

# CloudFront only reads certificates out of us-east-1, regardless of where the
# rest of the stack lives. The provider alias is passed in by the caller.
resource "aws_acm_certificate" "site" {
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
#
# `allow_overwrite` covers the one case where two entries would collide: ACM
# emits an identical validation record for a name and its wildcard, so a
# certificate carrying both writes the same record twice.
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

# ---------------------------------------------------------------------------
# Edge behaviour
# ---------------------------------------------------------------------------

# A static export writes `/docs/concepts.html`, but the link that reaches the
# CDN is `/docs/concepts`. S3 has no notion of a directory index beyond the
# bucket root, so without this rewrite every clean URL 404s. Running it as a
# CloudFront Function keeps the work at the edge: viewer-request functions are
# billed per invocation at a tenth of Lambda@Edge and add well under a
# millisecond.
resource "aws_cloudfront_function" "rewrite" {
  name    = "${var.name}-rewrite"
  runtime = "cloudfront-js-2.0"
  comment = "Map clean URLs onto the objects a static export actually writes"
  publish = true
  code = templatefile("${path.module}/rewrite.js.tftpl", {
    mode             = var.url_rewrite_mode
    exact_redirects  = jsonencode(var.exact_redirects)
    prefix_redirects = jsonencode(var.prefix_redirects)
    exact_rewrites   = jsonencode(var.exact_rewrites)
  })
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
        override                = true
      }
    }
  }

  custom_headers_config {
    items {
      header   = "Permissions-Policy"
      value    = "camera=(), microphone=(), geolocation=(), interest-cohort=(), payment=(), usb=()"
      override = true
    }
  }
}

# ---------------------------------------------------------------------------
# Distribution
# ---------------------------------------------------------------------------

resource "aws_cloudfront_distribution" "site" {
  enabled             = true
  is_ipv6_enabled     = true
  comment             = "${var.name} — ${var.domain_name}"
  default_root_object = "index.html"
  aliases             = local.all_domains
  price_class         = "PriceClass_100"

  origin {
    origin_id                = "s3-${aws_s3_bucket.site.id}"
    domain_name              = aws_s3_bucket.site.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.site.id
  }

  default_cache_behavior {
    target_origin_id       = "s3-${aws_s3_bucket.site.id}"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    # AWS managed policies, referenced by their well-known ids so the module
    # needs no extra data sources: CachingOptimized (long TTLs, gzip/brotli)
    # and CORS-S3Origin (forwards only the headers S3 actually varies on).
    cache_policy_id          = "658327ea-f89d-4fab-a63d-7e88639e58f6"
    origin_request_policy_id = "88a5eaf4-2fd4-4709-b370-b4c650ea3fcf"

    response_headers_policy_id = aws_cloudfront_response_headers_policy.site.id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.rewrite.arn
    }
  }

  # Hashed build output under /_next/static/ is immutable by construction —
  # a changed file gets a changed name — so it is safe to cache at the edge
  # for as long as CloudFront will hold it.
  dynamic "ordered_cache_behavior" {
    for_each = var.immutable_path_patterns
    content {
      path_pattern           = ordered_cache_behavior.value
      target_origin_id       = "s3-${aws_s3_bucket.site.id}"
      viewer_protocol_policy = "redirect-to-https"
      allowed_methods        = ["GET", "HEAD"]
      cached_methods         = ["GET", "HEAD"]
      compress               = true

      cache_policy_id            = "658327ea-f89d-4fab-a63d-7e88639e58f6"
      response_headers_policy_id = aws_cloudfront_response_headers_policy.site.id
    }
  }

  # A missing object is a missing page: serve the export's own 404 document
  # with a 404 status rather than S3's XML error body. The TTL keeps a burst
  # of requests for one bad URL from becoming a burst of origin requests.
  custom_error_response {
    error_code            = 403
    response_code         = 404
    response_page_path    = var.not_found_path
    error_caching_min_ttl = 300
  }

  custom_error_response {
    error_code            = 404
    response_code         = 404
    response_page_path    = var.not_found_path
    error_caching_min_ttl = 300
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
