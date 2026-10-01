terraform {
  required_version = "~> 1.8"

  # The runner module (github-aws-runners/terraform-aws-github-runner v7)
  # needs AWS provider 6.33 or later. This stack keeps its own state, so it
  # pins its own provider line and the other stacks stay on `~> 5.0` (ADR-246).
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.33"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
  }

  backend "s3" {
    bucket         = "oxagen-tfstate-916294258235"
    key            = "platform/ci-runners/terraform.tfstate"
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
      Application = "ci"
      ManagedBy   = "opentofu"
      Stack       = "platform/ci-runners"
    }
  }
}
