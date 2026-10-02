variable "region" {
  type    = string
  default = "us-east-1"
}

variable "account_id" {
  type = string
}

variable "vpc_cidr" {
  description = "The CI VPC. Production is 10.60.0.0/16 and staging 10.70.0.0/16."
  type        = string
  default     = "10.80.0.0/16"
}

variable "availability_zone_ids" {
  description = <<-EOT
    Zone ids, not names, because a zone name maps to a different zone in each
    account. use1-az3 is left out: it offers none of the runner instance types.
  EOT
  type        = list(string)
  default     = ["use1-az1", "use1-az2", "use1-az4", "use1-az5", "use1-az6"]
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

variable "runner_version" {
  description = <<-EOT
    The actions/runner release baked into the image. GitHub stops accepting a
    runner about 30 days after a newer release, so bump this with each release
    the image has not yet picked up. The checksums are the ones GitHub
    publishes in the release notes.
  EOT
  type = object({
    version = string
    sha256  = map(string)
  })
}

variable "node_version" {
  description = "Node.js pre-installed in the runner tool cache. Keep it equal to .node-version."
  type        = string
}

variable "image_build_schedule" {
  description = "When Image Builder rebuilds the runner image, as an EventBridge cron expression in UTC."
  type        = string
  default     = "cron(0 7 * * ? *)"
}

variable "images_to_keep" {
  description = "How many runner images to keep per architecture. Older AMIs and their snapshots are deleted."
  type        = number
  default     = 3
}

variable "github_org" {
  description = "The organization the runners register to."
  type        = string
  default     = "oxageninc"
}

variable "private_repositories" {
  description = <<-EOT
    The private repositories whose jobs the webhook accepts. A job from any
    other repository, a public one above all, never reaches a runner. Add a new
    private repository here and to the GitHub App's installation together.
  EOT
  type        = list(string)
}

variable "ci_runner_group" {
  description = "The organization runner group the CI pools join. It admits private repositories only."
  type        = string
  default     = "oxagen-ci"
}

variable "deploy_runner_group" {
  description = "The runner group the deploy pool joins. It admits oxageninc/product's deploy workflows on main only."
  type        = string
  default     = "oxagen-production"
}

variable "github_app_ready" {
  description = <<-EOT
    Whether the GitHub App exists and its id and key are in Parameter Store.
    The warm pools stay at zero until it does, because a pool runner cannot
    register without the App.
  EOT
  type        = bool
  default     = false
}

variable "warm_pool" {
  description = "Idle runners each pool keeps registered, around the clock, once github_app_ready is true."
  type        = map(number)
  default     = {}
}

variable "webhook_domain" {
  description = "The stable address the GitHub App posts workflow_job events to."
  type        = string
  default     = "ci-webhook.oxagen.sh"
}

variable "alarm_email" {
  description = "Who the alarms and the budget alert email."
  type        = string
}

variable "monthly_budget_usd" {
  description = "The AWS Budget for this stack. It alerts at 80% and 100% of actual and forecast spend."
  type        = number
}
