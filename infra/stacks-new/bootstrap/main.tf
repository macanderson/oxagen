/**
 * The new account's own OpenTofu backend: an S3 bucket for state, a DynamoDB
 * table for locking. Every other stack under `stacks-new/` depends on this
 * one having been applied first.
 *
 * Deliberately a local backend for this stack alone — it creates the bucket
 * every other stack's remote state lives in, so it cannot depend on that
 * bucket existing yet. State for `stacks-new/bootstrap` itself stays on disk;
 * it changes only when this account's backend infrastructure changes, which
 * is close to never.
 *
 * New account, new bucket: the old account's `oxagen-tfstate-578673726240`
 * stays exactly as it is and is not touched by anything under `stacks-new/`.
 * A live cross-account dependency on the old account's state bucket would be
 * the opposite of "not dependent on AWS wherever possible" applied to the
 * migration's own tooling.
 */

terraform {
  required_version = "~> 1.8"

  # `>= 1.6` accepted anything, including a major release that has not shipped.
  # CI pins 1.8.5 (`opentofu/setup-opentofu` in infra.yml), so the constraint
  # was wider than the only version that actually runs these stacks, and a
  # contributor on a newer local build could write state a CI apply then reads.
  # `~> 1.8` allows the patch and minor line CI is on and refuses the next
  # major, which is where state format changes live.

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Application = "oxagen.sh"
      ManagedBy   = "opentofu"
      Stack       = "bootstrap"
    }
  }
}

resource "aws_s3_bucket" "tfstate" {
  bucket = "oxagen-tfstate-${var.account_id}"

  # Losing this bucket does not lose one stack. It orphans every resource in
  # the account at once: five stacks' state lives here, and without it
  # Terraform believes nothing exists and plans to create all of it beside
  # what is already running. There is no recovery short of importing the
  # estate by hand.
  #
  # Versioning above means a deleted *object* is recoverable. A deleted
  # bucket is not, and that is the case this guards.
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "tfstate" {
  bucket                  = aws_s3_bucket.tfstate.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_dynamodb_table" "tflock" {
  name         = "oxagen-tflock"
  billing_mode = "PAY_PER_REQUEST" # No fixed floor — this table takes one write per apply.
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }

  # Cheaper to lose than the bucket — the table holds no state, only locks —
  # but losing it means concurrent applies stop being serialised, and two
  # applies writing one state file is how an estate gets a state that
  # describes neither.
  lifecycle {
    prevent_destroy = true
  }
}
