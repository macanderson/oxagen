variable "region" {
  type    = string
  default = "us-east-1"
}

variable "account_id" {
  type = string
}

variable "caa_issuers" {
  type    = list(string)
  default = ["amazon.com"]
}
