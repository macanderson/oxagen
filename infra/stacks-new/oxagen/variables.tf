variable "region" {
  description = "Primary region for this stack's regional resources."
  type        = string
  default     = "us-east-1"
}

variable "account_id" {
  description = <<-EOT
    AWS account id, used to make S3 bucket names globally unique and to make
    a plan run with the wrong credentials fail on a name mismatch instead of
    proposing a second set of resources in someone else's account.
  EOT
  type        = string
}

variable "availability_zones" {
  description = "Three AZs for the new VPC. Redshift Serverless set that floor and is gone (#2693); three is kept because dropping to two destroys subnets to save nothing — see modules/network/variables.tf."
  type        = list(string)
  default     = ["us-east-1a", "us-east-1b", "us-east-1c"]
}

variable "legacy_subdomains" {
  description = <<-EOT
    Subdomain label -> CNAME target, for names still served by a host this
    migration does not touch. See stacks/oxagen/variables.tf in the old
    account for the wildcard/CAA trap this must not reproduce.
  EOT
  type        = map(string)
  default = {
    arena = "cname.vercel-dns-016.com"
  }
}

variable "caa_issuers" {
  description = "Certificate authorities permitted to issue for oxagen.sh."
  type        = list(string)
  default     = ["amazon.com", "pki.goog", "sectigo.com", "letsencrypt.org"]
}

variable "oxagen_ai_elsewhere" {
  description = <<-EOT
    Subdomain label -> IPv4 address, for oxagen.ai names served by the Google
    Cloud load balancer this migration does not touch. Identical to the old
    account's variable of the same name — these are the same live services,
    unaffected by which AWS account owns the DNS zone in front of them.
  EOT
  type        = map(string)
  default = {
    admin      = "34.144.223.45"
    api        = "34.144.223.45"
    clickhouse = "34.144.223.45"
    mcp        = "34.144.223.45"
    pgadmin    = "34.144.223.45"
    redis      = "34.144.223.45"
  }
}

variable "oxagen_ai_redirect_to" {
  type    = string
  default = "https://oxagen.sh/"
}

# One pin for both instances, because they run the same image and there is no
# reason for the NAT and the app node to drift apart. Bumping this replaces
# both, which is the honest shape: an AMI change IS an instance replacement,
# and it should read like one in the plan rather than arriving as a side effect
# of an unrelated apply.
#
# Set in terraform.tfvars rather than defaulted here, so the value a plan uses
# is in the file someone opens to change it.
variable "node_ami" {
  description = "AMI for the app node and the NAT instance."
  type        = string
}
