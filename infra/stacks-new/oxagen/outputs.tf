output "nameservers" {
  description = "Delegate oxagen.sh to these at the registrar. Do this only once the plan below has been verified serving correctly — see the migration doc's cutover checklist."
  value       = aws_route53_zone.oxagen_sh.name_servers
}

output "oxagen_ai_nameservers" {
  description = "Delegate oxagen.ai to these at the registrar. oxagen.ai carries live mail and the GCP-fronted services — see dns-oxagen-ai.tf before touching this."
  value       = aws_route53_zone.oxagen_ai.name_servers
}

output "zone_id" {
  description = "For stacks-new/stella's parent_zone_id and any future subdomain owned by another brand."
  value       = aws_route53_zone.oxagen_sh.zone_id
}

output "web" {
  value = {
    bucket          = module.web.bucket_name
    distribution_id = module.web.distribution_id
  }
}

output "alb" {
  description = "For stacks-new/stella's alias record and stacks-new/ci-deploy's node lookup."
  value = {
    dns_name = aws_lb.app.dns_name
    zone_id  = aws_lb.app.zone_id
  }
}

output "app_node_instance_id" {
  value = module.app.instance_id
}

output "app_node_role_name" {
  description = "For stacks-new/ci-deploy to attach the deploy-read policies."
  value       = module.app.role_name
}

output "neo4j_connection_help" {
  value = module.app.neo4j_connection_help
}

output "postgres" {
  description = "Password lives at /oxagen-app/postgres/password in Parameter Store, not here — an output would write it into the state file in plaintext."
  value = {
    endpoint = aws_rds_cluster.postgres.endpoint
    port     = aws_rds_cluster.postgres.port
    database = aws_rds_cluster.postgres.database_name
    username = aws_rds_cluster.postgres.master_username
  }
}

output "redshift" {
  description = "Password lives at /oxagen-app/redshift/password in Parameter Store, not here."
  value = {
    endpoint = aws_redshiftserverless_workgroup.oxagen.endpoint
  }
}
