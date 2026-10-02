output "webhook_url" {
  description = "The GitHub App's webhook URL. scripts/github-app-manifest.html carries it."
  value       = "https://${var.webhook_domain}/webhook"
}

output "webhook_url_direct" {
  description = "The same webhook on API Gateway's own address, for debugging DNS or the certificate."
  value       = module.runners.webhook.endpoint
}

output "ci_images" {
  description = "Image references for the workflows' container: and services: keys."
  value = merge(
    { for name in keys(local.ci_images) : name => "${aws_ecrpublic_repository.ci[name].repository_uri}:latest" },
    { for name, source in local.service_images : name => "${aws_ecrpublic_repository.ci[name].repository_uri}:${split(":", source)[length(split(":", source)) - 1]}" },
  )
}

output "ecr_public_registry" {
  description = "The ECR Public registry, public.ecr.aws/<alias>."
  value       = local.ecr_public_registry
}

output "ci_image_role_arn" {
  description = "The role ci-image.yml assumes."
  value       = aws_iam_role.ci_image.arn
}

output "image_assets_bucket" {
  description = "Build files, build logs, and the pnpm store tarballs."
  value       = aws_s3_bucket.image_assets.id
}

output "image_pipelines" {
  description = "Image Builder pipelines. Start a build with: aws imagebuilder start-image-pipeline-execution --image-pipeline-arn <arn>"
  value       = { for k, p in aws_imagebuilder_image_pipeline.runner : k => p.arn }
}

output "runner_ami_parameters" {
  description = "Where Image Builder writes each architecture's newest AMI id."
  value       = { for k, p in aws_ssm_parameter.runner_ami : k => p.name }
}

output "github_app_parameters" {
  description = "Where scripts/store-github-app.sh writes the GitHub App's id, key, and webhook secret."
  value       = local.github_app_ssm
}

output "pools" {
  description = "Each pool's label, maximum, and warm size."
  value = merge(
    { for name, p in local.pools : name => { max = p.max, warm = var.github_app_ready ? lookup(var.warm_pool, name, 0) : 0, types = p.types } },
    { "oxagen-deploy" = { max = 6, warm = var.github_app_ready ? lookup(var.warm_pool, "oxagen-deploy", 0) : 0, types = ["m8gd.4xlarge", "m8g.4xlarge", "m7g.4xlarge"] } },
  )
}

output "deploy_runner_security_group_id" {
  description = "The deploy pool's security group. The production stack admits it to the data stores."
  value       = aws_security_group.deploy_runner.id
}

output "alarm_topic_arn" {
  value = aws_sns_topic.alarms.arn
}
