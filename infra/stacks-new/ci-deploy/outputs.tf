output "role_arns" {
  description = <<-EOT
    The role each repository assumes, by repository. These go into the
    workflows as the `role-to-assume` input.
  EOT
  value       = { for k, r in aws_iam_role.deployer : local.deployers[k].repository => r.arn }
}

output "deploy_document" {
  description = "SSM document name the service deploys send. Also a workflow input."
  value       = aws_ssm_document.deploy_service.name
}
