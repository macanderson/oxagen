variable "name" {
  description = "Short identifier for this redirect's resources, e.g. `oxagen-ai-redirect`."
  type        = string
}

variable "domain_name" {
  description = "Primary hostname to answer on. Gets an apex-capable alias record."
  type        = string
}

variable "alternate_domain_names" {
  description = "Further hostnames the distribution answers on. Each is added to the certificate and gets its own alias records."
  type        = list(string)
  default     = []
}

variable "hosted_zone_id" {
  description = "Route 53 zone holding `domain_name`. Certificate validation records and the alias records are written here."
  type        = string
}

variable "redirect_to" {
  description = <<-EOT
    Absolute URL every request is sent to, path and query discarded.

    Written in full including the scheme, because it is emitted verbatim as a
    `Location` header — a scheme-relative or bare-host value would be resolved
    against the requested host and redirect the domain to itself.
  EOT
  type        = string

  validation {
    condition     = startswith(var.redirect_to, "https://")
    error_message = "redirect_to must be an absolute https:// URL, since it is emitted verbatim as a Location header."
  }
}

variable "status_code" {
  description = <<-EOT
    HTTP status for the redirect.

    301 tells browsers, crawlers and link checkers that the move is permanent,
    which is what consolidates a retired domain's search reputation onto the
    surviving one. It is also the choice that is expensive to reverse: clients
    are entitled to cache a 301 indefinitely, and some do so regardless of the
    `Cache-Control` the function sends. Use 302 while a move is still
    provisional.
  EOT
  type        = number
  default     = 301

  validation {
    condition     = contains([301, 302, 307, 308], var.status_code)
    error_message = "status_code must be one of 301, 302, 307, 308."
  }
}

variable "tags" {
  description = "Extra tags merged onto every taggable resource."
  type        = map(string)
  default     = {}
}
