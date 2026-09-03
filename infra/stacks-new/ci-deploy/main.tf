/**
 * GitHub OIDC deploy roles for the new account. Same four repositories, same
 * trust-policy design as `stacks/ci-deploy` in the old account — an OIDC
 * provider and a set of IAM roles are account-scoped resources, so this is a
 * genuinely new provider and new roles, not a copy of existing ones. See the
 * old account's `stacks/ci-deploy/main.tf` for the full argument on why
 * `StringEquals` rather than `StringLike`, and why both subject spellings are
 * trusted.
 *
 * Cutover implication: each repository's workflow takes a `role-to-assume`
 * ARN as input. The role ARNs below are new — deploying to this account means
 * updating that input in each of the four workflows, not just applying this
 * stack.
 */

resource "aws_iam_openid_connect_provider" "github" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = local.github_thumbprints
}

locals {
  github_thumbprints = [
    "6938fd4d98bab03faadb97b34396831e3780aea1",
    "1c58a3a8518e8759bf075b76b750d4f2df264fcd",
  ]

  deployers = {
    stella = {
      repository  = "macanderson/stella"
      owner_id    = 542881
      repo_id     = 1297837446
      description = "Publishes stella.oxagen.sh from website/."
    }
    cgp-website = {
      repository  = "macanderson/cgp-website"
      owner_id    = 542881
      repo_id     = 1310376825
      description = "Publishes contextgraphprotocol.org."
    }
    context-graph-protocol = {
      repository  = "macanderson/context-graph-protocol"
      owner_id    = 542881
      repo_id     = 1304589599
      description = "Publishes the CGP schema and specification artifacts."
    }
    oxagen-platform = {
      repository  = "macanderson/oxagen"
      owner_id    = 542881
      repo_id     = 1252628274
      description = "Publishes oxagen.sh and the docs/app/api/mcp services on the node."
    }
  }

  deploy_environment = "production"
}

locals {
  deploy_subjects = {
    for key, d in local.deployers : key => [
      "repo:${d.repository}:environment:${local.deploy_environment}",
      "repo:${split("/", d.repository)[0]}@${d.owner_id}/${split("/", d.repository)[1]}@${d.repo_id}:environment:${local.deploy_environment}",
    ]
  }
}

data "aws_iam_policy_document" "assume" {
  for_each = local.deployers

  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = local.deploy_subjects[each.key]
    }
  }
}

resource "aws_iam_role" "deployer" {
  for_each = local.deployers

  name        = "gha-deploy-${each.key}"
  description = each.value.description

  assume_role_policy = data.aws_iam_policy_document.assume[each.key].json

  max_session_duration = 3600
}
