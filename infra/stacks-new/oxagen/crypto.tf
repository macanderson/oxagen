# ---------------------------------------------------------------------------
# Ingestion credential encryption key
# ---------------------------------------------------------------------------
# The platform wraps every stored connector credential and OAuth token with
# the KMS key named by /oxagen/production/AWS_KMS_INGESTION_KEY_ARN
# (packages/crypto/src/ingestion.ts). Before this file, that ARN named a key
# in the retired account 578673726240, in us-east-2, whose policy admits only
# that account's root. The node role here was never granted anything on it,
# so every GitHub connect since the 2026-08-27 cutover ended in
# `kms:GenerateDataKey ... not authorized` at the OAuth callback (issue
# #2680; API request 0f5a9e5d-3e02-4fca-8524-bf50eb38a157 on 2026-09-09).
#
# No re-wrap is needed. On 2026-09-09 every ciphertext column in production
# was empty, including token_kms_key_id on both auth.accounts rows, because
# nothing in this account had ever been able to encrypt. The old key stays
# where it is; deleting it is the maintainer's call and no part of this stack.

resource "aws_kms_key" "ingestion" {
  description             = "Oxagen ingestion credential encryption (production)"
  deletion_window_in_days = 30
  enable_key_rotation     = true

  tags = { Brand = local.brand }
}

resource "aws_kms_alias" "ingestion" {
  name          = "alias/oxagen-app/ingestion"
  target_key_id = aws_kms_key.ingestion.key_id
}

# Only this key, and only the calls envelope encryption makes. The node module
# grants kms:Decrypt with a kms:ViaService condition on SSM, for reading its
# own parameters; that condition excludes the direct call the crypto adapter
# makes, which is why a second, key-scoped statement lives here.
data "aws_iam_policy_document" "node_kms_ingestion" {
  statement {
    actions = [
      "kms:Encrypt",
      "kms:Decrypt",
      "kms:GenerateDataKey",
      "kms:GenerateDataKeyWithoutPlaintext",
      "kms:DescribeKey",
    ]
    resources = [aws_kms_key.ingestion.arn]
  }
}

resource "aws_iam_role_policy" "node_kms_ingestion" {
  name   = "oxagen-app-use-ingestion-key"
  role   = module.app.role_name
  policy = data.aws_iam_policy_document.node_kms_ingestion.json
}

# The parameter every service reads at deploy time. Adopted rather than
# recreated: it has existed under /oxagen/production since the cutover, set by
# hand, and creating it again would fail on ParameterAlreadyExists. Managed
# here so the ARN can never again name a key this stack does not own. The
# block is a no-op once the parameter is in state and can be removed later.
import {
  to = aws_ssm_parameter.ingestion_kms_key_arn
  id = "/oxagen/production/AWS_KMS_INGESTION_KEY_ARN"
}

resource "aws_ssm_parameter" "ingestion_kms_key_arn" {
  name        = "/oxagen/production/AWS_KMS_INGESTION_KEY_ARN"
  description = "KMS key the platform wraps connector credentials with"
  type        = "SecureString"
  value       = aws_kms_key.ingestion.arn

  tags = { Brand = local.brand }
}
