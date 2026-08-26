variable "region" {
  type    = string
  default = "us-east-1"
}

variable "parent_zone_id" {
  description = "Zone id for oxagen.sh — tofu -chdir=stacks-new/oxagen output zone_id"
  type        = string
}

variable "alb_dns_name" {
  description = "tofu -chdir=stacks-new/oxagen output -json alb | jq -r .dns_name"
  type        = string
}

variable "alb_zone_id" {
  description = "tofu -chdir=stacks-new/oxagen output -json alb | jq -r .zone_id"
  type        = string
}
