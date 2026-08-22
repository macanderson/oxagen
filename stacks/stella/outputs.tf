output "site" {
  description = "Stella site — bucket, distribution, and the Lambda serving it."
  value = {
    bucket          = module.site.bucket_name
    distribution_id = module.site.distribution_id
    cloudfront      = module.site.distribution_domain_name
    function        = module.site.function_name
    domains         = module.site.domains
  }
}
