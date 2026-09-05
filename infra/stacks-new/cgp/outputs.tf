output "nameservers" {
  description = "Delegate contextgraphprotocol.org to these at the registrar."
  value       = aws_route53_zone.cgp.name_servers
}

output "site" {
  value = {
    bucket          = module.site.bucket_name
    distribution_id = module.site.distribution_id
  }
}
