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
