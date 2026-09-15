/**
 * The bucket that carries build artifacts from CI to the node.
 *
 * In the old account this bucket exists but is not managed by any stack in
 * this repository — every reference to it is a plain string variable, which
 * means it was created by hand during the migration and never brought under
 * Terraform. Fixed here: this account's deploy bucket is a real resource, so
 * "what created this and why" has an answer that isn't "someone typed
 * `aws s3 mb`".
 */

resource "aws_s3_bucket" "deploy" {
  bucket = "oxagen-deploy-${var.account_id}"
}

resource "aws_s3_bucket_public_access_block" "deploy" {
  bucket                  = aws_s3_bucket.deploy.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# No expiry on artifacts. Each service has one fixed key,
# `_deploy/<service>-standalone.tgz`, overwritten on every deploy; the
# timestamped releases live on the node, which prunes them to three. The bucket
# cannot grow by redeploying.
#
# This used to expire everything under `_deploy/` after 30 days, on the belief
# that the keys were timestamped. They are not, so the rule deleted the only
# copy of any service not redeployed within a month (internal-docs, which ships
# by hand, and stella-serve, which redeploys only on a version bump). A node
# replacement restores services from this prefix (user-data.sh.tftpl), so after
# that month a replacement brought those services back as nothing.
#
# What can still accumulate is an interrupted multipart upload, which is
# invisible in a listing and billed anyway; that is what this rule clears.
resource "aws_s3_bucket_lifecycle_configuration" "deploy" {
  bucket = aws_s3_bucket.deploy.id

  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"

    filter {
      prefix = "_deploy/"
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}
