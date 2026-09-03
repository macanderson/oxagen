terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Each brand keeps its own state key in the shared bucket. Applying one
  # brand's stack therefore cannot touch another's resources even by mistake —
  # the plan is computed against a state file that does not contain them.
  backend "s3" {
    bucket         = "oxagen-tfstate-578673726240"
    key            = "brands/oxagen/terraform.tfstate"
    region         = "us-east-2"
    dynamodb_table = "oxagen-tflock"
    encrypt        = true
  }
}

provider "aws" {
  region = var.region

  # Applied to every taggable resource this stack creates. `Brand` is what the
  # Resource Group queries on and what cost allocation groups by, so setting it
  # here rather than per-resource is what makes the isolation total.
  default_tags {
    tags = {
      Brand     = "oxagen"
      ManagedBy = "opentofu"
      Stack     = "brands/oxagen"
    }
  }
}

# CloudFront certificates are only readable from us-east-1.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = {
      Brand     = "oxagen"
      ManagedBy = "opentofu"
      Stack     = "brands/oxagen"
    }
  }
}
