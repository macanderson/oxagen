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

# Artifacts are timestamped releases the node prunes to the last three; a
# short expiry here is a second backstop against the bucket growing forever
# if a node ever stops pruning.
resource "aws_s3_bucket_lifecycle_configuration" "deploy" {
  bucket = aws_s3_bucket.deploy.id

  rule {
    id     = "expire-old-artifacts"
    status = "Enabled"

    filter {
      prefix = "_deploy/"
    }

    expiration {
      days = 30
    }
  }
}
