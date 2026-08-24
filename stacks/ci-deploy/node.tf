/**
 * The read side of the deploy path, on the node.
 *
 * CI pushes an artifact into the deploy bucket and sends one command; the node
 * is what pulls the artifact and reads the configuration the service starts
 * with. Those two permissions exist only to serve deploys, which is why they
 * are here rather than in the module that owns the instance. The other reason
 * is operational: `stacks/oxagen-data` holds Postgres, Neo4j and ClickHouse,
 * and applying it to add an IAM statement computes a plan containing the
 * databases. This stack's plans contain roles.
 *
 * The role is looked up rather than created. It belongs to the data stack; a
 * `data` source makes that ownership explicit and makes a mistyped name fail
 * at plan time instead of creating a second, unattached role that would look
 * correct in the console and grant nothing.
 */

data "aws_iam_role" "node" {
  name = var.node_role_name
}

# Adopts the inline policy that was written by hand during the migration. The
# content is identical, so the first apply is a no-op in behaviour and a real
# change in provenance: the permission the whole deploy path depends on stops
# being drift that nothing would recreate if the role were ever rebuilt.
data "aws_iam_policy_document" "node_read_artifacts" {
  statement {
    sid       = "ReadDeployArtifacts"
    actions   = ["s3:GetObject"]
    resources = ["arn:aws:s3:::${var.deploy_bucket}/*"]
  }

  statement {
    sid       = "ListDeployBucket"
    actions   = ["s3:ListBucket"]
    resources = ["arn:aws:s3:::${var.deploy_bucket}"]
  }
}

resource "aws_iam_role_policy" "node_read_artifacts" {
  name   = "read-deploy-artifacts"
  role   = data.aws_iam_role.node.id
  policy = data.aws_iam_policy_document.node_read_artifacts.json
}

# The applications' runtime configuration. Scoped to `/oxagen/production/*`,
# which is a different subtree from the `/oxagen-data/*` passwords the node
# already reads at boot — a service that is compromised through its own
# configuration does not thereby enumerate the database credentials.
#
# `kms:Decrypt` is unavoidably `*` because SecureString parameters may be
# encrypted under the account's default SSM key, whose id is not a stable
# input. The `ViaService` condition is what makes it safe: the grant is usable
# only through Parameter Store, so it cannot decrypt anything this role cannot
# already read as a parameter. Same construction as the data stack's own.
data "aws_iam_policy_document" "node_read_app_config" {
  # Both ARNs, because the two call shapes authorize against different
  # resources. `GetParameter` names a leaf and is authorized against that
  # leaf, which the wildcard covers. `GetParametersByPath` names the *path*
  # and is authorized against the path's own ARN, which the wildcard does not
  # match — with only the wildcard the node's deploy script fails with
  # AccessDeniedException on `ssm:GetParametersByPath`, and every service
  # declaring a `config_prefix` starts with no configuration at all.
  statement {
    sid     = "ReadApplicationConfig"
    actions = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"]
    resources = [
      "${local.ssm_arn_prefix}:parameter${var.app_parameter_prefix}",
      "${local.ssm_arn_prefix}:parameter${var.app_parameter_prefix}/*",
    ]
  }

  statement {
    sid       = "DecryptThroughParameterStore"
    actions   = ["kms:Decrypt"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.${var.region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "node_read_app_config" {
  name   = "read-application-config"
  role   = data.aws_iam_role.node.id
  policy = data.aws_iam_policy_document.node_read_app_config.json
}
