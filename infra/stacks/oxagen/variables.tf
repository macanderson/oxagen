variable "region" {
  description = "Primary region for this stack's regional resources."
  type        = string
  default     = "us-east-1"
}

variable "legacy_subdomains" {
  description = <<-EOT
    Subdomain label -> CNAME target, for names still served by the previous
    host. Listed one by one rather than covered by a wildcard: a wildcard CNAME
    in this zone makes ACM's CAA check follow the alias to another domain and
    fail certificate issuance outright. See dns.tf for the full account.

    Only names with a real alias on the old host belong here. `app` and `docs`
    never had one — they reached the old host through the wildcard and returned
    its error page, so reproducing them would preserve a 404, not a service.

    Remove an entry when that subdomain moves to AWS.
  EOT
  type        = map(string)
  default = {
    arena = "cname.vercel-dns-016.com"
    cgp   = "cname.vercel-dns-016.com"
  }
}

variable "docs_bundle_path" {
  description = "Path to the docs site's zipped OpenNext server function, from tools/package-nextjs.sh."
  type        = string
}

variable "docs_bundle_hash" {
  description = "Base64 SHA-256 of the docs bundle, from tools/package-nextjs.sh."
  type        = string
}

variable "caa_issuers" {
  description = <<-EOT
    Certificate authorities permitted to issue for this domain.

    `amazon.com` is what lets ACM issue and must never be removed while any
    CloudFront distribution here serves HTTPS. The other three are inherited
    from the previous zone and are kept because Google still issues for the
    Workspace-hosted names; removing an issuer breaks its next renewal rather
    than anything visible on the day.
  EOT
  type        = list(string)
  default     = ["amazon.com", "pki.goog", "sectigo.com", "letsencrypt.org"]
}

variable "account_id" {
  description = <<-EOT
    AWS account id, used to make S3 bucket names globally unique. Passed in
    rather than read from `aws_caller_identity` so that a plan run with the
    wrong credentials fails on a name mismatch instead of silently proposing a
    second set of buckets in someone else's account.
  EOT
  type        = string
}

variable "oxagen_ai_elsewhere" {
  description = <<-EOT
    Subdomain label -> IPv4 address, for `oxagen.ai` names served by a host
    this migration does not touch.

    All six are the same Google Cloud load balancer, which still answers:
    `api` and `mcp` return application responses today, and the three
    datastore consoles sit behind the same front end. They are listed here
    rather than carried by `tools/import-dns.py` because that tool drops every
    A record on the reasoning that an A record is the old website — true for
    `oxagen.sh`, false here.

    Listed one by one rather than covered by a wildcard: a wildcard in this
    zone makes ACM's CAA check follow the alias to another domain and fail
    certificate issuance outright. See `dns.tf` for the full account.

    Remove an entry when that service moves or is switched off.
  EOT
  type        = map(string)
  default = {
    admin      = "34.144.223.45"
    api        = "34.144.223.45"
    clickhouse = "34.144.223.45"
    mcp        = "34.144.223.45"
    pgadmin    = "34.144.223.45"
    redis      = "34.144.223.45"
  }
}

variable "oxagen_ai_redirect_to" {
  description = <<-EOT
    Where `oxagen.ai` and `www.oxagen.ai` send every request.

    The homepage specifically, not the matching path: the two domains never
    shared a URL structure, so a path-preserving redirect would answer most
    links with a 404 on the target rather than with the page someone was
    looking for.
  EOT
  type        = string
  default     = "https://oxagen.sh/"
}
