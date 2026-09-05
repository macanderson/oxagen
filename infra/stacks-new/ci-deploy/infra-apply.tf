/**
 * Roles that let this repository plan and apply its own OpenTofu, so changing
 * infrastructure is a pull request rather than somebody signing in.
 *
 * Two roles, not one, and the split is the whole point. `plan` runs on every
 * pull request and can only read; `apply` runs after a merge and can write.
 * A pull request therefore cannot change anything no matter what its diff
 * says, which is what makes it safe to run a plan automatically on a proposal
 * nobody has reviewed yet.
 *
 * The trust conditions differ in the same way. `plan` is pinned to this
 * repository and nothing narrower, because a plan is harmless from any branch.
 * `apply` is pinned to the `production` environment, which is a GitHub setting
 * rather than a Terraform one — required reviewers and branch restrictions are
 * configured there, and that gate is the real control on this role. Widening
 * it is a decision made in the repository settings, deliberately, rather than
 * by editing a condition here.
 *
 * Both are pinned to the immutable `owner_id`/`repo_id` form as well as the
 * human-readable one, matching `local.deploy_subjects`: a repository can be
 * renamed or transferred, and the numeric identity cannot be squatted.
 */

locals {
  # The platform repository, because this configuration lives in it at `infra/`
  # rather than in a repository of its own. `local.deployers["oxagen-platform"]`
  # already names the same repository for its deploy role, and both are pinned
  # to the same numeric identity — the two grants are deliberately separate
  # roles, because publishing an artifact and administering the account are not
  # the same permission and should not be the same trust.
  infra_repository = local.deployers["oxagen-platform"].repository
  infra_owner_id   = local.deployers["oxagen-platform"].owner_id

  # Spelled out rather than read from the backend block: OpenTofu does not
  # expose backend settings as values, so these would have to be duplicated
  # somewhere regardless. Here, beside the only policy that uses them.
  tfstate_bucket_arn = "arn:aws:s3:::oxagen-tfstate-${var.account_id}"
  tflock_table_arn   = "arn:aws:dynamodb:${var.region}:${var.account_id}:table/oxagen-tflock"

  infra_repo_id = local.deployers["oxagen-platform"].repo_id

  # Both the readable form and the immutable owner@id/repo@id form, matching
  # `local.deploy_subjects`. Apply names one exact environment subject; plan
  # ends in a wildcard so it works from any branch, which is safe because that
  # role cannot write.
  infra_subjects = { for mode in ["plan", "apply"] : mode => [
    for shape in [
      local.infra_repository,
      "${split("/", local.infra_repository)[0]}@${local.infra_owner_id}/${split("/", local.infra_repository)[1]}@${local.infra_repo_id}",
    ] : mode == "apply"
    ? "repo:${shape}:environment:${local.deploy_environment}"
    : "repo:${shape}:*"
  ] }
}

data "aws_iam_policy_document" "infra_assume" {
  for_each = toset(["plan", "apply"])

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

    # `StringLike` for plan because its subject ends in a wildcard; apply names
    # one exact environment subject and stays on StringEquals.
    condition {
      test     = each.key == "apply" ? "StringEquals" : "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = local.infra_subjects[each.key]
    }
  }
}

resource "aws_iam_role" "infra" {
  for_each = toset(["plan", "apply"])

  name        = "gha-infra-${each.key}"
  description = "OpenTofu ${each.key} for ${local.infra_repository}."

  assume_role_policy   = data.aws_iam_policy_document.infra_assume[each.key].json
  max_session_duration = 3600
}

/**
 * Plan reads everything and writes nothing.
 *
 * `ReadOnlyAccess` rather than a hand-built list: a plan touches whatever the
 * configuration describes, which is most of the account, and an enumerated
 * read policy would fail on each new resource type the way `platform_services`
 * failed on `worker` — after a merge, on a step nothing runs earlier.
 */
resource "aws_iam_role_policy_attachment" "infra_plan_read" {
  role       = aws_iam_role.infra["plan"].name
  policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
}

/**
 * Plan also needs to read and lock state, which `ReadOnlyAccess` does not
 * cover: the lock table is a write.
 */
data "aws_iam_policy_document" "infra_state" {
  statement {
    sid       = "ReadState"
    actions   = ["s3:GetObject", "s3:ListBucket"]
    resources = [local.tfstate_bucket_arn, "${local.tfstate_bucket_arn}/*"]
  }

  statement {
    sid = "HoldTheLock"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:DeleteItem",
    ]
    resources = [local.tflock_table_arn]
  }
}

resource "aws_iam_role_policy" "infra_plan_state" {
  name   = "opentofu-state"
  role   = aws_iam_role.infra["plan"].id
  policy = data.aws_iam_policy_document.infra_state.json
}

/**
 * Apply administers the account.
 *
 * This is broad and it is meant to be: this role's job is to be the only thing
 * that changes this account, and it manages IAM, S3, EC2, SSM, CloudFront,
 * Route 53 and RDS across five stacks. A narrower grant would mean every new
 * resource type is a permission failure discovered after a merge, and the
 * predictable response to that is to widen it in a hurry rather than
 * deliberately.
 *
 * The control is the `production` environment gate in the trust policy above,
 * where required reviewers live, plus the fact that a pull request runs the
 * plan role and can never reach this one.
 */
resource "aws_iam_role_policy_attachment" "infra_apply_admin" {
  role       = aws_iam_role.infra["apply"].name
  policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess"
}

output "infra_role_arns" {
  description = "Role ARNs the infra workflow assumes, by mode."
  value       = { for k, r in aws_iam_role.infra : k => r.arn }
}
