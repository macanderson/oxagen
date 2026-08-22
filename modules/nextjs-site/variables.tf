variable "name" {
  description = "Short slug for this site; prefixes the names of its AWS resources."
  type        = string
}

variable "bucket_name" {
  description = "Globally-unique S3 bucket holding static assets, the incremental cache, and the deployment package."
  type        = string
}

variable "domain_name" {
  description = "Primary hostname the site is served on."
  type        = string
}

variable "alternate_domain_names" {
  description = "Additional hostnames on the certificate and in Route 53."
  type        = list(string)
  default     = []
}

variable "hosted_zone_id" {
  description = "Route 53 zone holding this site's records."
  type        = string
}

variable "region" {
  description = "Region the Lambda and bucket live in."
  type        = string
}

variable "bundle_path" {
  description = <<-EOT
    Path to the zipped OpenNext server function, produced by
    `tools/package-nextjs.sh` from `.open-next/server-functions/default`.
  EOT
  type        = string
}

variable "bundle_hash" {
  description = <<-EOT
    Base64 SHA-256 of the bundle, as `openssl dgst -binary -sha256 | base64`.
    Passed explicitly rather than read with `filebase64sha256` so that a plan
    run on a machine without the artifact reports a missing file instead of
    proposing to replace the function with an empty one.
  EOT
  type        = string
}

variable "memory_size" {
  description = <<-EOT
    Lambda memory in MB, which also sets its CPU share. 1024 is the point where
    server-rendering stops being CPU-starved; below it a request takes long
    enough that the cheaper per-millisecond rate costs more overall.
  EOT
  type        = number
  default     = 1024
}

variable "environment" {
  description = "Extra environment variables for the server function."
  type        = map(string)
  default     = {}
}

variable "content_security_policy" {
  description = "CSP to add when the application does not set its own, or null."
  type        = string
  default     = null
}

variable "tags" {
  description = "Tags applied to every resource, carrying the owning brand."
  type        = map(string)
}
