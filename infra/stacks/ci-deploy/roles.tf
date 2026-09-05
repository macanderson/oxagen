/**
 * What each repository may do once it has assumed its role.
 *
 * Written out per repository rather than generated from a table. The trust
 * policies in `main.tf` are uniform and belong in a loop; these are not
 * uniform, and each one is a decision about how far a compromised workflow
 * reaches. A reviewer should be able to answer "what can the CGP repository
 * touch?" by reading one block, not by evaluating a map against a module.
 *
 * Two shapes recur:
 *
 *   Publishing a static site is writing a bucket and invalidating the
 *   distribution in front of it. `s3:DeleteObject` is included because the
 *   sync is `--delete` — a site that only ever gains files keeps serving pages
 *   that were removed from the source.
 *
 *   Publishing a service is putting one object in the deploy bucket and
 *   sending one constrained SSM document. Neither grants a shell; see ssm.tf.
 */

locals {
  cloudfront_arn = "arn:aws:cloudfront::${var.account_id}:distribution"
  ssm_arn_prefix = "arn:aws:ssm:${var.region}:${var.account_id}"

  # Prefixes on the CGP bucket that belong to the protocol repository rather
  # than the website repository. Named once because two policies below have to
  # agree about them and disagreeing silently is the whole hazard: the website
  # syncs with `--delete`, so anything it is not told to leave alone, it
  # removes on the next merge.
  cgp_protocol_prefixes = ["schema", "spec"]
}

# --------------------------------------------------------------------------
# macanderson/stella -> stella.oxagen.sh
#
# The site runs as a Node process on the shared node rather than on Lambda:
# CloudFront in front of a Lambda Function URL returns 403 for every request in
# this account, including with the URL's own authorization disabled. The Stella
# stack still holds that Lambda and its bucket; nothing serves from them, and
# this role deliberately does not grant access to either, so a deploy cannot
# half-publish to a front door that does not work.
# --------------------------------------------------------------------------

data "aws_iam_policy_document" "stella" {
  statement {
    sid       = "PublishArtifact"
    actions   = ["s3:PutObject"]
    resources = ["arn:aws:s3:::${var.deploy_bucket}/_deploy/stella-standalone.tgz"]
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
    sid = "ReadCommandResult"
    # These two actions take no resource type at all in IAM, so `*` is the only
    # expressible scope rather than a widening. They read the outcome of a
    # command; sending one is scoped by the statement above.
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
#
# The microsite owns the bucket except for the prefixes the protocol
# repository publishes into. The exclusion is enforced here rather than left to
# the `--exclude` flags in the workflow, because those flags are one edit away
# from being dropped and the failure is silent: the site would deploy green and
# every schema URL would 404 until someone noticed.
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
#
# The protocol repository has no website of its own; what it publishes are the
# JSON Schemas and the specification, under two prefixes of the microsite's
# bucket. It gets those two prefixes and nothing else — notably not the
# site's HTML, which it must not be able to overwrite.
#
# It also fires a `repository_dispatch` at cgp-website so a protocol change
# rebuilds the rendered docs. That needs a GitHub token, not an AWS
# permission, and so appears nowhere in this policy.
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
# oxageninc/oxagen-platform -> oxagen.sh and the four services on the node
#
# The broadest of the four, because the repository genuinely owns the most:
# the marketing site as files, and `docs`, `app`, `api` and `mcp` as processes.
# The artifact statement still names each service's object individually rather
# than granting the deploy prefix, so this role cannot publish an artifact for
# a service it does not own — Stella's, for instance, which lands in the same
# bucket.
# --------------------------------------------------------------------------

locals {
  platform_services = ["docs", "app", "api", "mcp"]
}

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
      "arn:aws:s3:::${var.deploy_bucket}/_deploy/${s}-standalone.tgz"
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

  # `next build` reads the production environment out of Parameter Store, so
  # the credentials are assumed before packaging rather than only for the
  # upload. The path node is granted alongside its children because
  # GetParametersByPath authorizes against the path itself, and a grant of
  # only `/oxagen/production/*` fails the call that lists it.
  statement {
    sid = "ReadBuildEnvironment"
    actions = [
      "ssm:GetParametersByPath",
      "ssm:GetParameters",
      "ssm:GetParameter",
    ]
    resources = [
      "arn:aws:ssm:${var.region}:${var.account_id}:parameter/oxagen/production/*",
      "arn:aws:ssm:${var.region}:${var.account_id}:parameter/oxagen/production",
    ]
  }

  # Those parameters are SecureString, so reading them is a KMS decrypt. The
  # condition keeps the grant to decrypts made through Parameter Store.
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
