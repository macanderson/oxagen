variable "region" {
  description = "Primary region for this stack's regional resources."
  type        = string
  default     = "us-east-1"
}

variable "caa_issuers" {
  description = <<-EOT
    Certificate authorities permitted to issue for this domain.

    `amazon.com` is what lets ACM issue and must never be removed while any
    CloudFront distribution here serves HTTPS. The other three are inherited
    from the previous zone and are kept because Google still issues for the
    Workspace-hosted names; removing an issuer breaks its next renewal rather
    than anything visible on the day.
  EOT
  type        = list(string)
  default     = ["amazon.com", "pki.goog", "sectigo.com", "letsencrypt.org"]
}

variable "account_id" {
  description = <<-EOT
    AWS account id, used to make S3 bucket names globally unique. Passed in
    rather than read from `aws_caller_identity` so that a plan run with the
    wrong credentials fails on a name mismatch instead of silently proposing a
    second set of buckets in someone else's account.
  EOT
  type        = string
}
