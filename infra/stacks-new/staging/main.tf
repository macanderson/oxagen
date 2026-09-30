module "environment" {
  # Dormant since 2026-09-30, by Mac's decision: no customers are live, so
  # staging costs nothing it can avoid and production deploys do not wait on
  # it. To wake it, set this to false and the STAGING_ENABLED repository
  # variable to true (pipeline.yml's `staging` job reads it).
  dormant       = true
  local_inngest = true
  capture_email = true
  # Staging runs production's service limits (8448 MiB with ClickHouse and
  # Neo4j), Inngest (4 GiB), and the 1 GiB host reserve: 13.3 GiB, over
  # t4g.large's 7.6 GiB. Every staging deploy stopped at the memory
  # preflight until the node grew (#4835). A dormant node is stopped, so its
  # size costs nothing until staging wakes.
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
