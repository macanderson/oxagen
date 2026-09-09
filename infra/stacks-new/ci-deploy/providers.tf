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

  backend "s3" {
    bucket         = "oxagen-tfstate-916294258235"
    key            = "platform/ci-deploy/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "oxagen-tflock"
    encrypt        = true
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Brand       = "shared"
      Application = "oxagen.sh"
      ManagedBy   = "opentofu"
      Stack       = "platform/ci-deploy"
    }
  }
}
