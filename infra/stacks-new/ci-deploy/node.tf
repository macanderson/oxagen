/**
 * The read side of the deploy path, granted onto the app node's own role
 * (created by `modules/app-node`, looked up here by name — same reasoning as
 * the old account's `node.tf`: applying this stack, which changes often as
 * repositories gain or lose deploy access, must not compute a plan that
 * touches the node itself).
 *
 * No `/oxagen-data/*` secrets grant here, unlike the old account: this node
 * holds no database credentials to isolate from, because it holds no
 * database.
 */

data "aws_iam_role" "node" {
  name = var.node_role_name
}

data "aws_iam_policy_document" "node_read_artifacts" {
  statement {
    sid       = "ReadDeployArtifacts"
    actions   = ["s3:GetObject"]
    resources = ["arn:aws:s3:::${aws_s3_bucket.deploy.bucket}/*"]
  }

  statement {
    sid       = "ListDeployBucket"
    actions   = ["s3:ListBucket"]
    resources = ["arn:aws:s3:::${aws_s3_bucket.deploy.bucket}"]
  }
}

resource "aws_iam_role_policy" "node_read_artifacts" {
  name   = "read-deploy-artifacts"
  role   = data.aws_iam_role.node.id
  policy = data.aws_iam_policy_document.node_read_artifacts.json
}

data "aws_iam_policy_document" "node_read_app_config" {
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
