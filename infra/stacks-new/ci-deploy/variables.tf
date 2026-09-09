variable "region" {
  type    = string
  default = "us-east-1"
}

variable "account_id" {
  type = string
}

variable "node_name" {
  description = <<-EOT
    The app node's `Name` tag — what the deploy role is scoped to.

    Deliberately the tag rather than the instance id. The node is replaced
    whenever its user data changes, so an id pins the policy to a box that
    stops existing; the tag survives the replacement and names the same role
    in the system before and after.
  EOT
  type        = string
  default     = "oxagen-app"
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

