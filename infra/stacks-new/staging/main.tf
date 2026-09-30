module "environment" {
  local_inngest = true
  capture_email = true
  # Staging runs production's service limits (8448 MiB with ClickHouse and
  # Neo4j), Inngest (2 GiB), and the 1 GiB host reserve: 11.3 GiB, over
  # t4g.large's 7.6 GiB. Every staging deploy stopped at the memory
  # preflight until the node grew (#4835).
  app_instance_type  = "t4g.xlarge"
  source             = "../../modules/isolated-environment"
  environment        = "staging"
  account_id         = var.account_id
  region             = var.region
  availability_zones = ["${var.region}a", "${var.region}b", "${var.region}c"]
  ami_id             = var.ami_id
  domain             = "staging.oxagen.sh"
  hosted_zone_id     = var.hosted_zone_id
  vpc_cidr           = "10.70.0.0/16"
  oidc_provider_arn  = "arn:aws:iam::${var.account_id}:oidc-provider/token.actions.githubusercontent.com"
  oidc_subjects = [
    "repo:macanderson/oxagen:environment:staging",
    "repo:macanderson@542881/oxagen@1252628274:environment:staging"
  ]
}
output "deployment" { value = module.environment }
