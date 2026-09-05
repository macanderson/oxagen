/**
 * The command CI is allowed to run on the node.
 *
 * The manual migration deploys drove `AWS-RunShellScript`, which is the right
 * tool for a human with the account and the wrong one to hand a CI role:
 * permission to send `AWS-RunShellScript` to an instance is permission to run
 * anything on it as root, and that instance also hosts Postgres, Neo4j and
 * ClickHouse. A deploy role that can read every database is not a deploy role.
 *
 * So CI gets one document that takes one argument, and the argument is
 * constrained by `allowedPattern` at the API rather than by quoting inside the
 * script. `[a-z][a-z0-9-]{0,30}` cannot express a shell metacharacter, so
 * there is no injection to escape — SSM rejects the malformed value before the
 * instance ever sees it. The corresponding privilege on the node lives in the
 * script this invokes, which is version-controlled beside this file.
 *
 * What runs is deliberately *not* passed in. `deploy-service.sh` reads the
 * artifact's own `oxagen-run.json` for its image, port, command and
 * environment, so a service changing how it starts is a change to the
 * repository that owns it rather than a change to this document and a
 * re-apply of this stack.
 */

resource "aws_ssm_document" "deploy_service" {
  name            = "oxagen-deploy-service"
  document_type   = "Command"
  document_format = "YAML"

  content = yamlencode({
    schemaVersion = "2.2"
    description   = "Pull a published artifact from the deploy bucket and restart the service it describes."

    parameters = {
      service = {
        type        = "String"
        description = "Logical service name; selects <service>-standalone.tgz in the deploy bucket."
        # Anchored at both ends. An unanchored pattern would match a substring
        # of an argument that also carried something else.
        allowedPattern = "^[a-z][a-z0-9-]{0,30}$"
      }
    }

    mainSteps = [{
      action = "aws:runShellScript"
      name   = "deployService"
      inputs = {
        # The script is on the node, not inlined here, so that reading it does
        # not require reading Terraform state and fixing it does not require a
        # stack apply. `install-node-scripts.sh` in tools/ is what puts it
        # there, and is the file to change.
        runCommand = ["/opt/oxagen/bin/deploy-service.sh '{{ service }}'"]

        # A deploy that wedges should fail the workflow rather than hold the
        # runner until GitHub's own job timeout. Long enough for a cold image
        # pull on a small instance.
        timeoutSeconds = "900"
      }
    }]
  })
}
