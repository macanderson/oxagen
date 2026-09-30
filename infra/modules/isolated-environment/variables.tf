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

variable "app_instance_type" {
  description = <<-EOT
    Graviton instance type of the environment's app node. It carries the
    services at production's container limits, and with local_inngest and
    capture_email it also carries Inngest and the mail capture beside
    ClickHouse and Neo4j. The node memory preflight
    (infra/tools/node/memory-budget.py) refuses a deploy when the hard
    limits plus a 1 GiB host reserve pass physical memory.
  EOT
  type        = string
  default     = "t4g.large"
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
