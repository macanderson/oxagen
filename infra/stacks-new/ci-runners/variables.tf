variable "region" {
  type    = string
  default = "us-east-1"
}

variable "github_repository" {
  description = "The repository whose workflows build the CI images, as owner/name."
  type        = string
  default     = "oxageninc/product"
}

variable "github_owner_id" {
  description = "The numeric id of the repository's owner, for the immutable OIDC subject."
  type        = number
  default     = 267772457
}

variable "github_repo_id" {
  description = "The repository's numeric id, which survived its moves between owners."
  type        = number
  default     = 1252628274
}
