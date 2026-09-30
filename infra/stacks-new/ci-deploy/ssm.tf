resource "aws_ssm_document" "deploy_service" {
  name            = "oxagen-deploy-service"
  document_type   = "Command"
  document_format = "YAML"

  content = yamlencode({
    schemaVersion = "2.2"
    description   = "Pull a published artifact from the deploy bucket and restart the service it describes."

    parameters = {
      toolchainDigest = {
        type           = "String"
        description    = "Required source digest of an infrastructure-published node tool bundle."
        default        = "current"
        allowedPattern = "^(current|[0-9a-f]{64})$"
      }
      operation = {
        type          = "String"
        default       = "deploy"
        allowedValues = ["verify", "deploy"]
      }
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
        runCommand = [join("\n", [
          "python3 - '{{ operation }}' --service '{{ service }}' --digest '{{ toolchainDigest }}' --bucket '${aws_s3_bucket.deploy.bucket}' --region '${var.region}' <<'PY_NODE_TOOLS'",
          file("${path.module}/../../tools/node/deploy-dispatch.py"),
          "PY_NODE_TOOLS"
        ])]
        timeoutSeconds = "900"
      }
    }]
  })
}
