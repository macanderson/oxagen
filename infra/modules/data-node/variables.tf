variable "name" {
  description = "Short slug for this node; prefixes its resources and its SSM parameter path."
  type        = string
}

variable "region" {
  description = "Region the node runs in."
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
  description = <<-EOT
    Subnet for the instance. A public subnet is expected: the node needs
    outbound access for container images, and a private subnet would require a
    NAT gateway costing more per month than the instance itself. Nothing can
    reach it inbound regardless — the security group opens no port.
  EOT
  type        = string
}

variable "availability_zone" {
  description = "AZ of `subnet_id`. The data volume must be created in the same AZ as the instance that mounts it."
  type        = string
}

variable "instance_type" {
  description = <<-EOT
    Graviton instance type. `t4g.medium` (4 GiB) is the honest floor for
    Postgres, Neo4j and ClickHouse together — ClickHouse alone wants that much,
    and the bootstrap adds swap precisely because the margin is thin.

    `t4g.small` halves the cost and will boot, but OOM-kills ClickHouse under
    any real query load. Drop to it only alongside dropping an engine.
  EOT
  type        = string
  default     = "t4g.medium"
}

variable "data_volume_size" {
  description = "Size in GB of the durable data volume, separate from the root disk."
  type        = number
  default     = 50
}

variable "postgres_version" {
  description = "Postgres major version, as the pgvector image tags it (`pgvector/pgvector:pg<version>`)."
  type        = string
  default     = "16"
}

variable "neo4j_version" {
  description = "Neo4j image tag. Community 5.11+ is required for native vector indexes."
  type        = string
  default     = "5-community"
}

variable "clickhouse_image" {
  description = "ClickHouse server image."
  type        = string
  default     = "clickhouse/clickhouse-server:24.8"
}

variable "backup_retention_days" {
  description = "How many daily snapshots of the data volume to keep."
  type        = number
  default     = 7
}

variable "tags" {
  description = "Tags applied to every resource, carrying the owning brand."
  type        = map(string)
}
