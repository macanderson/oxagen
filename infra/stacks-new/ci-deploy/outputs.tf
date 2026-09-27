output "role_arns" {
  description = <<-EOT
    The role each repository assumes, by repository. These go into the
    workflows as the `role-to-assume` input.
  EOT
  value       = { for k, r in aws_iam_role.deployer : local.deployers[k].repository => r.arn }
}

output "turbo_cache" {
  description = "The turbo remote cache bucket and the role CI assumes to use it. Inputs to .github/actions/turbo-cache."
  value = {
    bucket   = aws_s3_bucket.turbo_cache.id
    role_arn = aws_iam_role.turbo_cache.arn
  }
}

output "deploy_document" {
  description = "SSM document name the service deploys send. Also a workflow input."
  value       = aws_ssm_document.deploy_service.name
}
