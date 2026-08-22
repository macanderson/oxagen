output "group_name" {
  description = "Name of the brand's Resource Group."
  value       = aws_resourcegroups_group.brand.name
}

output "group_arn" {
  description = "ARN of the brand's Resource Group."
  value       = aws_resourcegroups_group.brand.arn
}
