variable "name" {
  description = "Short slug for this VPC; prefixes the names of its resources."
  type        = string
}

variable "region" {
  description = "Region the VPC is created in."
  type        = string
}

variable "vpc_cidr" {
  description = "CIDR for the whole VPC."
  type        = string
  default     = "10.60.0.0/16"
}

variable "availability_zones" {
  description = <<-EOT
    Three AZs, in order. An ALB needs subnets in at least two; Redshift
    Serverless refuses to provision at all unless its subnet group spans at
    least three, each with enough free IPs — the stricter requirement here,
    so it sets the floor for both public and private subnet counts even
    though only one AZ's private subnet carries anything (the app node).
  EOT
  type        = list(string)

  validation {
    condition     = length(var.availability_zones) >= 3
    error_message = "Redshift Serverless requires subnets across at least three availability zones."
  }
}

variable "nat_instance_type" {
  description = <<-EOT
    Instance type for the NAT box. `t4g.nano` rather than a managed NAT
    Gateway: the gateway bills ~$32/month plus data processing before a single
    byte crosses it, against ~$3/month for an instance that forwards packets
    with a five-line sysctl-and-iptables bootstrap. The private subnet holds
    one node, so the gateway's higher availability and higher throughput both
    buy nothing here.
  EOT
  type        = string
  default     = "t4g.nano"
}

variable "tags" {
  description = "Tags applied to every resource, carrying the owning brand."
  type        = map(string)
}
