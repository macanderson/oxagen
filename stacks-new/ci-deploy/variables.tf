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

variable "infra_repo_id" {
  description = <<-DESC
    GitHub's numeric id for macanderson/oxagen-aws-infra, used to pin the
    OpenTofu roles' trust to an identity that survives a rename and cannot be
    squatted after a transfer.

    Null until the repository exists, which is the ordering this stack has to
    live with: the roles are created by the first apply, and that apply happens
    before anyone can read the id of a repository the apply is what enables.
    With it null the roles still work, trusting only the name form.
  DESC
  type        = number
  default     = null
}
