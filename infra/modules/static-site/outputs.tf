output "bucket_name" {
  description = "S3 bucket the built site is uploaded to."
  value       = aws_s3_bucket.site.id
}

output "distribution_id" {
  description = "CloudFront distribution id — needed to invalidate after a deploy."
  value       = aws_cloudfront_distribution.site.id
}

output "distribution_domain_name" {
  description = "CloudFront hostname, e.g. d111111abcdef8.cloudfront.net."
  value       = aws_cloudfront_distribution.site.domain_name
}

output "domains" {
  description = "Every hostname this distribution serves."
  value       = local.all_domains
}
