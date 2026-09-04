variable "alias" {
  type        = string
  description = "KMS key alias without the 'alias/' prefix (e.g. 'oxagen/ingestion-prod')"
}

variable "description" {
  type        = string
  default     = ""
  description = "Human-readable description for the KMS key"
}

variable "app_user_name" {
  type        = string
  description = "IAM user name created for the application to use this key"
}

variable "tags" {
  type        = map(string)
  default     = {}
  description = "Tags applied to all resources in this module"
}
