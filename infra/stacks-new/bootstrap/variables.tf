variable "region" {
  type    = string
  default = "us-east-1"
}

variable "account_id" {
  description = "New account id, used to make the state bucket name globally unique."
  type        = string
}
