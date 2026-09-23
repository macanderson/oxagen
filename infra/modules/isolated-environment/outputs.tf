output "instance_id" { value = module.app.instance_id }
output "node_name" { value = local.node_name }
output "deploy_bucket" { value = aws_s3_bucket.deploy.id }
output "parameter_prefix" { value = local.prefix }
output "deploy_role_arn" { value = aws_iam_role.deploy.arn }
output "deploy_document" { value = aws_ssm_document.deploy.name }
output "postgres_host" { value = aws_rds_cluster.postgres.endpoint }
output "urls" { value = { for service in local.services : service => "https://${service}.${var.domain}" } }
