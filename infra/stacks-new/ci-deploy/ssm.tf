resource "aws_ssm_document" "deploy_service" {
  name            = "oxagen-deploy-service"
  document_type   = "Command"
  document_format = "YAML"

  content = yamlencode({
    schemaVersion = "2.2"
    description   = "Pull a published artifact from the deploy bucket and restart the service it describes."

    parameters = {
      service = {
        type           = "String"
        description    = "Logical service name; selects <service>-standalone.tgz in the deploy bucket."
        allowedPattern = "^[a-z][a-z0-9-]{0,30}$"
      }
    }

    mainSteps = [{
      action = "aws:runShellScript"
      name   = "deployService"
      inputs = {
        runCommand     = ["/opt/oxagen/bin/deploy-service.sh '{{ service }}'"]
        timeoutSeconds = "900"
      }
    }]
  })
}
