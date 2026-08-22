/**
 * How GitHub Actions deploys to production without a long-lived AWS key.
 *
 * Four repositories publish to this account on merge — Stella's documentation
 * site, the Context Graph Protocol microsite and its specification artifacts,
 * and the Oxagen platform. Until this stack existed none of them could reach
 * AWS at all: the account held one OIDC provider, for Vercel, and Vercel is
 * gone.
 *
 * The alternative was an access key per repository in GitHub secrets. It is
 * rejected here for the obvious reason and a less obvious one. The obvious:
 * a key is a bearer credential that lives until someone remembers to rotate
 * it, and this account already has unrotated keys loose in the world. The
 * less obvious: a key carries no context, so an IAM policy written against it
 * cannot distinguish "the deploy job on main" from "anything at all holding
 * this key". An OIDC token carries the repository, the ref, and the
 * environment as claims, which is what lets the trust policy below be a real
 * control rather than a formality.
 *
 * Each role trusts exactly one subject: `environment:production` on its own
 * repository. That deliberately does *not* include `ref:refs/heads/main`.
 * GitHub mints an environment-scoped subject only for a job that declares
 * `environment: production`, and entry to that environment is a repository
 * setting — protection rules, required reviewers, a revocable secret — that
 * lives outside the workflow file. A subject naming the branch would let any
 * workflow on main assume the role; a subject naming the environment makes
 * assuming it an auditable event someone can revoke without a code change.
 * The workflows in all four repositories therefore MUST declare
 * `environment: production` on their deploy job or the assume-role step fails
 * closed.
 */

# GitHub's OIDC issuer. One provider serves every repository in every org —
# the per-repository separation is carried by the roles' trust policies below,
# not by having several providers.
resource "aws_iam_openid_connect_provider" "github" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = local.github_thumbprints
}

locals {
  # IAM stopped verifying this thumbprint against GitHub's leaf certificate in
  # 2023 — it validates the issuer against its own CA bundle instead — but the
  # API still requires the field. Both of GitHub's published intermediates are
  # listed so that a rotation to either one cannot strand the provider, which
  # is the failure this field can still cause.
  github_thumbprints = [
    "6938fd4d98bab03faadb97b34396831e3780aea1",
    "1c58a3a8518e8759bf075b76b750d4f2df264fcd",
  ]

  # One entry per repository allowed to deploy. Adding a repository here grants
  # it nothing on its own: it gets a role with an empty permission set until a
  # policy in `roles.tf` names it, which keeps "who may deploy" and "what they
  # may touch" as two separate reviewable decisions.
  deployers = {
    stella = {
      repository  = "macanderson/stella"
      description = "Publishes stella.oxagen.sh from website/."
    }
    cgp-website = {
      repository  = "macanderson/cgp-website"
      description = "Publishes contextgraphprotocol.org."
    }
    context-graph-protocol = {
      repository  = "macanderson/context-graph-protocol"
      description = "Publishes the CGP schema and specification artifacts."
    }
    oxagen-platform = {
      repository  = "oxageninc/oxagen-platform"
      description = "Publishes oxagen.sh and the four services on the node."
    }
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

    # The audience. Without this condition the trust policy would accept a
    # token minted for any audience by any GitHub repository.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    # The subject, and the reason this is `StringEquals` rather than the
    # `StringLike` that most published examples use. A wildcard subject —
    # `repo:owner/name:*` — accepts a token from a pull request opened by
    # anyone who can open one, on a fork, running their own workflow file.
    # These repositories are public. An exact subject accepts only the
    # environment, which a fork's pull request cannot enter.
    #
    # Two spellings, because every one of these repositories already carried a
    # `Production` environment created by Vercel's GitHub integration, and
    # GitHub resolves an environment name case-insensitively while the
    # workflows here write it lowercase. Which casing reaches the `sub` claim
    # is not something to find out from a failed deploy, and listing both is
    # still exact matching — two literal strings, no wildcard, no widening of
    # what is accepted beyond the same environment under its other spelling.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values = [
        "repo:${each.value.repository}:environment:production",
        "repo:${each.value.repository}:environment:Production",
      ]
    }
  }
}

resource "aws_iam_role" "deployer" {
  for_each = local.deployers

  name        = "gha-deploy-${each.key}"
  description = each.value.description

  assume_role_policy = data.aws_iam_policy_document.assume[each.key].json

  # An hour is longer than any deploy here takes and shorter than a working
  # day, so a token that leaks out of a runner has a bounded life without a
  # slow deploy having to re-authenticate mid-flight.
  max_session_duration = 3600
}
