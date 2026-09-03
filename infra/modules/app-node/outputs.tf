output "instance_id" {
  description = "Instance id — the address for `aws ssm start-session` and for the ALB target group attachment."
  value       = aws_instance.node.id
}

output "role_name" {
  description = "IAM role name, so a downstream stack (ci-deploy) can attach the deploy-read policies without this module knowing about CI."
  value       = aws_iam_role.node.name
}

output "private_ip" {
  value = aws_instance.node.private_ip
}

output "security_group_id" {
  description = "So the ALB's security group can scope its egress to exactly this node, not the whole VPC."
  value       = aws_security_group.node.id
}

output "neo4j_connection_help" {
  description = "How to reach Neo4j, given that it is not exposed to the network."
  value = {
    bolt = join(" ", [
      "aws ssm start-session --target ${aws_instance.node.id} --region ${var.region}",
      "--document-name AWS-StartPortForwardingSession",
      "--parameters '{\"portNumber\":[\"7687\"],\"localPortNumber\":[\"17687\"]}'",
    ])
  }
}

