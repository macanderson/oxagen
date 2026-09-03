output "nameservers" {
  description = <<-EOT
    Route 53 nameservers for contextgraphprotocol.org. Entered at the
    registrar to move the domain onto AWS DNS; until then this zone exists but
    nothing resolves through it.
  EOT
  value = aws_route53_zone.cgp.name_servers
}

output "zone_id" {
  description = "Zone id for contextgraphprotocol.org."
  value       = aws_route53_zone.cgp.zone_id
}

output "site" {
  description = "Microsite — bucket to upload to and distribution to invalidate."
  value = {
    bucket          = module.site.bucket_name
    distribution_id = module.site.distribution_id
    cloudfront      = module.site.distribution_domain_name
    domains         = module.site.domains
  }
}
