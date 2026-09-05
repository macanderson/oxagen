output "role_arns" {
  description = <<-EOT
    The role each repository assumes, by repository. These go into the
    workflows as the `role-to-assume` input — they are identifiers, not
    secrets, and a role is useless without a token whose subject the trust
    policy accepts, so committing them to a public repository costs nothing
    and reading the deploy in version control is worth something.
  EOT
  value       = { for k, r in aws_iam_role.deployer : local.deployers[k].repository => r.arn }
}

output "deploy_document" {
  description = "SSM document name the service deploys send. Also a workflow input."
  value       = aws_ssm_document.deploy_service.name
}

output "setup" {
  description = <<-EOT
    What has to be done by hand once, outside Terraform, before any of this
    works. Both halves are GitHub-side, which is why neither can be an
    `aws_` resource: the trust policy accepts a subject that only exists once
    the repository has an environment of that name.
  EOT
  value = <<-EOT
    In each of the four repositories, create an environment named exactly
    `production` (Settings -> Environments -> New environment). The roles below
    trust `repo:<owner>/<name>:environment:production` and nothing else, so a
    deploy job runs into an assume-role failure until the environment exists.

    Add protection rules there if the deploy should pause for a human. That is
    the whole reason the trust is pinned to the environment rather than to the
    main branch: it makes "who may deploy" a repository setting that can be
    tightened later without touching a workflow or re-applying this stack.
  EOT
}
