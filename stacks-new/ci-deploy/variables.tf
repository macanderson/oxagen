variable "region" {
  type    = string
  default = "us-east-1"
}

variable "account_id" {
  type = string
}

variable "node_instance_id" {
  description = "tofu -chdir=stacks-new/oxagen output app_node_instance_id"
  type        = string
}

variable "node_role_name" {
  description = "tofu -chdir=stacks-new/oxagen output app_node_role_name"
  type        = string
}

variable "app_parameter_prefix" {
  type    = string
  default = "/oxagen/production"
}

variable "sites" {
  type = map(object({
    bucket          = string
    distribution_id = string
  }))
}
