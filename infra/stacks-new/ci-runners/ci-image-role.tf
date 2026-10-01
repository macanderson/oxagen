/**
 * The role `ci-image.yml` assumes to publish CI images and the pnpm store.
 *
 * Only `ci-image.yml` on `main` can assume it: the subject pins the branch,
 * and `job_workflow_ref` pins the workflow file, so another workflow on main
 * and every pull request are refused. Both subject spellings are trusted, the
 * readable one and the immutable owner@id/repo@id one, as in ci-deploy.
 */

data "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"
}

locals {
  github_owner = split("/", var.github_repository)[0]
  github_name  = split("/", var.github_repository)[1]

  ci_image_subjects = [
    "repo:${var.github_repository}:ref:refs/heads/main",
    "repo:${local.github_owner}@${var.github_owner_id}/${local.github_name}@${var.github_repo_id}:ref:refs/heads/main",
  ]
}

data "aws_iam_policy_document" "ci_image_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [data.aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = local.ci_image_subjects
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:job_workflow_ref"
      values   = ["${var.github_repository}/.github/workflows/ci-image.yml@refs/heads/main"]
    }
  }
}

resource "aws_iam_role" "ci_image" {
  name                 = "gha-ci-image"
  description          = "Publish the CI images to ECR Public and the pnpm store to S3, from ci-image.yml on main."
  assume_role_policy   = data.aws_iam_policy_document.ci_image_assume.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "ci_image" {
  # ECR Public signs in with a bearer token from STS. The workflow also reads
  # the registry's alias. None of the three calls takes a resource scope.
  statement {
    sid       = "SignIn"
    actions   = ["ecr-public:DescribeRegistries", "ecr-public:GetAuthorizationToken", "sts:GetServiceBearerToken"]
    resources = ["*"]
  }

  statement {
    sid = "PushImages"
    actions = [
      "ecr-public:BatchCheckLayerAvailability",
      "ecr-public:CompleteLayerUpload",
      "ecr-public:DescribeImages",
      "ecr-public:DescribeRepositories",
      "ecr-public:InitiateLayerUpload",
      "ecr-public:PutImage",
      "ecr-public:UploadLayerPart",
    ]
    resources = [for r in aws_ecrpublic_repository.ci : r.arn]
  }

  statement {
    sid       = "PublishPnpmStore"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.image_assets.arn}/pnpm-store/*"]
  }
}

resource "aws_iam_role_policy" "ci_image" {
  name   = "publish-ci-images"
  role   = aws_iam_role.ci_image.id
  policy = data.aws_iam_policy_document.ci_image.json
}
