# Bootstrap: creates the S3 bucket and DynamoDB table that all other
# environments use as their Terraform state backend.
#
# Run ONCE with local state:
#   cd infra/bootstrap
#   tofu init && tofu apply
#
# After apply, the bucket and table names are printed as outputs.
# Never run `tofu destroy` on this — it would delete all state.

terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = "us-east-2"
}

resource "aws_s3_bucket" "tfstate" {
  bucket = "oxagen-tfstate-578673726240"

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
      sse_algorithm = "aws:kms"
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
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }

  tags = {
    Project   = "oxagen"
    ManagedBy = "opentofu"
  }
}

output "state_bucket" {
  value       = aws_s3_bucket.tfstate.bucket
  description = "S3 bucket name for Terraform state"
}

output "lock_table" {
  value       = aws_dynamodb_table.tflock.name
  description = "DynamoDB table name for Terraform state locking"
}
