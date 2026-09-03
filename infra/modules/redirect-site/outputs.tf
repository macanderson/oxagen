output "distribution_id" {
  description = "CloudFront distribution id. Nothing is cached here, so this is for identification rather than invalidation."
  value       = aws_cloudfront_distribution.redirect.id
}

output "distribution_domain_name" {
  description = "CloudFront hostname, e.g. d111111abcdef8.cloudfront.net. Useful for testing the redirect before the domain's nameservers point here."
  value       = aws_cloudfront_distribution.redirect.domain_name
}

output "domains" {
  description = "Every hostname this distribution redirects."
  value       = local.all_domains
}

output "redirect_to" {
  description = "The URL every request is sent to."
  value       = var.redirect_to
}
