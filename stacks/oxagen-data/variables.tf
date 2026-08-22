variable "region" {
  description = "Region the data node runs in."
  type        = string
  default     = "us-east-1"
}

variable "account_id" {
  description = "AWS account id, used to scope the node's SSM parameter permissions."
  type        = string
}

variable "vpc_id" {
  description = <<-EOT
    VPC for the data node. The account's default VPC is used rather than a
    purpose-built one: a dedicated VPC buys isolation this single instance does
    not need, and its private subnets would need a NAT gateway at ~$32/month —
    more than the instance itself — to pull container images.
  EOT
  type        = string
}

variable "subnet_id" {
  description = "Public subnet in `vpc_id`. Nothing is reachable inbound; see the module for why public."
  type        = string
}

variable "availability_zone" {
  description = "AZ of `subnet_id`; the data volume is created in the same one."
  type        = string
}

variable "instance_type" {
  description = "Graviton instance type. See the module for why t4g.medium is the floor."
  type        = string
  default     = "t4g.medium"
}

variable "data_volume_size" {
  description = "Size in GB of the durable data volume."
  type        = number
  default     = 50
}
