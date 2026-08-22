variable "region" {
  description = "Primary region for this stack's regional resources."
  type        = string
  default     = "us-east-1"
}

variable "account_id" {
  description = "AWS account id, used to make S3 bucket names globally unique."
  type        = string
}

variable "parent_zone_id" {
  description = <<-EOT
    Zone id for `oxagen.sh`, which the Oxagen stack owns and this site's
    hostname sits inside. Passed as a plain value rather than read through
    `terraform_remote_state` so that the two stacks stay genuinely independent:
    a remote-state read would make every Stella plan depend on Oxagen's state
    file being present and readable.
  EOT
  type        = string
}

variable "bundle_path" {
  description = "Path to the zipped OpenNext server function, from tools/package-nextjs.sh."
  type        = string
}

variable "bundle_hash" {
  description = "Base64 SHA-256 of the bundle, from tools/package-nextjs.sh."
  type        = string
}

variable "server_environment" {
  description = <<-EOT
    Environment variables for the server function.

    This is where the site's Upstash Redis credentials belong — the install
    counters degrade to "unconfigured" without them rather than failing, so the
    site is correct but its counters are inert until they are supplied. Set
    them outside version control, via a `.auto.tfvars` file that is gitignored
    or `TF_VAR_server_environment`.
  EOT
  type        = map(string)
  default     = {}
  sensitive   = true
}
