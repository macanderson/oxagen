/**
 * Permissions per repository. Same shape as the old account's `roles.tf`; the
 * only real difference is that `stella` here gets S3 + SSM deploy rights
 * (this account never grew the unused Lambda site the old account carries in
 * state, so there is nothing to deliberately withhold access to).
 */

locals {
  cloudfront_arn = "arn:aws:cloudfront::${var.account_id}:distribution"
  ssm_arn_prefix = "arn:aws:ssm:${var.region}:${var.account_id}"

  cgp_protocol_prefixes = ["schema", "spec"]
  platform_services     = ["docs", "app", "api", "mcp"]
}

# --------------------------------------------------------------------------
# macanderson/stella -> stella.oxagen.sh
# --------------------------------------------------------------------------

data "aws_iam_policy_document" "stella" {
  statement {
    sid       = "PublishArtifact"
    actions   = ["s3:PutObject"]
    resources = ["arn:aws:s3:::${aws_s3_bucket.deploy.bucket}/_deploy/stella-standalone.tgz"]
  }

  statement {
    sid     = "RestartService"
    actions = ["ssm:SendCommand"]
    resources = [
      aws_ssm_document.deploy_service.arn,
      "arn:aws:ec2:${var.region}:${var.account_id}:instance/${var.node_instance_id}",
    ]
  }

  statement {
    sid       = "ReadCommandResult"
    actions   = ["ssm:GetCommandInvocation", "ssm:ListCommandInvocations"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "stella" {
  name   = "deploy-stella-site"
  role   = aws_iam_role.deployer["stella"].id
  policy = data.aws_iam_policy_document.stella.json
}

# --------------------------------------------------------------------------
# macanderson/cgp-website -> contextgraphprotocol.org
# --------------------------------------------------------------------------

data "aws_iam_policy_document" "cgp_website" {
  statement {
    sid       = "ListSiteBucket"
    actions   = ["s3:ListBucket"]
    resources = ["arn:aws:s3:::${var.sites["cgp"].bucket}"]
  }

  statement {
    sid       = "PublishSite"
    actions   = ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"]
    resources = ["arn:aws:s3:::${var.sites["cgp"].bucket}/*"]
  }

  statement {
    sid       = "LeaveProtocolArtifactsAlone"
    effect    = "Deny"
    actions   = ["s3:PutObject", "s3:DeleteObject"]
    resources = [for p in local.cgp_protocol_prefixes : "arn:aws:s3:::${var.sites["cgp"].bucket}/${p}/*"]
  }

  statement {
    sid       = "InvalidateSite"
    actions   = ["cloudfront:CreateInvalidation", "cloudfront:GetInvalidation"]
    resources = ["${local.cloudfront_arn}/${var.sites["cgp"].distribution_id}"]
  }
}

resource "aws_iam_role_policy" "cgp_website" {
  name   = "deploy-cgp-site"
  role   = aws_iam_role.deployer["cgp-website"].id
  policy = data.aws_iam_policy_document.cgp_website.json
}

# --------------------------------------------------------------------------
# macanderson/context-graph-protocol -> the schema and spec on that same site
# --------------------------------------------------------------------------

data "aws_iam_policy_document" "cgp_protocol" {
  statement {
    sid       = "ListOwnPrefixes"
    actions   = ["s3:ListBucket"]
    resources = ["arn:aws:s3:::${var.sites["cgp"].bucket}"]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = concat([for p in local.cgp_protocol_prefixes : "${p}/*"], local.cgp_protocol_prefixes)
    }
  }

  statement {
    sid       = "PublishOwnPrefixes"
    actions   = ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"]
    resources = [for p in local.cgp_protocol_prefixes : "arn:aws:s3:::${var.sites["cgp"].bucket}/${p}/*"]
  }

  statement {
    sid       = "InvalidateSite"
    actions   = ["cloudfront:CreateInvalidation", "cloudfront:GetInvalidation"]
    resources = ["${local.cloudfront_arn}/${var.sites["cgp"].distribution_id}"]
  }
}

resource "aws_iam_role_policy" "cgp_protocol" {
  name   = "publish-cgp-schema"
  role   = aws_iam_role.deployer["context-graph-protocol"].id
  policy = data.aws_iam_policy_document.cgp_protocol.json
}

# --------------------------------------------------------------------------
# macanderson/oxagen -> oxagen.sh and the four services on the node
# --------------------------------------------------------------------------

data "aws_iam_policy_document" "oxagen_platform" {
  statement {
    sid       = "ListSiteBucket"
    actions   = ["s3:ListBucket"]
    resources = ["arn:aws:s3:::${var.sites["oxagen-web"].bucket}"]
  }

  statement {
    sid       = "PublishSite"
    actions   = ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"]
    resources = ["arn:aws:s3:::${var.sites["oxagen-web"].bucket}/*"]
  }

  statement {
    sid       = "InvalidateSite"
    actions   = ["cloudfront:CreateInvalidation", "cloudfront:GetInvalidation"]
    resources = ["${local.cloudfront_arn}/${var.sites["oxagen-web"].distribution_id}"]
  }

  statement {
    sid     = "PublishArtifacts"
    actions = ["s3:PutObject"]
    resources = [
      for s in local.platform_services :
      "arn:aws:s3:::${aws_s3_bucket.deploy.bucket}/_deploy/${s}-standalone.tgz"
    ]
  }

  statement {
    sid     = "RestartServices"
    actions = ["ssm:SendCommand"]
    resources = [
      aws_ssm_document.deploy_service.arn,
      "arn:aws:ec2:${var.region}:${var.account_id}:instance/${var.node_instance_id}",
    ]
  }

  statement {
    sid       = "ReadCommandResult"
    actions   = ["ssm:GetCommandInvocation", "ssm:ListCommandInvocations"]
    resources = ["*"]
  }

  statement {
    sid = "ReadBuildEnvironment"
    actions = [
      "ssm:GetParametersByPath",
      "ssm:GetParameters",
      "ssm:GetParameter",
    ]
    resources = [
      "arn:aws:ssm:${var.region}:${var.account_id}:parameter${var.app_parameter_prefix}/*",
      "arn:aws:ssm:${var.region}:${var.account_id}:parameter${var.app_parameter_prefix}",
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

resource "aws_iam_role_policy" "oxagen_platform" {
  name   = "deploy-oxagen-platform"
  role   = aws_iam_role.deployer["oxagen-platform"].id
  policy = data.aws_iam_policy_document.oxagen_platform.json
}
