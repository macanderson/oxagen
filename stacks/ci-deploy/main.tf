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
  #
  # `owner_id` and `repo_id` are the numeric database ids, and they are not
  # optional decoration — see the subject note in the trust policy below.
  # Read them with:
  #
  #   gh api repos/<owner>/<name> --jq '"\(.owner.id) \(.id)"'
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
      repository  = "oxageninc/oxagen-platform"
      owner_id    = 294371946
      repo_id     = 1252628274
      description = "Publishes oxagen.sh and the four services on the node."
    }
  }

  # The environment every deploy job declares. One place, because it appears in
  # four trust policies and the workflows have to spell it identically.
  deploy_environment = "production"
}

locals {
  # The two subject spellings GitHub may mint, per repository.
  #
  # The documented form is `repo:<owner>/<name>:environment:<env>`. This account
  # also sees the **immutable-id** form, in which the owner and repository each
  # carry their numeric database id:
  #
  #   repo:macanderson@542881/stella@1297837446:environment:production
  #
  # That is not a guess. The first real deploy failed with
  # `Not authorized to perform sts:AssumeRoleWithWebIdentity`, and CloudTrail's
  # `userIdentity.principalId` for the denied call carried exactly that string.
  # The point of the format is that renaming a repository cannot silently hand
  # its trust to whoever claims the old name — the ids do not move.
  #
  # Both are trusted because the setting is configurable per organisation and
  # these four repositories span two owners; a role that trusted only one form
  # would break the day the setting changed, with an error that says nothing
  # about why. Listing both is still exact matching — literal strings, no
  # wildcard.
  #
  # The environment name is taken verbatim from the workflow, lowercase, which
  # the same CloudTrail record settles: the repositories carry a `Production`
  # environment left over from Vercel, and the claim still said `production`.
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
    # Both spellings GitHub may mint; see `local.deploy_subjects`.
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

  # An hour is longer than any deploy here takes and shorter than a working
  # day, so a token that leaks out of a runner has a bounded life without a
  # slow deploy having to re-authenticate mid-flight.
  max_session_duration = 3600
}
