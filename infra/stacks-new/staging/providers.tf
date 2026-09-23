terraform {
  required_version = "~> 1.8"
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 5.0" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
  backend "s3" {
    bucket         = "oxagen-tfstate-916294258235"
    key            = "environments/staging/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "oxagen-tflock"
    encrypt        = true
  }
}
provider "aws" {
  region              = var.region
  allowed_account_ids = [var.account_id]
}
