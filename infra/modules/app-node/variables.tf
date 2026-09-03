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
  description = "Graviton instance type. `t4g.medium` is the floor for Caddy, a handful of small Node processes, and Neo4j sharing the box — Postgres and ClickHouse have moved to Aurora and Redshift Serverless, so this carries one engine rather than three."
  type        = string
  default     = "t4g.medium"
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
