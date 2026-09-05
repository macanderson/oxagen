terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Its own state key, for the same reason `oxagen-data` has one: the state
  # file is the unit of blast radius. This stack is applied whenever a
  # repository gains or loses the right to deploy, which is far more often
  # than a website stack changes and infinitely more often than the database
  # stack should. Sharing state with any of them would mean every permission
  # edit computes a plan containing production infrastructure it has no
  # business proposing changes to.
  backend "s3" {
    bucket         = "oxagen-tfstate-578673726240"
    key            = "platform/ci-deploy/terraform.tfstate"
    region         = "us-east-2"
    dynamodb_table = "oxagen-tflock"
    encrypt        = true
  }
}

provider "aws" {
  region = var.region

  # `Brand = shared` rather than one of the three: this stack's whole subject
  # is the seam *between* brands, and tagging it `oxagen` would file Stella's
  # and CGP's deploy roles into a Resource Group that does not own them.
  default_tags {
    tags = {
      Brand     = "shared"
      ManagedBy = "opentofu"
      Stack     = "platform/ci-deploy"
    }
  }
}
