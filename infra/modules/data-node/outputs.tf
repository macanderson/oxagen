output "instance_id" {
  description = "Instance id — the address for `aws ssm start-session`."
  value       = aws_instance.node.id
}

output "private_ip" {
  description = "Private address of the node inside the VPC."
  value       = aws_instance.node.private_ip
}

output "data_volume_id" {
  description = "Durable data volume, which outlives the instance."
  value       = aws_ebs_volume.data.id
}

output "secret_parameter_paths" {
  description = <<-EOT
    Where each engine's password lives in Parameter Store. The values are not
    output — reading them is an explicit `aws ssm get-parameter
    --with-decryption`, which is auditable in CloudTrail, whereas a Terraform
    output writes the secret into the state file in plaintext for anyone who
    can read the bucket.
  EOT
  value = {
    postgres   = aws_ssm_parameter.postgres.name
    neo4j      = aws_ssm_parameter.neo4j.name
    clickhouse = aws_ssm_parameter.clickhouse.name
  }
}

output "connection_help" {
  description = "How to reach each engine, given that none is exposed to the network."
  value = {
    session = "aws ssm start-session --target ${aws_instance.node.id} --region ${var.region}"
    postgres = join(" ", [
      "aws ssm start-session --target ${aws_instance.node.id} --region ${var.region}",
      "--document-name AWS-StartPortForwardingSession",
      "--parameters '{\"portNumber\":[\"5432\"],\"localPortNumber\":[\"15432\"]}'",
    ])
    neo4j_bolt = join(" ", [
      "aws ssm start-session --target ${aws_instance.node.id} --region ${var.region}",
      "--document-name AWS-StartPortForwardingSession",
      "--parameters '{\"portNumber\":[\"7687\"],\"localPortNumber\":[\"17687\"]}'",
    ])
    clickhouse_http = join(" ", [
      "aws ssm start-session --target ${aws_instance.node.id} --region ${var.region}",
      "--document-name AWS-StartPortForwardingSession",
      "--parameters '{\"portNumber\":[\"8123\"],\"localPortNumber\":[\"18123\"]}'",
    ])
  }
}
