output "bucket_name" {
  description = "Bucket holding static assets, the incremental cache, and deployment packages."
  value       = aws_s3_bucket.assets.id
}

output "distribution_id" {
  description = "CloudFront distribution id — needed to invalidate after a deploy."
  value       = aws_cloudfront_distribution.site.id
}

output "distribution_domain_name" {
  description = "CloudFront hostname, usable to verify the site before DNS points at it."
  value       = aws_cloudfront_distribution.site.domain_name
}

output "function_name" {
  description = "Server Lambda, for logs and manual invocation."
  value       = aws_lambda_function.server.function_name
}

output "domains" {
  description = "Every hostname this distribution serves."
  value       = local.all_domains
}
