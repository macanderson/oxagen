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
    key            = "brands/cgp/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "oxagen-tflock"
    encrypt        = true
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Brand       = "cgp"
      Application = "oxagen.sh"
      ManagedBy   = "opentofu"
      Stack       = "brands/cgp"
    }
  }
}

provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = {
      Brand       = "cgp"
      Application = "oxagen.sh"
      ManagedBy   = "opentofu"
      Stack       = "brands/cgp"
    }
  }
}
