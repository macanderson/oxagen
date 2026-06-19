# ── Ingestion KMS (OXA-1720 / OXA-1649) ────────────────────────────────────
# After `tofu apply`, set these in Vercel for oxagen-v2-api and oxagen-v2-mcp:
#   AWS_KMS_INGESTION_KEY_ARN  = tofu output -raw ingestion_kms_key_arn
#   AWS_ACCESS_KEY_ID          = tofu output -raw ingestion_access_key_id
#   AWS_SECRET_ACCESS_KEY      = tofu output -raw ingestion_secret_access_key
# Then flip: INGESTION_CRYPTO_PROVIDER=kms  (remove INGESTION_ENCRYPTION_KEY)

output "ingestion_kms_key_arn" {
  value       = module.kms_ingestion.key_arn
  description = "Set as AWS_KMS_INGESTION_KEY_ARN in Vercel"
}

output "ingestion_access_key_id" {
  value       = module.kms_ingestion.access_key_id
  description = "Set as AWS_ACCESS_KEY_ID in Vercel (oxagen-kms-ingestion-prod user)"
}

output "ingestion_secret_access_key" {
  value       = module.kms_ingestion.secret_access_key
  description = "Set as AWS_SECRET_ACCESS_KEY in Vercel"
  sensitive   = true
}

# ── Auth token KMS (OXA-1441) ───────────────────────────────────────────────
# After `tofu apply`, set these in Vercel for all projects (app, api, mcp):
#   AUTH_TOKEN_KMS_KEY_ID      = tofu output -raw auth_kms_key_arn
#   (use a separate Vercel env for these credentials — different IAM user)
#   AUTH_AWS_ACCESS_KEY_ID     = tofu output -raw auth_access_key_id
#   AUTH_AWS_SECRET_ACCESS_KEY = tofu output -raw auth_secret_access_key

output "auth_kms_key_arn" {
  value       = module.kms_auth_tokens.key_arn
  description = "Set as AUTH_TOKEN_KMS_KEY_ID in Vercel"
}

output "auth_access_key_id" {
  value       = module.kms_auth_tokens.access_key_id
  description = "Set as AUTH_AWS_ACCESS_KEY_ID in Vercel (oxagen-kms-auth-prod user)"
}

output "auth_secret_access_key" {
  value       = module.kms_auth_tokens.secret_access_key
  description = "Set as AUTH_AWS_SECRET_ACCESS_KEY in Vercel"
  sensitive   = true
}
