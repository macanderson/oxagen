/**
 * The turbo remote cache for CI (ADR-207, #4233).
 *
 * Turbo speaks an HTTP API, not S3, so each CI job starts a small cache server
 * on its own runner (`.github/actions/turbo-cache`) and that server reads and
 * writes this bucket. Nothing listens on the internet: the only way in is the
 * role below, and only a GitHub Actions job in this repository can assume it.
 *
 * This replaced Vercel's hosted cache, which answered every request with 402
 * from 2026-09-25.
 */

resource "aws_s3_bucket" "turbo_cache" {
  bucket = "oxagen-turbo-cache-${var.account_id}"
}

resource "aws_s3_bucket_public_access_block" "turbo_cache" {
  bucket                  = aws_s3_bucket.turbo_cache.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "turbo_cache" {
  bucket = aws_s3_bucket.turbo_cache.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Every object is disposable: a missing entry costs one rebuild. Fourteen days
# keeps what main and open pull requests reuse and lets the rest go, so the
# bucket's size tracks recent work rather than history. The server uploads
# with multipart, and a job killed mid-upload leaves parts that no listing
# shows and that are billed anyway, so those go after a day.
resource "aws_s3_bucket_lifecycle_configuration" "turbo_cache" {
  bucket = aws_s3_bucket.turbo_cache.id

  rule {
    id     = "expire-cache-entries"
    status = "Enabled"

    filter {}

    expiration {
      days = 14
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

locals {
  # Any job in the platform repository, from any branch or pull request, in
  # both the readable and the immutable owner@id/repo@id subject forms. A fork's
  # pull request gets no OIDC token, so it cannot reach this role at all.
  turbo_cache_subjects = [
    for shape in [
      local.infra_repository,
      "${split("/", local.infra_repository)[0]}@${local.infra_owner_id}/${split("/", local.infra_repository)[1]}@${local.infra_repo_id}",
    ] : "repo:${shape}:*"
  ]
}

data "aws_iam_policy_document" "turbo_cache_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = local.turbo_cache_subjects
    }
  }
}

resource "aws_iam_role" "turbo_cache" {
  name        = "gha-turbo-cache"
  description = "Read and write the turbo remote cache bucket from ${local.infra_repository} CI."

  assume_role_policy   = data.aws_iam_policy_document.turbo_cache_assume.json
  max_session_duration = 3600
}

# This bucket and nothing else. `ListBucket` is what makes a lookup of a
# missing entry answer 404 rather than 403, and turbo reads a 404 as a miss.
# Without it, every miss would look like an outage.
#
# Any branch can write, so a branch could plant an entry that main later
# restores. No deploy reads this cache (`deploy-node` never gets TURBO_API), so
# the worst case is a check that passes without running. The ADR records the
# hardening: a second role that only main can assume for writes.
data "aws_iam_policy_document" "turbo_cache" {
  statement {
    sid       = "ListCache"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.turbo_cache.arn]
  }

  statement {
    sid = "ReadWriteCacheEntries"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:AbortMultipartUpload",
    ]
    resources = ["${aws_s3_bucket.turbo_cache.arn}/*"]
  }
}

resource "aws_iam_role_policy" "turbo_cache" {
  name   = "turbo-cache"
  role   = aws_iam_role.turbo_cache.id
  policy = data.aws_iam_policy_document.turbo_cache.json
}
