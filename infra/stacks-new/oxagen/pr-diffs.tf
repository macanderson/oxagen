# ---------------------------------------------------------------------------
# Pull request diffs (ADR-288)
# ---------------------------------------------------------------------------
# The pull request sync (packages/inngest-functions forge/pull-request-sync)
# keeps the diff of every pull request head commit it captures, so a check of
# a run's work can read the exact bytes the run produced. A diff is customer
# source code, so it gets a private bucket and a key of its own, and never
# shares the blob store, which can be public.
#
# The app writes each object once, under a key that names its tenant and its
# head commit (`pr-diffs/<org>/<workspace>/...`), with `If-None-Match: *` and
# the object's sha256. The node role can put and get objects under that prefix
# and nothing else: no list, no delete. Versioning keeps an earlier version if
# a write ever replaced one, and the lifecycle rule expires a replaced version
# after 30 days.
#
# The app reads the bucket from the two parameters below, which every service
# loads with the rest of /oxagen/production. Until they exist, the sync records
# each revision's file list as `unconfigured`.

resource "aws_kms_key" "pr_diffs" {
  description             = "Oxagen pull request diffs (production)"
  deletion_window_in_days = 30
  enable_key_rotation     = true

  tags = { Brand = local.brand }
}

resource "aws_kms_alias" "pr_diffs" {
  name          = "alias/oxagen-app/pr-diffs"
  target_key_id = aws_kms_key.pr_diffs.key_id
}

resource "aws_s3_bucket" "pr_diffs" {
  bucket = "oxagen-pr-diffs-${var.account_id}"
  tags   = { Brand = local.brand }
}

resource "aws_s3_bucket_ownership_controls" "pr_diffs" {
  bucket = aws_s3_bucket.pr_diffs.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "pr_diffs" {
  bucket                  = aws_s3_bucket.pr_diffs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "pr_diffs" {
  bucket = aws_s3_bucket.pr_diffs.id
  versioning_configuration {
    status = "Enabled"
  }
}

# Every object is encrypted with the bucket's own key. The bucket key cuts the
# KMS calls to one per object batch instead of one per object.
resource "aws_s3_bucket_server_side_encryption_configuration" "pr_diffs" {
  bucket = aws_s3_bucket.pr_diffs.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.pr_diffs.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "pr_diffs" {
  bucket = aws_s3_bucket.pr_diffs.id

  rule {
    id     = "expire-replaced-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 30
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

# Refuse any request that is not over TLS.
data "aws_iam_policy_document" "pr_diffs_bucket" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.pr_diffs.arn,
      "${aws_s3_bucket.pr_diffs.arn}/*",
    ]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "pr_diffs" {
  bucket = aws_s3_bucket.pr_diffs.id
  policy = data.aws_iam_policy_document.pr_diffs_bucket.json

  depends_on = [aws_s3_bucket_public_access_block.pr_diffs]
}

# The node role writes and reads diffs under the prefix the app uses, and uses
# the bucket's key for exactly that.
data "aws_iam_policy_document" "node_pr_diffs" {
  statement {
    sid       = "PutAndGetDiffs"
    actions   = ["s3:PutObject", "s3:GetObject"]
    resources = ["${aws_s3_bucket.pr_diffs.arn}/pr-diffs/*"]
  }
  statement {
    sid       = "UseTheDiffKey"
    actions   = ["kms:GenerateDataKey", "kms:Decrypt"]
    resources = [aws_kms_key.pr_diffs.arn]
  }
}

resource "aws_iam_role_policy" "node_pr_diffs" {
  name   = "oxagen-app-pr-diffs"
  role   = module.app.role_name
  policy = data.aws_iam_policy_document.node_pr_diffs.json
}

resource "aws_ssm_parameter" "pr_diff_bucket" {
  name        = "/oxagen/production/PR_DIFF_BUCKET"
  description = "The private bucket the pull request sync keeps diffs in (ADR-288)"
  type        = "String"
  value       = aws_s3_bucket.pr_diffs.id

  tags = { Brand = local.brand }
}

resource "aws_ssm_parameter" "pr_diff_bucket_region" {
  name        = "/oxagen/production/PR_DIFF_BUCKET_REGION"
  description = "The region of PR_DIFF_BUCKET"
  type        = "String"
  value       = var.region

  tags = { Brand = local.brand }
}

output "pr_diffs_bucket" {
  description = "The private bucket that holds pull request diffs (ADR-288)."
  value       = aws_s3_bucket.pr_diffs.id
}
