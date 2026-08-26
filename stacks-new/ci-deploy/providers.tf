terraform {
  required_version = ">= 1.6"

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
