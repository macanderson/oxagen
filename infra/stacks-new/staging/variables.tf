variable "account_id" { type = string }
variable "region" {
  type    = string
  default = "us-east-1"
}
variable "ami_id" { type = string }
variable "hosted_zone_id" { type = string }
