/**
 * A Next.js site that cannot be reduced to files: a Lambda function running
 * the server, an S3 bucket holding the build's static assets, and a CloudFront
 * distribution that decides which of the two answers each request.
 *
 * The input is an OpenNext build (`.open-next/`), which repackages `next build`
 * output into a Lambda handler plus a directory of assets. OpenNext is used in
 * preference to rewriting the sites as static exports because both docs sites
 * have routes that genuinely run code — a search index, a counter, a script
 * proxy — and dropping them to fit the hosting would be changing the product
 * to suit the deployment.
 *
 * Cost, at the traffic these sites see, is dominated by nothing:
 *
 *   - Lambda's free tier (1M requests and 400,000 GB-seconds a month) is
 *     perpetual, not a 12-month trial, and this is far below it.
 *   - ARM64 is ~20% cheaper per GB-second than x86 and the bundle is
 *     architecture-independent JavaScript, so there is no reason to pay for
 *     x86.
 *   - A Function URL is used rather than an API Gateway, which would add a
 *     per-request charge for routing that CloudFront is already doing.
 *   - Most requests never reach Lambda at all: prerendered pages carry cache
 *     headers, so CloudFront answers them from the edge.
 */

terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
      configuration_aliases = [aws.us_east_1]
    }
  }
}

locals {
  all_domains = concat([var.domain_name], var.alternate_domain_names)

  tags = merge(var.tags, {
    Site = var.name
  })
}

# ---------------------------------------------------------------------------
# Assets
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "assets" {
  bucket = var.bucket_name
  tags   = local.tags
}

resource "aws_s3_bucket_public_access_block" "assets" {
  bucket                  = aws_s3_bucket.assets.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "assets" {
  bucket = aws_s3_bucket.assets.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "assets" {
  bucket = aws_s3_bucket.assets.id

  rule {
    id     = "abort-incomplete-multipart-uploads"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# ---------------------------------------------------------------------------
# Server function
# ---------------------------------------------------------------------------

# The deployment package lives in S3 rather than being inlined: the bundle is
# tens of megabytes, and Terraform holds an inline `filename` archive in state
# as a hash plus the file on disk, which makes applying from anywhere but the
# machine that built it unreliable.
resource "aws_s3_object" "server_bundle" {
  bucket      = aws_s3_bucket.assets.id
  key         = "_deploy/server-${var.bundle_hash}.zip"
  source      = var.bundle_path
  source_hash = var.bundle_hash

  tags = local.tags
}

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "server" {
  name               = "${var.name}-server"
  assume_role_policy = data.aws_iam_policy_document.assume.json
  tags               = local.tags
}

resource "aws_iam_role_policy_attachment" "logs" {
  role       = aws_iam_role.server.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# Beyond logging, the function needs exactly one thing: the incremental cache.
# A route declaring `revalidate` — Stella's `/install.sh` caches its upstream
# fetch for five minutes — stores that result somewhere shared, because a
# Lambda's own filesystem dies with the execution environment and would give
# every cold start a fresh cache.
#
# Scoped to the `_cache/` prefix rather than the whole bucket. The same bucket
# holds the site's public assets and its own deployment package, and a
# rendering path that can rewrite either of those is a rendering path that can
# replace the site or the code that serves it.
data "aws_iam_policy_document" "cache" {
  statement {
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
    ]
    resources = ["${aws_s3_bucket.assets.arn}/_cache/*"]
  }

  statement {
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.assets.arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["_cache/*"]
    }
  }
}

resource "aws_iam_role_policy" "cache" {
  name   = "${var.name}-incremental-cache"
  role   = aws_iam_role.server.id
  policy = data.aws_iam_policy_document.cache.json
}

# Fourteen days. Log retention defaults to "never expire", which is a bill that
# grows forever for data nobody reads after the incident it belonged to.
resource "aws_cloudwatch_log_group" "server" {
  name              = "/aws/lambda/${var.name}-server"
  retention_in_days = 14
  tags              = local.tags
}

resource "aws_lambda_function" "server" {
  function_name = "${var.name}-server"
  role          = aws_iam_role.server.arn

  s3_bucket        = aws_s3_bucket.assets.id
  s3_key           = aws_s3_object.server_bundle.key
  source_code_hash = var.bundle_hash

  handler       = "index.handler"
  runtime       = "nodejs22.x"
  architectures = ["arm64"]

  # Memory is the only performance dial Lambda exposes — CPU scales with it.
  # 1024 MB is the knee of the curve for server-rendering: below it, render
  # time rises faster than the memory saving, so a smaller setting costs more
  # per request rather than less.
  memory_size = var.memory_size
  timeout     = 30

  environment {
    variables = merge(var.environment, {
      CACHE_BUCKET_NAME         = aws_s3_bucket.assets.id
      CACHE_BUCKET_REGION       = var.region
      CACHE_BUCKET_KEY_PREFIX   = "_cache"
    })
  }

  depends_on = [aws_cloudwatch_log_group.server]
  tags       = local.tags
}

# A Function URL, reached only by CloudFront. `AWS_IAM` auth plus an Origin
# Access Control means the URL is useless to anyone who finds it: requests must
# carry a SigV4 signature that only the distribution can produce, so the
# distribution's caching and headers cannot be bypassed by calling the origin
# directly.
resource "aws_lambda_function_url" "server" {
  function_name      = aws_lambda_function.server.function_name
  authorization_type = "AWS_IAM"
  invoke_mode        = "RESPONSE_STREAM"
}

resource "aws_lambda_permission" "cloudfront" {
  statement_id           = "AllowCloudFrontInvoke"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.server.function_name
  principal              = "cloudfront.amazonaws.com"
  source_arn             = aws_cloudfront_distribution.site.arn
  function_url_auth_type = "AWS_IAM"
}
