output "key_arn" {
  value       = aws_kms_key.this.arn
  description = "KMS key ARN — set as AWS_KMS_INGESTION_KEY_ARN in Vercel"
}

output "key_id" {
  value       = aws_kms_key.this.key_id
  description = "KMS key ID (UUID form)"
}

output "alias_arn" {
  value       = aws_kms_alias.this.arn
  description = "KMS alias ARN"
}

output "access_key_id" {
  value       = aws_iam_access_key.app.id
  description = "AWS access key ID — set as AWS_ACCESS_KEY_ID in Vercel"
}

output "secret_access_key" {
  value       = aws_iam_access_key.app.secret
  description = "AWS secret access key — set as AWS_SECRET_ACCESS_KEY in Vercel"
  sensitive   = true
}
