output "nameservers" {
  description = <<-EOT
    The four Route 53 nameservers for oxagen.sh. These are what get entered at
    the registrar to move the domain onto AWS DNS; until they are, this zone
    exists but nothing resolves through it.
  EOT
  value = aws_route53_zone.oxagen_sh.name_servers
}

output "zone_id" {
  description = <<-EOT
    Zone id for oxagen.sh. The Stella and CGP stacks take this as input,
    because their sites live on subdomains of it.
  EOT
  value = aws_route53_zone.oxagen_sh.zone_id
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
