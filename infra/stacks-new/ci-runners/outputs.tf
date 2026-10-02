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
