variable "name" {
  description = "Short slug for this site; prefixes the names of its AWS resources."
  type        = string
}

variable "bucket_name" {
  description = "Globally-unique S3 bucket name holding the built site."
  type        = string
}

variable "domain_name" {
  description = "Primary hostname the site is served on, e.g. \"stella.oxagen.sh\"."
  type        = string
}

variable "alternate_domain_names" {
  description = <<-EOT
    Additional hostnames the distribution answers on, e.g. a "www" variant.
    Each is added to the certificate and gets its own Route 53 alias record.
  EOT
  type        = list(string)
  default     = []
}

variable "hosted_zone_id" {
  description = <<-EOT
    Route 53 zone that holds this site's records. A site may live in a zone
    another brand's stack owns — `stella.oxagen.sh` sits inside `oxagen.sh` —
    so the zone is an input rather than something this module creates.
  EOT
  type        = string
}

variable "url_rewrite_mode" {
  description = <<-EOT
    How a clean URL maps onto a key in the bucket. "html_suffix" for a Next.js
    static export (`/docs/concepts` -> `docs/concepts.html`), "directory_index"
    for hand-authored HTML (`/read` -> `read/index.html`). See rewrite.js.tftpl
    for why one distribution cannot serve both.
  EOT
  type        = string
  default     = "html_suffix"

  validation {
    condition     = contains(["html_suffix", "directory_index"], var.url_rewrite_mode)
    error_message = "url_rewrite_mode must be \"html_suffix\" or \"directory_index\"."
  }
}

variable "not_found_path" {
  description = "Object served for a request that matches nothing, e.g. \"/404.html\"."
  type        = string
  default     = "/404.html"
}

variable "immutable_path_patterns" {
  description = <<-EOT
    Path patterns whose contents are content-addressed and may be cached at the
    edge indefinitely — typically "/_next/static/*".
  EOT
  type        = list(string)
  default     = []
}

variable "content_security_policy" {
  description = <<-EOT
    CSP header value, or null to send none. Set per site: a docs site that
    inlines its hydration payload needs a different policy from a static page
    that inlines nothing.
  EOT
  type        = string
  default     = null
}

variable "exact_redirects" {
  description = <<-EOT
    Path -> destination, matched exactly and answered with a 308 at the edge.
    Carries the redirects a framework's config declares, which a static export
    drops on the floor because it ships no server to run them.
  EOT
  type        = map(string)
  default     = {}
}

variable "prefix_redirects" {
  description = <<-EOT
    Path prefix -> destination. The prefix and everything beneath it redirect
    to one destination, covering a `/docs/old/:path*` style rule.
  EOT
  type        = map(string)
  default     = {}
}

variable "exact_rewrites" {
  description = <<-EOT
    Path -> object key, rewritten at the edge without the visitor seeing it.
    For the paths where neither layout rule applies, typically hand-built HTML
    living under a framework export's `public/` directory.
  EOT
  type        = map(string)
  default     = {}
}

variable "tags" {
  description = "Tags applied to every resource, carrying the owning brand."
  type        = map(string)
}
