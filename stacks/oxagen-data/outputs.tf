output "instance_id" {
  description = "Data node instance id."
  value       = module.data.instance_id
}

output "secret_parameter_paths" {
  description = "Where each engine's generated password lives in Parameter Store."
  value       = module.data.secret_parameter_paths
}

output "connection_help" {
  description = "Commands to reach each engine through SSM, since none is exposed to the network."
  value       = module.data.connection_help
}
