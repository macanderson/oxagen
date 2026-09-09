variable "name" {
  description = "Short slug for this node; prefixes its resources."
  type        = string
}

variable "region" {
  description = "Region the node runs in — needed at boot to read the Neo4j password from Parameter Store."
  type        = string
}

variable "account_id" {
  description = "AWS account id, used to scope the instance's SSM parameter permissions."
  type        = string
}

variable "vpc_id" {
  description = "VPC the node joins."
  type        = string
}

variable "subnet_id" {
  description = "Private subnet for the instance. Public access is entirely through the ALB in front of it."
  type        = string
}

variable "availability_zone" {
  description = "AZ of `subnet_id`. Neo4j's data volume must be created in the same AZ as the instance that mounts it."
  type        = string
}

variable "instance_type" {
  description = <<-EOT
    Graviton instance type. This box carries Caddy, six Node services, and
    two databases — Neo4j and ClickHouse, which stayed self-hosted (#2693).

    `t4g.medium` was the floor and it had stopped being enough. Measured on
    the live node with ClickHouse not even running: 2184 MB of 3830 used,
    1457 available, no swap. Adding ClickHouse back fits only by capping it
    hard and trusting swap to absorb every spike — and the process the OOM
    killer reaches for first is always a database.

    `t4g.large` doubles memory for about $24/month. Two databases with no
    headroom is a worse thing to be paying for.
  EOT
  type        = string
  default     = "t4g.large"
}

variable "alb_security_group_id" {
  description = "Security group of the ALB in front of this node. The node accepts inbound only from it."
  type        = string
}

variable "neo4j_version" {
  description = "Neo4j image tag. Community 5.11+ is required for native vector indexes, which is what makes self-hosting here — rather than Neptune Analytics — still able to serve embeddings."
  type        = string
  default     = "5-community"
}

variable "clickhouse_image" {
  description = <<-EOT
    ClickHouse's image. Pinned to a patch line rather than `latest`, so a
    replacement of this node cannot also be a database upgrade nobody chose.
  EOT
  type        = string
  default     = "clickhouse/clickhouse-server:24.8-alpine"
}

variable "deploy_bucket" {
  description = <<-EOT
    Where the node's own artifacts and scripts live. The bootstrap reads
    `_bin/` and `_deploy/` out of it to bring the node back to serving after a
    replacement, rather than to a placeholder that answers only /healthz.
  EOT
  type        = string
}

variable "data_volume_size" {
  description = "Size in GB of Neo4j's durable data volume, separate from the root disk."
  type        = number
  default     = 20
}

variable "backup_retention_days" {
  description = "How many daily snapshots of Neo4j's data volume to keep."
  type        = number
  default     = 7
}

variable "tags" {
  description = "Tags applied to every resource, carrying the owning brand."
  type        = map(string)
}

# The AMI is pinned, not resolved. It used to come from
# `/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64` —
# AWS's *latest* pointer, which moves every few weeks as Amazon publishes a new
# image. `ami` forces replacement, so that configuration could never converge:
# every plan after a new release proposed destroying and recreating this
# instance, and an apply run for any other reason would have done it.
#
# On 2026-09-06 that gap was live. The pointer resolved to
# ami-07987a01dcdb011ef while both running instances were on
# ami-0cded71ff6ab7f608, and `tofu plan` read "4 to add, 3 to change, 10 to
# destroy" — including the node every service runs on (#2682).
#
# Pinned here so replacing an instance is always something someone chose. Bump
# it deliberately, in its own change, with the replacement sequenced against
# whatever the instance carries.
variable "ami_id" {
  description = "AMI for this instance. Pinned deliberately; see the note above."
  type        = string
}
