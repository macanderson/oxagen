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
      repository  = "oxageninc/cgp-website"
      owner_id    = 267772457
      repo_id     = 1310376825
      description = "Publishes contextgraphprotocol.org."
    }
    context-graph-protocol = {
      repository  = "oxageninc/context-graph-protocol"
      owner_id    = 267772457
      repo_id     = 1304589599
      description = "Publishes the CGP schema and specification artifacts."
    }
    oxagen-platform = {
      repository  = "oxageninc/product"
      owner_id    = 267772457
      repo_id     = 1252628274
      description = "Publishes oxagen.sh and the docs/app/api/mcp services on the node."
    }
  }

  # Names a deployer's repository had before it moved. On 2026-10-01 Mac moved
  # three of them from the macanderson account (owner 542881) into the
  # oxageninc organization (owner 267772457), and macanderson/oxagen became
  # oxageninc/product. A transfer keeps `repo_id`, and GitHub signs new tokens
  # with the new name only. The old names stay trusted so that applying this
  # stack never removes a subject a live role holds. Drop an entry once nothing
  # can run under the old name.
  moved_from = [
    { deployer = "cgp-website", repository = "macanderson/cgp-website", owner_id = 542881 },
    { deployer = "context-graph-protocol", repository = "macanderson/context-graph-protocol", owner_id = 542881 },
    { deployer = "oxagen-platform", repository = "macanderson/oxagen", owner_id = 542881 },
  ]

  deploy_environment = "production"
}

locals {
  # Every name each deployer's tokens may carry: the earlier names first, then
  # the current one.
  deploy_names = {
    for key, d in local.deployers : key => concat(
      [for m in local.moved_from : { repository = m.repository, owner_id = m.owner_id } if m.deployer == key],
      [{ repository = d.repository, owner_id = d.owner_id }],
    )
  }

  deploy_subjects = {
    for key, d in local.deployers : key => flatten([
      for n in local.deploy_names[key] : [
        "repo:${n.repository}:environment:${local.deploy_environment}",
        "repo:${split("/", n.repository)[0]}@${n.owner_id}/${split("/", n.repository)[1]}@${d.repo_id}:environment:${local.deploy_environment}",
      ]
    ])
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
