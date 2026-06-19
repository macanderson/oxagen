# Ingestion credential encryption (OXA-1720 / OXA-1649)
module "kms_ingestion" {
  source = "../../modules/kms"

  alias         = "oxagen/ingestion-prod"
  description   = "Oxagen ingestion pipeline credential encryption (production)"
  app_user_name = "oxagen-kms-ingestion-prod"

  tags = {
    Project     = "oxagen"
    Environment = "production"
    ManagedBy   = "opentofu"
    Ticket      = "OXA-1720"
  }
}

# OAuth token encryption at rest (OXA-1441)
module "kms_auth_tokens" {
  source = "../../modules/kms"

  alias         = "oxagen/auth-tokens-prod"
  description   = "Oxagen OAuth token encryption at rest — auth.accounts table (production)"
  app_user_name = "oxagen-kms-auth-prod"

  tags = {
    Project     = "oxagen"
    Environment = "production"
    ManagedBy   = "opentofu"
    Ticket      = "OXA-1441"
  }
}
