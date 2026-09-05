output "vpc_id" {
  value = aws_vpc.this.id
}

output "public_subnet_ids" {
  value = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  description = "Both private subnets, one per AZ — for Aurora/Redshift's subnet groups, which require at least two."
  value       = aws_subnet.private[*].id
}

output "app_node_subnet_id" {
  description = "The one private subnet the app node itself lives in."
  value       = aws_subnet.private[0].id
}

output "nat_instance_id" {
  value = aws_instance.nat.id
}
