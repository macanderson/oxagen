variable "environment" {
  description = "Environment slug used in every resource name and parameter path."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,15}$", var.environment)) && var.environment != "production"
    error_message = "Use a non-production environment slug of 2 to 16 characters."
  }
}
variable "account_id" { type = string }
variable "region" { type = string }
variable "availability_zones" { type = list(string) }
variable "ami_id" { type = string }
variable "domain" {
  description = "DNS suffix, for example staging.oxagen.sh or agents.customer.example."
  type        = string
}
variable "hosted_zone_id" { type = string }
variable "vpc_cidr" { type = string }
variable "oidc_provider_arn" { type = string }
variable "oidc_subjects" {
  description = "Exact repository and environment subjects accepted by GitHub OIDC."
  type        = list(string)
}

variable "local_inngest" {
  description = "Run an isolated Inngest development server for a test environment."
  type        = bool
  default     = false
}

variable "capture_email" {
  description = "Capture test email in a private local inbox without outbound delivery."
  type        = bool
  default     = false
}
