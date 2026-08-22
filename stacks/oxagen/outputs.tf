output "nameservers" {
  description = <<-EOT
    The four Route 53 nameservers for oxagen.sh. These are what get entered at
    the registrar to move the domain onto AWS DNS; until they are, this zone
    exists but nothing resolves through it.
  EOT
  value       = aws_route53_zone.oxagen_sh.name_servers
}

output "nameservers_oxagen_ai" {
  description = <<-EOT
    The four Route 53 nameservers for oxagen.ai. These are what get entered at
    the registrar — the domain is registered with Vercel, so it is that
    dashboard's nameserver form, not Terraform, that completes the move.

    Enter them only once this stack has been applied. Until then the zone is
    empty or partial, and repointing at an incomplete zone takes this domain's
    mail and its three live GCP-hosted services down with its website.
  EOT
  value       = aws_route53_zone.oxagen_ai.name_servers
}

output "zone_id" {
  description = <<-EOT
    Zone id for oxagen.sh. The Stella and CGP stacks take this as input,
    because their sites live on subdomains of it.
  EOT
  value       = aws_route53_zone.oxagen_sh.zone_id
}

output "oxagen_ai_redirect" {
  description = "The retired domain's redirect — where it points, and the distribution serving it."
  value = {
    distribution_id = module.oxagen_ai_redirect.distribution_id
    cloudfront      = module.oxagen_ai_redirect.distribution_domain_name
    domains         = module.oxagen_ai_redirect.domains
    redirect_to     = module.oxagen_ai_redirect.redirect_to
  }
}

output "web" {
  description = "Marketing site — bucket to upload to and distribution to invalidate."
  value = {
    bucket          = module.web.bucket_name
    distribution_id = module.web.distribution_id
    cloudfront      = module.web.distribution_domain_name
    domains         = module.web.domains
  }
}

output "docs" {
  description = "Documentation site — bucket to upload to and distribution to invalidate."
  value = {
    bucket          = module.docs.bucket_name
    distribution_id = module.docs.distribution_id
    cloudfront      = module.docs.distribution_domain_name
    domains         = module.docs.domains
  }
}
