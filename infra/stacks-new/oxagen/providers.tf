terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }

  backend "s3" {
    bucket         = "oxagen-tfstate-916294258235"
    key            = "brands/oxagen/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "oxagen-tflock"
    encrypt        = true
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Brand       = "oxagen"
      Application = "oxagen.sh"
      ManagedBy   = "opentofu"
      Stack       = "brands/oxagen"
    }
  }
}

# CloudFront certificates are only readable from us-east-1. The primary
# region is us-east-1 too in this account, so this alias is only load-bearing
# if that ever changes — kept for the same reason the old account keeps it:
# so a future region change to `var.region` doesn't silently break ACM.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = {
      Brand       = "oxagen"
      Application = "oxagen.sh"
      ManagedBy   = "opentofu"
      Stack       = "brands/oxagen"
    }
  }
}
