variable "region" {
  description = "Primary region for this stack's regional resources."
  type        = string
  default     = "us-east-1"
}

variable "account_id" {
  description = <<-EOT
    AWS account id. Passed in rather than read from `aws_caller_identity` for
    the same reason the brand stacks pass it: a plan run with the wrong
    credentials should fail on a mismatch rather than quietly propose a second
    set of roles in someone else's account.
  EOT
  type        = string
}

variable "node_instance_id" {
  description = <<-EOT
    The shared application node. Deploys that restart a service are scoped to
    this one instance, so a role that can deploy cannot run commands on any
    future instance that happens to appear in the account.
  EOT
  type        = string
}

variable "node_role_name" {
  description = <<-EOT
    IAM role attached to the node's instance profile. This stack grants it the
    read side of the deploy path — pulling artifacts out of the deploy bucket
    and reading the applications' own secrets — because those permissions
    exist only to serve deploys and belong with the rest of the deploy IAM
    rather than in the stack that owns the databases. Applying `oxagen-data`
    to add them would compute a plan containing Postgres.
  EOT
  type        = string
}

variable "deploy_bucket" {
  description = "S3 bucket that carries build artifacts from CI to the node."
  type        = string
}

variable "app_parameter_prefix" {
  description = <<-EOT
    Parameter Store prefix holding the applications' runtime configuration.
    The node reads it at container start; CI never does, so no CI role is
    granted access to it.
  EOT
  type        = string
  default     = "/oxagen/production"
}

variable "sites" {
  description = <<-EOT
    Static sites, by logical name, giving the bucket a role may write and the
    distribution it may invalidate. Kept as data because the permission shape
    is identical for every one of them and only the two identifiers change;
    which *role* gets which site is spelled out explicitly in `roles.tf`,
    because that is the security decision and it should not be inferable only
    by reading a map.
  EOT
  type = map(object({
    bucket          = string
    distribution_id = string
  }))
}
