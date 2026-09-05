resource "aws_kms_key" "this" {
  description             = var.description
  deletion_window_in_days = 30
  enable_key_rotation     = true
  multi_region            = false

  tags = var.tags
}

resource "aws_kms_alias" "this" {
  name          = "alias/${var.alias}"
  target_key_id = aws_kms_key.this.key_id
}

# Narrow IAM user for application use — only this key, only crypto operations.
# Credentials for this user go into Vercel as AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY.
resource "aws_iam_user" "app" {
  name = var.app_user_name
  tags = var.tags
}

resource "aws_iam_policy" "kms_use" {
  name        = "${var.app_user_name}-kms-use"
  description = "Allow ${var.app_user_name} to use KMS key alias/${var.alias}"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "kms:Encrypt",
          "kms:Decrypt",
          "kms:GenerateDataKey",
          "kms:GenerateDataKeyWithoutPlaintext",
          "kms:DescribeKey",
        ]
        Resource = aws_kms_key.this.arn
      }
    ]
  })
}

resource "aws_iam_user_policy_attachment" "kms_use" {
  user       = aws_iam_user.app.name
  policy_arn = aws_iam_policy.kms_use.arn
}

# Access key stored in Terraform state (encrypted at rest via S3 SSE-KMS).
# Retrieve with: tofu output -raw aws_secret_access_key
resource "aws_iam_access_key" "app" {
  user = aws_iam_user.app.name
}
